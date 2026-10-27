import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import './register-db-alias.mjs'

const stored = new Map()
globalThis.window = { enest: { storage: { set: async (key, value) => { stored.set(key, structuredClone(value)); return true } } } }
const facade = await import('@db/completion.js')
const { state, flushPendingPersist } = await import('@db/store.js')
let opened = 0
await facade.configureCompletionRuntime({ open: async () => { opened++; return {} }, close: async () => {} })
const scope = { connectionId: 'first', consoleId: 'query', dialect: 'mysql', database: 'orders', connected: false }
after(async () => { await facade.disposeCompletionRuntime(); await flushPendingPersist() })

test('offline completion stays local and accepted engine IDs persist per target', async () => {
  const request = { ...scope, sql: 'SEL', cursor: 3 }
  const response = await facade.requestCompletion(request)
  const selected = response.items.find(item => item.label === 'SELECT')
  assert.ok(selected)
  facade.applyCompletionItem(selected)
  assert.equal(state.completionUsage[selected._usageKey], 1)
  const second = await facade.requestCompletion({ ...request, connectionId: 'second' })
  assert.notEqual(second.items.find(item => item.label === 'SELECT')._usageKey, selected._usageKey)
  assert.equal(opened, 0)
  await flushPendingPersist()
  assert.equal(stored.get('db.completionUsage')[selected._usageKey], 1)
})

test('context guards change with document target, dialect, search path and saved configuration', () => {
  const key = facade.completionContextKey(scope)
  assert.notEqual(key, facade.completionContextKey({ ...scope, dialect: 'sqlite' }))
  assert.notEqual(key, facade.completionContextKey({ ...scope, searchPath: ['audit'] }))
  assert.notEqual(key, facade.completionContextKey({ ...scope, documentId: 'another' }))
  state.ui.completion = { behavior: { automatic: false } }
  assert.notEqual(key, facade.completionContextKey(scope))
})

test('editor behavior inherits matching scopes and a scoped learning override is honored', async () => {
  state.ui.completion = { behavior: { automatic: false, learnUsage: false }, profiles: [{ id: 'mysql-first', scope: { connectionId: 'first' }, overrides: { behavior: { automatic: true, delayMs: 120, learnUsage: true } } }] }
  assert.equal(facade.getCompletionBehavior(scope).automatic, true)
  assert.equal(facade.getCompletionBehavior(scope).delayMs, 120)
  assert.equal(facade.getCompletionBehavior({ ...scope, connectionId: 'second' }).automatic, false)
  const response = await facade.requestCompletion({ ...scope, sql: 'SEL', cursor: 3 })
  const item = response.items.find(candidate => candidate.label === 'SELECT'), before = state.completionUsage[item._usageKey]
  facade.applyCompletionItem(item)
  assert.equal(state.completionUsage[item._usageKey], before + 1)
})
