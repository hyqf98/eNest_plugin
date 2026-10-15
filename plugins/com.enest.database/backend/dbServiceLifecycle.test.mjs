import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
function load(file, mocks) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('import.meta.url', "'file:///tmp/enest-main/index.js'")
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const scriptParser = load('./sqlScript.ts', {})
const queryPolicy = load('./queryPolicy.ts', { '@backend/sqlScript': scriptParser })
const executionPolicy = load('./executionPolicy.ts', { '@backend/sqlScript': scriptParser })
function fixture(driver) {
  let catalogWrites = 0
  const api = load('./dbService.ts', {
    '@backend/drivers': { getDriver: () => driver, DEFAULT_MAX_ROWS: 1000 },
    '@backend/completion': { getCatalog: () => null, setCatalog: () => catalogWrites++, invalidateCatalog() {}, buildCompletion: () => ({}), isWriteSql: () => false, isDdlSql: () => false },
    '@backend/dialects': { listDialects: () => [] },
    '@backend/queryPolicy': queryPolicy,
    '@backend/sqlScript': scriptParser,
    '@backend/executionPolicy': executionPolicy,
    '@backend/driverCatalog': load('./driverCatalog.ts', {}),
    '@backend/nativeCompletion': load('./nativeCompletion.ts', {}),
    '@backend/rowChanges': load('./rowChanges.ts', { '@backend/queryPolicy': queryPolicy })
  })
  return { api, catalogWrites: () => catalogWrites }
}
const handle = () => ({ id: 'timescale', config: {}, raw: {}, readOnly: false })

test('opening a database while the owner closes disposes the late handle', async () => {
  let opened, closed = 0
  const { api } = fixture({ open: () => new Promise(resolve => opened = resolve), close: async () => closed++ })
  const pending = api.dbOpen('plugin', { driver: 'timescale' })
  await api.releaseDbSessions('plugin')
  opened(handle())
  await assert.rejects(pending, /opening cancelled/)
  assert.equal(closed, 1)
  assert.deepEqual(api.dbListSessions('plugin'), [])
})

test('concurrent same-key opens cannot overwrite an unclosed handle', async () => {
  const resolvers = []; let closed = 0
  const { api } = fixture({ open: () => new Promise(resolve => resolvers.push(resolve)), close: async () => closed++ })
  const first = api.dbOpen('plugin', { config: { driver: 'timescale' }, sessionKey: 'fixed' })
  const second = api.dbOpen('plugin', { config: { driver: 'timescale' }, sessionKey: 'fixed' })
  resolvers[1](handle()); await second
  resolvers[0](handle()); await assert.rejects(first, /opening cancelled/)
  assert.equal(closed, 1)
  assert.equal(api.dbListSessions('plugin').length, 1)
})

test('cancel closes the session and suppresses a late successful query', async () => {
  let execute; let closed = 0
  const { api } = fixture({ open: async () => handle(), close: async () => closed++, execute: () => new Promise(resolve => execute = resolve) })
  const session = await api.dbOpen('plugin', { driver: 'timescale' })
  const pending = api.dbExecute('plugin', { sessionKey: session.sessionKey, sql: 'SELECT 1' })
  await api.dbCancel('plugin', session.sessionKey)
  execute({ columns: [], rows: [[1]] })
  await assert.rejects(pending, /cancelled/)
  assert.equal(closed, 1)
})

test('catalog completion after close cannot refill a removed session cache', async () => {
  let finish
  const { api, catalogWrites } = fixture({ open: async () => handle(), close: async () => {}, completionCatalog: () => new Promise(resolve => finish = resolve) })
  const session = await api.dbOpen('plugin', { driver: 'timescale' })
  const pending = api.dbCompletion('plugin', { sessionKey: session.sessionKey, sql: '' })
  await api.dbClose('plugin', session.sessionKey)
  finish({ tables: [] }); await pending
  assert.equal(catalogWrites(), 0)
})

test('CSV preview retains only its bounded sample and preserves quoted newlines', async () => {
  const { api } = fixture({ open: async () => handle(), close: async () => {} })
  const session = await api.dbOpen('plugin', { driver: 'timescale' })
  const result = await api.dbImportPreview('plugin', { sessionKey: session.sessionKey, table: { table: 'sample' }, csvText: 'name,note\r\na,"line1\nline2"\r\nb,"quote ""inside"""\nc,last', options: { sampleRows: 1 } })
  assert.deepEqual(result.sampleRows, [['a', 'line1\nline2']])
  assert.equal(result.totalRowsEstimate, 3)
})

test('script preflight rejects malformed later input before any driver execution', async () => {
  let requests = 0
  const { api } = fixture({ open: async () => ({ ...handle(), id: 'mysql', runtime: {} }), close: async () => {}, execute: async () => { requests++; return { columns: [], rows: [], rowCount: 0, durationMs: 0 } } })
  const { sessionKey } = await api.dbOpen('plugin', { driver: 'mysql' })
  await assert.rejects(api.dbExecute('plugin', { sessionKey, sql: 'UPDATE audit SET n=1;\nDELIMITER invalid\nSELECT 1;' }), /Invalid DELIMITER/)
  await assert.rejects(api.dbExecute('plugin', { sessionKey, sql: 'UPDATE audit SET n=1; /* unterminated' }), /Unterminated/)
  assert.equal(requests, 0)
})

test('a procedure opening a transaction blocks a later implicit-commit DDL on the live state', async () => {
  const requests = [], runtime = { transaction: false }
  const { api } = fixture({ open: async () => ({ ...handle(), id: 'mysql', runtime }), close: async () => {}, transaction: async () => {}, execute: async (_h, sql) => { requests.push(sql); runtime.transaction = true; return { columns: [], rows: [], rowCount: 0, durationMs: 0 } } })
  const { sessionKey } = await api.dbOpen('plugin', { driver: 'mysql' })
  await assert.rejects(api.dbExecute('plugin', { sessionKey, sql: 'CALL p();\nCREATE TABLE should_not_commit(id INT);' }), /SQL unit 2.*implicitly commit/)
  assert.deepEqual(requests, ['CALL p()'])
  assert.equal(api.dbListSessions('plugin')[0].transactionActive, true)
})

test('SQL Server batches and nested driver recordsets retain their own schemas and one execution owner', async () => {
  const requests = []
  const { api } = fixture({ open: async () => ({ ...handle(), id: 'mssql', runtime: {} }), close: async () => {}, execute: async (_h, sql) => {
    requests.push(sql)
    const first = { columns: [{ name: 'left' }], rows: [[1]], rowCount: 1, durationMs: 0 }
    return { ...first, results: [first, { columns: [{ name: 'right' }], rows: [[2]], rowCount: 1, durationMs: 0 }] }
  } })
  const { sessionKey } = await api.dbOpen('plugin', { driver: 'mssql' })
  const result = await api.dbExecute('plugin', { sessionKey, executionId: 'one_owner', sql: 'DECLARE @v INT=1; SELECT @v AS left; SELECT 2 AS right;\nGO' })
  assert.equal(requests.length, 1); assert.match(requests[0], /^DECLARE.*SELECT.*SELECT/); assert.doesNotMatch(requests[0], /GO/)
  assert.deepEqual(result.results.map(item => item.columns[0].name), ['left', 'right'])
  assert.ok(result.results.every(item => item.executionId === 'one_owner'))
})
