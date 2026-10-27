import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
const { normalizeConfig, resolveConfig } = await import('@db/sql-intelligence/configuration/index.js')
const { buildCompletion } = await import('@db/sql-intelligence/completionEngine.js')
const { scopeMatches } = await import('@db/sql-intelligence/providers/catalogContext.js')

const scope = { connectionId: 'dev', database: 'app', schema: 'audit', table: 'customers', dialectId: 'postgres' }
const rules = {
  functions: [{ id: 'mask-audit', name: 'mask_audit', signature: 'mask_audit(customer_id)', scope }],
  enums: [{ id: 'audit-status', column: 'status', values: ['reviewed'], scope }],
  columnSets: [{ id: 'audit-fields', label: '审计字段', columns: ['audit_id', 'status'], scope }],
  templates: [
    { id: 'audit-query', label: '审计查询', trigger: 'auditq', generator: 'select', projection: { source: 'columnSet', columnSetId: 'audit-fields' }, scope },
    { id: 'audit-filter', label: '审计条件', trigger: 'auditf', generator: 'snippet', contexts: ['where'], body: "status = 'reviewed'", scope }
  ]
}
const catalog = { tables: [
  { name: 'customers', database: 'app', schema: 'public', state: 'ready', columns: [{ name: 'id' }, { name: 'status' }] },
  { name: 'customers', database: 'app', schema: 'audit', state: 'ready', columns: [{ name: 'audit_id' }, { name: 'status' }] }
] }
function complete(text, overrides = {}, raw = rules, data = catalog) {
  const cursor = text.indexOf('|')
  const request = { sql: text.replace('|', ''), cursor: cursor < 0 ? text.length : cursor, connectionId: 'dev', dialect: 'postgres', database: 'app', schema: 'public', contextKnown: true, ...overrides }
  // Follow the runtime path: configuration resolves before SQL object binding.
  const config = resolveConfig(normalizeConfig(raw), { ...request, dialectId: request.dialect })
  return buildCompletion(request, { config, catalog: data }).items
}

test('object-scoped lists retain cross-schema rules but preserve connection and dialect isolation', () => {
  const matching = resolveConfig(rules, { connectionId: 'dev', dialectId: 'postgres', database: 'app', schema: 'public' })
  for (const key of ['functions', 'enums', 'columnSets']) assert.equal(matching[key].length, 1)
  assert.ok(matching.templates.some(item => item.id === 'audit-query'))
  for (const context of [{ connectionId: 'other', dialectId: 'postgres' }, { connectionId: 'dev', dialectId: 'mysql' }]) {
    const excluded = resolveConfig(rules, context)
    for (const key of ['functions', 'enums', 'columnSets']) assert.deepEqual(excluded[key], [])
    assert.equal(excluded.templates.some(item => item.id.startsWith('audit-')), false)
  }
})

test('functions, argument guidance and enums bind the explicitly named schema only', () => {
  assert.ok(complete('SELECT mask_a| FROM audit.customers').some(item => item.label === 'mask_audit'))
  assert.ok(complete('SELECT mask_audit(|) FROM audit.customers').some(item => item.source === 'signature'))
  assert.ok(complete('SELECT audit_id FROM audit.customers WHERE status = |').some(item => item.label === "'reviewed'"))
  assert.equal(complete('SELECT mask_a| FROM public.customers').some(item => item.label === 'mask_audit'), false)
  assert.equal(complete('SELECT id FROM public.customers WHERE status = |').some(item => item.label === "'reviewed'"), false)
  assert.equal(complete('SELECT mask_a| FROM audit.customers', { connectionId: 'other' }).some(item => item.label === 'mask_audit'), false)
})

test('field groups and static templates use the bound object rather than editor defaults', () => {
  const fields = complete('SELECT | FROM audit.customers c').filter(item => item.source === 'columnSet')
  assert.equal(fields.length, 1)
  assert.equal(fields[0].editPlan.text, 'c.audit_id, c.status')
  assert.equal(complete('SELECT | FROM public.customers c').some(item => item.source === 'columnSet'), false)
  assert.ok(complete('SELECT audit_id FROM audit.customers WHERE auditf|').some(item => item.id === 'template:audit-filter'))
  assert.equal(complete('SELECT id FROM public.customers WHERE auditf|').some(item => item.id === 'template:audit-filter'), false)
})

test('dynamic templates include only matching ready and cold targets across schemas', () => {
  const ready = complete('auditq|').filter(item => item.id.startsWith('template:audit-query:'))
  assert.equal(ready.length, 1)
  assert.match(ready[0].editPlan.text, /FROM audit\.customers/)
  assert.match(ready[0].editPlan.text, /audit_id, status/)
  assert.equal(ready[0].metadataDependencies[0].schema, 'audit')
  const cold = { tables: catalog.tables.map(table => ({ ...table, columns: [], state: 'unloaded' })) }
  const pending = complete('auditq|', {}, rules, cold).filter(item => item.id.startsWith('template:audit-query:'))
  assert.equal(pending.length, 1)
  assert.equal(pending[0].resolve.table.schema, 'audit')
  assert.equal(complete('auditq|', { connectionId: 'other' }).some(item => item.id.startsWith('template:audit-query:')), false)
})

test('explicit null namespaces survive early resolution and never match named schemas', () => {
  const localRules = { functions: [{ id: 'local', name: 'local_only', signature: 'local_only()', scope: { connectionId: 'dev', schema: null, table: 'local_table' } }] }
  const localCatalog = { tables: [{ name: 'local_table', database: 'app', schema: null, state: 'ready', columns: [{ name: 'id' }] }, { name: 'local_table', database: 'app', schema: 'public', state: 'ready', columns: [{ name: 'id' }] }] }
  assert.ok(complete('SELECT local_| FROM local_table', { schema: '' }, localRules, { tables: [localCatalog.tables[0]] }).some(item => item.label === 'local_only'))
  assert.equal(complete('SELECT local_| FROM public.local_table', {}, localRules, localCatalog).some(item => item.label === 'local_only'), false)
  assert.equal(scopeMatches({ dialectId: 'postgres', schema: null }, { dialectId: 'postgres', schema: null }, localCatalog.tables[0]), true)
})

test('MySQL rules also follow explicit cross-database references without leaking to the default database', () => {
  const archiveScope = { connectionId: 'dev', database: 'archive', table: 'customers', dialectId: 'mysql' }
  const archiveRules = { functions: [{ id: 'archive', name: 'archive_mask', signature: 'archive_mask(value)', scope: archiveScope }], templates: [{ id: 'archive-query', label: '归档查询', trigger: 'arq', generator: 'select', scope: archiveScope }] }
  const tables = { tables: [{ name: 'customers', database: 'archive', schema: null, state: 'ready', columns: [{ name: 'archive_id' }] }, { name: 'customers', database: 'app', schema: null, state: 'ready', columns: [{ name: 'id' }] }] }
  assert.ok(complete('SELECT archive_m| FROM archive.customers', { dialect: 'mysql', schema: '' }, archiveRules, tables).some(item => item.label === 'archive_mask'))
  assert.equal(complete('SELECT archive_m| FROM app.customers', { dialect: 'mysql', schema: '' }, archiveRules, tables).some(item => item.label === 'archive_mask'), false)
  const templates = complete('arq|', { dialect: 'mysql', schema: '' }, archiveRules, tables).filter(item => item.id.startsWith('template:archive-query:'))
  assert.equal(templates.length, 1)
  assert.match(templates[0].editPlan.text, /FROM archive\.customers/)
})

test('table profile resolution preserves explicitly absent namespaces over editor defaults', () => {
  const raw = { profiles: [{ id: 'local-profile', scope: { database: null, schema: null, table: 'local_table' }, overrides: { behavior: { keywordCase: 'lower' } } }] }
  const request = { sql: 'SELECT  FROM local_table', cursor: 7, connectionId: 'dev', dialect: 'postgres', database: 'app', schema: 'public' }
  const config = resolveConfig(normalizeConfig(raw), { ...request, dialectId: 'postgres' })
  assert.equal(config.behavior.keywordCase, 'upper')
  const result = buildCompletion(request, { config, catalog: { tables: [{ name: 'local_table', database: null, schema: null, state: 'ready', columns: [{ name: 'id' }] }] } })
  assert.equal(result.config.keywordCase, 'lower')
})

test('CTE and derived outputs never inherit rules from a same-named physical table', () => {
  const localScope = { connectionId: 'dev', schema: 'public', table: 'customers' }
  const raw = {
    functions: [{ id: 'physical', name: 'physical_only', signature: 'physical_only(value)', scope: localScope }],
    enums: [{ id: 'physical-values', column: 'status', values: ['physical'], scope: localScope }],
    templates: [{ id: 'physical-filter', label: '物理表条件', trigger: 'phys', generator: 'snippet', contexts: ['where'], body: "status = 'physical'", scope: localScope }],
    profiles: [{ id: 'physical-case', scope: localScope, overrides: { behavior: { keywordCase: 'lower' } } }]
  }
  for (const sql of [
    'WITH customers AS (SELECT id, status FROM public.customers) SELECT physical_| FROM customers',
    'SELECT physical_| FROM (SELECT id, status FROM public.customers) customers'
  ]) {
    assert.equal(complete(sql, {}, raw).some(item => item.label === 'physical_only'), false)
    assert.equal(complete(sql.replace('physical_|', 'physical_only(|)'), {}, raw).some(item => item.source === 'signature'), false)
    assert.equal(complete(sql.replace('physical_|', 'id') + ' WHERE status = |', {}, raw).some(item => item.label === "'physical'"), false)
    assert.equal(complete(sql.replace('physical_|', 'id') + ' WHERE phys|', {}, raw).some(item => item.id === 'template:physical-filter'), false)
    const text = sql.replace('physical_|', '|'), cursor = text.indexOf('|')
    const request = { sql: text.replace('|', ''), cursor, connectionId: 'dev', dialect: 'postgres', schema: 'public', database: 'app' }
    const config = resolveConfig(raw, { ...request, dialectId: 'postgres' })
    assert.equal(buildCompletion(request, { config, catalog }).config.keywordCase, 'upper')
  }
})
