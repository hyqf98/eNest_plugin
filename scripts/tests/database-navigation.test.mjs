import test from 'node:test'
import assert from 'node:assert/strict'

const saved = new Map()
globalThis.window = { enest: {
  storage: { get: async key => saved.get(key), set: async (key, value) => { saved.set(key, structuredClone(value)); return true } },
  db: { open: () => assert.fail('restoring navigation must not connect'), execute: () => assert.fail('restoring navigation must not execute') }
} }
const { state, flushPendingPersist, loadAll } = await import('../../plugins/database/src/js/store.js')
const { initWorkspace, openWorkspaceTab, moveWorkspaceTab, removeWorkspaceTab, objectTabId } = await import('../../plugins/database/src/js/workspaceState.js')
delete globalThis.window

function legacy() {
  state.connections = [{ id: 'dev' }, { id: 'analytics' }]
  state.sessions = [
    { id: 'console-a', connectionId: 'dev', database: 'orders', activeEditorId: 'sql-a', editors: [{ id: 'sql-a', title: '订单.sql', sql: 'SELECT * FROM orders;' }] },
    { id: 'console-b', connectionId: 'analytics', database: 'reports', activeEditorId: 'sql-b', editors: [{ id: 'sql-b', title: '统计.sql', sql: 'SELECT count(*) FROM events;' }] }
  ]
  state.activeSessionId = 'console-b'
  state.ui = { leftWidth: 310, sidebarCollapsed: true, treeExpanded: ['dev/root'] }
}

test('legacy consoles migrate to query tabs with document identity and active selection intact', async () => {
  legacy()
  const sql = state.sessions.map(session => session.editors[0].sql)
  const workspace = initWorkspace()
  assert.equal(workspace.version, 1)
  assert.deepEqual(workspace.tabs.map(tab => [tab.id, tab.consoleId, tab.database]), [['query:sql-a', 'console-a', 'orders'], ['query:sql-b', 'console-b', 'reports']])
  assert.equal(workspace.activeTabId, 'query:sql-b')
  assert.deepEqual(state.sessions.map(session => session.editors[0].sql), sql)
  assert.equal(state.ui.leftWidth, 310)
  await flushPendingPersist()
})

test('workspace restore filters deleted targets, keeps order, and allows a deliberately empty tab strip', async () => {
  legacy()
  state.ui.workspace = { version: 1, activeTabId: 'missing', tabs: [
    { id: 'settings', kind: 'settings', title: '设置', runtimeResult: { rows: ['private data'] } },
    { id: 'missing', kind: 'query', consoleId: 'deleted', editorId: 'sql-a' },
    { id: 'query:sql-b', kind: 'query', consoleId: 'console-b', editorId: 'sql-b', connectionId: 'analytics' },
    { id: 'settings', kind: 'settings', title: '设置' }
  ] }
  const workspace = initWorkspace()
  assert.deepEqual(workspace.tabs.map(tab => tab.id), ['settings', 'query:sql-b'])
  assert.equal(workspace.activeTabId, 'settings')
  assert.equal('runtimeResult' in workspace.tabs[0], false)
  removeWorkspaceTab('settings'); removeWorkspaceTab('query:sql-b')
  assert.deepEqual(initWorkspace().tabs, [])
  assert.equal(state.sessions.length, 2, 'closing navigation retains the saved documents')
  await flushPendingPersist()
})

test('object identity includes full path and origin while persisted state excludes results and live transactions', async () => {
  legacy(); initWorkspace()
  const id = objectTabId('dev', 'orders', 'public', 'table', 'customers')
  assert.notEqual(id, objectTabId('dev', 'archive', 'public', 'table', 'customers'))
  assert.notEqual(id, objectTabId('dev', 'orders', 'public', 'view', 'customers'))
  assert.notEqual(id, objectTabId('dev', 'orders', 'public', 'table', 'customers', 'quick'))
  const input = { id, kind: 'object', title: 'customers', consoleId: 'console-a', editorId: 'sql-a', connectionId: 'dev', database: 'orders', schema: 'public', objectType: 'table', objectName: 'customers', rows: ['never persist'] }
  const first = openWorkspaceTab(input), again = openWorkspaceTab(input)
  assert.equal(first, again)
  assert.equal(state.ui.workspace.tabs.length, 3)
  moveWorkspaceTab(id, 'query:sql-a')
  assert.equal(state.ui.workspace.tabs[0].id, id)
  state.sessions[0].transactionActive = true
  state.runtime.consoleSessionKeys.set('console-a', 'live-transport')
  state.results.set('sql-a', { rows: ['never persist'] })
  await flushPendingPersist()
  assert.equal(saved.get('db.sessions')[0].transactionActive, undefined)
  assert.equal(saved.get('db.ui').workspace.tabs[0].rows, undefined)
  assert.equal(saved.get('db.ui').workspace.tabs[0].consoleId, 'console-a')
  state.runtime.consoleSessionKeys.clear(); state.results.clear()
  await loadAll()
  assert.equal(state.sessions[0].transactionActive, false)
  assert.equal(initWorkspace().tabs[0].id, id)
  assert.equal(state.runtime.consoleSessionKeys.size, 0)
  await flushPendingPersist()
})
