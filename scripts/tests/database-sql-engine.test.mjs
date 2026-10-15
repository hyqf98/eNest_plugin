import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
const { buildCompletion, analyzeSql, signatureHelp, getDialect } = await import('@db/sql-intelligence/completionEngine.js')
const { applyEditPlan } = await import('@db/sql-intelligence/edits/editPlanner.js')

const catalog = { revision: 7, tables: [
  { name: 'customers', schema: 'public', state: 'ready', columns: [{ name: 'id', type: 'integer', pk: true }, { name: 'name', type: 'text', comment: '客户姓名' }, { name: 'status', type: 'text' }, { name: 'computed', generated: true }, { name: 'hidden_value', invisible: true }] },
  { name: 'orders', schema: 'public', state: 'ready', columns: [{ name: 'order_id', type: 'integer' }, { name: 'customer_id', type: 'integer' }, { name: 'tenant_id', type: 'integer' }], foreignKeys: [{ name: 'orders_customer', columns: ['customer_id', 'tenant_id'], refTable: 'customers', refColumns: ['id', 'tenant_id'], refSchema: 'public' }] },
  { name: 'odd table', schema: 'public', state: 'ready', columns: [{ name: 'odd column' }] },
  { name: 'MixedCase', schema: 'public', state: 'ready', columns: [{ name: 'DisplayName' }] },
  { name: 'customers', schema: 'audit', state: 'ready', columns: [{ name: 'audit_id' }] }
] }
function complete(text, options = {}, request = {}) {
  const cursor = text.indexOf('|')
  return buildCompletion({ sql: text.replace('|', ''), cursor: cursor < 0 ? text.length : cursor, dialect: 'postgres', schema: 'public', documentId: 'doc', modelVersion: 9, ...request }, { catalog, ...options })
}
const columns = result => result.items.filter(item => item.kind === 'column').map(item => item.label)

test('uses FROM after the cursor and does not require prior tree expansion', () => {
  assert.ok(columns(complete('SELECT | FROM customers c')).includes('name'))
  assert.deepEqual(columns(complete('SELECT c.na| FROM customers c')), ['name'])
})
test('keeps nested alias shadowing inside its own query block', () => {
  assert.ok(columns(complete('SELECT c.| FROM customers c WHERE EXISTS (SELECT 1 FROM orders c)')).includes('name'))
  assert.deepEqual(columns(complete('SELECT * FROM customers c WHERE EXISTS (SELECT c.| FROM orders c)')).sort(), ['customer_id', 'order_id', 'tenant_id'])
})
test('correlated subquery can resolve an outer alias', () => {
  assert.ok(columns(complete('SELECT * FROM customers c WHERE EXISTS (SELECT c.| FROM orders o)')).includes('name'))
})
test('derived tables and CTE expose only their projected columns', () => {
  assert.deepEqual(columns(complete('SELECT x.| FROM (SELECT id AS customer_id FROM customers) x')), ['customer_id'])
  assert.deepEqual(columns(complete('WITH recent AS (SELECT id AS customer_id FROM customers) SELECT r.| FROM recent r')), ['customer_id'])
  assert.deepEqual(columns(complete('WITH recent(customer_key) AS (SELECT id FROM customers) SELECT r.| FROM recent r')), ['customer_key'])
})
test('derived table cannot accidentally inherit sibling FROM aliases', () => {
  assert.deepEqual(columns(complete('SELECT * FROM customers c JOIN (SELECT c.|) x ON 1=1')), [])
})
test('independent UNION branches do not leak aliases', () => {
  assert.deepEqual(columns(complete('SELECT c.| FROM customers c UNION ALL SELECT o.order_id FROM orders o')).sort(), ['computed', 'hidden_value', 'id', 'name', 'status'])
  assert.deepEqual(columns(complete('SELECT c.id FROM customers c UNION ALL SELECT o.| FROM orders o')).sort(), ['customer_id', 'order_id', 'tenant_id'])
})
test('quoted identifiers and case are preserved', () => {
  assert.deepEqual(columns(complete('SELECT t.| FROM "odd table" t')), ['odd column'])
  assert.equal(complete('SELECT t.| FROM "MixedCase" t').items[0].insertText, '"DisplayName"')
  assert.deepEqual(columns(complete('SELECT t.| FROM mixedcase t')), [])
  assert.deepEqual(columns(complete('SELECT t.| FROM `odd table` t', {}, { dialect: 'mysql' })), ['odd column'])
})
test('fully scoped table identity wins over same-name tables', () => {
  assert.deepEqual(columns(complete('SELECT c.| FROM audit.customers c')), ['audit_id'])
  assert.ok(columns(complete('SELECT c.| FROM public.customers c')).includes('name'))
})
test('ambiguous unqualified names are withheld without an effective search path', () => {
  assert.deepEqual(columns(complete('SELECT c.| FROM customers c', {}, { schema: undefined })), [])
})
test('comments, literals and PostgreSQL dollar strings do not leak completion', () => {
  assert.deepEqual(complete("SELECT 'FROM customers |'").items, [])
  assert.deepEqual(complete('SELECT 1 -- FROM customers |').items, [])
  assert.deepEqual(complete('SELECT $$ FROM customers | $$').items, [])
  assert.ok(columns(complete("SELECT ';'; SELECT c.| FROM customers c")).includes('name'))
})
test('UTF-16 offsets and CRLF allow atomic replacement in the middle of a word', () => {
  const source = '-- 😀\r\nSELECT c.na|me FROM customers c'
  const item = complete(source).items.find(item => item.kind === 'column')
  assert.equal(applyEditPlan(source.replace('|', ''), item.editPlan), '-- 😀\r\nSELECT c.name FROM customers c')
  assert.equal(item.editPlan.expectedModelVersion, 9)
  assert.equal(item.editPlan.expectedCatalogRevision, 7)
})
test('star expansion is exact, scoped and excludes invisible fields', () => {
  const source = 'SELECT c.*| FROM customers c JOIN orders o ON o.customer_id = c.id'
  const item = complete(source).items.find(item => item.source === 'projection')
  assert.ok(item)
  assert.equal(item.editPlan.text, 'c.id, c.name, c.status, c.computed')
  assert.match(applyEditPlan(source.replace('|', ''), item.editPlan), /^SELECT c.id, c.name/)
})
test('COUNT star, USING/NATURAL joins, stale data and unknown context are not rewritten', () => {
  for (const text of ['SELECT COUNT(*|) FROM customers c', 'SELECT *| FROM customers c JOIN orders o USING (id)', 'SELECT *| FROM customers c NATURAL JOIN orders o']) assert.ok(!complete(text).items.some(item => item.source === 'projection'))
  assert.ok(!complete('SELECT *| FROM customers c', {}, { contextKnown: false }).items.some(item => item.source === 'projection'))
  assert.ok(!complete('SELECT *| FROM customers c', { catalog: { tables: [{ ...catalog.tables[0], state: 'stale' }] } }).items.some(item => item.source === 'projection'))
})
test('field groups preserve configured order and refuse missing columns', () => {
  const config = { columnSets: [{ id: 'summary', label: '列表', scope: { table: 'customers' }, columns: ['name', 'id'] }, { id: 'bad', label: '过期', scope: { table: 'customers' }, columns: ['gone'] }] }
  const items = complete('SELECT *| FROM customers c', { config }).items.filter(item => item.source === 'columnSet')
  assert.equal(items.length, 1); assert.equal(items[0].editPlan.text, 'c.name, c.id')
})
test('compound foreign keys remain one complete join condition', () => {
  const item = complete('SELECT * FROM customers c JOIN orders o ON |').items.find(item => item.source === 'foreignKey')
  assert.equal(item.insertText, 'o.customer_id = c.id AND o.tenant_id = c.tenant_id')
})
test('INSERT and UPDATE suppress existing/generated fields', () => {
  assert.deepEqual(columns(complete('INSERT INTO customers (id, |)')).sort(), ['hidden_value', 'name', 'status'])
  const result = complete('UPDATE customers SET name = 1, |')
  assert.ok(!columns(result).includes('name')); assert.ok(!columns(result).includes('computed'))
  assert.ok(result.items.find(item => item.label === 'status').insertText.endsWith(' = '))
})
test('function signatures track nested commas and custom functions', () => {
  const sql = 'SELECT COALESCE(LOWER(name), '
  const help = signatureHelp({ sql, cursor: sql.length, dialect: 'postgres' })
  assert.equal(help.activeParameter, 1); assert.match(help.signatures[0].label, /^COALESCE/)
  const custom = signatureHelp({ sql: 'SELECT tax(', cursor: 11, dialect: 'sqlite' }, { config: { functions: [{ id: 'tax', name: 'tax', signature: 'tax(amount, rate)' }] } })
  assert.equal(custom.signatures[0].parameters.length, 2)
})
test('static enum values are typed and scoped without querying table data', () => {
  const config = { enums: [{ id: 'status', column: 'status', scope: { table: 'customers' }, values: ['active', null, 2, "can't"] }] }
  const items = complete('SELECT * FROM customers c WHERE c.status = |', { config }).items.filter(item => item.kind === 'value')
  assert.deepEqual(new Set(items.map(item => item.insertText)), new Set(["'active'", 'NULL', '2', "'can''t'"]))
})
test('user snippets preserve numbered tab stops', () => {
  const config = { templates: [{ id: 'cnt', trigger: 'cnt', label: '计数', contexts: ['statementStart'], generator: 'snippet', body: 'SELECT COUNT(*) FROM ${1:table};$0' }] }
  const item = complete('cn|', { config }).items.find(item => item.id === 'template:cnt')
  assert.equal(item.editPlan.snippet, 'SELECT COUNT(*) FROM ${1:table};$0')
})
test('whole query generators use real fields and refuse to overwrite an existing body', () => {
  const item = complete('sel|').items.find(item => item.id.includes('builtin.select-all') && item.label.endsWith('customers'))
  assert.ok(item); assert.match(item.insertText, /SELECT id, name, status, computed/)
  assert.ok(!complete('sel| FROM customers').items.some(item => item.id.includes('builtin.select-all')))
})
test('dialect quoting, pagination and capability limits are explicit', () => {
  assert.equal(getDialect('postgres').quoteIdentifier('Order'), '"Order"')
  assert.equal(getDialect('mysql').quoteIdentifier('odd`name'), '`odd``name`')
  assert.match(getDialect('sqlserver').select('id', 'users', 50), /^SELECT TOP \(50\)/)
  assert.match(getDialect('oracle').select('id', 'users', 50), /FETCH FIRST 50 ROWS ONLY/)
  assert.equal(getDialect('new-product').known, false)
  assert.deepEqual(getDialect('new-product').functions, [])
  assert.equal(getDialect('duckdb').capabilities.projectionRewrite, false)
})
test('learning cannot move global functions ahead of scoped fields and can be disabled', () => {
  const baseline = complete('SELECT | FROM customers c')
  const fn = baseline.items.find(item => item.kind === 'function')
  const learned = complete('SELECT | FROM customers c', { usage: { [fn.id]: 99999999 } })
  assert.equal(learned.items[0].kind, 'column')
  const disabled = complete('SELECT | FROM customers c', { usage: { [fn.id]: 99999 }, config: { behavior: { learnUsage: false } } })
  assert.equal(disabled.items.find(item => item.id === fn.id).scoreBreakdown.learned, 0)
})
test('metadata needs identify referenced tables beyond arbitrary first-N prefetch', () => {
  const result = complete('SELECT b.| FROM beyond_first_300 b', { catalog: { tables: [] } })
  assert.equal(result.requiredTables[0].name, 'beyond_first_300'); assert.equal(result.isIncomplete, true)
})
test('diagnostics are configurable and do not flag temporary missing SELECT input', () => {
  assert.ok(complete('SELECT | FROM customers').diagnostics.every(item => item.code !== 'unknownColumn'))
  assert.ok(complete('SELECT * FROM customers x JOIN orders x ON |').diagnostics.some(item => item.code === 'duplicateAlias'))
  assert.ok(complete('UPDATE customers SET |').diagnostics.some(item => item.code === 'unsafeMutation'))
})
test('oversized scripts have a bounded explicit fallback', () => {
  const result = buildCompletion({ sql: ' '.repeat(500001), cursor: 0, dialect: 'mysql' })
  assert.equal(result.context.limited, true); assert.deepEqual(result.items, [])
})
test('overlapping edit plans are rejected atomically', () => {
  assert.throws(() => applyEditPlan('select', { from: 0, to: 3, text: 'a', additionalEdits: [{ from: 2, to: 5, text: 'b' }] }), /重叠/)
})

test('typed query-template table names lazily request only matching unloaded objects', () => {
  const unloaded = { tables: [{ name: 'customers', schema: 'public', columns: [], state: 'unloaded' }, { name: 'orders', schema: 'public', columns: [], state: 'unloaded' }] }
  for (const text of ['SELECT cust|', 'sel customers|']) {
    const first = complete(text, { catalog: unloaded })
    assert.deepEqual(first.requiredTables.map(table => table.name), ['customers'])
    assert.ok(complete(text).items.some(item => item.id.includes('builtin.select-all') && item.label.includes('customers')))
  }
  assert.deepEqual(complete('sel|', { catalog: unloaded }).requiredTables, [])
})
test('typing an unknown FROM prefix does not describe a different table on every key', () => {
  assert.deepEqual(complete('SELECT * FROM cust|', { catalog: { tables: [] } }).requiredTables, [])
  assert.deepEqual(complete('SELECT c.| FROM customers c', { catalog: { tables: [] } }).requiredTables.map(table => table.name), ['customers'])
})
test('temporary objects shadow permanent objects only inside the unqualified session namespace', () => {
  const local = { tables: [...catalog.tables, { name: 'customers', temporary: true, columns: [{ name: 'session_only' }], state: 'ready' }] }
  assert.deepEqual(columns(complete('SELECT c.| FROM customers c', { catalog: local })), ['session_only'])
  assert.ok(columns(complete('SELECT c.| FROM public.customers c', { catalog: local })).includes('name'))
  const unknown = { tables: [...catalog.tables, { name: 'customers', temporary: true, columns: [], state: 'unloaded' }] }
  const result = complete('SELECT c.| FROM customers c', { catalog: unknown })
  assert.deepEqual(columns(result), []); assert.deepEqual(result.requiredTables, [])
})
test('two aliases in a self-join keep distinct candidates', () => {
  const result = columns(complete('SELECT | FROM customers parent JOIN customers child ON child.id = parent.id'))
  assert.ok(result.includes('parent.name')); assert.ok(result.includes('child.name'))
})
test('zero learning weight is respected and keyword preserve follows typed case', () => {
  const result = complete('SELECT | FROM customers c', { config: { ranking: { usageWeight: 0 } }, usage: { 'function::COUNT': 999 } })
  assert.equal(result.items.find(item => item.label === 'COUNT').scoreBreakdown.learned, 0)
  assert.equal(complete('se|', { config: { behavior: { keywordCase: 'preserve' } } }).items.find(item => item.label === 'SELECT').insertText, 'select')
})
test('single-table profiles affect provider behavior after metadata binding', () => {
  const config = { profiles: [{ id: 'hideComments', label: '客户表', scope: { table: 'customers' }, overrides: { behavior: { commentSearch: false } } }] }
  assert.deepEqual(columns(complete('SELECT 姓名| FROM customers c', { config })), [])
  assert.equal(complete('SELECT | FROM customers c', { config }).config.commentSearch, false)
})
test('disabled built-in templates stay disabled', () => {
  const config = { templates: [{ id: 'builtin.select-all', trigger: 'sel', label: 'Disabled', generator: 'select', disabled: true }] }
  assert.ok(!complete('sel|', { config }).items.some(item => item.id.includes('builtin.select-all')))
})

test('lazy requirements preserve the resolved SQLite default database identity', () => {
  const response = complete('SELECT n.na| FROM notes n', { catalog: { tables: [{ name: 'notes', database: 'main', type: 'table', state: 'unloaded', columns: [] }] } }, { dialect: 'sqlite', database: '', schema: '' })
  assert.deepEqual(response.requiredTables, [{ name: 'notes', database: 'main', schema: undefined, type: 'table' }])
})

test('cold sel lists table targets without requesting all columns and keeps identity after hydration', () => {
  const cold = { revision: 1, tables: catalog.tables.map(table => ({ ...table, columns: [], state: 'unloaded' })) }
  for (const sql of ['sel|', 'sel |']) {
    const result = complete(sql, { catalog: cold })
    const item = result.items.find(item => item.label === 'sel · public.customers')
    assert.ok(item?.resolve)
    assert.deepEqual(result.requiredTables, [])
    assert.equal(applyEditPlan(sql.replace('|', ''), item.editPlan), sql.replace('|', ''))
    assert.deepEqual(item.resolve.table, { name: 'customers', database: undefined, schema: 'public', type: undefined })
    assert.equal(item.metadataDependencies[0].mode, 'identity')
    const ready = complete(sql).items.find(candidate => candidate.id === item.id)
    assert.ok(ready && !ready.resolve)
    assert.match(ready.insertText, /SELECT id, name, status, computed/)
    assert.equal(ready.metadataDependencies[0].mode, 'structure')
  }
})

test('table-scoped generators appear for the matching cold target only', () => {
  const config = { templates: [{ id: 'builtin.select-all', disabled: true }, { id: 'customers.only', trigger: 'cust', label: '客户常用查询', generator: 'select', scope: { table: 'customers', schema: 'public' } }] }
  const cold = { tables: catalog.tables.map(table => ({ ...table, columns: [], state: 'unloaded' })) }
  const items = complete('cust|', { config, catalog: cold }).items.filter(item => item.resolve)
  assert.equal(items.length, 1)
  assert.equal(items[0].resolve.table.name, 'customers')
  assert.equal(items[0].resolve.table.schema, 'public')
})

test('a fixed field-group ID never falls back to another table default group', () => {
  const config = {
    templates: [{ id: 'builtin.select-all', disabled: true }, { id: 'fixed', trigger: 'fixed', label: '固定订单字段', generator: 'select', projection: { source: 'columnSet', columnSetId: 'order-fields' } }],
    columnSets: [{ id: 'order-fields', label: '订单', columns: ['order_id'], scope: { table: 'orders' } }, { id: 'customer-default', label: '客户默认', columns: ['name'], default: true, scope: { table: 'customers', schema: 'public' } }]
  }
  for (const data of [catalog, { tables: catalog.tables.map(table => ({ ...table, state: 'unloaded', columns: [] })) }]) {
    const items = complete('fixed|', { config, catalog: data }).items.filter(item => item.id.startsWith('template:'))
    assert.equal(items.length, 1)
    assert.equal(items[0].label, 'fixed · orders')
  }
})

test('JOIN object candidates prioritize declared relationships and exclude premature clause keywords', () => {
  const data = { tables: [...catalog.tables, { name: 'aaa_unrelated', schema: 'public', state: 'ready', columns: [{ name: 'id' }] }] }
  const result = complete('SELECT * FROM customers c JOIN |', { catalog: data })
  const tables = result.items.filter(item => ['table', 'view'].includes(item.kind))
  assert.equal(tables[0].label, 'orders')
  assert.match(tables[0].presentation.description, /外键/)
  assert.equal(result.items.some(item => item.kind === 'keyword'), false)
  const afterTable = complete('SELECT * FROM customers c JOIN orders o |')
  assert.ok(afterTable.items.some(item => item.label === 'ON'))
  assert.equal(afterTable.items.some(item => item.kind === 'table'), false)
})

test('signature guidance stays in the same candidate list, tracks the active argument and never inserts', () => {
  const sql = 'SELECT COALESCE(LOWER(name), |) FROM customers'
  const item = complete(sql).items.find(item => item.source === 'signature')
  assert.ok(item?.nonInsert)
  assert.equal(item.label, 'COALESCE(value, fallback, ...values)')
  assert.match(item.presentation.description, /当前参数 2：fallback/)
  assert.equal(applyEditPlan(sql.replace('|', ''), item.editPlan), sql.replace('|', ''))
  assert.equal(complete("SELECT 'COUNT(|'").items.some(item => item.source === 'signature'), false)
})

test('column presentation never mistakes a missing type for a comment or key marker', () => {
  const data = { tables: [{ name: 'customers', schema: 'public', state: 'ready', columns: [{ name: 'nickname', comment: '客户 · 昵称', pk: true, nullable: false, defaultValue: '' }] }] }
  const item = complete('SELECT c.ni| FROM customers c', { catalog: data }).items.find(item => item.kind === 'column')
  assert.equal(item.presentation.type, '')
  assert.equal(item.presentation.description, 'PK · 必填 · 有默认值 · 客户 · 昵称')
})

test('PostgreSQL escaped strings do not expose apparent FROM aliases inside literal text', () => {
  const result = complete(String.raw`SELECT E'it\'s FROM orders o WHERE o.|'`)
  assert.equal(result.context.suppressed, true)
  assert.deepEqual(result.items, [])
})

test('materialized CTEs shadow a permanent table with the same name', () => {
  const data = { tables: [...catalog.tables, { name: 'recent', schema: 'public', state: 'ready', columns: [{ name: 'permanent_only' }] }] }
  for (const modifier of ['MATERIALIZED', 'NOT MATERIALIZED']) {
    assert.deepEqual(columns(complete(`WITH recent AS ${modifier} (SELECT order_id FROM orders) SELECT r.| FROM recent r`, { catalog: data })), ['order_id'])
  }
})

test('SQLite bracket identifiers and MySQL double-minus arithmetic retain field scope', () => {
  assert.ok(columns(complete('SELECT o.| FROM [orders] o', {}, { dialect: 'sqlite' })).includes('order_id'))
  assert.ok(columns(complete('SELECT 1--1, o.| FROM orders o', {}, { dialect: 'mysql' })).includes('order_id'))
  assert.deepEqual(complete('SELECT 1-- FROM orders o WHERE o.|', {}, { dialect: 'mysql' }).items, [])
})

test('single-table function scopes apply to candidates and active argument guidance', () => {
  const config = { functions: [{ id: 'customerScore', name: 'customer_score', signature: 'customer_score(customer_id)', scope: { table: 'customers', schema: 'public' } }] }
  assert.ok(complete('SELECT customer_s| FROM customers', { config }).items.some(item => item.label === 'customer_score'))
  assert.equal(complete('SELECT customer_s| FROM orders', { config }).items.some(item => item.label === 'customer_score'), false)
  assert.ok(complete('SELECT customer_score(|) FROM customers', { config }).items.some(item => item.source === 'signature'))
})

test('null provider scopes match an explicitly absent namespace rather than every schema', () => {
  const config = { functions: [{ id: 'noSchema', name: 'local_only', signature: 'local_only()', scope: { schema: null } }] }
  assert.equal(complete('SELECT local_| FROM customers', { config }).items.some(item => item.label === 'local_only'), false)
  const data = { tables: [{ name: 'local_table', schema: null, state: 'ready', columns: [{ name: 'id' }] }] }
  assert.ok(complete('SELECT local_| FROM local_table', { config, catalog: data }).items.some(item => item.label === 'local_only'))
})
