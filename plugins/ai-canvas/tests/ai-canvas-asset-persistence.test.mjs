import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../src/js/assets.mjs', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const image = label => ({ dataUrl: 'data:image/png;base64,AA==', mime: 'image/png', bytes: 1, label })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const drain = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }

function fixture(options = {}) {
  const calls = [], revoked = [], created = []
  const files = new Map((options.assets ?? ['removed']).map(id => [id, image(id)]))
  let meta = structuredClone(options.meta ?? { removed: { prompt: 'old' }, retained: { prompt: 'keep' } })
  let durable = structuredClone(meta), commitFailures = options.commitFailures ?? 0, readFailures = options.readFailures ?? 0
  let imageReads = 0
  const assets = {
    get: async id => {
      imageReads++
      calls.push({ type: 'image-get', id })
      return options.readImage ? options.readImage(id, imageReads) : files.get(id) ?? null
    },
    [options.legacyDelete ? 'delete' : 'remove']: async id => {
      calls.push({ type: 'image-remove', id })
      return files.delete(id)
    },
  }
  const storage = {
    assets,
    get: async key => {
      calls.push({ type: 'get', key })
      if (readFailures > 0) { readFailures--; throw new Error('Fixture index read failure') }
      return structuredClone(meta)
    },
    set: async (key, value) => {
      calls.push({ type: 'set', key, value: plain(value) })
      meta = structuredClone(value)
      return true
    },
    ...(options.mode === 'legacy' || options.mode === 'flush' ? {} : { commit: async operations => {
      calls.push({ type: 'commit', operations: plain(operations) })
      if (options.commitGate) await options.commitGate.promise
      if (commitFailures > 0) { commitFailures--; throw new Error('Fixture index commit failure') }
      assert.equal(operations.length, 1)
      assert.equal(operations[0].op, 'set')
      meta = structuredClone(operations[0].value)
      durable = structuredClone(meta)
      return { commitId: 'fixture', committedAt: 1, committedKeys: 1 }
    } }),
    ...(options.mode === 'legacy' ? {} : { flush: async () => {
      calls.push({ type: 'flush' })
      durable = structuredClone(meta)
      return { commitId: 'fixture', committedAt: 1, committedKeys: 1 }
    } }),
  }
  const context = {
    window: { enest: { storage } }, structuredClone, atob,
    Blob: class { constructor(parts, options) { this.parts = parts; this.options = options } },
    URL: {
      createObjectURL: () => { const url = `blob:fixture-${created.length + 1}`; created.push(url); return url },
      revokeObjectURL: url => revoked.push(url),
    },
  }
  vm.runInNewContext(source.replace(/^export /gm, '') + `\nglobalThis.api = { deleteAsset, attachGalleryMeta, loadGalleryMeta, assetPreviewUrl };`, context, {
    filename: fileURLToPath(new URL('../src/js/assets.mjs', import.meta.url)),
  })
  return { api: context.api, calls, files, revoked, created, get meta() { return plain(meta) }, get durable() { return plain(durable) }, get imageReads() { return imageReads } }
}

test('deletion clears previews immediately and a failed index commit can retry after the asset is absent', async () => {
  const f = fixture({ commitFailures: 1 })
  const preview = await f.api.assetPreviewUrl('removed')
  await assert.rejects(f.api.deleteAsset('removed'), /Fixture index commit failure/)
  assert.equal(f.files.has('removed'), false)
  assert.deepEqual(f.revoked, [preview])
  assert.ok(f.meta.removed, 'failed commit preserves the prior index for retry')
  assert.equal(await f.api.assetPreviewUrl('removed'), null, 'deleted previews cannot survive in the cache')
  assert.equal(await f.api.deleteAsset('removed'), true)
  assert.deepEqual(f.durable, { retained: { prompt: 'keep' } })
  assert.equal(f.calls.filter(call => call.type === 'image-remove').length, 2)
  assert.equal(f.calls.filter(call => call.type === 'commit').length, 2)
  assert.equal(f.calls.some(call => call.type === 'set' || call.type === 'flush'), false, 'commit is the preferred barrier')
})

test('an absent legacy asset still cleans metadata using set then flush when available', async () => {
  const f = fixture({ assets: [], mode: 'flush', legacyDelete: true })
  assert.equal(await f.api.deleteAsset('removed'), true)
  assert.deepEqual(f.durable, { retained: { prompt: 'keep' } })
  assert.deepEqual(f.calls.filter(call => ['image-remove', 'set', 'flush'].includes(call.type)).map(call => call.type), ['image-remove', 'set', 'flush'])
})

test('an old host without commit or flush keeps the explicit best-effort set fallback', async () => {
  const f = fixture({ assets: [], mode: 'legacy', legacyDelete: true })
  assert.equal(await f.api.deleteAsset('removed'), true)
  assert.deepEqual(f.meta, { retained: { prompt: 'keep' } })
  assert.ok(f.durable.removed, 'the fallback must not manufacture durability')
  assert.equal(f.calls.filter(call => call.type === 'set').length, 1)
})

test('index read failures reject mutations instead of overwriting existing metadata with an empty object', async () => {
  const f = fixture({ readFailures: 1 })
  await assert.rejects(f.api.deleteAsset('removed'), /Fixture index read failure/)
  assert.equal(f.files.has('removed'), false)
  assert.equal(f.calls.some(call => call.type === 'commit' || call.type === 'set'), false)
  assert.deepEqual(f.meta, { removed: { prompt: 'old' }, retained: { prompt: 'keep' } })
  await f.api.deleteAsset('removed')
  assert.deepEqual(f.meta, { retained: { prompt: 'keep' } })

  const malformed = fixture({ meta: ['not a record'] })
  await assert.rejects(malformed.api.attachGalleryMeta('new', { prompt: 'new' }), /画廊索引格式无效/)
  assert.equal(malformed.calls.some(call => call.type === 'commit' || call.type === 'set'), false)
})

test('attachments and deletion share one serialized metadata read-modify-write queue', async () => {
  const commitGate = deferred(), f = fixture({ commitGate })
  const original = { prompt: 'first', at: 1 }
  const first = f.api.attachGalleryMeta('first', original)
  original.prompt = 'mutated after scheduling'
  try {
    await drain()
    const deletion = f.api.deleteAsset('removed')
    const second = f.api.attachGalleryMeta('second', { prompt: 'second', at: 2 })
    await drain()
    assert.equal(f.calls.filter(call => call.type === 'get').length, 1, 'later writers cannot read a stale index while the first commit is pending')
    commitGate.resolve()
    await Promise.all([first, deletion, second])
    assert.deepEqual(f.meta, { retained: { prompt: 'keep' }, first: { prompt: 'first', at: 1 }, second: { prompt: 'second', at: 2 } })
  } finally { commitGate.resolve() }
})

for (const staleFailure of [false, true]) {
  test(`invalidated preview reads cannot revive cache or remove a replacement task (${staleFailure ? 'reject' : 'resolve'})`, async () => {
    const oldRead = deferred(), newRead = deferred()
    const f = fixture({ readImage: (_id, count) => count === 1 ? oldRead.promise : newRead.promise })
    const old = f.api.assetPreviewUrl('removed')
    const oldOutcome = staleFailure ? assert.rejects(old, /Fixture stale read failure/) : old
    try {
      await drain()
      await f.api.deleteAsset('removed')
      f.files.set('removed', image('replacement'))
      const replacement = f.api.assetPreviewUrl('removed')
      await drain()
      assert.equal(f.imageReads, 2)
      if (staleFailure) oldRead.reject(new Error('Fixture stale read failure'))
      else oldRead.resolve(image('stale'))
      if (staleFailure) await oldOutcome
      else assert.equal(await oldOutcome, null)
      assert.deepEqual(f.created, [], 'an invalidated read must not create a blob URL')
      const shared = f.api.assetPreviewUrl('removed')
      await drain()
      assert.equal(f.imageReads, 2, 'the stale finally must not erase the replacement task')
      newRead.resolve(image('replacement'))
      const url = await replacement
      assert.equal(await shared, url)
      assert.equal(await f.api.assetPreviewUrl('removed'), url)
      assert.equal(f.created.length, 1)
    } finally { oldRead.resolve(null); newRead.resolve(null) }
  })
}
