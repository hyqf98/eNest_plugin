import './register-db-alias.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
const { settingsMetadataScope } = await import('../src/js/sql-intelligence/settings/metadataScope.js')
const active = { connectionId: 'dev', database: 'working', schema: 'public', consoleId: 'query', sessionKey: 'user', generation: 4, connected: true }
const connection = { id: 'dev', driver: 'postgres', database: 'default', schema: 'public' }

test('settings metadata preserves explicit empty namespaces and inherits only omitted namespaces', () => {
  const empty = settingsMetadataScope({ database: null, schema: null }, active, connection, 'shell')
  assert.equal(empty.database, ''); assert.equal(empty.schema, '')
  const inherited = settingsMetadataScope({}, active, connection, 'shell')
  assert.equal(inherited.database, 'working'); assert.equal(inherited.schema, 'public')
})

test('selecting another connection uses its namespaces and isolated metadata context', () => {
  const other = { id: 'analytics', driver: 'postgres', database: 'warehouse', schema: 'audit' }
  const scope = settingsMetadataScope({ connectionId: 'analytics' }, active, other, 'quick')
  assert.equal(scope.database, 'warehouse'); assert.equal(scope.schema, 'audit')
  assert.equal(scope.sessionKey, ''); assert.equal(scope.consoleId, 'settings:analytics')
  assert.equal(scope.generation, 0); assert.equal(scope.connected, false)
  assert.equal(settingsMetadataScope({}, active, other, 'quick', true).connected, true)
})
