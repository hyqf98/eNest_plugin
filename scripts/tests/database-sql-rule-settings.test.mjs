import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, validateConfig } from '../../plugins/database/src/js/sql-intelligence/configuration/index.js'
const { enumValueDraft, parseEnumValue, updateScope, updateOverride, inheritedProfileConfig } = await import('@db/sql-intelligence/settings/ruleModel.js')

test('typed enum form values preserve scalars, strings and escaped SQL text', () => {
  for (const value of ['', 'null', 'true', '001', "O'Reilly", 0, -2.5, 1000, false, true, null]) assert.deepEqual(parseEnumValue(enumValueDraft(value)), { value })
  assert.deepEqual(parseEnumValue({ type: 'number', text: '1e3' }), { value: 1000 })
  for (const text of ['', ' ', 'Infinity', 'NaN', '1.2.3', '0xFF', '1e999']) assert.ok(parseEnumValue({ type: 'number', text }).error)
  assert.ok(parseEnumValue({ type: 'boolean', text: 'yes' }).error)
})

test('scope edits distinguish wildcard and null without deleting unrelated constraints', () => {
  const scope = { connectionId: 'dev', database: 'orders', schema: 'public', table: 'customers', serverVersion: '8.0' }
  updateScope(scope, 'schema', '', 'none')
  assert.equal(scope.schema, null)
  updateScope(scope, 'database', '', 'any')
  assert.equal(Object.hasOwn(scope, 'database'), false)
  updateScope(scope, 'connectionId', 'reporting')
  assert.deepEqual(scope, { connectionId: 'reporting', schema: null, table: 'customers', serverVersion: '8.0' })
})

test('per-property reset restores inheritance while keeping other imported overrides', () => {
  const profile = { overrides: { behavior: { automatic: false, delayMs: 110 }, ranking: { pinned: ['special'] }, metadata: { prefetch: 'none' }, functions: [{ id: 'legacy', disabled: true }] } }
  updateOverride(profile, 'behavior.automatic', true, false)
  assert.deepEqual(profile.overrides.behavior, { delayMs: 110 })
  updateOverride(profile, 'behavior.delayMs', 70, false)
  assert.equal(Object.hasOwn(profile.overrides, 'behavior'), false)
  assert.deepEqual(profile.overrides.ranking, { pinned: ['special'] })
  assert.deepEqual(profile.overrides.metadata, { prefetch: 'none' })
  assert.deepEqual(profile.overrides.functions, [{ id: 'legacy', disabled: true }])
  updateOverride(profile, 'diagnostics.selectStar', 'off')
  assert.deepEqual(profile.overrides.diagnostics, { selectStar: 'off' })
})

test('profile inheritance reflects engine specificity and only preceding same-level rules', () => {
  const config = normalizeConfig({ profiles: [
    { id: 'table', label: '表', scope: { connectionId: 'a', table: 't' }, overrides: { behavior: { delayMs: 180 } } },
    { id: 'dialect', label: '方言', scope: { dialectId: 'mysql' }, overrides: { behavior: { delayMs: 80, keywordCase: 'lower' } } },
    { id: 'first', label: '连接一', scope: { connectionId: 'a' }, overrides: { behavior: { delayMs: 100 } } },
    { id: 'second', label: '连接二', scope: { connectionId: 'a' }, overrides: { behavior: { delayMs: 120 } } }
  ] })
  const inherited = inheritedProfileConfig(config, config.profiles[3], { dialectId: 'mysql', table: 't' })
  assert.equal(inherited.behavior.delayMs, 100)
  assert.equal(inherited.behavior.keywordCase, 'lower')
  assert.equal(inherited._sources['behavior.delayMs'], '连接一')
  assert.equal(inheritedProfileConfig(config, config.profiles[0], { dialectId: 'mysql' }).behavior.delayMs, 120)
})

test('visual rule data supports full JSON round trip with scoped advanced data intact', () => {
  const config = normalizeConfig({
    functions: [{ id: 'mask', name: 'MASK_PHONE', signature: 'MASK_PHONE(phone)', description: '手机号脱敏', dialects: ['mysql'], scope: { connectionId: 'dev', serverVersion: '8.0' } }],
    enums: [{ id: 'status', column: 'status', scope: { connectionId: 'dev', schema: null, table: 'customers' }, values: ['new', 1, false, null] }],
    profiles: [{ id: 'dev', scope: { connectionId: 'dev' }, overrides: { metadata: { prefetch: 'none' }, templates: [{ id: 'builtin.select-all', disabled: true }] } }]
  })
  updateOverride(config.profiles[0], 'behavior.automatic', false)
  updateScope(config.functions[0].scope, 'database', 'orders')
  const copy = JSON.parse(JSON.stringify(config))
  assert.deepEqual(validateConfig(copy), [])
  assert.equal(copy.functions[0].scope.serverVersion, '8.0')
  assert.deepEqual(copy.profiles[0].overrides.templates, [{ id: 'builtin.select-all', disabled: true }])
})
