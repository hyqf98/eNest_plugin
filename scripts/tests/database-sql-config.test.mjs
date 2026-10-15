import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, normalizeConfig, validateConfig, resolveConfig, fingerprintConfig, scopeMatches, mergeConfig, configConnectionIds } from '../../plugins/com.enest.database/src/js/sql-intelligence/configuration/index.js'

test('defaults are immutable, normalized copies do not share mutable arrays', () => {
  const first = normalizeConfig()
  const second = normalizeConfig()
  first.templates[0].label = 'Changed'
  first.ranking.pinned.push('one')
  assert.notEqual(second.templates[0].label, 'Changed')
  assert.deepEqual(second.ranking.pinned, [])
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.behavior))
  assert.deepEqual(validateConfig(first), [])
})

test('legacy preferences migrate only when not replaced by the new configuration', () => {
  assert.equal(normalizeConfig({}, { autoAliasAfterTable: true, learnUsage: false }).behavior.autoAlias, true)
  assert.equal(normalizeConfig({}, { autoAliasAfterTable: true, learnUsage: false }).behavior.learnUsage, false)
  const config = normalizeConfig({ behavior: { autoAlias: false, learnUsage: true } }, { autoAliasAfterTable: true, learnUsage: false })
  assert.equal(config.behavior.autoAlias, false)
  assert.equal(config.behavior.learnUsage, true)
})

test('invalid configuration is rejected instead of silently discarding user settings', () => {
  assert.throws(() => normalizeConfig({ behavior: { delayMs: -1 } }), error => error.issues[0].path === '$.behavior.delayMs')
  assert.equal(validateConfig({ schemaVersion: 99 })[0].path, '$.schemaVersion')
  assert.equal(validateConfig({ metadata: { ttlMs: '5000' } })[0].path, '$.metadata.ttlMs')
  assert.equal(validateConfig({ behavior: { automatic: 'yes' } })[0].path, '$.behavior.automatic')
})

test('unknown keys, prototype injection, large configuration and duplicate IDs are rejected', () => {
  assert.ok(validateConfig(JSON.parse('{"__proto__":{"polluted":true}}')).some(issue => issue.message === '未知配置项'))
  assert.ok(validateConfig({ behavior: { runJavaScript: 'alert(1)' } }).length)
  assert.ok(validateConfig({ functions: [{ id: 'fn', name: 'one', signature: 'one()' }, { id: 'fn', name: 'two', signature: 'two()' }] }).some(issue => issue.message === 'ID 重复'))
  assert.ok(validateConfig({ giant: 'a'.repeat(270000) }).some(issue => issue.message.includes('256 KB')))
  assert.equal({}.polluted, undefined)
})

test('scoped profiles apply in specificity order, keeping a visible provenance', () => {
  const input = { behavior: { keywordCase: 'upper' }, profiles: [
    { id: 'table', label: '客户表', scope: { table: 'customers' }, overrides: { behavior: { keywordCase: 'preserve' } } },
    { id: 'dialect', label: 'PG', scope: { dialectId: 'postgres' }, overrides: { behavior: { keywordCase: 'lower', delayMs: 30 } } },
    { id: 'connection', label: '订单连接', scope: { connectionId: 'orders' }, overrides: { behavior: { delayMs: 50 } } }
  ] }
  const resolved = resolveConfig(input, { dialectId: 'postgres', connectionId: 'orders', table: 'customers' })
  assert.equal(resolved.behavior.keywordCase, 'preserve')
  assert.equal(resolved.behavior.delayMs, 50)
  assert.equal(resolved._sources['behavior.keywordCase'], '客户表')
  assert.equal(resolved._sources['behavior.delayMs'], '订单连接')
  assert.equal(resolveConfig(input, { dialectId: 'mysql' }).behavior.keywordCase, 'upper')
})

test('profile matching distinguishes null schema, same named tables and exact dialects', () => {
  assert.equal(scopeMatches({ schema: null }, {}), true)
  assert.equal(scopeMatches({ schema: null }, { schema: 'public' }), false)
  assert.equal(scopeMatches({ connectionId: 'a', table: 'users' }, { connectionId: 'b', table: 'users' }), false)
  assert.equal(scopeMatches({ dialectId: 'mysql' }, { dialectId: 'mariadb' }), false)
  assert.equal(scopeMatches({ table: 'Users' }, { table: 'users' }), false)
})

test('stable ID overlays disable a builtin without removing other builtin templates', () => {
  const resolved = resolveConfig({ templates: [{ id: 'builtin.select-all', disabled: true }], profiles: [{ id: 'one', scope: { connectionId: 'a' }, overrides: { templates: [{ id: 'builtin.select-common', trigger: 'common' }] } }] }, { connectionId: 'a' })
  assert.equal(resolved.templates.length, 2)
  assert.equal(resolved.templates.find(item => item.id === 'builtin.select-all').disabled, true)
  assert.equal(resolved.templates.find(item => item.id === 'builtin.select-common').trigger, 'common')
  assert.equal(resolved.templates.find(item => item.id === 'builtin.select-common').generator, 'select')
})

test('field groups and configured functions are filtered to exact applicable scopes', () => {
  const input = {
    columnSets: [{ id: 'customer.list', label: '客户列表', scope: { connectionId: 'a', database: 'main', table: 'customers' }, columns: ['id', 'name'], order: 'configured' }],
    functions: [{ id: 'custom', name: 'FIND_USER', signature: 'FIND_USER(id)', dialects: ['postgres'] }]
  }
  assert.equal(resolveConfig(input, { connectionId: 'a', database: 'main', table: 'customers', dialectId: 'postgres' }).columnSets.length, 1)
  assert.equal(resolveConfig(input, { connectionId: 'b', database: 'main', table: 'customers' }).columnSets.length, 0)
  assert.equal(resolveConfig(input, { dialectId: 'mysql' }).functions.length, 0)
})

test('field groups require unique nonempty fields and a table scope', () => {
  assert.ok(validateConfig({ columnSets: [{ id: 'empty', label: 'Empty', scope: {}, columns: [] }] }).some(issue => issue.path.endsWith('.scope.table')))
  assert.ok(validateConfig({ columnSets: [{ id: 'duplicate', label: 'Duplicate', scope: { table: 't' }, columns: ['id', 'id'] }] }).some(issue => issue.path.endsWith('.columns')))
})

test('templates support numbered placeholders and reject executable interpolation', () => {
  const template = { id: 'snippet', label: 'Query', trigger: 'selx', generator: 'snippet', body: 'SELECT ${1:column} FROM ${2:table}; $0' }
  assert.deepEqual(validateConfig({ templates: [template] }), [])
  assert.ok(validateConfig({ templates: [{ ...template, body: 'SELECT ${process.env.SECRET}' }] }).some(issue => issue.path.endsWith('.body')))
  assert.ok(validateConfig({ templates: [{ ...template, trigger: 'two words' }] }).some(issue => issue.path.endsWith('.trigger')))
})

test('static enum values preserve JSON scalar types', () => {
  const config = normalizeConfig({ enums: [{ id: 'status', scope: { table: 'users' }, column: 'status', values: ['new', 2, false, null] }] })
  assert.deepEqual(config.enums[0].values, ['new', 2, false, null])
  assert.ok(validateConfig({ enums: [{ id: 'status', scope: {}, column: 'status', values: [{ execute: 'query' }] }] }).length)
})

test('config fingerprint ignores object property order and resolution annotations', () => {
  assert.equal(fingerprintConfig({ behavior: { automatic: true, delayMs: 70 } }), fingerprintConfig({ behavior: { delayMs: 70, automatic: true }, _sources: {} }))
  assert.notEqual(fingerprintConfig({ behavior: { delayMs: 70 } }), fingerprintConfig({ behavior: { delayMs: 80 } }))
  assert.notEqual(fingerprintConfig({ a: ['x', 'y'] }), fingerprintConfig({ a: ['y', 'x'] }))
})

test('import strategies preserve unrelated rules and handle explicit ID conflicts', () => {
  const current = { functions: [{ id: 'same', name: 'OLD', signature: 'OLD()' }, { id: 'local', name: 'LOCAL', signature: 'LOCAL()' }] }
  const incoming = { functions: [{ id: 'same', name: 'NEW', signature: 'NEW()' }, { id: 'remote', name: 'REMOTE', signature: 'REMOTE()' }] }
  const replace = mergeConfig(current, incoming, 'replace')
  assert.equal(replace.functions.find(item => item.id === 'same').name, 'NEW')
  assert.equal(replace.functions.length, 3)
  const keep = mergeConfig(current, incoming, 'keep')
  assert.equal(keep.functions.find(item => item.id === 'same').name, 'OLD')
  assert.equal(keep.functions.length, 3)
})

test('import connection mapping includes nested override rules', () => {
  assert.deepEqual(configConnectionIds({ columnSets: [{ scope: { connectionId: 'one' } }], profiles: [{ scope: { connectionId: 'two' }, overrides: { enums: [{ scope: { connectionId: 'three' } }] } }] }), ['one', 'two', 'three'])
})

test('partial scoped items require an inherited definition; new IDs must be complete', () => {
  const profile = { id: 'pg', scope: { dialectId: 'postgres' }, overrides: { functions: [{ id: 'new' }] } }
  assert.ok(validateConfig({ profiles: [profile] }).some(issue => issue.path === '$.profiles[0].overrides.functions[0].name'))
  assert.deepEqual(validateConfig({ functions: [{ id: 'new', name: 'CUSTOM', signature: 'CUSTOM(value)' }], profiles: [profile] }), [])
  assert.ok(validateConfig({ functions: [{ id: 'new', disabled: true }], profiles: [{ ...profile, overrides: { functions: [{ id: 'new', disabled: false }] } }] }).some(issue => issue.path.endsWith('.name')))
  assert.ok(validateConfig({ profiles: [{ ...profile, overrides: { templates: [{ id: 'new-template', trigger: 'short' }] } }] }).some(issue => issue.path.endsWith('.generator')))
})
