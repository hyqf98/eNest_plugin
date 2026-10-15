import { state, setUiPref } from './store.js'

/** Only serializable navigation descriptors belong here; sessions, results and models stay runtime-owned. */
const kinds = new Set(['query', 'object', 'structure', 'resources', 'compare', 'documents', 'history', 'settings'])
const fields = ['id', 'kind', 'title', 'connectionId', 'consoleId', 'editorId', 'database', 'schema', 'objectType', 'objectName', 'view', 'origin']
const descriptor = (input) => Object.fromEntries(fields.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))

export function initWorkspace() {
  const saved = state.ui.workspace
  const valid = saved?.version === 1 && Array.isArray(saved.tabs)
  const tabs = valid ? saved.tabs.filter((tab) => {
    if (!tab || !kinds.has(tab.kind) || typeof tab.id !== 'string') return false
    if (tab.consoleId && !state.sessions.some((session) => session.id === tab.consoleId)) return false
    if (tab.connectionId && !state.connections.some((conn) => conn.id === tab.connectionId)) return false
    if (['query', 'object'].includes(tab.kind)) return state.sessions.some((session) => session.id === tab.consoleId && session.editors.some((editor) => editor.id === tab.editorId))
    return true
  }).map(descriptor) : state.sessions.flatMap((session) => session.editors.map((editor) => queryDescriptor(session, editor)))
  const unique = [...new Map(tabs.map((tab) => [tab.id, tab])).values()]
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
  const preferred = valid ? saved.activeTabId : activeSession ? `query:${activeSession.activeEditorId}` : null
  state.ui.workspace = { version: 1, tabs: unique, activeTabId: unique.some((tab) => tab.id === preferred) ? preferred : unique[0]?.id || null }
  // Persisting restoration must never open a database or execute a statement.
  persistWorkspace()
  return state.ui.workspace
}

export function getWorkspace() { return state.ui.workspace?.version === 1 ? state.ui.workspace : initWorkspace() }
export function activeWorkspaceTab() { const workspace = getWorkspace(); return workspace.tabs.find((tab) => tab.id === workspace.activeTabId) || null }
export function persistWorkspace() { const workspace = state.ui.workspace; if (workspace) setUiPref('workspace', workspace) }

export function openWorkspaceTab(input, { activate = true } = {}) {
  const workspace = getWorkspace()
  input = { ...input }
  if (!input.id) input.id = input.kind === 'query' ? `query:${input.editorId}` : input.kind === 'object' ? objectTabId(input.connectionId, input.database, input.schema, input.objectType, input.objectName, input.origin) : ['resources', 'structure'].includes(input.kind) ? `${input.kind}:${JSON.stringify([input.connectionId || '', input.consoleId || ''])}` : input.kind
  const tab = workspace.tabs.find((item) => item.id === input.id)
  if (tab) Object.assign(tab, descriptor(input))
  else workspace.tabs.push(descriptor(input))
  if (activate) workspace.activeTabId = input.id
  persistWorkspace()
  return getWorkspace().tabs.find((item) => item.id === input.id)
}

export function activateWorkspaceTab(id) {
  const workspace = getWorkspace()
  if (!workspace.tabs.some((tab) => tab.id === id)) return null
  workspace.activeTabId = id
  persistWorkspace()
  return activeWorkspaceTab()
}

export function removeWorkspaceTab(id) {
  const workspace = getWorkspace(), index = workspace.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  workspace.tabs.splice(index, 1)
  if (workspace.activeTabId === id) workspace.activeTabId = workspace.tabs[Math.min(index, workspace.tabs.length - 1)]?.id || null
  persistWorkspace()
}

export function moveWorkspaceTab(id, beforeId) {
  const workspace = getWorkspace(), index = workspace.tabs.findIndex((tab) => tab.id === id)
  if (index < 0 || id === beforeId) return
  const [tab] = workspace.tabs.splice(index, 1), target = workspace.tabs.findIndex((item) => item.id === beforeId)
  workspace.tabs.splice(target < 0 ? workspace.tabs.length : target, 0, tab)
  persistWorkspace()
}

export function queryDescriptor(session, editor) {
  return descriptor({ id: `query:${editor.id}`, kind: 'query', title: editor.title, connectionId: session.connectionId, consoleId: session.id, editorId: editor.id, database: session.database || '', schema: session.schema || '', origin: session.origin || 'shell' })
}
export function ensureQueryTab(session, editor, options) { return session && editor ? openWorkspaceTab(queryDescriptor(session, editor), options) : null }
export function objectTabId(connectionId, database, schema, type, name, origin = 'shell') { return `object:${JSON.stringify([connectionId, database || '', schema || '', type || 'table', name, origin])}` }
