import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createClipboardHistory } from '../background/history.mjs'
import { createClipboardApi } from '../src/js/history-api.mjs'

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0i8AAAAASUVORK5CYII='
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(options = {}) {
  const documents = new Map(), blobs = new Map(), events = [], operations = []
  const state = { settings: {}, failDocument: false, failCommit: false, marker: false, blobGate: null, ...options }
  let sequence = 0
  const host = {
    private: {
      readDocument: async key => structuredClone(documents.get(key) ?? null),
      async writeDocument(key, value) {
        operations.push('document')
        if (state.failDocument) throw new Error('fixture persistence failure')
        documents.set(key, structuredClone(value))
      },
      getBlob: async id => structuredClone(blobs.get(id) ?? null),
      async putBlob({ id = `blob-${++sequence}`, dataUrl }) {
        if (state.blobGate) await state.blobGate.promise
        const old = blobs.get(id)
        if (old && old.dataUrl !== dataUrl) throw new Error('immutable blob collision')
        const bytes = Buffer.from(dataUrl.split(',')[1], 'base64').length
        blobs.set(id, { dataUrl, bytes }); operations.push(`put:${id}`)
        return { id, bytes }
      },
      async removeBlob(id) { operations.push(`remove:${id}`); return blobs.delete(id) }
    },
    settings: { get: async () => ({ ...state.settings }) },
    emit: async (event, data) => events.push({ event, data }),
    legacy: {
      read: async () => state.marker || state.legacy === undefined ? null : { token: 'fixture-source-token', document: typeof state.legacy === 'string' ? state.legacy : JSON.stringify(state.legacy) },
      getBlob: async (_source, _token, name) => state.legacyBlobs?.[name] ? { dataUrl: state.legacyBlobs[name], bytes: Buffer.from(state.legacyBlobs[name].split(',')[1], 'base64').length } : null,
      async commit() { operations.push('legacy.commit'); if (state.failCommit) throw new Error('fixture interrupted marker'); state.marker = true }
    }
  }
  const service = createClipboardHistory(host, { now: () => 2000000000000, uuid: () => `record-${++sequence}` })
  return { service, host, state, documents, blobs, events, operations }
}

const text = (revision, value, extra = {}) => ({ revision, capturedAt: 2000000000000 + revision, type: 'text', text: value, ...extra })
const image = (revision, dataUrl = IMAGE) => ({ revision, capturedAt: 2000000000000 + revision, type: 'image', dataUrl, width: 1, height: 1 })

test('text, image and files deduplicate while retaining ID and pin metadata', async () => {
  const f = fixture()
  await f.service.onEvent('clipboard.changed', text(1, 'same text'))
  const original = (await f.service.call('history.query', [{}])).items[0]
  await f.service.call('history.togglePin', [original.id])
  await f.service.onEvent('clipboard.changed', text(2, 'same text', { sourceApp: { name: 'Fixture', evidence: 'owner' } }))
  await f.service.onEvent('clipboard.changed', image(3))
  await f.service.onEvent('clipboard.changed', image(4))
  const files = { type: 'files', files: [{ path: '/fixture/document.txt', name: 'document.txt' }] }
  await f.service.onEvent('clipboard.changed', { revision: 5, capturedAt: 5, ...files })
  await f.service.onEvent('clipboard.changed', { revision: 6, capturedAt: 6, ...files })
  const result = await f.service.call('history.query', [{}])
  assert.equal(result.total, 3)
  assert.equal(result.items[0].id, original.id)
  assert.equal(result.items[0].pinned, true)
  assert.equal(result.items[0].sourceApp.name, 'Fixture')
  assert.equal(f.blobs.size, 1)
  assert.equal((await f.service.call('history.get', [result.items.find(item => item.type === 'image').id])).dataUrl, IMAGE)
})

test('source exclusion remains effective when recording source metadata is disabled', async () => {
  const f = fixture({ settings: { recordSource: false, excludedApps: 'fixture.private' } })
  await f.service.onEvent('clipboard.changed', text(1, 'excluded', { sourceApp: { id: 'fixture.private', name: 'Private', evidence: 'owner' } }))
  await f.service.onEvent('clipboard.changed', text(2, 'allowed', { sourceApp: { id: 'fixture.public', name: 'Public', evidence: 'owner' } }))
  const { items } = await f.service.call('history.query', [{}])
  assert.deepEqual(items.map(item => item.text), ['allowed'])
  assert.equal(items[0].sourceApp, undefined)
})

test('capacity, retention, pinned-first pagination and clear preserve pinned records', async () => {
  const f = fixture({ settings: { historyLimit: 50, retentionDays: 1 } })
  await f.service.onEvent('clipboard.changed', text(1, 'pinned old'))
  const pin = (await f.service.call('history.query', [{}])).items[0]
  await f.service.call('history.togglePin', [pin.id])
  for (let i = 2; i <= 58; i++) await f.service.onEvent('clipboard.changed', text(i, `row ${i}`))
  await f.service.onEvent('clipboard.changed', text(59, 'expired', { capturedAt: 1 }))
  const result = await f.service.call('history.query', [{ limit: 10 }])
  assert.equal(result.total, 50)
  assert.equal(result.items[0].id, pin.id)
  assert.equal(result.nextCursor, 10)
  assert.equal((await f.service.call('history.query', [{ query: 'expired' }])).total, 0)
  await f.service.call('history.clear')
  assert.deepEqual((await f.service.call('history.query', [{}])).items.map(item => item.id), [pin.id])
})

test('failed index commit never removes a still-live image and capture is retryable', async () => {
  const f = fixture()
  await f.service.onEvent('clipboard.changed', image(1))
  const { items } = await f.service.call('history.query', [{}])
  f.state.failDocument = true
  await assert.rejects(f.service.call('history.remove', [items[0].id]), /persistence failure/)
  assert.equal(f.blobs.size, 1)
  assert.equal((await f.service.call('history.query', [{}])).total, 1)
  await assert.rejects(f.service.onEvent('clipboard.changed', text(2, 'retry me')), /persistence failure/)
  f.state.failDocument = false
  await f.service.onEvent('clipboard.changed', text(2, 'retry me'))
  assert.equal((await f.service.call('history.query', [{}])).total, 2)
  f.operations.length = 0
  await f.service.call('history.remove', [items[0].id])
  assert.equal(f.operations[0], 'document')
  assert.match(f.operations[1], /^remove:/)
})

test('all migration IDs, unknown fields and image bytes survive without retention trimming', async () => {
  const records = [{ id: 'old-text', type: 'text', text: 'retained', preview: 'retained', ts: 1, pinned: true, customField: 'preserve' },
    { id: 'old-image', type: 'image', preview: '1×1', ts: 2, pinned: false, blobFile: 'old-image.png', width: 1, height: 1 }]
  const f = fixture({ legacy: records, legacyBlobs: { 'old-image.png': IMAGE }, settings: { retentionDays: 1 } })
  const result = await f.service.call('history.query', [{}])
  assert.deepEqual(result.items.map(item => item.id), ['old-text', 'old-image'])
  assert.equal(result.items[0].customField, 'preserve')
  assert.equal((await f.service.call('history.get', ['old-image'])).dataUrl, IMAGE)
  assert.equal(f.state.marker, true)
  assert.ok(f.operations.indexOf('document') < f.operations.indexOf('legacy.commit'))
  const restarted = createClipboardHistory(f.host)
  assert.equal((await restarted.call('history.query', [{}])).total, 2)
  assert.equal(f.blobs.size, 1)
})

test('interrupted migration commit retries from private durable state without duplicate blobs', async () => {
  const f = fixture({ legacy: [{ id: 'old', type: 'image', preview: '1×1', ts: 1, blobFile: 'old.png' }], legacyBlobs: { 'old.png': IMAGE }, failCommit: true })
  await assert.rejects(f.service.call('history.query', [{}]), /interrupted marker/)
  assert.equal(f.blobs.size, 1)
  f.state.failCommit = false
  const restarted = createClipboardHistory(f.host)
  assert.equal((await restarted.call('history.query', [{}])).total, 1)
  assert.equal(f.blobs.size, 1)
  assert.equal(f.state.marker, true)
})

test('corrupt legacy documents, missing blobs and traversal fail without a completion marker', async () => {
  for (const options of [{ legacy: '{invalid' }, { legacy: {} },
    { legacy: [{ id: 'missing', type: 'image', preview: 'missing', ts: 1, blobFile: 'missing.png' }] },
    { legacy: [{ id: 'escape', type: 'image', preview: 'escape', ts: 1, blobFile: '../secret.png' }] }]) {
    const f = fixture(options)
    await assert.rejects(f.service.call('history.query', [{}]))
    assert.equal(f.state.marker, false)
    assert.equal(f.documents.size, 0)
  }
})

test('closing the background during an image write prevents a late history commit', async () => {
  const gate = deferred(), f = fixture({ blobGate: gate })
  await f.service.call('history.query', [{}])
  const before = structuredClone(f.documents.get('clipboard.history.v2'))
  const work = f.service.onEvent('clipboard.changed', image(1))
  await new Promise(resolve => setImmediate(resolve))
  f.service.dispose(); gate.resolve()
  await assert.rejects(work, /closed/)
  assert.deepEqual(f.documents.get('clipboard.history.v2'), before)
  assert.equal(f.blobs.size, 0)
})

test('background and UI mutations share one serialized writer and can restart without a UI', async () => {
  const f = fixture()
  await Promise.all([f.service.onEvent('clipboard.changed', text(1, 'first')), f.service.onEvent('clipboard.changed', text(2, 'second'))])
  const resumed = createClipboardHistory(f.host)
  const result = await resumed.search('first', 6)
  assert.equal(result.length, 1)
  assert.equal(result[0].title, 'first')
  assert.ok(result[0].payload.historyId)
  assert.equal(result[0].code, 'main')
})

test('unrelated events, paused monitoring and stale revisions do not add records', async () => {
  const f = fixture({ settings: { monitoring: false } })
  await f.service.onEvent('clipboard.changed', text(1, 'paused'))
  f.state.settings.monitoring = true
  await f.service.onEvent('clipboard.changed', text(2, 'active'))
  await f.service.onEvent('clipboard.changed', text(1, 'stale'))
  await f.service.onEvent('unrelated', text(3, 'wrong source'))
  assert.deepEqual((await f.service.call('history.query', [{}])).items.map(item => item.text), ['active'])
})

test('image quotas fail without replacing prior state', async () => {
  const f = fixture()
  await f.service.onEvent('clipboard.changed', text(1, 'keep'))
  await assert.rejects(f.service.onEvent('clipboard.changed', image(2, `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`)), /oversized/)
  assert.deepEqual((await f.service.call('history.query', [{}])).items.map(item => item.text), ['keep'])
})

test('private UI facade routes storage to background and native actions to the current UI owner', async () => {
  const operations = [], listeners = new Map()
  let entry = { id: 'files', type: 'files', preview: 'sample', files: [{ name: 'sample.txt', path: '/fixture/sample.txt' }] }
  const host = Object.freeze({
    background: Object.freeze({ call: async (method, args, options) => { operations.push({ method, args, options }); return method === 'history.query' ? { items: [entry], total: 1, nextCursor: null } : entry } }),
    clipboard: Object.freeze({ writeText: async value => operations.push({ writeText: value }), writeImage: async value => operations.push({ writeImage: value }),
      writeFiles: async value => operations.push({ writeFiles: value }), paste: async () => ({ pasted: false, reason: 'fixture target unavailable' }), revealFile: async value => { operations.push({ revealConfirmed: value }); return true } }),
    on: (name, callback) => listeners.set(name, callback), off: name => listeners.delete(name)
  })
  const api = createClipboardApi(host)
  assert.equal(host.clipboard.history, undefined)
  assert.equal((await api.clipboard.history.query({})).items[0].files[0].exists, null)
  await api.clipboard.history.copy('files')
  await api.clipboard.history.copy('files', { paths: true })
  assert.equal((await api.clipboard.history.paste('files')).pasted, false)
  await api.clipboard.history.reveal('files', 0)
  assert.deepEqual(operations.find(value => value.writeFiles)?.writeFiles, ['/fixture/sample.txt'])
  assert.equal(operations.find(value => value.revealConfirmed)?.revealConfirmed, '/fixture/sample.txt')
  entry = { id: 'image', type: 'image', dataUrl: IMAGE }
  await api.clipboard.history.copy('image')
  assert.equal(operations.find(value => value.writeImage)?.writeImage, IMAGE)
  assert.ok(operations.filter(value => value.method).every(value => value.options.timeoutMs === 600000))
  let changed = 0
  const release = api.clipboard.history.onChange(() => changed++)
  listeners.get('background.event')({ event: 'unrelated' })
  listeners.get('background.event')({ event: 'history.changed', data: { count: 1 } })
  assert.equal(changed, 1); release(); assert.equal(listeners.size, 0)
})

test('manifest declares sandboxed background and no Node backend or plugin polling', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'))
  const source = await readFile(new URL('../background/history.mjs', import.meta.url), 'utf8')
  assert.equal(manifest.version, '1.4.0')
  assert.equal(manifest.engines.enest, '>=0.2.3')
  assert.equal(manifest.background.entry, 'assets/background.html')
  assert.equal(manifest.background.eventSettings['clipboard.changed'], 'monitoring')
  assert.equal(manifest.background.quickSearch, true)
  assert.equal(manifest.permissions.includes('backend.node'), false)
  assert.doesNotMatch(source, /setInterval|setTimeout|from ['"](?:node:|electron|@main)/)
})
