import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
const { createMetadataService, metadataObjectId, createCatalogReader } = await import('@db/sql-intelligence/metadata/index.js')

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const scope = changes => ({
  connectionId: 'connection-a', consoleId: 'query-a', generation: 1, configRevision: 1,
  surface: 'shell', database: 'app', schema: 'public', dialect: 'postgres', connected: true,
  connection: { id: 'connection-a', driver: 'postgres', secretRef: 'secret-ref', options: { ssl: true } }, ...changes
})

function backend(overrides = {}) {
  const calls = { open: [], close: [], tables: [], describe: [], maximumActive: 0 }, updates = []
  let active = 0
  const tracked = async action => { active++; calls.maximumActive = Math.max(calls.maximumActive, active); try { await tick(); return await action() } finally { active-- } }
  const dependencies = {
    open: async request => { calls.open.push(request); return { sessionKey: request.sessionKey } },
    close: async sessionKey => { calls.close.push(sessionKey) },
    listTables: async request => { calls.tables.push(request); return tracked(() => Array.from({ length: 80 }, (_, i) => ({ name: `table_${i}`, type: 'table' }))) },
    describeTable: async request => { calls.describe.push(request); return tracked(() => ({ columns: [{ name: 'id', dataType: 'INTEGER', primaryKey: true }] })) },
    toConfig: (connection, changes) => ({ ...connection, ...changes }),
    onUpdate: (snapshot, owner) => updates.push({ snapshot, owner }),
    ...overrides
  }
  return { service: createMetadataService(dependencies), calls, updates }
}

test('unqualified SQLite fields reuse the unique main catalog identity', async () => {
  const { service, calls } = backend({ listTables: async () => [{ name: 'notes', database: 'main', type: 'table' }] })
  const target = scope({ dialect: 'sqlite', database: undefined, schema: undefined })
  await service.ensureColumns(target, [{ name: 'notes' }])
  assert.equal(calls.describe[0].database, 'main')
  const tables = service.getSnapshot(target).tables
  assert.equal(tables.length, 1)
  assert.equal(tables[0].database, 'main')
  assert.equal(tables[0].columnsLoaded, true)
  await service.dispose()
})

test('PostgreSQL schema roots load qualified objects serially on one readonly metadata session', async () => {
  const requests = []
  const { service, calls } = backend({ listTables: createCatalogReader(async input => {
    requests.push(input)
    if (!input.schema) return [{ name: 'public', type: 'schema', database: 'app' }, { name: 'audit', type: 'schema', database: 'app' }]
    return [{ name: 'events', type: input.schema === 'audit' ? 'view' : 'table' }]
  }) })
  const target = scope({ schema: undefined })
  await service.ensureObjects(target)
  const snapshot = service.getSnapshot(target)
  assert.equal(snapshot.status, 'ready')
  assert.deepEqual(snapshot.schemas, ['public', 'audit'])
  assert.deepEqual(snapshot.tables.map(table => [table.name, table.database, table.schema, table.type]), [['events', 'app', 'public', 'table'], ['events', 'app', 'audit', 'view']])
  assert.equal(calls.open.length, 1)
  assert.equal(calls.describe.length, 0)
  assert.equal(new Set(requests.map(request => request.sessionKey)).size, 1)
  assert.equal(requests[1].parent, 'schema')
  await service.dispose()
})

test('schema traversal bounds discovery and retains partial permission feedback', async () => {
  const requests = []
  const read = createCatalogReader(async input => {
    requests.push(input.schema)
    if (!input.schema) return ['public', 'private', 'other'].map(name => ({ name, type: 'schema' }))
    if (input.schema === 'private') throw new Error('permission denied')
    return [{ name: 'orders', type: 'table' }]
  }, { maxSchemas: 2 })
  const result = await read({ sessionKey: 'metadata', database: 'app' })
  assert.equal(result.complete, false)
  assert.match(result.reason, /private: permission denied/)
  assert.match(result.reason, /读取上限/)
  assert.deepEqual(requests, [undefined, 'public', 'private'])
  assert.equal(result.tables[0].schema, 'public')
})

test('invalidated schema traversal stops before the next native request', async () => {
  let current = true
  const requests = []
  const read = createCatalogReader(async input => {
    requests.push(input.schema)
    if (!input.schema) return ['public', 'audit'].map(name => ({ name, type: 'schema' }))
    current = false
    return [{ name: 'orders', type: 'table' }]
  })
  await assert.rejects(read({ sessionKey: 'metadata', isCurrent: () => current }), error => error.code === 'STALE_METADATA')
  assert.deepEqual(requests, [undefined, 'public'])
})

test('an omitted namespace never silently chooses between two matching catalogs', async () => {
  const { service, calls } = backend({ listTables: async () => [{ name: 'notes', database: 'main' }, { name: 'notes', database: 'attached' }] })
  const target = scope({ dialect: 'sqlite', database: undefined, schema: undefined })
  await service.ensureColumns(target, [{ name: 'notes', database: 'attached' }])
  assert.equal(calls.describe[0].database, 'attached')
  assert.equal(service.getSnapshot(target).tables.length, 2)
  assert.equal(service.getSnapshot(target).tables.find(table => table.database === 'main').columnsLoaded, false)
  await service.dispose()
})

test('offline, unknown and unavailable contexts never open a metadata connection', async () => {
  const { service, calls } = backend()
  assert.equal((await service.ensureObjects(scope({ connected: false }))).status, 'offline')
  assert.equal((await service.ensureColumns(scope({ connected: false }), ['orders'])).status, 'offline')
  assert.equal((await service.ensureObjects(scope({ contextKnown: false }))).status, 'unavailable')
  assert.equal((await service.ensureObjects({})).status, 'unavailable')
  assert.equal(calls.open.length, 0)
  await assert.rejects(service.withMetadataSession(scope({ connected: false }), () => {}), /尚未连接/)
  await service.dispose()
})

test('lazy table reads use an independent readonly serialized session and preserve compound foreign keys', async () => {
  const { service, calls } = backend()
  const current = scope()
  await service.ensureObjects(current)
  assert.equal(calls.describe.length, 0, 'object discovery does not warm the first forty tables')
  await service.ensureColumns(current, ['table_1', 'table_60'])
  assert.deepEqual(calls.describe.map(request => request.table), ['table_1', 'table_60'])
  assert.equal(calls.open.length, 1)
  assert.equal(calls.maximumActive, 1)
  const config = calls.open[0].config
  assert.equal(config.readOnly, true)
  assert.equal(config.options.readOnly, true)
  assert.equal(config.createIfMissing, false)
  assert.equal(config.options.createIfMissing, false)
  assert.equal(config.options.ssl, true)
  assert.match(calls.describe[0].sessionKey, /^db-nav:catalog:intelligence:/)
  assert.notEqual(calls.describe[0].sessionKey, current.consoleId)
  const detail = { columns: [{ name: 'tenant_id' }, { name: 'customer_id' }], foreignKeys: [{ name: 'customer_fk', columns: ['tenant_id', 'customer_id'], referencedSchema: 'sales', referencedTable: 'customers', referencedColumns: ['tenant_id', 'id'] }] }
  const table = service.publishTable(current, 'table_1', detail).tables.find(value => value.name === 'table_1')
  assert.deepEqual(table.foreignKeys[0].columns, ['tenant_id', 'customer_id'])
  assert.deepEqual(table.foreignKeys[0].referencedColumns, ['tenant_id', 'id'])
  assert.equal(table.foreignKeys[0].referencedSchema, 'sales')
  assert.equal(service.getSnapshot(current).pendingColumns, 0)
  assert.ok(Object.isFrozen(table.columns))
  await service.dispose()
  assert.deepEqual(calls.close, [calls.open[0].sessionKey])
})

test('concurrent discovery and repeated column references are coalesced', async () => {
  const { service, calls } = backend()
  const current = scope()
  await Promise.all([service.ensureObjects(current), service.ensureObjects(current), service.ensureColumns(current, ['table_2', 'table_2']), service.ensureColumns(current, ['table_2'])])
  assert.equal(calls.tables.length, 1)
  assert.equal(calls.describe.length, 1)
  assert.equal(service.getSnapshot(current).tables.length, 80)
  await service.dispose()
})

test('column visibility, generation and defaults survive the metadata boundary', async () => {
  const { service } = backend()
  const field = { name: 'generated_id', hidden: true, invisible: true, isHidden: true, starVisible: false, generated: true, isGenerated: true, computed: true, identity: true, autoIncrement: true, defaultValue: 'CURRENT_TIMESTAMP' }
  const snapshot = service.publishTable(scope(), 'items', { columns: [field] })
  const column = snapshot.tables[0].columns[0]
  for (const key of Object.keys(field)) assert.equal(column[key], field[key], key)
  await service.dispose()
})

test('scope identity distinguishes schema, case, Quick and configuration revisions', async () => {
  const { service, calls } = backend({ listTables: async () => [{ name: 'Orders', type: 'view' }, { name: 'orders', type: 'table' }] })
  const a = scope(), b = scope({ schema: 'archive' }), quick = scope({ surface: 'quick' }), revised = scope({ configRevision: 2 })
  await service.ensureColumns(a, ['Orders'])
  await Promise.all([service.ensureObjects(b), service.ensureObjects(quick), service.ensureObjects(revised)])
  assert.equal(calls.open.length, 4)
  const snapshot = service.getSnapshot(a)
  assert.equal(snapshot.tables.length, 2)
  assert.equal(snapshot.tables.find(table => table.name === 'Orders').type, 'view')
  assert.equal(snapshot.tables.find(table => table.name === 'orders').columnsLoaded, false)
  assert.notEqual(metadataObjectId(a, 'orders'), metadataObjectId(b, 'orders'))
  assert.notEqual(snapshot.scopeKey, service.getSnapshot(quick).scopeKey)
  assert.ok(!JSON.stringify(snapshot).includes('secret-ref'))
  assert.ok(!JSON.stringify(snapshot).includes('db-nav:catalog:'))
  await service.dispose()
})

test('TTL refresh retains loaded columns and refreshes them only when their TTL expires', async () => {
  let time = 100
  const { service, calls } = backend({ now: () => time, ttlMs: 20, columnTtlMs: 60 })
  const current = scope()
  await service.ensureColumns(current, ['table_1'])
  time += 21
  assert.equal(service.getSnapshot(current).status, 'stale')
  assert.equal(service.getSnapshot(current).tables.find(table => table.name === 'table_1').state, 'stale')
  await service.ensureColumns(current, ['table_1'])
  assert.equal(calls.tables.length, 2)
  assert.equal(calls.describe.length, 1)
  assert.equal(service.getSnapshot(current).tables.find(table => table.name === 'table_1').state, 'ready')
  time += 40
  await service.ensureColumns(current, ['table_1'])
  assert.equal(calls.describe.length, 2)
  await service.dispose()
})

test('permission failures have visible state and bounded retries without pretending fields are empty', async () => {
  let time = 100, descriptions = 0
  const { service } = backend({ now: () => time, retryMs: 30, describeTable: async () => { descriptions++; throw new Error('permission denied on orders') } })
  const current = scope()
  let snapshot = await service.ensureColumns(current, ['table_1'])
  const table = snapshot.tables.find(value => value.name === 'table_1')
  assert.equal(table.state, 'permission-denied')
  assert.equal(table.columnsLoaded, false)
  assert.match(table.reason, /permission denied/)
  await service.ensureColumns(current, ['table_1'])
  assert.equal(descriptions, 1)
  time += 31
  await service.ensureColumns(current, ['table_1'])
  assert.equal(descriptions, 2)
  await service.dispose()
})

test('invalidation during open closes the late session and never starts directory discovery', async () => {
  const opening = deferred()
  const { service, calls } = backend({ open: async request => { calls.open.push(request); await opening.promise; return { sessionKey: request.sessionKey } } })
  const current = scope()
  const loading = service.ensureObjects(current)
  await tick()
  const invalidation = service.invalidate(current.connectionId)
  opening.resolve()
  await Promise.all([loading, invalidation])
  assert.equal(calls.tables.length, 0)
  assert.equal(calls.close.length, 1)
  assert.equal(service.getSnapshot(current).tables.length, 0)
  await service.dispose()
})

test('late column responses and queued reads cannot repopulate an invalidated catalog', async () => {
  const reading = deferred(), started = deferred()
  const { service, calls, updates } = backend({ describeTable: async request => { calls.describe.push(request); started.resolve(); await reading.promise; return { columns: [{ name: 'old_column' }] } } })
  const current = scope()
  const loading = service.ensureColumns(current, ['table_1', 'table_2'])
  await started.promise
  const revision = updates.at(-1).snapshot.revision
  const invalidating = service.invalidate(current.connectionId, 'disconnected')
  reading.resolve()
  await Promise.all([loading, invalidating])
  assert.equal(calls.describe.length, 1, 'queued stale reads never execute')
  assert.equal(service.getSnapshot(current).tables.length, 0)
  assert.equal(calls.close.length, 1)
  assert.ok(!updates.filter(update => update.snapshot.revision > revision).some(update => JSON.stringify(update.snapshot).includes('old_column')))
  await service.ensureObjects(scope({ generation: 2 }))
  assert.equal(calls.open.length, 2)
  await service.dispose()
})

test('LRU evicts idle scopes and disposal waits for their session cleanup', async () => {
  let time = 0
  const { service, calls } = backend({ now: () => ++time, maxScopes: 2 })
  const a = scope({ database: 'a' }), b = scope({ database: 'b' }), c = scope({ database: 'c' })
  await service.ensureObjects(a)
  await service.ensureObjects(b)
  service.getSnapshot(a)
  await service.ensureObjects(c)
  assert.equal(service.getSnapshot(b).status, 'unloaded')
  assert.equal(service.getSnapshot(a).tables.length, 80)
  await service.dispose()
  assert.equal(calls.close.length, 3)
  assert.equal(service.getSnapshot(a).status, 'unavailable')
})

test('partial object catalogs and missing adapters retain accurate availability', async () => {
  const { service } = backend({ listTables: async () => ({ tables: [{ name: 'orders' }], truncated: true }), describeTable: undefined })
  const current = scope()
  const snapshot = await service.ensureColumns(current, ['orders'])
  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.complete, false)
  assert.equal(snapshot.tables[0].state, 'unavailable')
  await service.dispose()
  const unavailable = createMetadataService()
  assert.equal((await unavailable.ensureObjects(current)).status, 'unavailable')
  await unavailable.dispose()
})

test('legacy completion actions are serialized with metadata reads on their own session', async () => {
  const { service, calls } = backend()
  const current = scope()
  const metadata = service.ensureObjects(current)
  const value = await service.withMetadataSession(current, async ({ sessionKey, scope: captured, isCurrent }) => {
    assert.equal(isCurrent(), true)
    assert.equal(captured.database, current.database)
    assert.equal(calls.tables.length, 1)
    return sessionKey
  })
  await metadata
  assert.equal(value, calls.open[0].sessionKey)
  assert.equal(calls.open.length, 1)
  await service.dispose()
})
