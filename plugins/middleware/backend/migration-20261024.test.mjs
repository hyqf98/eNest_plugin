import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('.', import.meta.url))
const compiled = await build({ entryPoints: [root + 'worker.ts'], bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: root + 'tsconfig.json', logLevel: 'silent' })
const { createMiddlewareBackend } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
const policy = await build({ entryPoints: [root + 'workbench.ts'], bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: root + 'tsconfig.json', logLevel: 'silent' })
const { mwWorkbenchPermission } = await import('data:text/javascript;base64,' + Buffer.from(policy.outputFiles[0].text).toString('base64'))
const OWNER = 'com.github.eNest.middleware'
const DEFER = Symbol('defer')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const proxy = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].map(key => [key, process.env[key]]))

class Port extends EventEmitter {
  messages = []
  waiters = new Map()
  sequence = 0
  control = request => request.method === 'permission.authorize' ? true : request.method === 'secret.resolve' ? `fixture-${request.params.ref}` : undefined
  postMessage(message) {
    this.messages.push(message)
    if (message.type === 'host.request') {
      let result
      try { result = this.control(message) } catch (error) { queueMicrotask(() => this.respond(message.id, false, error.message)); return }
      if (result !== DEFER) queueMicrotask(() => this.respond(message.id, true, result))
    } else if (this.waiters.has(message.id)) {
      const waiter = this.waiters.get(message.id)
      this.waiters.delete(message.id)
      if (message.ok) waiter.resolve(message.data)
      else waiter.reject(new Error(message.error))
    }
  }
  respond(id, ok, value) { this.emit('message', { data: { type: 'host.response', id, ok, ...(ok ? { data: value } : { error: value }) } }) }
  call(action, input = {}, extra = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject })
      this.emit('message', { data: { id, pluginId: OWNER, method: 'workbench', args: [{ action, input }], proxy, ...extra } })
    })
  }
  exit() { for (const waiter of this.waiters.values()) waiter.reject(new Error('fixture backend exited')); this.waiters.clear() }
}
function fixture(t, { initialize = true } = {}) {
  const port = new Port(), operations = [], contexts = [], sinks = [], handles = []
  const driver = {
    kind: 'kafka', label: 'Mock middleware', transport: 'native', capabilities: {}, messageQueryModes: ['offset'],
    async test(config, password) { operations.push({ op: 'test', config, password }); return { ok: true, message: 'fixture', latencyMs: 0 } },
    async open(config, password, context) {
      operations.push({ op: 'open', config, password }); contexts.push(context)
      const handle = { kind: config.kind, config, readOnly: false, capabilities: {}, raw: null }
      handles.push(handle)
      return handle
    },
    async close(handle) { operations.push({ op: 'close', alreadyClosed: !!handle.closed }); handle.closed = true },
    async overview() { operations.push({ op: 'overview' }); return { kind: 'kafka', brokers: [] } },
    async topicDelete() { operations.push({ op: 'delete' }) },
    async tailStart(_handle, _input, sink) {
      sinks.push(sink)
      return { stop: async () => { operations.push({ op: 'tail.stop' }) } }
    }
  }
  const backend = createMiddlewareBackend({ port, getDriver: () => driver, descriptors: () => [{ kind: 'kafka' }], onShutdown: () => port.exit() })
  t.after(async () => { await backend.shutdown(); for (const [key, value] of Object.entries(proxy)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const init = { type: 'init', pluginId: OWNER, generation: 2, wcId: 8, context: { protocolVersion: 1, appDataPath: root, packagePath: root, appExecPath: process.execPath } }
  if (initialize) port.emit('message', { data: init })
  return { port, driver, operations, contexts, sinks, handles, backend, init }
}
const open = (f, input = {}) => f.port.call('session.open', { sessionKey: 'mw:fixture', config: { kind: 'kafka', ...input } })
const controls = (f, method) => f.port.messages.filter(message => message.method === method)

test('connection/query/admin permission mapping is private and rejects unknown actions', () => {
  for (const action of ['kinds.list', 'test', 'session.open', 'session.close', 'session.list']) assert.equal(mwWorkbenchPermission(action), 'mw.connect')
  for (const action of ['overview', 'messages.query', 'tail.start', 'tail.stop', 'configs.describe']) assert.equal(mwWorkbenchPermission(action), 'mw.query')
  for (const action of ['topic.delete', 'topic.purge', 'messages.send', 'configs.alter']) assert.equal(mwWorkbenchPermission(action), 'mw.admin')
  assert.throws(() => mwWorkbenchPermission('arbitrary'), /Unknown/)
})

test('protocol v1 initialization is mandatory, single-use and bound to the runtime owner', async t => {
  const f = fixture(t, { initialize: false })
  await assert.rejects(f.port.call('kinds.list'), /initialized/)
  f.port.emit('message', { data: f.init })
  await assert.rejects(f.port.call('kinds.list', {}, { pluginId: 'other' }), /owner/)
  await assert.rejects(f.port.call('kinds.list', {}, { method: 'mwWorkbenchService' }), /Invalid/)
  f.port.emit('message', { data: f.init })
  await f.backend.shutdown()
  assert.equal(f.backend.state.closed, true)
  assert.equal(f.operations.length, 0)
  const bad = fixture(t, { initialize: false })
  bad.port.emit('message', { data: { ...bad.init, context: { ...bad.init.context, protocolVersion: 0 } } })
  await bad.backend.shutdown()
  assert.equal(bad.backend.state.initialized, false)
})

test('denied/failed domain authorization cannot resolve credentials or contact a driver', async t => {
  const f = fixture(t)
  f.port.control = () => false
  await assert.rejects(open(f, { secretRef: 'private' }), /permission denied/)
  f.port.control = () => { throw new Error('permission denied: fixture') }
  await assert.rejects(f.port.call('test', { config: { kind: 'kafka' } }), /permission denied/)
  assert.equal(controls(f, 'secret.resolve').length, 0)
  assert.equal(controls(f, 'activity.acquire').length, 0)
  assert.equal(f.operations.length, 0)
})

test('both connection and EMQX refs resolve inside the backend and never return as plaintext', async t => {
  const f = fixture(t)
  const info = await open(f, { kind: 'mqtt', secretRef: 'broker', emqx: { enabled: true, version: 'auto', apiSecretRef: 'emqx' } })
  const opening = f.operations.find(item => item.op === 'open')
  assert.equal(opening.password, 'fixture-broker')
  assert.equal(opening.config.secretRef, undefined)
  assert.equal(opening.config.emqx.apiSecretRef, undefined)
  assert.equal(opening.config.emqx.ephemeralSecret, 'fixture-emqx')
  assert.ok(!JSON.stringify(info).includes('fixture-broker'))
  assert.deepEqual(controls(f, 'secret.resolve').map(item => item.params.ref), ['broker', 'emqx'])
  assert.equal(controls(f, 'activity.acquire').length, 1)
  await f.port.call('session.close', { sessionKey: 'mw:fixture' })
  assert.equal(controls(f, 'activity.release').length, 1)
  assert.equal(f.operations.find(item => item.op === 'close').alreadyClosed, false)
  await f.port.call('test', { config: { kind: 'kafka', ephemeralSecret: 'temporary-fixture', secretRef: 'unused' } })
  assert.equal(controls(f, 'secret.resolve').length, 2)
  assert.equal(f.operations.find(item => item.op === 'test').password, 'temporary-fixture')
})

test('missing secret fails closed, while read-only policy rejects writes after authorization', async t => {
  const f = fixture(t)
  f.port.control = request => request.method === 'permission.authorize' ? true : undefined
  await assert.rejects(open(f, { secretRef: 'missing' }), /credential is missing/)
  assert.equal(f.operations.length, 0)
  const info = await open(f, { readOnly: true })
  const listed = await f.port.call('session.list')
  assert.equal(listed[0].connectedAt, info.connectedAt)
  await f.port.call('overview', { sessionKey: 'mw:fixture' })
  await assert.rejects(f.port.call('topic.delete', { sessionKey: 'mw:fixture', name: 'fixture' }), /Read-only/)
  assert.equal(f.operations.some(item => item.op === 'delete'), false)
  assert.ok(controls(f, 'permission.authorize').some(item => item.params.permission === 'mw.admin'))
})

test('tails use generic event envelopes and close waits for real driver cleanup before release', async t => {
  const f = fixture(t)
  await open(f)
  await f.port.call('tail.start', { sessionKey: 'mw:fixture', tailId: 'tail', topic: 'fixture' })
  f.sinks[0]({ topic: 'fixture', value: 'message' })
  const event = f.port.messages.find(item => item.event === 'mw.data')
  assert.deepEqual(event.data, { sessionKey: 'mw:fixture', tailId: 'tail', message: { topic: 'fixture', value: 'message' } })
  assert.equal(event.payload, undefined)
  const closing = deferred()
  f.driver.close = async handle => { handle.closed = true; await closing.promise; f.operations.push({ op: 'closed' }) }
  const result = f.port.call('session.close', { sessionKey: 'mw:fixture' })
  await tick()
  assert.equal(controls(f, 'activity.release').length, 0)
  assert.equal(f.operations.filter(item => item.op === 'tail.stop').length, 1)
  const before = f.port.messages.filter(item => item.event).length
  f.sinks[0]({ value: 'late' })
  assert.equal(f.port.messages.filter(item => item.event).length, before)
  closing.resolve()
  assert.equal(await result, true)
  assert.equal(controls(f, 'activity.release').length, 1)
})

test('same-key opening cannot race and late open during shutdown is closed, not registered', async t => {
  const f = fixture(t), gate = deferred()
  f.driver.open = async config => { await gate.promise; return { kind: config.kind, config, capabilities: {}, raw: null, readOnly: false } }
  const first = open(f).catch(error => error)
  await tick()
  await assert.rejects(open(f), /already opening/)
  const shutdown = f.backend.shutdown()
  await tick()
  assert.equal(controls(f, 'activity.release').length, 0)
  gate.resolve()
  await shutdown
  assert.match((await first).message, /exited/)
  assert.equal(f.operations.filter(item => item.op === 'close').length, 1)
  assert.equal(controls(f, 'activity.acquire').length, 1)
  assert.equal(controls(f, 'activity.release').length, 1)
})

test('pending tail startup is stopped exactly once when shutdown interrupts it', async t => {
  const f = fixture(t), gate = deferred()
  await open(f)
  f.driver.tailStart = async () => { await gate.promise; return { stop: async () => { f.operations.push({ op: 'late-tail.stop' }) } } }
  const tail = f.port.call('tail.start', { sessionKey: 'mw:fixture', tailId: 'slow', topic: 'fixture' }).catch(error => error)
  await tick()
  const shutdown = f.backend.shutdown()
  gate.resolve()
  await shutdown
  assert.match((await tail).message, /exited/)
  assert.equal(f.operations.filter(item => item.op === 'late-tail.stop').length, 1)
  assert.equal(controls(f, 'activity.release').length, 1)
})

test('failed cleanup of a late open keeps its lease until host-confirmed process exit', async t => {
  const f = fixture(t), gate = deferred()
  f.driver.open = async config => { await gate.promise; return { kind: config.kind, config, capabilities: {}, raw: null, readOnly: false } }
  f.driver.close = async () => { throw new Error('fixture late close failed') }
  const pending = open(f).catch(error => error)
  await tick()
  const shutdown = f.backend.shutdown()
  gate.resolve()
  await shutdown
  await pending
  assert.equal(controls(f, 'activity.release').length, 0)
  assert.equal(f.port.messages.find(item => item.type === 'shutdown.complete').ok, false)
})

test('MQTT driver waits for the end callback before reporting a closed connection', async t => {
  const previous = globalThis.__enestMqttMigrationMock
  t.after(() => { globalThis.__enestMqttMigrationMock = previous })
  let finish
  const client = new EventEmitter()
  client.end = (_force, _options, callback) => { finish = callback }
  globalThis.__enestMqttMigrationMock = { connect: () => { queueMicrotask(() => client.emit('connect')); return client } }
  const built = await build({ entryPoints: [root + 'drivers/mqtt.ts'], bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: root + 'tsconfig.json', logLevel: 'silent',
    plugins: [{ name: 'mqtt-driver-no-network', setup(builder) {
      builder.onResolve({ filter: /^mqtt$/ }, () => ({ path: 'mqtt', namespace: 'fixture' }))
      builder.onResolve({ filter: /^@backend\/httpRequest$/ }, () => ({ path: 'http', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'mqtt' ? 'export default globalThis.__enestMqttMigrationMock' : 'export async function mwHttpJson(){throw new Error("network forbidden in migration fixture")}', loader: 'js' }))
    } }] })
  const { mqttDriver } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
  const handle = await mqttDriver.open({ kind: 'mqtt', brokerUrl: 'mqtt://fixture.invalid' }, undefined, { signal: new AbortController().signal, emit: () => {} })
  let complete = false
  const closing = mqttDriver.close(handle).then(() => { complete = true })
  await tick()
  assert.equal(complete, false)
  finish()
  await closing
  assert.equal(complete, true)
})

test('request/result budgets and late permission responses cannot start work after shutdown', async t => {
  const f = fixture(t)
  await assert.rejects(f.port.call('test', { padding: 'x'.repeat(4 * 1024 * 1024) }), /Invalid/)
  f.driver.test = async () => ({ data: 'x'.repeat(8 * 1024 * 1024) })
  await assert.rejects(f.port.call('test', { config: { kind: 'kafka' } }), /8 MiB/)
  f.port.control = () => DEFER
  const result = open(f).catch(error => error)
  await tick()
  const request = controls(f, 'permission.authorize').at(-1)
  await f.backend.shutdown()
  f.port.respond(request.id, true, true)
  await tick()
  assert.match((await result).message, /exited/)
  assert.equal(controls(f, 'activity.acquire').length, 0)
})

test('driver close failures report unsuccessful retirement and do not release connection early', async t => {
  const f = fixture(t)
  await open(f)
  f.driver.close = async () => { throw new Error('fixture close failed') }
  const result = f.port.call('session.close', { sessionKey: 'mw:fixture' }).catch(error => error)
  await tick()
  await f.backend.shutdown()
  assert.match((await result).message, /exited/)
  assert.equal(f.port.messages.find(item => item.type === 'shutdown.complete').ok, false)
  assert.equal(controls(f, 'activity.release').length, 0)
})

test('frontend works with frozen host API, bounded timeout options and backend.event unsubscribe', async t => {
  const oldWindow = globalThis.window, oldEnest = globalThis.enest, calls = [], listeners = new Map()
  t.after(() => { globalThis.window = oldWindow; globalThis.enest = oldEnest })
  let removed = 0
  delete globalThis.enest
  globalThis.window = Object.freeze({ enest: Object.freeze({
    backend: Object.freeze({ call: async (...args) => { calls.push(args); return [] } }),
    on: (event, listener) => { listeners.set(event, listener); return () => { removed++; listeners.delete(event) } }
  }) })
  const api = await import(new URL('../src/js/api.js', import.meta.url))
  await api.mw('kinds.list')
  await api.testConnection({ kind: 'kafka' })
  await api.mw('messages.query', { sessionKey: 'fixture' }, { timeoutMs: 90000 })
  assert.deepEqual(calls.map(call => call[2].timeoutMs), [30000, 15000, 90000])
  assert.ok(calls.every(call => call[0] === 'workbench'))
  await assert.rejects(api.mw('kinds.list', {}, { timeoutMs: 249 }), /250ms/)
  const seen = [], off = api.onMwData(data => seen.push(data))
  listeners.get('backend.event')({ event: 'mw.error', data: 'ignore' })
  listeners.get('backend.event')({ event: 'mw.data', data: { value: 'fixture' } })
  assert.deepEqual(seen, [{ value: 'fixture' }]); off(); assert.equal(removed, 1)
})

test('version-gated plugin entry bundles no host facade or production host contracts', async () => {
  const manifest = JSON.parse(readFileSync(root + '../plugin.json', 'utf8'))
  assert.equal(manifest.version, '0.4.0'); assert.equal(manifest.engines.enest, '>=0.2.2')
  assert.ok(manifest.permissions.includes('backend.node'))
  const entry = await build({ entryPoints: [root + 'index.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', tsconfig: root + 'tsconfig.json', external: ['amqplib', 'kafkajs', 'mqtt'], metafile: true, logLevel: 'silent' })
  assert.ok(Object.keys(entry.metafile.inputs).every(path => !path.includes('src/main/') && !path.includes('src/shared/')))
  const frontend = readFileSync(root + '../src/js/api.js', 'utf8')
  assert.doesNotMatch(frontend, /host\(\)\?\.mw|runtime\.workbench|enest\.mw/)
})
