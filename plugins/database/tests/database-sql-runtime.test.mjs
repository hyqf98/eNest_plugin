import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
const { CompletionRuntime, engineRequest } = await import('@db/sql-intelligence/index.js')
const { sessionEffects } = await import('@db/sql-intelligence/runtime/sessionEffects.js')
const { completionDialect, createCompletionConsoleLifecycle } = await import('@db/sql-intelligence/runtime/consoleLifecycle.js')
const { buildCompletion } = await import('@db/sql-intelligence/completionEngine.js')

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const scope = changes => ({ connectionId: 'a', consoleId: 'console-a', sessionKey: 'user-query-session', documentId: 'doc-a', generation: 1, surface: 'shell', database: 'app', schema: 'public', dialect: 'postgres', connected: true, contextKnown: true, connection: { id: 'a', driver: 'postgres', secretRef: 'vault-only', password: 'never-in-worker', options: { token: 'private-option' } }, ...changes })
function runtime(overrides = {}) {
  const calls = { worker: [], open: [], close: [], describe: [], tables: [] }
  const options = {
    getScope: () => scope(),
    open: async request => { calls.open.push(request); return { sessionKey: request.sessionKey } },
    close: async key => { calls.close.push(key) },
    listTables: async request => { calls.tables.push(request); return [{ name: 'orders', columns: [{ name: 'permanent_id' }] }] },
    describeTable: async request => { calls.describe.push(request); return { columns: [{ name: 'lazy_field' }] } },
    engineClient: { run: async (method, request, options) => { calls.worker.push({ method, request, options }); return { items: [{ label: 'safe' }], requiredTables: [] } }, dispose() {} },
    ...overrides
  }
  return { service: new CompletionRuntime(options), calls, options }
}
const temporary = (service, target = scope()) => service.catalog(target).tables.filter(table => table.temporary)

test('acceptance validates only relevant metadata, with no network or global revision dependency', async () => {
  const { service, calls } = runtime({ engineClient: { run: async (_method, request, options) => buildCompletion(request, options), dispose() {} } })
  const target = scope({ sql: 'SELECT o.* FROM orders o', cursor: 10, modelVersion: 4 })
  const result = await service.complete(target, { waitForMetadata: true })
  const item = result.items.find(item => item.source === 'projection')
  assert.ok(item?._completionTicket)
  const callCount = JSON.stringify(calls)
  assert.equal(service.validateItem(item, target, { modelVersion: 4 }), true)
  assert.equal(service.validateItem(item, target, { modelVersion: 5 }), false)
  assert.equal(service.validateItem(item, target), false)
  assert.equal(JSON.stringify(calls), callCount)
  service.metadata.publishTable(target, { name: 'unrelated' }, { columns: [{ name: 'new_field' }] })
  assert.equal(service.validateItem(item, target, { modelVersion: 4 }), true)
  await service.invalidate({ connectionId: 'other-connection' }, 'other connection refresh')
  assert.equal(service.validateItem(item, target, { modelVersion: 4 }), true)
  service.metadata.publishTable(target, { name: 'orders' }, { columns: [{ name: 'changed_field' }] })
  assert.equal(service.validateItem(item, target, { modelVersion: 4 }), false)
  await service.dispose()
})

test('acceptance retires a candidate after refresh, DDL, settings, target or TTL changes', async () => {
  let now = 0
  const { service } = runtime({ now: () => now, engineClient: { run: async (_method, request, options) => buildCompletion(request, options), dispose() {} } })
  const target = scope({ sql: 'SELECT o.* FROM orders o', cursor: 10, modelVersion: 1 })
  const rawConfig = { metadata: { ttlMs: 1000 } }
  const options = { waitForMetadata: true, rawConfig }
  const read = async () => (await service.complete(target, options)).items.find(item => item.source === 'projection')
  const valid = (item, changes = {}, config = rawConfig) => service.validateItem(item, scope({ ...target, ...changes }), { modelVersion: 1, rawConfig: config })
  let item = await read()
  for (const changes of [{ connected: false }, { contextKnown: false }, { documentId: 'new-document' }, { generation: 2 }, { database: 'another' }]) assert.equal(valid(item, changes), false)
  assert.equal(valid(item, {}, { ...rawConfig, behavior: { keywordCase: 'lower' } }), false)
  now = 1001
  assert.equal(valid(item), false)
  item = await read()
  assert.equal(valid(item), true)
  await service.invalidate({ connectionId: 'a', preserveSession: true }, 'tree refresh')
  assert.equal(valid(item), false)
  item = await read()
  await service.record(scope({ consoleId: 'other-console' }), { sql: 'ALTER TABLE orders ADD changed INT', success: true })
  assert.equal(valid(item), false)
  await service.dispose()
})

test('new same-name objects retire structural rewrites, while object acceptance ignores lazy fields', async () => {
  const { service } = runtime({ engineClient: { run: async (_method, request, options) => buildCompletion(request, options), dispose() {} } })
  const target = scope({ sql: 'SELECT o.* FROM orders o', cursor: 10 })
  const projection = (await service.complete(target, { waitForMetadata: true })).items.find(item => item.source === 'projection')
  service.metadata.publishTable(target, { name: 'orders', schema: 'audit' }, { columns: [{ name: 'audit_id' }] })
  assert.equal(service.validateItem(projection, target), false)
  const objectTarget = scope({ sql: 'SELECT * FROM ord', cursor: 17 })
  const object = (await service.complete(objectTarget)).items.find(item => item.id.startsWith('object:') && item.owner === 'public')
  assert.ok(object)
  service.metadata.publishTable(target, { name: 'orders' }, { columns: [{ name: 'new_column' }] })
  assert.equal(service.validateItem(object, objectTarget), true)
  await service.dispose()
})

test('newer requests retire metadata waiters immediately without dispatching stale SQL', async () => {
  const gate = deferred()
  const { service, calls } = runtime({ listTables: () => gate.promise })
  const old = service.complete(scope({ sql: 'SELECT old', cursor: 10 }), { waitForMetadata: true })
  await tick()
  const latest = service.complete(scope({ sql: 'SELECT latest', cursor: 13 }))
  assert.equal((await old).stale, true)
  await latest
  assert.deepEqual(calls.worker.map(call => call.request.sql), ['SELECT latest'])
  gate.resolve([])
  await service.dispose()
})

test('AbortSignal retires a metadata waiter without cancelling its shared readonly read', async () => {
  const gate = deferred(), controller = new AbortController()
  const { service, calls } = runtime({ listTables: () => gate.promise })
  const pending = service.complete(scope({ sql: 'SELECT old', cursor: 10 }), { waitForMetadata: true, signal: controller.signal })
  await tick(); controller.abort()
  assert.equal((await pending).stale, true)
  assert.equal(calls.worker.length, 0)
  gate.resolve([])
  await service.dispose()
})

test('completion keeps MariaDB/TiDB engine identity after receiving a MySQL protocol dialect', () => {
  for (const driver of ['mariadb', 'tidb']) assert.equal(completionDialect({ driver, dialect: 'mysql' }), driver)
  assert.equal(completionDialect({ dialect: 'postgres' }), 'postgres')
})

test('slow console close blocks metadata reopening, coalesces retry and cleans up on completion', async () => {
  const gate = deferred(), sessionKeys = new Map([['console-a', 'user-query-session']]), generations = new Map(), contexts = new Map()
  const { service, calls } = runtime()
  let closes = 0
  const lifecycle = createCompletionConsoleLifecycle({ sessionKeys, generations, contexts, close: () => { closes++; return gate.promise }, invalidate: (...args) => service.invalidate(...args) })
  const first = lifecycle.close('console-a', scope())
  assert.equal(first, lifecycle.close('console-a', scope()))
  assert.equal(lifecycle.isClosing('console-a'), true)
  await service.complete(scope({ generation: generations.get('console-a'), connected: sessionKeys.has('console-a') && !lifecycle.isClosing('console-a') }), { waitForMetadata: true })
  assert.equal(calls.open.length, 0)
  gate.resolve()
  assert.equal(await first, 'user-query-session')
  assert.equal(closes, 1)
  assert.equal(sessionKeys.has('console-a'), false)
  assert.equal(lifecycle.isClosing('console-a'), false)
  await service.dispose()
})

test('failed close retains the handle but never restores known context until reconnect', async () => {
  const sessionKeys = new Map([['console-a', 'user-query-session']]), generations = new Map(), contexts = new Map([['console-a', { contextKnown: false, sessionContextRevision: 4 }]])
  let failure = true
  const lifecycle = createCompletionConsoleLifecycle({ sessionKeys, generations, contexts, close: async () => { if (failure) throw new Error('transport closed') }, invalidate: async () => {} })
  await assert.rejects(lifecycle.close('console-a', scope()), /transport closed/)
  assert.equal(sessionKeys.get('console-a'), 'user-query-session')
  assert.deepEqual(contexts.get('console-a'), { contextKnown: false, sessionContextRevision: 5 })
  assert.equal(lifecycle.isClosing('console-a'), false)
  failure = false
  await lifecycle.close('console-a', scope())
  assert.equal(sessionKeys.has('console-a'), false)
  assert.equal(contexts.has('console-a'), false)
})

test('delayed result descriptions cannot refill metadata after DDL, refresh or reconnect', async () => {
  const { service } = runtime()
  const ref = { name: 'orders', database: 'app', schema: 'public' }, detail = { columns: [{ name: 'old_column' }] }
  let ticket = service.captureMetadataRead(scope())
  assert.equal(service.publishMetadataTable(scope(), ref, detail, ticket), true)
  ticket = service.captureMetadataRead(scope())
  await service.record(scope({ consoleId: 'other-console' }), { sql: 'ALTER TABLE orders ADD COLUMN changed INT', success: true })
  assert.equal(service.publishMetadataTable(scope(), ref, detail, ticket), false)
  assert.equal(service.catalog(scope()).tables.length, 0)
  ticket = service.captureMetadataRead(scope())
  await service.invalidate({ connectionId: 'a', preserveSession: true }, 'refresh')
  assert.equal(service.publishMetadataTable(scope(), ref, detail, ticket), false)
  ticket = service.captureMetadataRead(scope())
  assert.equal(service.publishMetadataTable(scope({ generation: 2 }), ref, detail, ticket), false)
  assert.equal(service.publishMetadataTable(scope({ connected: false }), ref, detail, ticket), false)
  await service.dispose()
})

test('worker request boundary excludes connection, credentials, handles and arbitrary nested values', async () => {
  const { service, calls } = runtime()
  await service.complete({ sql: 'SELECT 1', cursor: 8, sessionKey: 'user-query-session', driverHandle: { password: 'hidden' }, searchPath: ['public', { token: 'secret' }] })
  assert.deepEqual(calls.worker[0].request.searchPath, ['public'])
  const payload = JSON.stringify(calls.worker[0])
  for (const secret of ['vault-only', 'never-in-worker', 'private-option', 'driverHandle', 'user-query-session']) assert.ok(!payload.includes(secret), secret)
  assert.equal(engineRequest({ sql: '', dialect: { password: 'x' }, contextRevision: { token: 'x' } }).dialect, undefined)
  await service.dispose()
})

test('temporary tables stay local to console, generation and Quick, preserving same-name permanent tables', async () => {
  const { service } = runtime()
  await service.metadata.ensureObjects(scope())
  await service.record(scope(), { sql: 'CREATE TEMP TABLE orders (temporary_id INT, label TEXT)', success: true })
  await service.metadata.ensureObjects(service.scope(scope()))
  const tables = service.catalog(scope()).tables.filter(table => table.name === 'orders')
  assert.equal(tables.length, 2)
  assert.deepEqual(tables.find(table => table.temporary).columns.map(column => column.name), ['temporary_id', 'label'])
  for (const other of [scope({ consoleId: 'console-b' }), scope({ generation: 2 }), scope({ surface: 'quick' })]) assert.equal(temporary(service, other).length, 0)
  await service.invalidate({ connectionId: 'a', preserveSession: true }, 'manual refresh')
  assert.equal(temporary(service).length, 1)
  await service.invalidate(scope(), 'console closed')
  assert.equal(temporary(service).length, 0)
  await service.dispose()
})

test('PostgreSQL temporary DDL follows transaction rollback and savepoint snapshots', async () => {
  const { service } = runtime()
  const record = sql => service.record(scope(), { sql, success: true })
  await record('CREATE TEMP TABLE before_tx (id INT)')
  await record('BEGIN; CREATE TEMP TABLE in_tx (id INT); SAVEPOINT halfway; CREATE TEMP TABLE after_savepoint (id INT)')
  assert.equal(temporary(service).length, 3)
  await record('ROLLBACK TO SAVEPOINT halfway')
  assert.deepEqual(temporary(service).map(table => table.name).sort(), ['before_tx', 'in_tx'])
  await record('DROP TABLE before_tx; ROLLBACK')
  assert.deepEqual(temporary(service).map(table => table.name), ['before_tx'])
  assert.equal(temporary(service)[0].state, 'ready')
  await service.dispose()
})

test('MySQL temporary table creation is not incorrectly undone by transaction rollback', async () => {
  const { service } = runtime()
  const target = scope({ dialect: 'mysql', schema: undefined })
  await service.record(target, { sql: 'BEGIN; CREATE TEMPORARY TABLE recent_orders (id INT); ROLLBACK', success: true })
  assert.equal(temporary(service, target)[0].name, 'recent_orders')
  assert.equal(temporary(service, target)[0].state, 'ready')
  await service.dispose()
})

test('PostgreSQL ON COMMIT DROP facts expire at commit, including implicit transactions', async () => {
  const { service } = runtime()
  await service.record(scope(), { sql: 'BEGIN; CREATE TEMP TABLE short_lived (id INT) ON COMMIT DROP', success: true })
  assert.equal(temporary(service).length, 1)
  await service.record(scope(), { sql: 'COMMIT', success: true })
  assert.equal(temporary(service).length, 0)
  await service.record(scope(), { sql: 'CREATE TEMP TABLE immediate (id INT) ON COMMIT DROP', success: true })
  assert.equal(temporary(service).length, 0)
  await service.dispose()
})

test('CTAS, conditional creation and failed batches never invent confirmed temporary columns', async () => {
  const { service } = runtime()
  await service.record(scope(), { sql: 'CREATE TEMP TABLE copied AS SELECT * FROM orders', success: true })
  await service.record(scope(), { sql: 'CREATE TEMP TABLE IF NOT EXISTS conditional (id INT)', success: true })
  await service.record(scope(), { sql: 'CREATE TEMP TABLE failed (id INT); SELECT invalid', success: false })
  for (const table of temporary(service)) { assert.equal(table.state, 'unknown'); assert.deepEqual(table.columns, []) }
  const effect = sessionEffects('SELECT \'CREATE TEMP TABLE leaked (id INT)\'; -- USE other\nSELECT 2', 'postgres', true)
  assert.equal(effect.unknown, false)
  assert.equal(effect.operations.length, 0)
  await service.dispose()
})

test('session setting changes stay explicitly unknown until reconnect', async () => {
  const { service, calls } = runtime()
  const changed = await service.record(scope(), { sql: 'USE other_database', success: true })
  assert.equal(changed.contextKnown, false)
  assert.ok(changed.sessionContextRevision > 0)
  await service.complete({ ...scope(), sql: 'SELECT * FROM orders', cursor: 7 })
  assert.equal(calls.worker[0].request.contextKnown, false)
  assert.match(service.catalog(scope()).reason, /重新连接/)
  assert.equal(service.scope(scope({ generation: 2 })).contextKnown, true)
  await service.dispose()
})

test('invalidation discards late engine output, including signatures', async () => {
  const output = deferred(), started = deferred()
  const { service } = runtime({ engineClient: { run: () => { started.resolve(); return output.promise }, dispose() {} } })
  const request = service.complete({ ...scope(), sql: 'SELECT 1', cursor: 8 })
  await started.promise
  await service.invalidate(scope(), 'disconnected')
  output.resolve({ items: [{ label: 'old_connection_secret_column' }] })
  const result = await request
  assert.equal(result.stale, true)
  assert.deepEqual(result.items, [])
  await service.dispose()
  const signature = deferred(), ready = deferred()
  const next = runtime({ engineClient: { run: () => { ready.resolve(); return signature.promise }, dispose() {} } }).service
  const pending = next.complete({ ...scope(), sql: 'COUNT(', cursor: 6 }, { method: 'signature' })
  await ready.promise; await next.dispose(); signature.resolve({ signatures: [{ label: 'old' }] })
  assert.equal(await pending, null)
})

test('DDL invalidation returns without waiting for a slow metadata read to close', async () => {
  const reading = deferred(), started = deferred()
  const { service, calls } = runtime({ listTables: async () => { started.resolve(); await reading.promise; return [] } })
  const load = service.metadata.ensureObjects(scope())
  await started.promise
  const recorded = await Promise.race([service.record(scope(), { sql: 'ALTER TABLE orders ADD x INT', success: true }).then(() => true), tick().then(() => false)])
  assert.equal(recorded, true)
  assert.equal(calls.close.length, 0)
  reading.resolve(); await load; await service.dispose()
  assert.equal(calls.close.length, 1)
})

test('configuration replaces an early runtime getScope and invalidates pending work', async () => {
  const { service, options } = runtime({ getScope: () => scope({ database: 'old' }) })
  const generation = service.epoch
  service.configure({ ...options, getScope: () => scope({ database: 'new' }) })
  assert.equal(service.scope({ sessionKey: 'user-query-session' }).database, 'new')
  assert.ok(service.epoch > generation)
  await service.dispose()
})

test('prefetch none skips automatic field reads while explicit completion can load them', async () => {
  const { service, calls } = runtime({ listTables: async () => [{ name: 'orders' }], engineClient: { run: async () => ({ items: [], requiredTables: [{ name: 'orders' }] }), dispose() {} } })
  const request = { ...scope(), sql: 'SELECT * FROM orders', cursor: 7 }
  await service.complete(request, { rawConfig: { metadata: { prefetch: 'none', ttlMs: 12000 } } })
  await tick()
  assert.equal(calls.describe.length, 0)
  assert.equal(service.metadata.ttlMs, 12000)
  assert.equal(service.metadata.columnTtlMs, 12000)
  await service.complete(request, { rawConfig: { metadata: { prefetch: 'none' } }, waitForMetadata: true })
  assert.equal(calls.describe.length, 1)
  await service.dispose()
})

test('maxObjects reports a partial catalog but still describes explicitly referenced later tables', async () => {
  const { service, calls } = runtime({ listTables: async () => Array.from({ length: 25 }, (_, index) => ({ name: `table_${index}` })) })
  await service.complete({ ...scope(), sql: 'SELECT 1' }, { rawConfig: { metadata: { maxObjects: 10 } }, waitForMetadata: true })
  const snapshot = service.catalog(scope())
  assert.equal(snapshot.tables.length, 10)
  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.complete, false)
  assert.match(snapshot.reason, /10/)
  await service.metadata.ensureColumns(scope(), ['table_24'])
  assert.equal(calls.describe[0].table, 'table_24')
  assert.equal(service.catalog(scope()).tables.find(table => table.name === 'table_24').columnsLoaded, true)
  await service.dispose()
})

test('facade initialized before host configuration adopts the later getScope and metadata dependencies', async () => {
  const previousWindow = globalThis.window
  globalThis.window = {}
  try {
    const facade = await import('@db/completion.js')
    await facade.getCompletionCatalog({ sessionKey: 'early-call' })
    let opened = 0
    await facade.configureCompletionRuntime({
      getScope: () => scope({ database: 'configured_database' }),
      open: async ({ sessionKey }) => { opened++; return { sessionKey } },
      close: async () => {},
      listTables: async () => [{ name: 'configured_table' }]
    })
    await facade.warmCompletionCatalog({ sessionKey: 'early-call' })
    const catalog = await facade.getCompletionCatalog({ sessionKey: 'early-call' })
    assert.equal(catalog.database, 'configured_database')
    assert.equal(catalog.tables[0].name, 'configured_table')
    assert.equal(opened, 1)
    await facade.disposeCompletionRuntime()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
