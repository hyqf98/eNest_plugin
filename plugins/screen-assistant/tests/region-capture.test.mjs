import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { before, test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'

const bridge = new EventEmitter()
const display = { id: 0, scaleFactor: 2, bounds: { x: -1440, y: 160, width: 1440, height: 900 } }
const bounds = { x: 2800, y: 1700, width: 80, height: 100 }
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8O8AAAAASUVORK5CYII='
let openRegion, openBar, captureStill, sequence = 0

before(async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { enest: bridge } })
  try {
    const surfaces = await import('../src/lib/surfaces.js')
    openRegion = surfaces.openRegion
    openBar = surfaces.openBar
    captureStill = (await import('../src/lib/session.js')).captureStill
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete globalThis.window
  }
})

function fixture({ holdClose = false, holdReady = false } = {}) {
  const windowId = `region-${++sequence}`
  const attached = Promise.withResolvers(), presented = Promise.withResolvers()
  const closing = Promise.withResolvers(), closed = Promise.withResolvers()
  const displays = [display], captures = [], closeCalls = [], presentations = []
  const message = data => bridge.emit('auxiliary.message', { windowId, data })
  let options, live = false, bytes = 0
  const closeNatively = () => {
    if (!live) return false
    live = false
    bridge.emit('auxiliary.closed', { windowId })
    return true
  }
  bridge.auxiliary = {
    async open(input) { options = input; live = true; return { windowId } },
    async send(target, command, update) {
      assert.equal(target, windowId)
      if (command.type === 'attached') {
        assert.notEqual(update?.visible, true)
        attached.resolve(options)
        if (!holdReady) queueMicrotask(() => { if (live) message({ type: 'ready' }) })
      } else if (command.type === 'present') {
        presentations.push(update)
        assert.equal(live, true)
        assert.deepEqual(update, { visible: true, focus: true })
        presented.resolve(options)
      }
    },
    async close(target) {
      assert.equal(target, windowId)
      closeCalls.push(target)
      closing.resolve()
      if (holdClose) await closed.promise
      return closeNatively()
    }
  }
  bridge.screen = {
    async displays() { return displays },
    async capture(input) {
      captures.push(input)
      assert.equal(live, false, 'the selection window must already be gone')
      return { displayId: input.displayId, dataUrl: png, width: 1, height: 1 }
    }
  }
  bridge.files = { stream: {
    async open() { return { streamId: 'image-stream' } },
    async write(_stream, _sequence, chunk) { bytes += chunk.byteLength },
    async finish() { return { id: 'image-file', size: bytes } },
    async abort() {}
  } }
  const library = { async addSaved(item) { return { ...item, id: 'library-image' } } }
  return { attached: attached.promise, presented: presented.promise, closing: closing.promise, releaseClose: closed.resolve, closeNatively,
    displays, captures, closeCalls, presentations, message, library, get options() { return options } }
}

test('opening and cancelling a live selection never request a screenshot or a media stream', async () => {
  for (const reason of ['escape', 'native-close']) {
    const native = fixture()
    const selection = openRegion({ display, withAudio: true })
    const options = await native.presented
    assert.equal(options.displayId, display.id)
    assert.equal(options.placement, 'display')
    assert.equal(options.transparent, true)
    assert.equal(options.visible, false)
    assert.equal(options.capture, undefined)
    assert.equal(options.data.shot, undefined)
    assert.equal(options.data.action, 'image')
    assert.equal(Object.hasOwn(options.data, 'withAudio'), false)
    assert.deepEqual(native.captures, [])
    if (reason === 'escape') native.message({ type: 'cancel' })
    else native.closeNatively()
    assert.equal(await selection, null)
    assert.deepEqual(native.captures, [])
  }
})

test('a selection closed before ready is not presented and its stale messages cannot capture', async () => {
  const native = fixture({ holdReady: true })
  const selection = openRegion({ display })
  const options = await native.attached
  assert.equal(options.visible, false)
  native.message({ type: 'action', action: 'image', bounds })
  native.closeNatively()
  assert.equal(await selection, null)
  native.message({ type: 'ready' })
  await nextTurn()
  assert.deepEqual(native.presentations, [])
  assert.deepEqual(native.captures, [])
})

test('a confirmed still waits for native close and captures only the selected display-local pixels', async () => {
  const native = fixture({ holdClose: true })
  let selected
  const capture = openRegion({ display }).then(result => {
    selected = result
    return captureStill({ display, bounds: result.bounds, library: native.library })
  })
  await native.presented
  native.message({ type: 'action', action: 'image', bounds: { ...bounds, displayId: 999 }, displayId: 999 })
  await native.closing
  await nextTurn()
  assert.equal(selected, undefined)
  assert.deepEqual(native.captures, [])
  native.releaseClose()
  const { item, shotDataUrl } = await capture
  assert.deepEqual(selected, { action: 'image', bounds })
  assert.deepEqual(native.captures, [{ displayId: display.id, bounds }])
  assert.equal(shotDataUrl, png)
  assert.equal(item.fileId, 'image-file')
  assert.equal(item.source, 'capture')
  assert.equal(item.width, 1)
  assert.equal(item.height, 1)
})

test('invalid, fractional, and out-of-display selections close without taking a picture', async () => {
  for (const invalid of [null, { ...bounds, x: -1 }, { ...bounds, y: 1.5 }, { ...bounds, width: 0 }, { ...bounds, height: 101 }]) {
    const native = fixture()
    const rejected = assert.rejects(openRegion({ display }).then(result => captureStill({ display, bounds: result.bounds, library: native.library })), /选区/)
    await native.presented
    native.message({ type: 'action', action: 'image', bounds: invalid })
    await rejected
    assert.equal(native.closeCalls.length, 1)
    assert.deepEqual(native.captures, [])
  }
})

test('disconnecting the selected screen during close never falls back to another monitor', async () => {
  const native = fixture({ holdClose: true })
  const capture = openRegion({ display }).then(result => captureStill({ display, bounds: result.bounds, library: native.library }))
  await native.presented
  native.message({ type: 'action', action: 'image', bounds })
  await native.closing
  native.displays.splice(0, 1, { ...display, id: 9, primary: true })
  const rejected = assert.rejects(capture, /显示器/)
  native.releaseClose()
  await rejected
  assert.deepEqual(native.captures, [])
})

test('recording and longshot return bounds only after the native selection closes once, without taking a still', async () => {
  for (const action of ['record', 'longshot']) {
    const native = fixture({ holdClose: true })
    let returned = false
    const recording = action === 'record'
    const selection = openRegion({ display, prefer: action, withAudio: !recording }).then(result => { returned = true; return result })
    const options = await native.presented
    assert.equal(options.data.action, action)
    assert.equal(Object.hasOwn(options.data, 'withAudio'), recording)
    if (recording) assert.equal(options.data.withAudio, false)
    const confirmed = { action, bounds, ...(recording ? { withAudio: true } : {}) }
    native.message({ type: 'action', ...confirmed })
    native.message({ type: 'action', ...confirmed, ...(recording ? { withAudio: false } : {}) })
    await native.closing
    await nextTurn()
    assert.equal(returned, false)
    assert.deepEqual(native.captures, [])
    native.releaseClose()
    assert.deepEqual(await selection, confirmed)
    assert.equal(native.closeCalls.length, 1)
    assert.deepEqual(native.captures, [])
  }
})

test('selection messages cannot change the requested action or attach audio to a still or longshot', async () => {
  for (const [prefer, payload] of [
    ['image', { action: 'record', withAudio: true }], ['longshot', { action: 'record', withAudio: false }],
    ['image', { action: 'longshot' }], ['record', { action: 'image' }],
    ['image', { action: 'image', withAudio: true }], ['longshot', { action: 'longshot', withAudio: false }],
    ['record', { action: 'record', withAudio: 'true' }]
  ]) {
    const native = fixture()
    const rejected = assert.rejects(openRegion({ display, prefer }), /选区/)
    await native.presented
    native.message({ type: 'action', bounds, ...payload })
    await rejected
    assert.equal(native.closeCalls.length, 1)
    assert.deepEqual(native.captures, [])
  }
})

test('only recording opts into system audio when opening a capture control bar', async () => {
  for (const [mode, withAudio] of [['longshot', true], ['record', false], ['record', true]]) {
    const native = fixture()
    const bar = await openBar({ mode, display, bounds, withAudio })
    const audio = mode === 'record' ? { withAudio } : {}
    assert.deepEqual(native.options.capture, { displayId: display.id, ...audio })
    assert.deepEqual(native.options.data, { mode, bounds, display, ...audio })
    await bar.close()
  }
})
