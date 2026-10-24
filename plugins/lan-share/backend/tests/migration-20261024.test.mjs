import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createLanShareService, lanIpv4Addresses, parseRange, READ_CHUNK_BYTES, verifyShareCode } from '../share-service.mjs'
import { createShareApi } from '../../src/js/share-api.mjs'
import { loadHistory, recordFromShare } from '../../src/js/history.mjs'

const pluginRoot = new URL('../../', import.meta.url)
const DATA = Buffer.from('selected-file-only\n'.repeat(9000))

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'enest-lan-migration-'))
  const paths = new Map(), tokens = new Map(), activities = new Set(), controls = [], events = []
  const inputs = options.files || [['sample.txt', DATA], ['empty.txt', Buffer.alloc(0)]]
  for (const [name, content] of inputs) {
    const path = join(directory, name)
    await writeFile(path, content)
    paths.set(name, path)
  }
  let bytesRead = 0, activeReads = 0, maxReads = 0
  const hostRequest = async (method, params) => {
    controls.push({ method, params })
    await options.beforeControl?.(method, params)
    if (method === 'files.open') {
      const path = paths.get(params.handleId)
      if (!path) throw new Error('invalid or expired local file handle')
      const file = await open(path, 'r'), stat = await file.stat(), token = randomUUID()
      tokens.set(token, { file, stat })
      return { token, name: params.handleId, size: stat.size }
    }
    if (method === 'files.read') {
      const entry = tokens.get(params.token)
      if (!entry) throw new Error('invalid file token')
      assert.ok(Number.isSafeInteger(params.offset) && params.offset >= 0)
      assert.ok(params.length > 0 && params.length <= 256 * 1024)
      activeReads++; maxReads = Math.max(maxReads, activeReads)
      try {
        const current = await entry.file.stat()
        if (current.ino !== entry.stat.ino || current.size !== entry.stat.size || current.mtimeMs !== entry.stat.mtimeMs) throw new Error('selected file changed')
        const block = Buffer.alloc(params.length)
        const result = await entry.file.read(block, 0, block.length, params.offset)
        bytesRead += result.bytesRead
        return { bytes: new Uint8Array(block.buffer, block.byteOffset, result.bytesRead), bytesRead: result.bytesRead }
      } finally { activeReads-- }
    }
    if (method === 'files.close') {
      const entry = tokens.get(params.token)
      if (entry) { await entry.file.close(); tokens.delete(params.token) }
      return
    }
    if (method === 'activity.acquire') { activities.add(params.token); return }
    if (method === 'activity.release') { activities.delete(params.token); return }
    throw new Error(`unexpected host method ${method}`)
  }
  const service = createLanShareService({ hostRequest, emit: (event, data) => events.push({ event, data }),
    listenHost: '127.0.0.1', interfaces: () => ({}), ...options.serviceOptions })
  t.after(async () => {
    await service.shutdown()
    for (const entry of tokens.values()) await entry.file.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  return { service, paths, tokens, activities, controls, events,
    get bytesRead() { return bytesRead }, get maxReads() { return maxReads },
    start: (files = ['sample.txt']) => service.start({ files: files.map(handleId => ({ handleId })), minutes: 1 }) }
}

function get(share, { index = 0, code = share.code, method = 'GET', headers = {}, path } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: share.port, agent: false, method,
      path: path ?? `/d/${share.files[index].id}?code=${code}`, headers }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) { request.destroy(new Error('test response exceeds bounded collection')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.setTimeout(2000, () => request.destroy(new Error('test request timed out')))
    request.on('error', reject)
    request.end()
  })
}

async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(5) }
  assert.fail('condition did not become true')
}

test('migration declares a new native permission and keeps the renderer on standard backend transport', async () => {
  const manifest = JSON.parse(await readFile(new URL('plugin.json', pluginRoot), 'utf8'))
  const pkg = JSON.parse(await readFile(new URL('package.json', pluginRoot), 'utf8'))
  assert.equal(manifest.version, '1.2.0')
  assert.equal(manifest.engines.enest, '>=0.2.2')
  assert.ok(manifest.permissions.includes('backend.node'))
  assert.ok(!manifest.permissions.includes('lan.share'))
  assert.equal(manifest.backend.entry, 'backend/index.cjs')
  assert.deepEqual(pkg.enestBackend.dependencies, [])
  const calls = [], listeners = new Map()
  const api = createShareApi({ backend: { call: (method, args) => { calls.push({ method, args }); return Promise.resolve({ shareId: 'fixture-share', downloads: 2 }) } },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event) } })
  await api.start({ files: [{ handleId: 'selected' }], minutes: 5 })
  assert.deepEqual(calls, [{ method: 'share.start', args: [{ files: [{ handleId: 'selected' }], minutes: 5 }] }])
  const events = [], off = api.onRequest(value => events.push(value))
  listeners.get('backend.event')({ event: 'not-lan', data: 1 })
  listeners.get('backend.event')({ event: 'lan.request', data: { file: 'selected' } })
  assert.deepEqual(events, [{ file: 'selected' }])
  off(); assert.equal(listeners.size, 0)
  const stopped = [], offStopped = api.onStopped(value => stopped.push(value))
  listeners.get('backend.event')({ event: 'backend.exit', data: { code: 9, unexpected: true } })
  assert.equal(stopped[0].shareId, 'fixture-share')
  assert.equal(stopped[0].status.stopped, true)
  assert.equal(stopped[0].status.activeConnections, 0)
  assert.equal(stopped[0].status.downloads, 2)
  offStopped()
  const source = await readFile(new URL('src/jsx/App.jsx', pluginRoot), 'utf8')
  assert.doesNotMatch(source, /api\.net\.share/)
})

test('loopback full GET streams selected file blocks and counts only completed downloads', async t => {
  const f = await fixture(t), share = await f.start()
  assert.equal(f.activities.size, 1)
  assert.equal(f.tokens.size, 1)
  assert.equal(JSON.stringify(share).includes('token'), false)
  assert.equal(JSON.stringify(share).includes('/'), false)
  assert.match(share.code, /^\d{6}$/)
  const full = await get(share)
  assert.equal(full.status, 200)
  assert.deepEqual(full.body, DATA)
  assert.equal(full.headers['content-length'], String(DATA.length))
  assert.equal(full.headers['x-content-type-options'], 'nosniff')
  await until(() => f.service.status(share.shareId).downloads === 1)
  const reads = f.controls.filter(control => control.method === 'files.read')
  assert.ok(reads.length > 1)
  assert.ok(reads.every(control => control.params.length <= READ_CHUNK_BYTES))
  assert.equal(f.maxReads, 1)
  assert.equal(f.bytesRead, DATA.length)
  assert.equal(f.events.filter(event => event.event === 'lan.request').length, 1)
  assert.equal(await f.service.stop(share.shareId), true)
  assert.equal(f.tokens.size, 0)
  assert.equal(f.activities.size, 0)
  assert.equal(f.service.status(share.shareId).downloads, 1)
  assert.equal(f.service.status(share.shareId).activeConnections, 0)
  assert.equal(f.service.list().length, 0)
  await assert.rejects(get(share), /ECONNREFUSED/)
})

test('HTTP denies codes, methods and arbitrary paths before reading a selected file', async t => {
  const f = await fixture(t), share = await f.start()
  assert.equal((await get(share, { code: '0000000' })).status, 403)
  assert.equal((await get(share, { method: 'POST' })).status, 405)
  assert.equal((await get(share, { path: '/../../etc/passwd' })).status, 404)
  assert.equal((await get(share, { path: '/d/not-selected?code=' + share.code })).status, 404)
  assert.equal(f.controls.filter(control => control.method === 'files.read').length, 0)
  assert.equal(f.events.filter(event => event.event === 'lan.request').length, 0)
})

test('single/suffix Range and HEAD preserve HTTP lengths without inflating completed-download counts', async t => {
  const f = await fixture(t), share = await f.start()
  const partial = await get(share, { headers: { Range: 'bytes=2-6' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers['content-range'], `bytes 2-6/${DATA.length}`)
  assert.deepEqual(partial.body, DATA.subarray(2, 7))
  const suffix = await get(share, { headers: { Range: 'bytes=-999999' } })
  assert.equal(suffix.status, 206)
  assert.deepEqual(suffix.body, DATA)
  const head = await get(share, { method: 'HEAD', headers: { Range: 'bytes=5-' } })
  assert.equal(head.status, 206)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['content-length'], String(DATA.length - 5))
  for (const Range of ['bytes=-0', 'bytes=6-2', 'bytes=0-1,5-6', 'bytes=9007199254740992-', 'not-a-range']) {
    const response = await get(share, { headers: { Range } })
    assert.equal(response.status, 416, Range)
    assert.equal(response.headers['content-range'], `bytes */${DATA.length}`)
  }
  assert.equal(f.service.status(share.shareId).downloads, 0)
})

test('empty files have a valid 200 response and reject ranges without negative offsets', async t => {
  const f = await fixture(t), share = await f.start(['empty.txt'])
  const head = await get(share, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], '0')
  const body = await get(share)
  assert.equal(body.status, 200)
  assert.equal(body.body.length, 0)
  assert.equal((await get(share, { headers: { Range: 'bytes=0-' } })).status, 416)
  await until(() => f.service.status(share.shareId).downloads === 1)
})

test('a sparse 3 GiB selected file uses only the requested 16-byte range', async t => {
  const f = await fixture(t, { files: [['large.bin', Buffer.alloc(0)]] })
  const file = await open(f.paths.get('large.bin'), 'r+')
  const size = 3 * 1024 ** 3
  await file.truncate(size)
  await file.write(Buffer.from('0123456789abcdef'), 0, 16, size - 16)
  await file.close()
  const share = await f.start(['large.bin'])
  const result = await get(share, { headers: { Range: `bytes=${size - 16}-` } })
  assert.equal(result.status, 206)
  assert.equal(result.body.toString(), '0123456789abcdef')
  assert.equal(f.bytesRead, 16)
  assert.equal(f.controls.filter(control => control.method === 'files.read').length, 1)
})

test('a paused consumer cannot buffer a whole 3 GiB file in the backend', async t => {
  const f = await fixture(t, { files: [['large.bin', Buffer.alloc(0)]] })
  const file = await open(f.paths.get('large.bin'), 'r+')
  await file.truncate(3 * 1024 ** 3); await file.close()
  const share = await f.start(['large.bin'])
  let request
  const response = await new Promise((resolve, reject) => {
    request = httpRequest({ hostname: '127.0.0.1', port: share.port, agent: false,
      path: `/d/${share.files[0].id}?code=${share.code}` }, resolve)
    request.on('error', reject); request.end()
  })
  response.on('error', () => {})
  response.pause()
  await delay(50)
  // TCP/socket buffers may accept a few MiB; the producer must still stop far short of the file.
  assert.ok(f.bytesRead < 16 * 1024 ** 2, `unexpected prefetch: ${f.bytesRead}`)
  assert.ok(f.controls.filter(control => control.method === 'files.read').every(control => control.params.length <= READ_CHUNK_BYTES))
  await f.service.stop(share.shareId)
  request.destroy(); response.destroy()
  assert.equal(f.service.status(share.shareId).downloads, 0)
  assert.equal(f.tokens.size, 0)
})

test('changed files fail closed before headers and do not count as downloads', async t => {
  const f = await fixture(t), share = await f.start()
  await writeFile(f.paths.get('sample.txt'), 'changed')
  const result = await get(share)
  assert.equal(result.status, 410)
  assert.equal(f.service.status(share.shareId).downloads, 0)
})

test('invalid path-shaped input never reaches host controls and partial open failures release acquired tokens', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.start({ files: [{ path: '/etc/passwd' }] }), /selected file handles/)
  await assert.rejects(f.service.start({ files: [{ handleId: 'sample.txt', path: '/etc/passwd' }] }), /selected file handles/)
  assert.equal(f.controls.length, 0)
  await assert.rejects(f.start(['sample.txt', 'not-granted']), /invalid or expired/)
  assert.equal(f.tokens.size, 0)
  assert.equal(f.activities.size, 0)
})

test('expiry closes the loopback listener, selected tokens and activity lease', async t => {
  let expire
  const f = await fixture(t, { serviceOptions: {
    setTimer(callback, duration) {
      if (duration >= 60_000) { expire = callback; return { unref() {} } }
      return setTimeout(callback, duration)
    }, clearTimer(timer) { if (!timer?.unref || typeof timer === 'object' && !('_onTimeout' in timer)) return; clearTimeout(timer) }
  } })
  const share = await f.start()
  expire()
  await until(() => f.events.some(event => event.event === 'lan.stopped'))
  const event = f.events.find(event => event.event === 'lan.stopped')
  assert.equal(event.data.reason, 'expired')
  assert.equal(f.tokens.size, 0)
  assert.equal(f.activities.size, 0)
  await assert.rejects(get(share), /ECONNREFUSED/)
})

test('shutdown aborts an in-flight bounded read and never emits events for the closing incarnation', async t => {
  let releaseRead, enteredRead
  const started = new Promise(resolve => { enteredRead = resolve })
  const held = new Promise(resolve => { releaseRead = resolve })
  const f = await fixture(t, { beforeControl: async method => {
    if (method === 'files.read') { enteredRead(); await held }
  } })
  const share = await f.start()
  const download = get(share).then(() => null, error => error)
  await started
  const previousEvents = f.events.length
  const shutdown = f.service.shutdown()
  releaseRead()
  await shutdown
  assert.ok(await download)
  assert.equal(f.events.length, previousEvents)
  assert.equal(f.tokens.size, 0)
  assert.equal(f.activities.size, 0)
  assert.equal(f.controls.filter(control => control.method === 'files.read').length, 1)
  await assert.rejects(f.start(), /closing/)
  await assert.rejects(get(share), /ECONNREFUSED/)
})

test('the ninth socket is rejected and shutdown destroys idle keep-alive sockets', async t => {
  const f = await fixture(t), share = await f.start(), sockets = []
  for (let index = 0; index < 8; index++) {
    const socket = connect({ port: share.port, host: '127.0.0.1' })
    socket.on('error', () => {})
    sockets.push(socket)
    await once(socket, 'connect')
  }
  await until(() => f.service.status(share.shareId).activeConnections === 8)
  const extra = connect({ port: share.port, host: '127.0.0.1' })
  extra.on('error', () => {})
  await once(extra, 'close')
  assert.equal(f.service.status(share.shareId).activeConnections, 8)
  const closed = sockets.map(socket => once(socket, 'close'))
  await f.service.shutdown()
  await Promise.all(closed)
  assert.ok(sockets.every(socket => socket.destroyed))
})

test('share/code/address/history policies remain plugin-local and bounded', () => {
  assert.deepEqual(parseRange('bytes=-100', 4), { start: 0, end: 3, partial: true })
  assert.equal(verifyShareCode('123456', Buffer.from('123456')), true)
  assert.equal(verifyShareCode('123455', Buffer.from('123456')), false)
  assert.equal(verifyShareCode('12345x', Buffer.from('123456')), false)
  assert.deepEqual(lanIpv4Addresses({ test: [
    { family: 'IPv4', address: '169.254.2.1', internal: false },
    { family: 'IPv4', address: '192.168.1.2', internal: false },
    { family: 'IPv4', address: '127.0.0.1', internal: true },
    { family: 'IPv4', address: '192.168.1.2', internal: false }
  ] }), ['192.168.1.2'])
  const row = recordFromShare({ shareId: 'share', downloads: 3, files: [{ name: 'test', size: 4 }] })
  assert.equal(row.downloads, 3)
  assert.equal(loadHistory({ v: 2, entries: [row] })[0].downloads, 3)
  assert.equal(loadHistory(['legacy-file'])[0].names, 'legacy-file')
})

test('native backend transport rejects absent/wrong owners and acknowledges shutdown without exposing host paths', async () => {
  const output = await build({ entryPoints: [new URL('../index.mjs', import.meta.url).pathname], bundle: true,
    write: false, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  const messages = [], port = new EventEmitter(), fakeProcess = new EventEmitter()
  let exitCode
  port.postMessage = message => messages.push(message)
  fakeProcess.parentPort = port; fakeProcess.exit = value => { exitCode = value }
  vm.runInNewContext(output.outputFiles[0].text, { require: createRequire(import.meta.url), process: fakeProcess,
    Buffer, Uint8Array, URL, AbortController, setTimeout, clearTimeout })
  const send = message => port.emit('message', { data: message })
  send({ id: 1, pluginId: 'com.github.eNest.lan-share', method: 'share.list', args: [] })
  await until(() => messages.some(message => message.id === 1))
  assert.match(messages.find(message => message.id === 1).error, /owner/)
  send({ type: 'init', pluginId: 'com.github.eNest.lan-share', generation: 3, wcId: 4, context: { protocolVersion: 1 } })
  send({ id: 2, pluginId: 'wrong-owner', method: 'share.list', args: [] })
  send({ id: 3, pluginId: 'com.github.eNest.lan-share', method: 'share.list', args: [] })
  send({ id: 4, pluginId: 'com.github.eNest.lan-share', method: 'files.open', args: ['/etc/passwd'] })
  await until(() => messages.some(message => message.id === 4))
  assert.match(messages.find(message => message.id === 2).error, /owner/)
  assert.equal(messages.find(message => message.id === 3).ok, true)
  assert.equal(messages.find(message => message.id === 3).data.length, 0)
  assert.match(messages.find(message => message.id === 4).error, /unsupported/)
  assert.equal(messages.some(message => message.type === 'host.request'), false)
  send({ type: 'shutdown' })
  await until(() => exitCode === 0)
  assert.equal(messages.find(message => message.type === 'shutdown.complete').ok, true)
})
