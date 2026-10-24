import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createDatabaseApi } from '../src/js/backend-api.mjs'

const backendRoot = new URL('./', import.meta.url).pathname
const facadeBundle = await build({ entryPoints: [backendRoot + 'facade.ts'], bundle: true, write: false,
  platform: 'node', format: 'cjs', target: 'node22', alias: { '@backend': backendRoot }, logLevel: 'silent' })
const exports = {}
const module = { exports }
vm.runInNewContext(facadeBundle.outputFiles[0].text, { exports, module, require: createRequire(import.meta.url) })
const { createDatabaseFacade, workbenchPermission } = module.exports
const owner = 'com.github.eNest.database'

function fixture(options = {}) {
  const controls = [], calls = [], activities = new Set(), sessions = new Map()
  let active = true
  const service = {
    dbOpen: async (pluginId, input) => {
      const config = input.config || input, session = { sessionKey: input.sessionKey || 'session', driver: config.driver, transactionActive: false }
      calls.push({ method: 'dbOpen', pluginId, input }); sessions.set(session.sessionKey, session); return session
    },
    dbTest: async (pluginId, config) => { calls.push({ method: 'dbTest', pluginId, config }); return { ok: true } },
    dbClose: async (pluginId, key) => { calls.push({ method: 'dbClose', pluginId, key }); sessions.delete(key); return true },
    dbListSessions: () => [...sessions.values()],
    dbExecute: async (pluginId, input) => { calls.push({ method: 'dbExecute', pluginId, input }); return { transactionActive: true } },
    dbCancel: async (pluginId, input) => { calls.push({ method: 'dbCancel', pluginId, input }); sessions.delete(input.sessionKey || input); return true },
    dbImportPreview: async (pluginId, input) => { calls.push({ method: 'dbImportPreview', pluginId, input }); return { rows: [] } },
    dbImportRun: async (pluginId, input) => { calls.push({ method: 'dbImportRun', pluginId, input }); return { imported: 1 } },
    dbDialectsList: () => [{ id: 'fixture' }],
    dbWorkbenchService: async (pluginId, input) => { calls.push({ method: 'workbench', pluginId, input }); return { active: true } },
    releaseDbSessions: async () => { calls.push({ method: 'releaseDbSessions' }); sessions.clear() },
    ...options.service
  }
  const host = { pluginId: owner, assertCurrent() { if (!active) throw new Error('fixture incarnation retired') },
    async request(method, params) {
      controls.push({ method, params: structuredClone(params) })
      await options.beforeControl?.(method, params)
      if (method === 'permission.authorize') { if (options.denied === params.permission) throw new Error('permission denied'); return true }
      if (method === 'secret.resolve') return 'private-fixture-password'
      if (method === 'files.resolve') return `/selected/${params.handleId}`
      if (method === 'files.pick') return [{ id: 'selected', name: 'fixture.sqlite', kind: 'file' }]
      if (method === 'files.save') return { id: 'saved', name: 'database.sqlite', kind: 'file' }
      if (method === 'activity.acquire') { activities.add(params.token); return }
      if (method === 'activity.release') { activities.delete(params.token); return }
      throw new Error('unexpected capability')
    }
  }
  return { facade: createDatabaseFacade(host, service), controls, calls, activities, sessions,
    retire() { active = false }, service }
}

async function until(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await delay(5) }
  assert.fail('fixture did not complete')
}

test('database distribution owns its adapter and requires the generic backend API version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '1.4.0')
  assert.equal(manifest.engines.enest, '>=0.2.2')
  assert.ok(manifest.permissions.includes('backend.node'))
  const source = await readFile(new URL('./facade.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"](?:electron|@main\/|@shared\/)/)
})

test('credentials resolve only in the plugin backend and selected local databases preserve read/write grants', async () => {
  const f = fixture()
  const result = await f.facade.call('db.open', [{ config: { driver: 'sqlite', secretRef: 'vault-ref', fileHandleId: 'fixture.sqlite', readOnly: true } }])
  assert.equal(result.sessionKey, 'session')
  assert.equal(f.calls[0].input.config.ephemeralSecret, 'private-fixture-password')
  assert.equal(f.calls[0].input.config.secretRef, undefined)
  assert.equal(f.calls[0].input.config.filePath, '/selected/fixture.sqlite')
  assert.equal(JSON.stringify(result).includes('password'), false)
  assert.deepEqual(f.controls.find(control => control.method === 'files.resolve').params, { handleId: 'fixture.sqlite', access: 'read' })
  assert.equal(f.activities.size, 1)
  await f.facade.call('db.execute', [{ sessionKey: 'session', sql: 'fixture transaction' }])
  assert.equal(f.activities.size, 1, 'the connection lease covers an active transaction')
  await f.facade.shutdown()
  assert.equal(f.sessions.size, 0)
  assert.equal(f.activities.size, 0)
})

test('raw database/import paths and unknown actions are rejected by plugin policy', async () => {
  const f = fixture()
  for (const config of [
    { driver: 'sqlite', filePath: '/etc/passwd' },
    { driver: 'duckdb', sqlitePath: '/etc/passwd' },
    { driver: 'sqlite', options: { file: '/etc/passwd' } },
    { driver: 'sqlite', options: { filePath: '/etc/passwd' } },
    { driver: 'sqlite' }
  ]) await assert.rejects(f.facade.call('db.open', [config]), /raw database paths|fileHandleId/)
  await assert.rejects(f.facade.call('db.importPreview', [{ filePath: '/etc/passwd' }]), /raw import paths/)
  await assert.rejects(f.facade.call('db.workbench', [{ action: 'system.exec', input: {} }]), /Unknown database/)
  await assert.rejects(f.facade.call('releaseDbSessions', []), /unknown database method/)
  assert.equal(f.calls.length, 0)
})

test('permission denial does not invoke drivers or resolve secrets', async () => {
  const f = fixture({ denied: 'db.connect' })
  await assert.rejects(f.facade.call('db.open', [{ driver: 'mysql', secretRef: 'denied' }]), /permission denied/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.controls.some(control => control.method === 'secret.resolve'), false)
  assert.equal(workbenchPermission('drivers.list'), null)
  assert.equal(workbenchPermission('table.design.preview'), 'db.schema')
  assert.equal(workbenchPermission('table.design.apply'), 'db.query')
})

test('workbench test uses the same private secret and local-file resolution as ordinary test', async () => {
  const f = fixture()
  await f.facade.call('db.workbench', [{ action: 'test', input: { driver: 'duckdb', fileHandleId: 'fixture.duckdb', secretRef: 'private' } }])
  assert.equal(f.calls[0].method, 'dbTest')
  assert.equal(f.calls[0].config.filePath, '/selected/fixture.duckdb')
  assert.equal(f.calls[0].config.ephemeralSecret, 'private-fixture-password')
  assert.deepEqual(f.controls.find(control => control.method === 'files.resolve').params, { handleId: 'fixture.duckdb', access: 'write' })
  await f.facade.call('db.test', [{ driver: 'sqlite', database: ':memory:' }])
  assert.equal(f.calls[1].config.filePath, ':memory:')
})

test('import and picker policy use only generic host capabilities', async () => {
  const f = fixture()
  await f.facade.call('db.importPreview', [{ fileHandleId: 'data.csv' }])
  assert.equal(f.calls[0].input.filePath, '/selected/data.csv')
  assert.equal((await f.facade.call('db.pickSqliteFile', [{ readOnly: true }])).id, 'selected')
  assert.equal((await f.facade.call('db.pickSqliteFile', [{ createIfMissing: true }])).id, 'saved')
  assert.equal((await f.facade.call('db.pickImportFile', [])).id, 'selected')
  assert.deepEqual(f.controls.filter(control => control.method === 'files.pick').map(control => control.params.options.access), ['read', 'read'])
})

test('a late close cannot release a replacement connection lease', async () => {
  let finishClose, closeStarted
  const ready = new Promise(resolve => { closeStarted = resolve })
  const held = new Promise(resolve => { finishClose = resolve })
  const f = fixture()
  await f.facade.call('db.open', [{ sessionKey: 'same-key', config: { driver: 'mysql' } }])
  f.service.dbClose = async (_owner, key) => { f.sessions.delete(key); closeStarted(); await held; return true }
  const pending = f.facade.call('db.close', ['same-key'])
  await ready
  await f.facade.call('db.open', [{ sessionKey: 'same-key', config: { driver: 'mysql' } }])
  finishClose(); await pending
  assert.equal(f.activities.size, 1)
  assert.equal(f.sessions.size, 1)
  await f.facade.shutdown()
  assert.equal(f.activities.size, 0)
})

test('cancellation/list reconciliation releases only sessions that actually disappeared', async () => {
  const f = fixture()
  await f.facade.call('db.open', [{ config: { driver: 'mysql' } }])
  await f.facade.call('db.cancel', [{ sessionKey: 'session' }])
  assert.equal(f.activities.size, 0)
  await f.facade.call('db.open', [{ config: { driver: 'mysql' } }])
  f.sessions.clear()
  assert.equal((await f.facade.call('db.listSessions', [])).length, 0)
  assert.equal(f.activities.size, 0)
})

test('retirement while awaiting a secret prevents any driver call', async () => {
  let resume, began
  const entered = new Promise(resolve => { began = resolve })
  const held = new Promise(resolve => { resume = resolve })
  const f = fixture({ beforeControl: async method => { if (method === 'secret.resolve') { began(); await held } } })
  const pending = f.facade.call('db.open', [{ driver: 'mysql', secretRef: 'ref' }])
  await entered; f.retire(); resume()
  await assert.rejects(pending, /retired/)
  assert.equal(f.calls.length, 0)
})

test('failing an activity grant closes the new driver and releases its token', async () => {
  const f = fixture({ beforeControl: method => { if (method === 'activity.acquire') throw new Error('activity quota') } })
  await assert.rejects(f.facade.call('db.open', [{ driver: 'mysql' }]), /activity quota/)
  assert.equal(f.sessions.size, 0)
  assert.equal(f.activities.size, 0)
  assert.ok(f.calls.some(call => call.method === 'dbClose'))
})

test('renderer adapter preserves a frozen host API, moves deadlines after consent, and stops blocked cancellation', async () => {
  const calls = [], sentinel = { ui: true }
  let stops = 0, timedOut = false
  const host = Object.freeze({ ui: sentinel, backend: Object.freeze({
    call: async (method, args, options) => {
      calls.push({ method, args, options })
      if (timedOut && method !== 'db.authorize') throw new Error('plugin backend request timed out')
      return true
    }, stop: async () => { stops++; return true }
  }) })
  const api = createDatabaseApi(host)
  assert.equal(host.db, undefined)
  assert.equal(api.ui, sentinel)
  await api.db.execute({ timeoutMs: 120_000, sessionKey: 'test' })
  assert.equal(calls[0].method, 'db.authorize')
  assert.equal(calls[0].options.timeoutMs, 86_400_000)
  assert.equal(calls[1].options.timeoutMs, 120_500)
  calls.length = 0; timedOut = true
  await assert.rejects(api.db.workbench({ action: 'cancel', input: { sessionKey: 'test' } }), /timed out/)
  assert.equal(calls.length, 1, 'cancel must not wait on a blocked backend authorization preflight')
  assert.equal(calls[0].options.timeoutMs, 250)
  assert.equal(stops, 1)
  assert.equal(api.db.completion.suggest, api.db.completion)
})

test('native entry uses initialized owner identity, generational shutdown, bounded results and generic capabilities', async () => {
  const mock = fixture(), messages = [], port = new EventEmitter(), fakeProcess = new EventEmitter()
  let exitCode
  fakeProcess.env = {}; fakeProcess.parentPort = port; fakeProcess.exit = code => { exitCode = code }
  const methodNames = Object.keys(mock.service)
  const nativeBundle = await build({ entryPoints: [backendRoot + 'index.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', target: 'node22', alias: { '@backend': backendRoot }, logLevel: 'silent',
    plugins: [{ name: 'mock-native-database', setup(builder) {
      builder.onResolve({ filter: /^@backend\/(dbService|workbenchService)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('workbenchService')
        ? 'export const dbWorkbenchService = (...args) => globalThis.nativeService.dbWorkbenchService(...args)'
        : methodNames.map(name => `export const ${name} = (...args) => globalThis.nativeService.${name}(...args)`).join('\n'), loader: 'js' }))
    } }] })
  port.postMessage = message => {
    messages.push(message)
    if (message.type !== 'host.request') return
    let data
    if (message.method === 'permission.authorize') data = true
    if (message.method === 'secret.resolve') data = 'fixture-secret'
    if (message.method === 'activity.acquire') mock.activities.add(message.params.token)
    if (message.method === 'activity.release') mock.activities.delete(message.params.token)
    queueMicrotask(() => port.emit('message', { data: { type: 'host.response', id: message.id, ok: true, data } }))
  }
  vm.runInNewContext(nativeBundle.outputFiles[0].text, { require: createRequire(import.meta.url), process: fakeProcess,
    Buffer, setTimeout, clearTimeout, nativeService: mock.service })
  const send = data => port.emit('message', { data })
  const rpc = async (id, method, args, pluginId = owner) => {
    send({ id, method, args, pluginId })
    await until(() => messages.some(message => !message.type && message.id === id))
    return messages.find(message => !message.type && message.id === id)
  }
  assert.match((await rpc(1, 'db.dialects.list', [])).error, /uninitialized/)
  send({ type: 'init', pluginId: owner, generation: 3, wcId: 7, context: { protocolVersion: 1 } })
  assert.match((await rpc(2, 'db.dialects.list', [], 'wrong-plugin')).error, /owner/)
  assert.equal((await rpc(3, 'db.open', [{ driver: 'mysql', secretRef: 'fixture' }])).ok, true)
  assert.equal(mock.activities.size, 1)
  assert.equal(messages.filter(message => !message.type && message.id === 3).some(message => JSON.stringify(message).includes('fixture-secret')), false)
  mock.service.dbDialectsList = () => 'x'.repeat(8 * 1024 * 1024 + 1)
  assert.match((await rpc(4, 'db.dialects.list', [])).error, /8 MiB/)
  send({ type: 'shutdown' })
  await until(() => exitCode === 0)
  assert.equal(messages.find(message => message.type === 'shutdown.complete').ok, true)
  assert.equal(mock.activities.size, 0)
  assert.equal(mock.sessions.size, 0)
  const previousResponses = messages.filter(message => !message.type).length
  send({ id: 5, method: 'db.open', args: [{ driver: 'mysql' }], pluginId: owner })
  await delay(10)
  assert.equal(messages.filter(message => !message.type).length, previousResponses)
})
