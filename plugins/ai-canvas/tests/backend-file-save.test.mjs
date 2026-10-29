import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { readFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const entryUrl = new URL('../backend/index.js', import.meta.url)
const source = readFileSync(entryUrl, 'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*(?:\r?\n|$)/gm, '')
const drain = async () => { await new Promise(setImmediate); await new Promise(setImmediate) }
const plain = value => JSON.parse(JSON.stringify(value))
const target = '/virtual-ai-canvas/image.png'

// Real Writable lifecycle; only disk progress and descriptor closure are controlled.
class FileStream extends Writable {
  chunks = []
  writeCallbacks = []
  finalCallback = null
  closeCallback = null
  constructor(holdClose) { super({ autoDestroy: true }); this.holdClose = holdClose }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); this.writeCallbacks.push(callback) }
  _final(callback) { this.finalCallback = callback }
  _destroy(error, callback) {
    this.closeCallback = () => callback(error)
    if (!this.holdClose) this.releaseClose()
  }
  completeWrite(error) {
    const callback = this.writeCallbacks.shift()
    assert.equal(typeof callback, 'function', 'a disk write must be pending')
    callback(error)
  }
  completeEnd(error) {
    const callback = this.finalCallback
    this.finalCallback = null
    assert.equal(typeof callback, 'function', 'stream finalization must be pending')
    callback(error)
  }
  releaseClose() {
    const callback = this.closeCallback
    this.closeCallback = null
    assert.equal(typeof callback, 'function', 'descriptor closure must be pending')
    callback()
  }
}

function fixture(t, options = {}) {
  const port = new EventEmitter(), process = new EventEmitter()
  const messages = [], streams = [], creates = [], exits = [], timers = new Set()
  let sequence = 1000, uuid = 0
  port.postMessage = message => messages.push(plain(message))
  process.parentPort = port
  process.exit = code => exits.push(code)
  const send = data => port.emit('message', { data })
  vm.runInNewContext(source, {
    process, Buffer, once, queueMicrotask, setImmediate, clearImmediate,
    randomUUID: () => `fixture-write-${++uuid}`,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() { return this } }
      timers.add(timer)
      return timer
    },
    clearTimeout: timer => timers.delete(timer),
    createWriteStream: (path, config) => {
      creates.push({ path, config: plain(config) })
      if (options.createError) throw new Error('fixture create failure')
      const stream = new FileStream(options.holdClose)
      streams.push(stream)
      queueMicrotask(() => {
        if (options.openError) stream.destroy(new Error('fixture open failure'))
        else if (!stream.destroyed) stream.emit('open', 42)
      })
      return stream
    },
  }, { filename: fileURLToPath(entryUrl) })
  const replies = id => messages.filter(message => !message.type && message.id === id)
  const call = (method, input) => {
    const id = ++sequence
    send({ id, pluginId: 'com.github.eNest.ai-canvas', method, args: input === undefined ? [] : [input] })
    return id
  }
  const control = method => {
    const request = messages.filter(message => message.type === 'host.request' && message.method === method).at(-1)
    assert.ok(request, `missing host request: ${method}`)
    return request
  }
  const respond = (request, ok, value) => send({ type: 'host.response', id: request.id, ok, ...(ok ? { data: value } : { error: value }) })
  const result = async (id, ok = true, pattern) => {
    await drain()
    const responses = replies(id)
    assert.equal(responses.length, 1, `RPC ${id} must settle exactly once`)
    assert.equal(responses[0].ok, ok, responses[0].error)
    if (!ok) {
      assert.equal(typeof responses[0].error, 'string')
      assert.ok(responses[0].error.length > 0)
      if (pattern) assert.match(responses[0].error, pattern)
    }
    return responses[0].data
  }
  const begin = async () => {
    const id = call('writeBegin', { handleId: 'directory-handle', name: 'image.png' })
    await drain()
    const request = control('files.directoryTarget')
    assert.deepEqual(request.params, { handleId: 'directory-handle', name: 'image.png' })
    respond(request, true, { path: target })
    const data = await result(id)
    assert.equal(typeof data.writeId, 'string')
    assert.equal(data.path, target)
    return { ...data, stream: streams.at(-1) }
  }
  const expire = () => {
    const pending = [...timers]
    assert.ok(pending.length > 0, 'a deadline must be armed')
    for (const timer of pending) { timers.delete(timer); timer.callback() }
  }
  t.after(async () => {
    send({ type: 'shutdown' })
    for (const stream of streams) {
      stream.holdClose = false
      stream.destroy()
      if (stream.closeCallback) stream.releaseClose()
    }
    await drain()
    timers.clear()
  })
  return { messages, streams, creates, exits, timers, send, call, control, respond, replies, result, begin, expire }
}

test('directory picker requests write access and settles success, failure and cancellation only once', async t => {
  const f = fixture(t), first = f.call('pickDirectory')
  await drain()
  const request = f.control('files.pick')
  assert.deepEqual(request.params.options, { kind: 'directory', multiple: false, access: 'write' })
  f.respond(request, true, [{ id: 'directory-handle', displayPath: '/virtual-ai-canvas' }])
  assert.deepEqual(await f.result(first), { handleId: 'directory-handle', displayPath: '/virtual-ai-canvas' })
  assert.equal(f.timers.size, 0)

  const second = f.call('pickDirectory')
  await drain()
  const denied = f.control('files.pick')
  f.respond(request, false, 'duplicate response')
  f.respond({ id: 999999 }, true, [])
  await drain()
  assert.equal(f.replies(second).length, 0, 'stale or unknown responses cannot settle another request')
  f.respond(denied, false, 'fixture permission denied')
  await f.result(second, false, /fixture permission denied/)
  f.respond(denied, true, [{ id: 'late-handle' }])
  await drain()
  assert.equal(f.replies(first).length, 1)
  assert.equal(f.replies(second).length, 1)
  assert.equal(f.timers.size, 0)

  const cancelled = f.call('pickDirectory')
  await drain()
  f.respond(f.control('files.pick'), true, [])
  assert.equal(await f.result(cancelled), null)
})

test('expired directory authorization rejects and its late success cannot create a file', async t => {
  const f = fixture(t), id = f.call('writeBegin', { handleId: 'directory-handle', name: 'image.png' })
  await drain()
  const request = f.control('files.directoryTarget')
  f.expire()
  await f.result(id, false, /timed out/)
  f.respond(request, true, target)
  await drain()
  assert.equal(f.creates.length, 0)
  assert.equal(f.replies(id).length, 1)
})

test('chunks wait for disk callbacks and successful end waits for descriptor closure', async t => {
  const f = fixture(t, { holdClose: true }), { writeId, stream } = await f.begin()
  assert.deepEqual(f.creates, [{ path: target, config: { mode: 0o600 } }])
  const chunks = [Buffer.from('first chunk'), Buffer.from([0, 255, 1, 128])]
  for (const bytes of chunks) {
    const id = f.call('writeChunk', { writeId, chunk: bytes.toString('base64') })
    await drain()
    assert.equal(f.replies(id).length, 0, 'accepted bytes are not yet a completed write')
    stream.completeWrite()
    assert.equal(await f.result(id), true)
  }
  assert.deepEqual(Buffer.concat(stream.chunks), Buffer.concat(chunks))
  const end = f.call('writeEnd', { writeId })
  await drain()
  assert.equal(f.replies(end).length, 0)
  stream.completeEnd()
  await drain()
  assert.equal(stream.writableFinished, true)
  assert.equal(stream.closed, false)
  assert.equal(f.replies(end).length, 0, 'finish must not acknowledge an open descriptor')
  stream.releaseClose()
  assert.deepEqual(await f.result(end), { path: target })
  assert.equal(stream.closed, true)
  await f.result(f.call('writeChunk', { writeId, chunk: 'YQ==' }), false)
  await f.result(f.call('writeEnd', { writeId }), false)
})

for (const failure of ['createError', 'openError']) {
  test(`${failure} returns a writeBegin error without terminating the backend`, async t => {
    const f = fixture(t, { [failure]: true })
    const id = f.call('writeBegin', { handleId: 'directory-handle', name: 'image.png' })
    await drain()
    f.respond(f.control('files.directoryTarget'), true, target)
    await f.result(id, false, /fixture (create|open) failure/)
    assert.ok(f.streams.every(stream => stream.destroyed && stream.closed))
    assert.equal(await f.result(f.call('writeAbort', { writeId: 'unknown' })), true)
    assert.deepEqual(f.exits, [])
  })
}

test('an error between open and the first chunk is handled and returned by RPC', async t => {
  const f = fixture(t), { writeId, stream } = await f.begin()
  assert.doesNotThrow(() => stream.emit('error', new Error('fixture early stream failure')))
  await f.result(f.call('writeChunk', { writeId, chunk: 'YQ==' }), false, /fixture early stream failure/)
  assert.equal(await f.result(f.call('writeAbort', { writeId })), true)
  assert.equal(stream.closed, true)
  assert.deepEqual(f.exits, [])
})

test('a disk write callback failure rejects the chunk and retires the failed stream', async t => {
  const f = fixture(t), { writeId, stream } = await f.begin()
  const chunk = f.call('writeChunk', { writeId, chunk: 'YQ==' })
  await drain()
  stream.completeWrite(new Error('fixture disk full'))
  await f.result(chunk, false, /fixture disk full/)
  assert.equal(stream.destroyed, true)
  assert.equal(stream.closed, true)
  await f.result(f.call('writeEnd', { writeId }), false)
  assert.deepEqual(f.exits, [])
})

test('a finalization error rejects writeEnd instead of acknowledging saved output', async t => {
  const f = fixture(t), { writeId, stream } = await f.begin()
  const end = f.call('writeEnd', { writeId })
  await drain()
  stream.completeEnd(new Error('fixture finalization failure'))
  await f.result(end, false, /fixture finalization failure/)
  assert.equal(stream.closed, true)
  assert.deepEqual(f.exits, [])
})

for (const method of ['writeChunk', 'writeEnd']) {
  test(`abort closes an in-flight ${method} without waiting for its disk callback`, async t => {
    const f = fixture(t, { holdClose: true }), { writeId, stream } = await f.begin()
    const pending = f.call(method, { writeId, chunk: 'YQ==' })
    await drain()
    const abort = f.call('writeAbort', { writeId })
    await drain()
    assert.equal(stream.destroyed, true)
    assert.equal(f.replies(abort).length, 0, 'abort must wait for descriptor closure')
    stream.releaseClose()
    assert.equal(await f.result(abort), true)
    await f.result(pending, false)
    if (method === 'writeChunk') stream.completeWrite()
    else stream.completeEnd()
    await drain()
    assert.equal(f.replies(pending).length, 1, 'a late disk callback cannot change the RPC outcome')
    assert.equal(await f.result(f.call('writeAbort', { writeId })), true)
  })
}

test('shutdown retires pending controls and writes; late authorization cannot create files', async t => {
  const f = fixture(t, { holdClose: true }), first = await f.begin(), second = await f.begin()
  const chunk = f.call('writeChunk', { writeId: first.writeId, chunk: 'YQ==' })
  const end = f.call('writeEnd', { writeId: second.writeId })
  const picker = f.call('pickDirectory')
  const begin = f.call('writeBegin', { handleId: 'directory-handle', name: 'late.png' })
  await drain()
  const pickerRequest = f.control('files.pick'), targetRequest = f.control('files.directoryTarget')
  f.send({ type: 'shutdown', reason: 'fixture cleanup', deadlineAt: Date.now() + 500 })
  await drain()
  assert.ok(f.streams.every(stream => stream.destroyed && !stream.closed))
  assert.equal(f.messages.filter(message => message.type === 'shutdown.complete').length, 0)
  assert.deepEqual(f.exits, [])
  for (const stream of f.streams) stream.releaseClose()
  await drain()
  assert.deepEqual(f.messages.filter(message => message.type === 'shutdown.complete'), [{ type: 'shutdown.complete', ok: true }])
  assert.deepEqual(f.exits, [0])
  assert.equal(f.timers.size, 0)
  f.respond(targetRequest, true, '/virtual-ai-canvas/late.png')
  f.respond(pickerRequest, true, [{ id: 'late-handle' }])
  f.call('writeBegin', { handleId: 'late-handle', name: 'ignored.png' })
  f.send({ type: 'shutdown' })
  first.stream.completeWrite()
  second.stream.completeEnd()
  await drain()
  assert.equal(f.creates.length, 2)
  for (const id of [chunk, end, picker, begin]) assert.ok(f.replies(id).every(reply => reply.ok === false))
  assert.equal(f.messages.filter(message => message.type === 'shutdown.complete').length, 1)
  assert.deepEqual(f.exits, [0])
})

test('shutdown observes its deadline if a descriptor never reports close', async t => {
  const f = fixture(t, { holdClose: true })
  await f.begin()
  f.send({ type: 'shutdown', deadlineAt: Date.now() + 500 })
  await drain()
  f.expire()
  await drain()
  const ack = f.messages.find(message => message.type === 'shutdown.complete')
  assert.equal(ack?.ok, false)
  assert.equal(typeof ack.error, 'string')
  assert.deepEqual(f.exits, [1])
  assert.equal(f.timers.size, 0)
})

test('shutdown fences authorization already resolved before its continuation resumes', async t => {
  const f = fixture(t)
  const begin = f.call('writeBegin', { handleId: 'directory-handle', name: 'image.png' })
  await drain()
  f.respond(f.control('files.directoryTarget'), true, target)
  f.send({ type: 'shutdown' })
  await drain()
  assert.equal(f.creates.length, 0)
  assert.ok(f.replies(begin).every(reply => reply.ok === false))
  assert.deepEqual(f.exits, [0])
  assert.equal(f.timers.size, 0)
})
