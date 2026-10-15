import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
const { queryColumnSet } = await import('../../plugins/com.enest.database/src/js/sql-intelligence/settings/queryColumnSet.js')
const catalog = { tables: [{ name: 'customers', database: 'orders', state: 'ready', columnsLoaded: true, columns: [{ name: 'id' }, { name: 'name' }, { name: 'Customer Name' }] }] }
const extract = (sql, options = {}, metadata = catalog) => queryColumnSet({ sql: sql.replace('|', ''), cursor: sql.indexOf('|') >= 0 ? sql.indexOf('|') : 0, dialect: 'mysql', connectionId: 'dev', database: 'orders', ...options }, metadata)

test('query field groups preserve physical column order and remove output aliases and duplicates', () => {
  const result = extract('SELECT c.name AS display_name, c.id customer_id, c.name FROM customers c;')
  assert.deepEqual(result.columns, ['name', 'id'])
  assert.deepEqual(result.scope, { connectionId: 'dev', database: 'orders', schema: null, table: 'customers' })
  assert.deepEqual(extract('SELECT `Customer Name` AS `显示名称`, id FROM customers;').columns, ['Customer Name', 'id'])
})

test('only the query under the caret is extracted and namespace identity is preserved', () => {
  const table = { ...catalog.tables[0], database: 'warehouse', schema: 'public' }
  const result = extract('SELECT 1;\nSELECT "c"."name", "c"."id" FROM "public"."customers" "c"|;', { dialect: 'postgres', database: 'warehouse', schema: 'public' }, { tables: [table] })
  assert.deepEqual(result.columns, ['name', 'id'])
  assert.deepEqual(result.scope, { connectionId: 'dev', database: 'warehouse', schema: 'public', table: 'customers' })
  const noSchema = extract('SELECT name FROM customers;', { schema: 'public' }, { tables: [{ ...catalog.tables[0], schema: '' }] })
  assert.equal(noSchema.scope.schema, null, 'an explicitly absent schema must not inherit the current schema or match every schema')
})

test('expressions, stars, CTE outputs and multi-table queries cannot silently become partial field groups', () => {
  for (const sql of [
    'SELECT id, upper(name) FROM customers;',
    'SELECT * FROM customers;',
    'SELECT c.* FROM customers c;',
    'SELECT c.name, o.id FROM customers c JOIN orders o ON c.id=o.id;',
    'WITH names AS (SELECT name FROM customers) SELECT |name FROM names;',
    'SELECT x.name FROM (SELECT name FROM customers) x;',
    'SELECT wrong.id FROM customers c;'
  ]) {
    const result = extract(sql)
    assert.deepEqual(result.columns, [], sql)
    assert.ok(result.reason, sql)
  }
})

test('field validation never guesses ambiguous tables, unknown columns or case-sensitive quoted names', () => {
  assert.deepEqual(extract('SELECT missing FROM customers').columns, [])
  const tables = ['public', 'audit'].map(schema => ({ ...catalog.tables[0], schema }))
  assert.deepEqual(extract('SELECT id FROM customers', { dialect: 'postgres' }, { tables }).columns, [])
  assert.deepEqual(extract('SELECT "NAME" FROM customers', { dialect: 'postgres' }).columns, [])
})

test('metadata is requested only for the one settled physical table', () => {
  const table = { name: 'customers', database: 'orders', schema: '', type: 'table', state: 'unloaded' }
  const result = extract('SELECT c.name FROM customers c', {}, { tables: [table] })
  assert.deepEqual(result.requiredTables, [{ name: 'customers', database: 'orders', schema: '', type: 'table' }])
  assert.deepEqual(result.columns, [])
  assert.deepEqual(extract('SELECT upper(name) FROM customers', {}, { tables: [table] }).requiredTables, [])
})
