import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNativeSurfaces } from '../packages/native-surfaces/client.js'
import { prepareNativeSurfaceAssets, nativeSurfacesAssets } from '../packages/native-surfaces/vite.js'

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const PREFIX = 'assets/vendor/native-surfaces/'

function fixture(t) {
  const listeners = new Map(), windows = new Map(), sent = [], writes = [], streams = new Set(), aborted = [], closed = [], captures = []
  let next = 0, openHook, sendHook, writeHook
  const emit = (name, payload) => { for (const fn of listeners.get(name) || []) fn(payload) }
  const host = {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn) },
    untouched: { identity: 'fixture' },
    screen: { async capture(options) { captures.push(options); return { dataUrl: 'data:image/png;base64,fixture', width: 800, height: 600, displayId: 9 } } },
    auxiliary: {
      async open(options) { const windowId = `window-${++next}`; windows.set(windowId, options); await openHook?.(windowId, options); return { windowId } },
      async send(windowId, data, options) { sent.push({ windowId, data, options }); await sendHook?.(windowId, data, options) },
      async list() { return [...windows].map(([windowId, value]) => ({ windowId, entry: value.entry })) },
      async close(windowId) { if (!windows.delete(windowId)) return false; closed.push(windowId); emit('auxiliary.closed', { windowId }); return true }
    },
    files: { stream: {
      async open() { const streamId = `stream-${++next}`; streams.add(streamId); return { streamId } },
      async write(streamId, sequence, bytes) { await writeHook?.(streamId, sequence, bytes); writes.push({ streamId, sequence, bytes }) },
      async finish(streamId) { streams.delete(streamId); return { id: streamId, path: '/fixture-only/result.webm', size: 7 } },
      async abort(streamId) { aborted.push(streamId); return streams.delete(streamId) }
    } }
  }
  const client = createNativeSurfaces(Object.freeze(host))
  t.after(async () => { for (const id of [...windows.keys()]) await host.auxiliary.close(id); await settle() })
  const message = (windowId, data) => emit('auxiliary.message', { windowId, data })
  return { host, client, windows, sent, writes, aborted, closed, captures, streams, message, emit,
    openHook: fn => { openHook = fn }, sendHook: fn => { sendHook = fn }, writeHook: fn => { writeHook = fn } }
}

test('facade is plugin-owned and idle: no auxiliary window, file stream or preload mutation', async t => {
  const f = fixture(t)
  assert.equal(createNativeSurfaces(f.host), f.client)
  assert.equal(f.client.untouched, f.host.untouched)
  assert.equal(f.host.pin, undefined); assert.equal(f.host.screen.record, undefined)
  assert.equal(f.windows.size, 0); assert.equal(f.streams.size, 0)
  await f.client.screen.capture({ bounds: { displayId: 4, x: 0, y: 0, width: 1, height: 1 } })
  assert.equal(f.captures[0].displayId, 4)
})

test('pin controls stay in plugin assets and list/close only their own presentation entries', async t => {
  const f = fixture(t)
  const pin = await f.client.pin.open({ dataUrl: 'data:image/png;base64,fixture', title: 'fixture' })
  assert.equal(f.windows.get(pin.pinId).entry, PREFIX + 'pin.html')
  assert.equal(f.windows.get(pin.pinId).alwaysOnTop, true)
  const other = await f.host.auxiliary.open({ entry: 'assets/other.html' })
  assert.deepEqual(await f.client.pin.list(), [pin])
  assert.equal(await f.client.pin.close(other.windowId), false)
  assert.equal(await f.client.pin.closeAll(), 1)
  assert.equal(f.windows.has(other.windowId), true)
  await assert.rejects(f.client.pin.open({ dataUrl: 'https://example.invalid/image.png' }), /图片/)
})

test('region early replies and close cancellation use the actual preload event shape', async t => {
  const f = fixture(t)
  f.openHook(id => f.message(id, { type: 'confirm', bounds: { x: 10, y: 20, width: 30, height: 40 } }))
  assert.deepEqual(await f.client.screen.selectRegion(), { x: 10, y: 20, width: 30, height: 40, displayId: 9 })
  assert.equal(f.windows.size, 0)
  f.openHook(id => f.emit('auxiliary.closed', { windowId: id }))
  assert.equal(await f.client.screen.selectRegion(), null)
  assert.equal(f.windows.size, 0)
})

test('recording has a real-start handshake, ordered chunk ACK, stop/finalize and no Node backend', async t => {
  const f = fixture(t)
  f.openHook(id => f.message(id, { type: 'started' }))
  const started = await f.client.screen.record.start({ bounds: { displayId: 9, x: 0, y: 0, width: 80, height: 60 }, withAudio: true })
  const [id, options] = [...f.windows][0]
  assert.deepEqual(options.capture, { displayId: 9, withAudio: true })
  assert.equal(options.entry, PREFIX + 'recorder.html')
  assert.equal(f.sent.find(value => value.data.type === 'ack-start').options.visible, false)
  f.message(id, { type: 'chunk', sequence: 0, bytes: new Uint8Array([1, 2, 3]).buffer })
  await settle()
  assert.equal(f.writes[0].sequence, 0)
  assert.ok(f.sent.some(value => value.data.type === 'ack' && value.data.sequence === 0))
  f.sendHook((windowId, data) => { if (data.type === 'stop') f.message(windowId, { type: 'stopped' }) })
  const result = await f.client.screen.record.stop(started.sessionId)
  assert.equal(result.path, '/fixture-only/result.webm')
  assert.equal(result.size, 7); assert.ok(result.durationMs >= 0)
  assert.equal(f.windows.size, 0); assert.equal(f.streams.size, 0)
})

test('native track end caches one completed result until the visible plugin saves its history', async t => {
  const f = fixture(t); f.openHook(id => f.message(id, { type: 'started' }))
  const started = await f.client.screen.record.start(), id = [...f.windows.keys()][0]
  f.message(id, { type: 'stopped' }); await settle()
  assert.equal(f.windows.size, 0)
  assert.equal((await f.client.screen.record.stop(started.sessionId)).path, '/fixture-only/result.webm')
  await assert.rejects(f.client.screen.record.stop(started.sessionId), /不可用/)
})

test('recording cancellation, window loss and write failures abort unfinished private output', async t => {
  const f = fixture(t); f.openHook(id => f.message(id, { type: 'started' }))
  const first = await f.client.screen.record.start()
  assert.equal(await f.client.screen.record.cancel(first.sessionId), true)
  assert.equal(f.streams.size, 0); assert.equal(f.windows.size, 0)
  f.openHook(id => f.emit('auxiliary.closed', { windowId: id }))
  await assert.rejects(f.client.screen.record.start(), /关闭/)
  assert.equal(f.streams.size, 0); assert.equal(f.windows.size, 0)
  f.openHook(id => f.message(id, { type: 'started' }))
  await f.client.screen.record.start()
  f.writeHook(async () => { throw new Error('fixture disk failure') })
  f.message([...f.windows.keys()][0], { type: 'chunk', sequence: 0, bytes: new ArrayBuffer(1) })
  await settle()
  assert.equal(f.streams.size, 0); assert.equal(f.windows.size, 0)
  assert.equal(f.aborted.length, 3)
})

test('slow auxiliary opening cannot leak a window after its recording has already been cancelled', async t => {
  const f = fixture(t), gate = deferred(), entered = deferred()
  f.openHook(id => { f.emit('auxiliary.closed', { windowId: id }); entered.resolve(); return gate.promise })
  const start = f.client.screen.record.start(), observed = assert.rejects(start, /关闭/)
  await entered.promise; gate.resolve(); await observed
  assert.equal(f.windows.size, 0); assert.equal(f.streams.size, 0)
})

test('Vite asset hook materializes portable real files for dev and build without source symlinks', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'enest-surface-assets-fixture-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await nativeSurfacesAssets().configResolved({ root })
  const directory = join(root, 'public', PREFIX)
  const names = await fs.readdir(directory)
  assert.equal(names.length, 10)
  for (const name of names) assert.equal((await fs.lstat(join(directory, name))).isSymbolicLink(), false)
  for (const name of ['pin', 'region', 'recorder']) {
    const html = await fs.readFile(join(directory, `${name}.html`), 'utf8')
    assert.match(html, new RegExp(`src="${name}\\.js"`))
    assert.match(html, new RegExp(`href="${name}\\.css"`))
  }
  await fs.cp(join(root, 'public'), join(root, 'dist'), { recursive: true })
  assert.equal(await fs.readFile(join(root, 'dist', PREFIX, 'recorder.js'), 'utf8'), await fs.readFile(join(directory, 'recorder.js'), 'utf8'))
  if (process.platform !== 'win32') {
    const other = await fs.mkdtemp(join(tmpdir(), 'enest-surface-symlink-fixture-'))
    t.after(() => fs.rm(other, { recursive: true, force: true }))
    await fs.symlink(root, join(other, 'public'))
    await assert.rejects(prepareNativeSurfaceAssets(other), /real directories/)
  }
})

test('all four consumers declare and build the private adapter; host no longer owns selection/recording/pin UI', () => {
  for (const name of ['screen-assistant', 'color-picker', 'image-tools', 'remote-desktop']) {
    const base = new URL(`../plugins/${name}/`, import.meta.url)
    const pkg = JSON.parse(readFileSync(new URL('package.json', base), 'utf8')), manifest = JSON.parse(readFileSync(new URL('plugin.json', base), 'utf8'))
    assert.equal(pkg.dependencies['@enest/native-surfaces'], '1.0.0')
    assert.equal(pkg.version, manifest.version); assert.equal(manifest.engines.enest, '>=0.2.3')
    assert.match(readFileSync(new URL('vite.config.js', base), 'utf8'), /nativeSurfacesAssets\(\)/)
    assert.match(readFileSync(new URL('src/jsx/App.jsx', base), 'utf8'), /createNativeSurfaces\(window\.enest/)
  }
  const recorder = readFileSync(new URL('../packages/native-surfaces/assets/recorder.js', import.meta.url), 'utf8')
  assert.match(recorder, /startButton\.onclick/); assert.match(recorder, /getDisplayMedia/)
  assert.doesNotMatch(recorder, /executeJavaScript|window\.enest\b|shellApi/)
  const screen = readFileSync(new URL('../../src/main/screen/screenService.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(screen, /MediaRecorder|BrowserWindow|<html|regionSelect|recordSessions/)
})
