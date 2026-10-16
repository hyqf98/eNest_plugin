/**
 * main.js — 数据库插件入口
 * 数据：enest.storage KV；密钥：enest.vault.set → secretRef
 * Host：db.* Spec 方法名；宿主滞后 try/catch → toast/状态
 * UI：连接与对象一体导航；统一工作标签；上下文工具栏与独立结果状态
 */
import {
  api,
  applyShellTheme,
  registerPluginSettings,
  setFollowShellTheme,
  DbHost,
  Vault,
  toast,
  notify,
  setTitle,
  hostLag,
  toConnectionInput,
  sessionKeyOf,
  StorageKeys,
  saveTextFile,
  clipboardWrite
} from './api.js'
import { enhanceSelect } from './dropdown.js'
import {
  state,
  loadAll,
  persistNow,
  flushPendingPersist,
  activeSession,
  activeEditor,
  getConnection,
  upsertConnection,
  saveConnection,
  removeConnection,
  duplicateConnection,
  createSession,
  createEditorTab,
  setActiveSession,
  renameSession,
  togglePinSession,
  deleteSession,
  duplicateSession,
  updateSessionEditorSql,
  saveSessionsImmediate,
  schedulePersistSessions,
  pushHistory,
  getResultState,
  setUiPref,
  uid
} from './store.js'
import { SqlEditor } from './monacoEditor.js'
import { completionDialect, createCompletionConsoleLifecycle } from '@db/sql-intelligence/runtime/consoleLifecycle.js'
import { createCatalogReader } from '@db/sql-intelligence/metadata/CatalogReader.js'
import { DatabaseWorkbench } from './workbench.js'
import { runDatabaseTask } from './operationTask.js'
import { initWorkspace, getWorkspace, activeWorkspaceTab, ensureQueryTab, objectTabId, persistWorkspace, removeWorkspaceTab } from './workspaceState.js'
import { createDialog, bindDockResize } from '@enest/plugin-kit/workbench'
import { isReadQuery } from './comparison.js'
import { planSqlScript, maskSql } from './executionParser.js'
import { objectQuery, qualifiedName } from './queryTemplates.js'
import { objectPolicy } from './databaseObjectDetails.js'
import { ResultGrid } from './resultGrid.js'
import {
  kindMeta,
  configureCompletionRuntime,
  getCompletionCatalog,
  warmCompletionCatalog,
  captureCompletionMetadataRead,
  publishCompletionTable,
  invalidateCompletionContext,
  recordCompletionExecution,
  disposeCompletionRuntime
} from './completion.js'
import { SidePanel, driverLabel } from './schemaTree.js'
import {
  createImportWizard,
  exportResult,
  copyResult,
  exportConnections,
  exportSessions,
  exportHistory
} from './importExport.js'
import { detectDangerousSql } from './tokenizer.js'
import { openCtxMenu, closeCtxMenu } from './ctxMenu.js'
import { bindIconTips, setTip } from './tips.js'

const $ = (sel) => document.querySelector(sel)
const dom = {
  app: $('#app'),
  side: $('#side'),
  sideToggle: $('#side-toggle'),
  topMore: $('#top-more'),
  editorTabs: $('#editor-tabs'),
  toolbar: $('#toolbar'),
  editorHost: $('#editor-host'),
  results: $('#results'),
  resizerBottom: $('#resizer-bottom'),
  statusbar: $('#statusbar'),
  rightPanel: $('#right-panel'),
  modalRoot: $('#modal-root'),
  toastLocal: $('#local-toast'),
  fabRun: $('#fab-run')
}

let editor = null
let grid = null
let side = null
let rightMode = 'changes'
let workbench = null
let displayedResult = null
let displayedResultData = null
const connectingConsoles = new Map()
const consoleGenerations = new Map()
const warmingCatalogs = new Map()
const transactionWrites = new Map()
const completionContexts = new Map()
const connectionConfigRevisions = new Map()
const completionConsoleLifecycle = createCompletionConsoleLifecycle({
  sessionKeys: state.runtime.consoleSessionKeys,
  generations: consoleGenerations,
  contexts: completionContexts,
  close: sessionKey => DbHost.close(sessionKey),
  invalidate: invalidateCompletionContext
})

/** A completion request belongs to its document and console, never the selected tree row. */
function completionScopeFor(session = currentSession(), connection = getConnection(session?.connectionId), overrides = {}) {
  const context = completionContexts.get(session?.id)
  const sessionKey = state.runtime.consoleSessionKeys.get(session?.id) || ''
  return {
    connection,
    connectionId: connection?.id || '',
    consoleId: session?.id || '',
    sessionKey,
    dialect: completionDialect(connection),
    database: session?.database ?? connection?.database,
    schema: session?.schema ?? connection?.schema,
    connected: !!sessionKey && !completionConsoleLifecycle.isClosing(session?.id) && !(workbench?.mode === 'quick' && session?.origin !== 'quick'),
    contextKnown: context?.contextKnown !== false,
    contextRevision: context?.sessionContextRevision || 0,
    sessionContextRevision: context?.sessionContextRevision || 0,
    configRevision: connectionConfigRevisions.get(connection?.id) || 0,
    generation: consoleGenerations.get(session?.id) || 0,
    documentId: session?.activeEditorId || '',
    surface: session?.origin === 'quick' ? 'quick' : workbench?.mode || 'shell',
    usageBoost: state.completionUsage,
    autoAliasAfterTable: state.ui.autoAliasAfterTable !== false,
    ...overrides
  }
}

function completionScopeFromSessionKey(sessionKey) {
  const session = state.sessions.find(item => state.runtime.consoleSessionKeys.get(item.id) === sessionKey)
  return session ? completionScopeFor(session) : { sessionKey, connected: false, contextKnown: false }
}

async function recordExecutionForCompletion(context, sql, success, sessionKey) {
  const scope = completionScopeFor(context.session, context.connection, { documentId: context.editor?.id || context.session?.activeEditorId, sessionKey, connected: !!sessionKey, surface: context.surface || context.session?.origin || 'shell', generation: context.generation })
  try {
    const result = await recordCompletionExecution(scope, { sql, success })
    if (contextValid(context) && result) completionContexts.set(context.session.id, {
      contextKnown: result.contextKnown !== false,
      sessionContextRevision: result.sessionContextRevision ?? scope.sessionContextRevision
    })
  } catch { /* Completion learning cannot change the outcome of a database execution. */ }
}

function invalidateConnectionCompletion(connectionId, reason, preserveSession = true) {
  void invalidateCompletionContext({ connectionId, preserveSession }, reason).catch(() => {})
}

function captureVisibleGrid() {
  // display:none collapses scroll offsets; keep the snapshot captured before hiding.
  if (displayedResult && grid?.el.viewport.getClientRects().length) displayedResult.gridSnapshot = grid.captureState()
}
function contextForTab(tab = activeWorkspaceTab()) {
  const session = tab?.consoleId ? state.sessions.find((item) => item.id === tab.consoleId) : tab ? null : currentSession()
  const document = session?.editors.find((item) => item.id === (tab?.editorId || session.activeEditorId))
  const connection = getConnection(tab?.connectionId || session?.connectionId || state.selectedConnectionId)
  return { tabId: tab?.id, session, editor: document, connection, sessionKey: state.runtime.consoleSessionKeys.get(session?.id) || '', surface: workbench?.mode || 'shell', generation: consoleGenerations.get(session?.id) || 0 }
}
function operationContext() {
  const context = contextForTab()
  const resultState = context.editor ? getResultState(context.editor.id) : null
  return { ...context, resultState, resultTab: resultState?.tabs?.[resultState.activeTab] }
}
function contextValid(context) { return state.sessions.includes(context.session) && (consoleGenerations.get(context.session?.id) || 0) === context.generation && (!context.tabId || getWorkspace().tabs.some((tab) => tab.id === context.tabId)) }
function activateTabContext(tab) {
  captureVisibleGrid()
  if (tab?.consoleId) {
    const session = state.sessions.find((item) => item.id === tab.consoleId)
    if (session) { setActiveSession(session.id); if (tab.editorId) session.activeEditorId = tab.editorId }
  }
  renderEditorValue(); renderResultTabs(); renderToolbar(); renderRightPanel(); side?.render()
}
async function closeWorkspaceDocument(tab) {
  const context = contextForTab(tab)
  if (state.runtime.activeQuery?.tabId === tab.id || state.runtime.activeQuery?.editorId === tab.editorId && tab.editorId) { showLocalToast('请先取消或等待此标签的任务完成', 'warn'); return false }
  captureVisibleGrid()
  const results = tab.editorId && state.results.get(tab.editorId)
  if (results?.tabs.some((result) => result.gridSnapshot && snapshotHasChanges(result.gridSnapshot))) { showLocalToast('请先提交或放弃此标签的数据变更', 'warn'); return false }
  if (context.session?.transactionActive && !getWorkspace().tabs.some((other) => other.id !== tab.id && other.consoleId === context.session.id)) { showLocalToast('此控制台仍有事务，请先提交或回滚', 'warn'); return false }
  try {
    await flushPendingPersist()
    if (context.session && !getWorkspace().tabs.some((other) => other.id !== tab.id && other.consoleId === context.session.id)) await closeConsole(context.session)
  } catch (error) { showLocalToast(error.message, 'error'); return false }
  if (tab.editorId) { editor.releaseDocument(tab.editorId); state.results.delete(tab.editorId) }
  if (displayedResult && results?.tabs.includes(displayedResult)) { displayedResult = null; displayedResultData = null }
  return true
}
function snapshotHasChanges(snapshot) {
  const rows = snapshot.rowState instanceof Map ? snapshot.rowState : new Map(Object.entries(snapshot.rowState || {}).map(([key, value]) => [Number(key), value]))
  return [...rows.values()].some(row => row.status && row.status !== 'clean') || (snapshot.insertedRows || []).some(row => !rows.get(row._idx)?.committedInsert)
}
function consoleHasLocalChanges(session) {
  return session?.editors.some(document => state.results.get(document.id)?.tabs.some(result => result.gridSnapshot && snapshotHasChanges(result.gridSnapshot)))
}
function invalidateConsoleResults(session) {
  for (const document of session.editors) {
    const results = state.results.get(document.id)
    if (!results) continue
    if (results.tabs.includes(displayedResult)) { displayedResult = null; displayedResultData = null }
    results.tabs = []; results.activeTab = 0; results.error = ''
  }
}
async function reconcileFailedExecution(context, { sessionKey, rollsBack, changesTransaction }) {
  if (!sessionKey || !contextValid(context)) return
  if (rollsBack) invalidateConsoleResults(context.session)
  try {
    const sessions = await DbHost.listSessions()
    if (!Array.isArray(sessions)) throw new Error('无法读取控制台状态')
    if (!contextValid(context)) return
    const live = sessions.find(session => session.sessionKey === sessionKey)
    context.session.transactionActive = !!live?.transactionActive
    if (!live?.transactionActive) transactionWrites.delete(context.session.id)
    else if (rollsBack && transactionWrites.has(context.session.id)) transactionWrites.set(context.session.id, -1)
    if (!live) {
      state.runtime.consoleSessionKeys.delete(context.session.id)
      if (state.runtime.sessionKeys.get(context.connection.id) === sessionKey) state.runtime.sessionKeys.delete(context.connection.id)
      consoleGenerations.set(context.session.id, context.generation + 1)
      completionContexts.delete(context.session.id)
      invalidateConnectionCompletion(context.connection.id, '查询会话已断开', false)
    }
  } catch {
    // An older/unavailable host cannot prove a failed multi-statement batch did not begin a transaction.
    if (contextValid(context) && changesTransaction) { context.session.transactionActive = true; transactionWrites.set(context.session.id, -2) }
  }
}
function openDocument(sessionId, editorId) {
  captureVisibleGrid()
  const session = state.sessions.find((item) => item.id === sessionId)
  const document = session?.editors.find((item) => item.id === editorId)
  if (!document) return
  setActiveSession(session.id); session.activeEditorId = document.id
  workbench.openQuery(session, document); renderAll()
}
function openCurrentQuery() { const session = currentSession(), document = currentEditor(); if (session && document) workbench?.openQuery(session, document) }
async function newQueryDocument() {
  captureVisibleGrid()
  const session = currentSession()
  if (session && !quickDesktopPreview()) { createEditorTab(session); openCurrentQuery(); renderAll() }
  else await newSession(currentConnection()?.id)
}
async function historyAction(id, action) {
  const item = state.queryHistory.find((entry) => entry.id === id)
  if (!item) return
  if (action === 'copy') return clipboardWrite(item.sql)
  if (action === 'export') return exportHistory([item])
  if (!getConnection(item.connectionId)) return showLocalToast('原连接已删除，请先选择新的连接', 'warn')
  const session = await newSession(item.connectionId)
  if (!session) return
  currentEditor().sql = item.sql; schedulePersistSessions(); renderAll()
}
async function switchDatabase(database, sourceSession = currentSession()) {
  const connection = getConnection(sourceSession?.connectionId)
  if (!connection) return
  captureVisibleGrid()
  let session = state.sessions.find((item) => item.connectionId === connection.id && item.database === database && item.schema === sourceSession.schema && (item.origin || 'shell') === (sourceSession.origin || 'shell') && !item.objectContext)
  if (!session) { session = createSession({ connectionId: connection.id, database, schema: sourceSession.schema }); if (!session) return; session.origin = sourceSession.origin || 'shell' }
  setActiveSession(session.id); openCurrentQuery(); renderAll()
  await ensureConsoleConnected({ session, connection }); renderToolbar()
}
async function transaction(operation, sourceSession = currentSession()) {
  if (state.runtime.executing) throw new Error('请等待当前任务完成')
  const context = { session: sourceSession, connection: getConnection(sourceSession?.connectionId), generation: consoleGenerations.get(sourceSession?.id) || 0 }
  if (!context.session || context.connection?.readOnly || context.session.origin === 'quick') throw new Error('此控制台不可执行事务')
  const sessionKey = state.runtime.consoleSessionKeys.get(sourceSession.id)
  if (!sessionKey) throw new Error('请先连接此控制台')
  captureVisibleGrid()
  if (operation === 'rollback' && consoleHasLocalChanges(sourceSession)) throw new Error('此控制台还有本地待提交变更，请先写入事务或放弃本地变更，再回滚')
  state.runtime.executing = true; state.runtime.activeQuery = { sessionKey, consoleId: sourceSession.id, editorId: sourceSession.activeEditorId, kind: 'transaction' }; renderToolbar()
  refreshResultSurface()
  try {
    const result = await DbHost.transaction({ sessionKey, operation })
    if (contextValid(context)) {
      await recordExecutionForCompletion(context, operation.toUpperCase(), true, sessionKey)
      sourceSession.transactionActive = result.active ?? operation === 'begin'
      if (operation !== 'begin') transactionWrites.delete(sourceSession.id)
      if (operation === 'rollback') {
        // Values observed inside a rolled-back transaction are stale, including other query tabs.
        invalidateConsoleResults(sourceSession)
        if (currentSession()?.id === sourceSession.id) { renderResultTabs(); renderRightPanel() }
      }
    }
    return result
  }
  catch (error) { await recordExecutionForCompletion(context, operation.toUpperCase(), false, sessionKey); throw error }
  finally { state.runtime.executing = false; state.runtime.activeQuery = null; refreshResultSurface(); workbench?.update(); renderToolbar() }
}

function gridAvailable(action) {
  const tab = activeWorkspaceTab()
  if (!['query', 'object'].includes(tab?.kind) || !['query', 'object'].includes(workbench?.page) || !grid?.data) return false
  if (['selectAll', 'exportSelected'].includes(action)) return action === 'selectAll' || grid.selectedRows.size > 0
  if (grid.readOnly || !grid.editable || state.runtime.executing) return false
  if (action === 'commit') return currentConnected() && grid.hasPendingChanges()
  if (['duplicateRow', 'deleteRows', 'revertRows', 'editRows'].includes(action)) return grid.selectedRows.size > 0 || !!grid.cellSel
  return true
}
function gridAction(action) {
  if (!gridAvailable(action)) return false
  if (action === 'commit') return commitChanges()
  if (action === 'exportSelected') return openExportMenu('selected')
  const method = { selectAll: 'selectAllVisible', insertRow: 'insertRow', duplicateRow: 'duplicateSelectedRows', deleteRows: 'markDeleteSelected', revertRows: 'revertSelectedRows', editRows: 'openBulkEdit', paste: 'openPasteDialog' }[action]
  if (!method || typeof grid[method] !== 'function') return false
  grid[method](); syncDockFromGrid(); renderRightPanel(); return true
}


function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function currentSession() {
  return activeSession()
}
function currentEditor() {
  return activeEditor()
}
function currentConnection() {
  const s = currentSession()
  return s ? getConnection(s.connectionId) : getConnection(state.selectedConnectionId)
}
function currentSessionKey() {
  const conn = currentConnection()
  if (!conn) return ''
  return (
    state.runtime.consoleSessionKeys.get(currentSession()?.id) ||
    `${sessionKeyOf(conn.id, currentSession()?.database || conn.database)}::console:${currentSession()?.id || 'preview'}`
  )
}
function currentConnected() { return state.runtime.consoleSessionKeys.has(currentSession()?.id) }
function quickDesktopPreview() { return workbench?.mode === 'quick' && currentSession()?.origin !== 'quick' }
function consoleConnectionInput(conn, session, database) {
  const input = toConnectionInput(conn, { database })
  if (session?.origin === 'quick') { input.readOnly = true; input.options.readOnly = true }
  return input
}
function currentDialect() {
  return completionDialect(currentConnection())
}
function currentResultState() {
  const ed = currentEditor()
  return ed ? getResultState(ed.id) : null
}

function menuItems(pairs) {
  const out = []
  for (const it of pairs) {
    if (!it || (Array.isArray(it) && !it[0])) continue
    if (it === 'sep') {
      if (!out.length || out[out.length - 1] === 'sep') continue
      out.push(it)
      continue
    }
    out.push(it)
  }
  while (out.length && out[out.length - 1] === 'sep') out.pop()
  return out
}

/* ───────────── boot ───────────── */

async function boot() {
  bindIconTips()
  let schemaTaskConnectionId = null
  document.addEventListener('database-task-changed', () => {
    const task = state.runtime.activeQuery
    if (task?.kind === 'tableDesign') schemaTaskConnectionId = state.sessions.find(session => session.id === task.consoleId)?.connectionId
    else if (!task && schemaTaskConnectionId) {
      invalidateConnectionCompletion(schemaTaskConnectionId, '表结构设计已完成，请重新读取元数据')
      schemaTaskConnectionId = null
    }
    renderToolbar(); refreshResultSurface()
  })
  await registerPluginSettings()
  await applyShellTheme()
  await configureCompletionRuntime({
    open: input => DbHost.open(input),
    close: sessionKey => DbHost.close(sessionKey),
    listTables: createCatalogReader(input => DbHost.schema.tables(input)),
    describeTable: input => DbHost.schema.describe(input),
    toConfig: toConnectionInput,
    getScope: completionScopeFromSessionKey,
    onUpdate: (snapshot, scope) => {
      if (!['loading', 'unloaded'].includes(snapshot.status) && snapshot.pendingColumns === 0 && scope.sessionKey && scope.sessionKey === state.runtime.consoleSessionKeys.get(currentSession()?.id)) editor?.refreshCompletion?.(scope)
    }
  })
  try {
    await setTitle('数据库')
  } catch {
    /* ignore */
  }

  editor = new SqlEditor(dom.editorHost, {
    onChange: (sql, cursor) => {
      const ed = currentEditor()
      if (!ed) return
      updateSessionEditorSql(ed, sql, cursor)
      renderEditorTabs()
      syncDockFromGrid()
    },
    onExecute: (opts) => void execute(opts),
    onExecuteAll: () => void execute({ mode: 'all' }),
    onSave: () => void saveSessionNow(),
    getSessionKey: () => currentSessionKey(),
    getDialect: () => currentDialect(),
    getCompletionScope: () => completionScopeFor()
  })

  grid = new ResultGrid(dom.results, {
    onCommit: () => void commitChanges(),
    onRevert: () => {
      syncDockFromGrid()
      renderRightPanel()
    },
    onExport: (scope = 'all') => openExportMenu(scope),
    onExportCsv: (scope = grid.selectedRows.size ? 'selected' : 'all') => {
      const { cols, rows } = grid.getExportData(scope)
      void exportResult('csv', cols, rows, grid.tableRef, { ...state.ui, driver: currentConnection()?.driver })
    },
    onImport: () => openImportWizard(),
    isMutationLocked: () => !!state.runtime.executing && (['applyChanges', 'transaction'].includes(state.runtime.activeQuery?.kind) || state.runtime.activeQuery?.invalidatesResults) && state.runtime.activeQuery?.consoleId === currentSession()?.id,
    onServerFilter: (column, value) => { const tab = currentResultState()?.tabs?.[currentResultState().activeTab]; if (tab?.browse) void fetchTablePage(tab, { filters: [...(tab.browse.request.filters || []).filter(filter => filter.column !== column), { column, operator: value == null ? 'is-null' : 'eq', value }], offset: 0 }) },
    onGenerateSql: (kind) => showSqlPreview(kind),
    onSelectionChange: () => {
      syncDockFromGrid()
      renderRightPanel()
    },
    onRefresh: () => { const rs = currentResultState(), tab = rs?.tabs?.[rs.activeTab]; if (tab?.browse) void fetchTablePage(tab); else void execute({ mode: 'current' }) },
    onServerSort: (column, direction) => { const rs = currentResultState(), tab = rs?.tabs?.[rs.activeTab]; if (tab?.browse) void fetchTablePage(tab, { order: direction ? [{ column, direction }] : [], offset: 0 }) },
    onPageSizeChange: (size) => {
      // 每页行数持久化到当前编辑器 gridState（store 已预留字段）
      const ed = currentEditor()
      if (!ed) return
      ed.gridState = { ...(ed.gridState || {}), page: 0, pageSize: size }
      schedulePersistSessions()
    }
  })

  side = new SidePanel(dom.side, {
    onSideAction: (tab) => void onSideAction(tab),
    onSelectSession: (id) => selectSession(id),
    onSessionAction: (id, act) => void onSessionAction(id, act),
    onSelectConnection: (id) => {
      state.selectedConnectionId = id
      side.render()
    },
    onConnectionAction: (id, act) => onConnectionAction(id, act),
    onConnectionContext: (id, ev) => void connectionContext(id, ev),
    onExportConnections: (list) => void exportConnections(list),
    onExportSessions: (list) => void exportSessions(list),
    onExportHistory: (list) => void exportHistory(list),
    onTabChange: (tab) => setUiPref('leftTab', tab),
    onHistoryInsert: (id) => insertHistory(id),
    onHistorySelect: (id) => {
      const h = state.queryHistory.find((x) => x.id === id)
      if (h) showLocalToast(h.error || h.sql.slice(0, 120))
    },
    onHistoryCopy: async (id) => {
      const h = state.queryHistory.find((x) => x.id === id)
      if (!h) return
      await clipboardWrite(h.sql)
      showLocalToast('已复制 SQL', 'success')
    },
    onExpandRequest: () => setSidebarCollapsed(false),
    onOpenTable: (node, conn) => openTableData(node, conn),
    onOpenObject: (node, conn, view) => openTableData(node, conn, view),
    onNavigate: (page) => workbench?.navigate(page),
    onTreeContext: (node, conn, ev) => void treeContext(node, conn, ev),
    onMetadataInvalidate: invalidateConnectionCompletion
  })

  const origRender = SqlEditor.prototype._renderCompletion
  SqlEditor.prototype._renderCompletion = function (...args) {
    const ret = origRender.apply(this, args)
    try {
      const st = this.completionState
      const rs = currentResultState()
      if (st?.open && st.items?.[st.index] && rs) {
        rs.lastCompletion = st.items[st.index]
        if (state.ui.rightOpen && rightMode === 'docs') renderRightPanel()
      }
    } catch {
      /* ignore */
    }
    return ret
  }

  bindResizers()
  bindChrome()

  await loadAll()
  initWorkspace()
  await loadDialects()
  workbench = new DatabaseWorkbench({
    editor: () => editor, connection: currentConnection, session: currentSession, sessionKey: currentSessionKey,
    isConnected: currentConnected,
    execute, cancel: cancelQuery, save: saveSessionNow, export: openExportMenu, message: showLocalToast,
    newConnection: openConnectionForm,
    onPageChange: (page) => side?.setPage(page),
    browse: (node, connection, view = 'data', forceRefresh = false) => openTableData(node, connection || currentConnection(), view, forceRefresh),
    surfaceChanged: refreshResultSurface,
    newQuery: newQueryDocument,
    activateTab: activateTabContext, closeTab: closeWorkspaceDocument, beforeNavigate: captureVisibleGrid,
    contextForTab, contextValid, ensureConnected: ensureConsoleConnected, transaction, openDocument, sessionAction: onSessionAction, historyAction,
    queryContextMenu: (tab, event) => editorTabContext(tab.editorId, event, tab.consoleId),
    openSqlDocument: (context, sql, title) => {
      if (!contextValid(context)) return showLocalToast('来源控制台已关闭，请重新打开对象', 'warn')
      captureVisibleGrid()
      const document = createEditorTab(context.session, title, sql)
      if (document) openDocument(context.session.id, document.id)
    },
    transactionPending: session => transactionWrites.get(session?.id) || 0,
    gridAction, gridAvailable, gridFocused: () => !!document.activeElement?.closest?.('#results'),
    getQueryContext: () => ({ session: currentSession(), editor: currentEditor() }),
    newQuick: async () => { await newSession(currentConnection()?.id); workbench.navigate('query') },
    connect: () => toggleConnect(false),
    selectConnection: async (id) => { await onConnectionAction(id, 'connect'); if (!currentConnected()) throw new Error('连接未成功，请检查连接配置') },
    switchDatabase,
    resetLayout: () => { applySidebarCollapsed(false); dom.side.style.width = '240px'; dom.rightPanel.style.width = '280px'; dom.results.style.height = '300px' }
  })
  await workbench.initialize()
  try {
    const v = await api?.settings?.get?.('followShellTheme')
    if (v !== undefined && v !== null) setFollowShellTheme(v !== false)
  } catch {
    /* ignore */
  }

  applySidebarCollapsed(!!state.ui.sidebarCollapsed)
  dom.rightPanel.style.width = `${state.ui.rightWidth || 280}px`
  dom.results.style.height = `${state.ui.bottomHeight || 300}px`
  if (!state.ui.sidebarCollapsed) {
    dom.side.style.width = `${state.ui.leftWidth || 240}px`
  }

  renderAll()
  side.render()

  api?.onEnter?.((event) => {
    if (event?.code === 'settings') workbench.navigate('settings')
    side?.render()
    renderAll()
  })
  api?.onBeforeClose?.(async () => {
    await Promise.allSettled([flushPendingPersist(), side?.dispose?.(), disposeCompletionRuntime()])
  })
  window.addEventListener('pagehide', () => {
    try {
      void flushPendingPersist().catch(() => {})
      void disposeCompletionRuntime().catch(() => {})
    } catch {
      /* ignore */
    }
  })

  if (!api) showLocalToast('功能未就绪', 'warn')
  else if (!api.db && !api.vault) {
    state.runtime.hostLagNotified = true
    showLocalToast('功能未就绪', 'warn')
  }
}

/* ───────────── sidebar collapse ───────────── */

function applySidebarCollapsed(collapsed) {
  state.ui.sidebarCollapsed = !!collapsed
  dom.app?.classList.toggle('sidebar-collapsed', !!collapsed)
  if (!collapsed) {
    dom.side.style.width = `${state.ui.leftWidth || 240}px`
  } else {
    dom.side.style.width = ''
  }
  side?.setCollapsed(!!collapsed)
  setUiPref('sidebarCollapsed', !!collapsed)
  const toggle = dom.sideToggle
  if (toggle) {
    toggle.title = collapsed ? '展开侧栏' : '收起侧栏'
    toggle.textContent = collapsed ? '☰' : '≡'
  }
}

function setSidebarCollapsed(v) {
  applySidebarCollapsed(v)
}

/* ───────────── render ───────────── */

function renderAll() {
  renderEditorTabs()
  renderToolbar()
  renderEditorValue()
  renderResultTabs()
  renderStatus()
  renderRightPanel()
  side?.render()
  workbench?.update()
}

function renderEditorTabs() {
  if (!workbench) return
  for (const tab of getWorkspace().tabs) {
    if (tab.kind !== 'query') continue
    const session = state.sessions.find((item) => item.id === tab.consoleId)
    const document = session?.editors.find((item) => item.id === tab.editorId)
    if (document) tab.title = document.title
  }
  workbench.renderTabs()
}

function renderEditorValue() {
  const ed = currentEditor()
  if (!editor) return
  const sql = ed?.sql || ''
  editor.activateDocument(ed?.id, sql, ed?.cursor)
  editor.setDialect(currentDialect())
}

/** 顶栏：连接状态 chip（名称 · 驱动），无工具栏墙 */
function renderToolbar() {
  const conn = currentConnection()
  const s = currentSession()
  const open = currentConnected()
  const busy = !!state.runtime.executing
  const dotCls = busy ? 'busy' : open ? 'on' : ''
  const title = [conn?.name, conn ? driverLabel(conn.driver) : '', s?.name]
    .filter(Boolean)
    .join(' · ')
  dom.toolbar.innerHTML = `
    <span class="ctx-chip" title="${esc(title || '未选择连接')}">
      <span class="dot ${dotCls}"></span>
      <strong>${conn ? esc(conn.name || '连接') : '未连接'}</strong>
      ${conn ? `<span class="driver-chip ${String(conn.driver || '').toLowerCase().replace(/[^a-z0-9]/g, '') ? 'd-' + String(conn.driver).toLowerCase().replace(/[^a-z0-9]/g, '') : ''}">${esc(driverLabel(conn.driver))}</span>` : ''}
      ${conn?.readOnly || s?.origin === 'quick' ? '<span class="badge xs warn">只读</span>' : ''}
    </span>
  `
  if (dom.fabRun) {
    dom.fabRun.disabled = busy
    const label = busy ? '执行中…' : '执行选区或当前语句'
    setTip(dom.fabRun, label)
    dom.fabRun.innerHTML = busy ? '…' : '▶'
  }
  workbench?.update()
}

/** 顶栏 ⋯：执行 + 次要操作 */
function openChromeMenu(ev) {
  if (!['query', 'object'].includes(activeWorkspaceTab()?.kind)) {
    openCtxMenu(ev, [['new-connection', '新建连接'], ['new-query', '新建查询'], ['documents', '查询文档'], ['history', '查询历史'], ['settings', '设置与快捷键']], (action) => {
      if (action === 'new-connection') void openConnectionForm()
      else if (action === 'new-query') void newQueryDocument()
      else workbench.navigate(action === 'documents' ? 'documents' : action)
    })
    return
  }
  const conn = currentConnection()
  const open = currentConnected()
  const busy = !!state.runtime.executing
  const dirty = !!(grid && grid.pendingChanges().length)
  const items = menuItems([
    ['run-all', '执行整篇查询'],
    ['run-sel', '执行选区或当前语句'],
    ['explain', '执行计划'],
    busy ? ['cancel', '取消查询'] : null,
    'sep',
    ['connect', open ? '断开连接' : '连接'],
    ['save', '保存会话'],
    ['format', '注释'],
    ['complete', '代码提示'],
    ['right', state.ui.rightOpen ? '收起侧栏' : '变更面板'],
    dirty && conn && !conn.readOnly ? ['commit', '提交变更'] : null,
    dirty ? ['revert', '放弃变更'] : null,
    'sep',
    ['import', '导入表格'],
    ['export', '导出结果'],
    !currentSession() ? ['new-session', '新建会话'] : null
  ])
  openCtxMenu(ev, items, (k) => {
    if (k === 'run-all') void execute({ mode: 'all' })
    else if (k === 'run-sel') void execute({ mode: 'selection' })
    else if (k === 'new-session') void newSession()
    else if (k === 'connect') void toggleConnect(false)
    else if (k === 'save') void saveSessionNow()
    else if (k === 'explain') void execute({ mode: 'current', explain: true })
    else if (k === 'format') editor?.toggleComment()
    else if (k === 'complete') editor?.triggerCompletion(true)
    else if (k === 'import') openImportWizard()
    else if (k === 'export') openExportMenu()
    else if (k === 'commit') void commitChanges()
    else if (k === 'revert') {
      grid.revertAll()
      syncDockFromGrid()
      renderRightPanel()
    } else if (k === 'right') {
      state.ui.rightOpen = !state.ui.rightOpen
      setUiPref('rightOpen', state.ui.rightOpen)
      renderRightPanel()
    } else if (k === 'cancel') void cancelQuery()
  })
}

function syncDockFromGrid() {
  const dirty = !!(grid && grid.pendingChanges().length)
  if (dirty && !state.ui.rightOpen) {
    state.ui.rightOpen = true
    setUiPref('rightOpen', true)
  }
}

function setResultsVisible(visible) {
  if (dom.results) dom.results.hidden = !visible
  if (dom.resizerBottom) dom.resizerBottom.hidden = !visible
}

function renderResultTabs() {
  captureVisibleGrid()
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  const tabs = rs?.tabs || []
  const hasData = tabs.length > 0
  // 结果列表：执行并拿到数据后才显示
  setResultsVisible(hasData)
  if (!hasData) {
    dom.results?.querySelector('.result-tabs')?.remove()
    loadResultIntoGrid()
    return
  }
  let tabsEl = dom.results.querySelector('.result-tabs')
  if (!tabsEl) {
    tabsEl = document.createElement('div')
    tabsEl.className = 'result-tabs'
    const bar = dom.results.querySelector('.grid-bar')
    if (bar && bar.nextSibling) dom.results.insertBefore(tabsEl, bar.nextSibling)
    else dom.results.insertBefore(tabsEl, dom.results.firstChild)
  }
  tabsEl.hidden = false
  tabsEl.innerHTML = tabs
    .map(
      (t, i) =>
        `<button type="button" class="tab${i === rs.activeTab ? ' active' : ''}" data-rt="${i}">${esc(
          t.label || `结果 ${i + 1}`
        )}</button>`
    )
    .join('')
  tabsEl.querySelectorAll('[data-rt]').forEach((b) => {
    b.addEventListener('click', () => {
      rs.activeTab = Number(b.dataset.rt)
      loadResultIntoGrid()
      renderResultTabs()
    })
  })
  loadResultIntoGrid()
}

function loadResultIntoGrid() {
  const ed = currentEditor(), rs = ed ? getResultState(ed.id) : null
  const tab = rs?.tabs?.[rs.activeTab], conn = currentConnection()
  const descriptor = state.runtime.dialects.find((driver) => driver.id === conn?.driver)
  const capability = descriptor?.capabilities?.edit || descriptor?.capabilities?.crud
  const options = {
    readOnly: workbench?.mode === 'quick' || currentSession()?.origin === 'quick' || !!conn?.readOnly || !!tab?.result?.readOnly || ['applyChanges', 'browse', 'transaction'].includes(state.runtime.activeQuery?.kind) && state.runtime.activeQuery?.editorId === ed?.id,
    serverPage: quickDesktopPreview() ? undefined : tab?.browse?.request,
    pageSize: ed?.gridState?.pageSize
  }
  if (displayedResult !== tab || displayedResultData !== tab?.result) {
    captureVisibleGrid()
    if (tab?.gridSnapshot && tab.gridSnapshot.data === tab.result) grid.restoreState(tab.gridSnapshot)
    else grid.setResult({ ...options, result: tab?.result || null, tableRef: tab?.tableRef || rs?.tableRefOverride || null, driverUpdatable: capability ? capability.state === 'available' : !/influx|tdengine|redis/.test(conn?.driver || '') })
    displayedResult = tab || null; displayedResultData = tab?.result || null
  }
  grid.setDialect?.(conn?.driver || 'mysql')
  grid.setViewOptions(options)
  renderServerPager(tab); renderQuickResultBar(tab)
}

/** Descriptions use the navigation's read-only session, never the transaction console. */
async function hydrateResultMetadata(context, tab) {
  const result = tab?.result, tableRef = tab?.tableRef || result?.tableRef
  if (!result?.columns?.length || !tableRef?.table || !context.connection || !context.editor) return
  if (completionContexts.get(context.session?.id)?.contextKnown === false) return
  try {
    const scope = completionScopeFor(context.session, context.connection, { documentId: context.editor.id, surface: context.surface })
    if (!scope.connected) return
    const ticket = await captureCompletionMetadataRead(scope)
    if (!contextValid(context) || !completionScopeFor(context.session, context.connection).connected) return
    const detail = await side.describeForResult(context.connection, tableRef, context.surface)
    if (!contextValid(context) || tab.result !== result || !state.results.get(context.editor.id)?.tabs.includes(tab)) return
    const ownerTab = getWorkspace().tabs.find(item => item.id === context.tabId)
    const published = await publishCompletionTable(
      completionScopeFor(context.session, context.connection, { documentId: context.editor.id, surface: context.surface }),
      { ...tableRef, name: tableRef.table, type: ownerTab?.objectType || 'table' },
      detail,
      ticket
    )
    if (!published || !contextValid(context) || tab.result !== result || !state.results.get(context.editor.id)?.tabs.includes(tab)) return
    const metadata = new Map((detail?.columns || []).map(column => [column.name, column]))
    const columns = result.columns.map(column => {
      const field = metadata.get(column.name)
      if (!field) return column
      // Descriptions enrich labels only; row identity/editability remains host-owned.
      return { ...column, comment: column.comment || field.comment || '', dataType: field.dataType || field.type || column.dataType }
    })
    result.columns = columns
    if (tab.gridSnapshot) tab.gridSnapshot.columns = columns
    if (displayedResult === tab && displayedResultData === result) grid.updateColumnMetadata?.(columns)
  } catch { /* Metadata permissions and stale requests never replace the query result. */ }
}

function refreshResultSurface() {
  const rs = currentResultState(), tab = rs?.tabs?.[rs.activeTab]
  // Change presentation without reloading results or dropping uncommitted cell edits.
  grid.setViewOptions({
    readOnly: workbench?.mode === 'quick' || currentSession()?.origin === 'quick' || !!currentConnection()?.readOnly || !!tab?.result?.readOnly || ['applyChanges', 'browse', 'transaction'].includes(state.runtime.activeQuery?.kind) && state.runtime.activeQuery?.editorId === currentEditor()?.id,
    serverPage: quickDesktopPreview() ? undefined : tab?.browse?.request,
    pageSize: currentEditor()?.gridState?.pageSize
  })
  renderServerPager(tab); renderQuickResultBar(tab)
}

function renderQuickResultBar(tab) {
  dom.results.querySelector('.wb-quick-results-bar')?.remove()
  dom.results.querySelector('.wb-quick-filter')?.remove()
  if (!tab?.result) document.querySelector('#app').dataset.quickResults = ''
  if (workbench?.mode !== 'quick' || !tab?.result) return
  const remote = !!tab.browse && !quickDesktopPreview()
  const bar = document.createElement('div'); bar.className = 'wb-quick-results-bar'
  const expanded = document.querySelector('#app').dataset.quickResults === 'expanded'
  bar.innerHTML = `<span>${remote ? '当前页' : '已加载'} ${tab.result.rows?.length || 0} 行${tab.result.truncated ? ' · 已截断' : ''}</span><span class="spacer"></span><button class="btn" data-expand-results>${expanded ? '返回查询' : '展开结果'}</button><button class="btn" data-copy-results title="复制${remote ? '服务器当前页' : '筛选后的已加载结果'}">复制</button><button class="btn" data-export-results title="导出${remote ? '服务器当前页' : '筛选后的已加载结果'}">导出</button>`
  dom.results.prepend(bar)
  bar.querySelector('[data-expand-results]').onclick = () => { document.querySelector('#app').dataset.quickResults = expanded ? '' : 'expanded'; renderQuickResultBar(tab); editor.instance?.layout() }
  bar.querySelector('[data-copy-results]').onclick = async () => { const { cols, rows } = grid.getExportData('all'); const stringify = (value) => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); await clipboardWrite([cols.map((col) => col.name || col), ...rows].map((row) => row.map(stringify).join('\t')).join('\n')); showLocalToast('已复制当前结果', 'success') }
  bar.querySelector('[data-export-results]').onclick = () => { const { cols, rows } = grid.getExportData('all'); void exportResult('csv', cols, rows, grid.tableRef, { ...state.ui, driver: currentConnection()?.driver }) }
  if (!expanded || !tab.result.columns?.length) return
  const filter = document.createElement('form'); filter.className = 'wb-quick-filter'
  const names = tab.result.columns.map((column) => column.name || column)
  const activeColumn = remote ? tab.quickFilter?.column || names[0] : names[Object.keys(grid.filters)[0] || 0]
  const activeText = remote ? tab.quickFilter?.text || '' : Object.values(grid.filters)[0] || ''
  filter.innerHTML = `<select aria-label="Quick 筛选字段" data-quick-filter-column>${names.map((name) => `<option ${name === activeColumn ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select><input data-quick-filter-text aria-label="${remote ? '服务器' : '已加载结果'}包含文本" placeholder="包含文本 · ${remote ? '查询服务器' : '仅已加载数据'}" value="${esc(activeText)}"><button class="btn" type="submit" data-quick-filter-apply>${remote ? '添加筛选' : '筛选'}</button><button class="btn" type="button" data-quick-filter-clear title="清除所有筛选条件">清除</button>`
  bar.after(filter)
  const apply = async () => {
    const column = filter.querySelector('select').value, text = filter.querySelector('input').value.trim()
    if (!remote) { grid.filterLoaded(names.indexOf(column), text); return }
    if (!text) return
    const filters = [...(tab.browse.request.filters || []).filter((item) => item.column !== column || item.operator !== 'contains'), { column, operator: 'contains', value: text }]
    tab.quickFilter = { column, text }
    await fetchTablePage(tab, { filters, offset: 0 })
  }
  filter.onsubmit = (event) => { event.preventDefault(); void apply() }
  if (!remote) {
    filter.querySelector('input').oninput = () => void apply()
    filter.querySelector('select').onchange = () => void apply()
  }
  filter.querySelector('[data-quick-filter-clear]').onclick = async () => {
    if (remote) { tab.quickFilter = null; await fetchTablePage(tab, { filters: [], offset: 0 }) }
    else { filter.querySelector('input').value = ''; grid.filterLoaded(0, ''); filter.querySelector('input').focus() }
  }
}

function renderServerPager(tab) {
  dom.results.querySelector('.wb-server-pager')?.remove()
  if (!tab?.browse || quickDesktopPreview()) return
  const bar = document.createElement('div'); bar.className = 'wb-server-pager'
  const paging = tab.result.page || {}, request = tab.browse.request, rows = tab.result.rows?.length || 0
  const offset = paging.offset ?? request.offset, limit = paging.limit ?? request.limit
  const quickOrigin = tab.browse.surface === 'quick' || state.sessions.find((session) => session.id === tab.browse.consoleId)?.origin === 'quick' || workbench?.mode === 'quick'
  bar.innerHTML = `<span title="${paging.stableOrder ? '稳定排序' : '无唯一排序，翻页结果可能变化'}">服务器分页 · ${offset + (rows ? 1 : 0)}–${offset + rows} 行${request.filters?.length ? ` · ${request.filters.length} 条件` : ''}</span><span class="muted">${paging.stableOrder ? '稳定排序' : '无唯一排序，翻页结果可能变化'}</span><span class="spacer"></span><button class="btn" data-server-filter>筛选${request.filters?.length ? ` (${request.filters.length})` : ''}</button><button class="btn" data-server-prev ${offset === 0 ? 'disabled' : ''}>上一页</button><button class="btn" data-server-next ${!paging.hasMore ? 'disabled' : ''}>下一页</button><select aria-label="服务器每页行数">${[50, 100, 200, ...(quickOrigin ? [] : [500, 1000])].map((size) => `<option ${size === limit ? 'selected' : ''}>${size}</option>`).join('')}</select><button class="btn" data-server-refresh>刷新</button><span class="muted">导出范围：当前页</span>`
  dom.results.append(bar)
  bar.querySelector('[data-server-prev]').onclick = () => void fetchTablePage(tab, { offset: Math.max(0, offset - (quickOrigin ? Math.min(200, limit) : limit)) })
  bar.querySelector('[data-server-next]').onclick = () => void fetchTablePage(tab, { offset: offset + limit })
  bar.querySelector('[data-server-refresh]').onclick = () => void fetchTablePage(tab)
  bar.querySelector('select').onchange = (event) => void fetchTablePage(tab, { limit: Number(event.target.value), offset: 0 })
  bar.querySelector('[data-server-filter]').onclick = () => openServerFilters(tab)
}

async function fetchTablePage(tab, changes = {}) {
  if (!tab?.browse || tab.browse.loading) return false
  if (tab.browse.consoleId && tab.browse.generation !== (consoleGenerations.get(tab.browse.consoleId) || 0)) { showLocalToast('此结果连接已断开，请重新打开对象', 'warn'); return false }
  if (quickDesktopPreview()) { showLocalToast('此桌面控制台请在桌面继续，或新建独立快捷查询', 'warn'); return false }
  captureVisibleGrid()
  if (tab.gridSnapshot && snapshotHasChanges(tab.gridSnapshot)) { showLocalToast('请先提交或放弃当前页的数据变更，再进行服务器分页、排序或筛选', 'warn'); return false }
  const ownerTab = getWorkspace().tabs.find((workspaceTab) => workspaceTab.editorId && state.results.get(workspaceTab.editorId)?.tabs.includes(tab))
  const sourceSession = state.sessions.find((session) => session.id === tab.browse.consoleId)
  const request = { ...tab.browse.request, ...changes }, { sessionKey } = tab.browse
  const surface = workbench?.mode === 'quick' ? 'quick' : tab.browse.surface || 'shell'
  if (surface === 'quick' && sourceSession?.origin !== 'quick') { showLocalToast('请在桌面继续读取此控制台', 'warn'); return false }
  if (surface === 'quick') request.limit = Math.min(200, request.limit)
  tab.browse.loading = true
  try {
    const result = await runDatabaseTask({ kind: 'browse', sessionKey, consoleId: tab.browse.consoleId, editorId: ownerTab?.editorId, tabId: ownerTab?.id }, () => DbHost.workbench('table.page', { sessionKey, ...request, surface }))
    if (tab.browse.consoleId && tab.browse.generation !== (consoleGenerations.get(tab.browse.consoleId) || 0)) return false
    if (['view', 'materialized_view'].includes(ownerTab?.objectType)) result.readOnly = true
    tab.result = result; delete tab.gridSnapshot; tab.browse.request = { ...request, offset: result.page?.offset ?? request.offset, limit: result.page?.limit ?? request.limit }
    void hydrateResultMetadata(contextForTab(ownerTab), tab)
    if (currentResultState()?.tabs?.[currentResultState().activeTab] === tab) { loadResultIntoGrid(); renderStatus() }
    return true
  } catch (error) { showLocalToast(error.message, 'error'); return false } finally { tab.browse.loading = false }
}

function openServerFilters(tab) {
  let rows = structuredClone(tab.browse.request.filters || [])
  const names = tab.result.columns.map((col) => col.name)
  const operators = { eq: '等于', ne: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', contains: '包含文本', in: '属于列表', 'is-null': '为空', 'not-null': '不为空' }
  const modal = createDialog({ title: '服务器筛选', content: '<p class="muted">条件之间使用 AND；筛选会重新查询服务器。值支持 JSON 数字、布尔值、null、数组，其余作为文本。</p><div data-filters></div><div class="form-actions"><button class="btn" data-add-filter>添加条件</button><span class="spacer"></span><button class="btn primary" data-apply-filter>应用筛选</button></div><p data-error role="status"></p>' })
  const render = () => {
    modal.body.querySelector('[data-filters]').innerHTML = rows.map((row, i) => `<div class="wb-filter-row" data-filter-index="${i}"><select data-prop="column" aria-label="筛选字段">${names.map((name) => `<option ${name === row.column ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select><select data-prop="operator" aria-label="条件">${Object.entries(operators).map(([id, label]) => `<option value="${id}" ${id === row.operator ? 'selected' : ''}>${label}</option>`).join('')}</select><input data-prop="value" aria-label="筛选值" value="${esc(typeof row.value === 'string' ? row.value : JSON.stringify(row.value ?? ''))}"><button class="btn" data-remove-filter="${i}" aria-label="删除条件">×</button></div>`).join('')
    modal.body.querySelectorAll('[data-prop]').forEach((input) => input.oninput = () => { let value = input.value; if (input.dataset.prop === 'value') { try { value = JSON.parse(value) } catch { /* text value */ } } rows[input.closest('[data-filter-index]').dataset.filterIndex][input.dataset.prop] = value })
    modal.body.querySelectorAll('[data-remove-filter]').forEach((button) => button.onclick = () => { rows.splice(Number(button.dataset.removeFilter), 1); render() })
  }
  modal.body.querySelector('[data-add-filter]').onclick = () => { rows.push({ column: names[0], operator: 'eq', value: '' }); render() }
  modal.body.querySelector('[data-apply-filter]').onclick = async () => { const invalid = rows.find((row) => row.operator === 'in' && !Array.isArray(row.value)); if (invalid) { modal.body.querySelector('[data-error]').textContent = '属于列表的值需要填写 JSON 数组，例如 [1,2,3]'; return } if (await fetchTablePage(tab, { filters: rows, offset: 0 })) modal.close() }
  render()
}

function renderStatus() {
  if (!dom.statusbar) return
  const conn = currentConnection()
  const s = currentSession()
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  const tab = rs?.tabs?.[rs.activeTab]
  const parts = []
  parts.push(conn ? `${conn.name || conn.id} · ${driverLabel(conn.driver)}` : '无连接')
  if (s?.database || conn?.database) parts.push(s?.database || conn.database)
  if (tab?.result) {
    parts.push(`${tab.result.rows?.length ?? 0} 行`)
    if (tab.result.durationMs != null) parts.push(`${tab.result.durationMs} ms`)
    if (tab.result.truncated) parts.push('截断')
  }
  if (conn?.readOnly) parts.push('只读')
  if (state.runtime.executing) parts.push('执行中…')
  if (state.runtime.hostLagNotified) parts.push('功能未就绪')
  dom.statusbar.innerHTML = parts.map((p) => `<span class="st-item">${esc(p)}</span>`).join('')
}

function renderRightPanel() {
  const open = !!state.ui.rightOpen
  dom.rightPanel.hidden = !open
  if (!open) return
  const changes = grid?.pendingChanges?.() || []
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  const lastItem = rs?.lastCompletion
  dom.rightPanel.innerHTML = `
    <div class="right-tabs">
      <button type="button" data-rp="changes" class="${rightMode === 'changes' ? 'active' : ''}">变更${
        changes.length ? ` (${changes.length})` : ''
      }</button>
      <button type="button" data-rp="docs" class="${rightMode === 'docs' ? 'active' : ''}">代码提示</button>
      <button type="button" data-rp="ddl" class="${rightMode === 'ddl' ? 'active' : ''}">DDL</button>
      <button type="button" class="btn icon" data-rp="close" title="关闭">×</button>
    </div>
    <div class="right-body" data-el="rbody"></div>
  `
  dom.rightPanel.querySelectorAll('[data-rp]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.rp === 'close') {
        state.ui.rightOpen = false
        setUiPref('rightOpen', false)
        renderRightPanel()
        return
      }
      rightMode = b.dataset.rp
      renderRightPanel()
    })
  })
  const body = dom.rightPanel.querySelector('[data-el=rbody]')
  if (rightMode === 'changes') {
    if (!changes.length) {
      body.innerHTML = `<div class="empty">暂无待提交变更</div>`
      return
    }
    body.innerHTML = `
      <div class="changes-actions">
        <button type="button" class="btn primary sm" data-c="commit">提交</button>
        <button type="button" class="btn sm" data-c="revert">放弃</button>
        <button type="button" class="btn sm" data-c="sql">SQL</button>
      </div>
      <div class="changes-list">
        ${changes
          .map(
            (c) => `<div class="change-item ${esc(c.status)}" data-idx="${c.idx}">
          <div class="ci-head"><strong>${esc(statusLabel(c.status))}</strong> <span class="muted">#${c.idx + 1}</span></div>
          <div class="ci-body"><code>${esc(changeSummary(c))}</code></div>
          ${c.error ? `<div class="ci-err">${esc(c.error)}</div>` : ''}
        </div>`
          )
          .join('')}
      </div>`
    body.querySelector('[data-c=commit]')?.addEventListener('click', () => void commitChanges())
    body.querySelector('[data-c=revert]')?.addEventListener('click', () => {
      grid.revertAll()
      syncDockFromGrid()
      renderRightPanel()
    })
    body.querySelector('[data-c=sql]')?.addEventListener('click', () => showSqlPreview('preview'))
    body.querySelectorAll('.change-item').forEach((el) => {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const idx = Number(el.dataset.idx)
        openCtxMenu(
          e,
          [
            ['commit', '提交全部'],
            ['revert', '放弃全部'],
            'sep',
            ['discard', '放弃该项', { danger: true }],
            ['script', '生成到编辑器']
          ],
          (k) => {
            if (k === 'commit') void commitChanges()
            else if (k === 'revert') {
              grid.revertAll()
              syncDockFromGrid()
              renderRightPanel()
            } else if (k === 'discard') {
              grid.discardChange(idx)
              syncDockFromGrid()
              renderRightPanel()
            } else if (k === 'script') showSqlPreview('editor')
          }
        )
      })
    })
  } else if (rightMode === 'docs') {
    if (lastItem) {
      const meta = kindMeta(lastItem.kind)
      body.innerHTML = `<div class="doc-panel">
        <div class="doc-kind" style="color:${meta.color}">${esc(meta.label)}${
          lastItem.owner ? ' · ' + esc(lastItem.owner) : ''
        }</div>
        <div class="doc-label">${esc(lastItem.label)}</div>
        ${lastItem.detail ? `<div class="doc-detail">${esc(lastItem.detail)}</div>` : ''}
        ${lastItem.doc ? `<div class="doc-body">${esc(lastItem.doc)}</div>` : ''}
      </div>`
    } else {
      body.innerHTML = `<div class="empty">—</div>`
    }
  } else {
    body.innerHTML = `<div class="empty"><pre class="ddl">${esc(rs?.ddl || '—')}</pre></div>`
  }
}

function statusLabel(st) {
  return (
    { dirty: '已修改', inserted: '新增', deleted: '删除', failed: '失败', clean: '干净' }[st] || st
  )
}

function changeSummary(c) {
  if (c.status === 'inserted') {
    return `INSERT → ${JSON.stringify(zipCols(c.current)).slice(0, 140)}`
  }
  if (c.status === 'deleted') return `DELETE WHERE ${JSON.stringify(c.key)}`
  const cols = grid?.columns || []
  const diff = []
  cols.forEach((col, i) => {
    if (c.original?.[i] !== c.current?.[i]) {
      const a = c.original?.[i]
      const b = c.current?.[i]
      diff.push(`${col.name}: ${a == null ? 'NULL' : String(a)} → ${b == null ? 'NULL' : String(b)}`)
    }
  })
  return `UPDATE ${diff.join(', ') || '(无差异)'} WHERE ${JSON.stringify(c.key)}`
}

function zipCols(values) {
  const o = {}
  ;(grid?.columns || []).forEach((col, i) => {
    o[col.name] = values?.[i]
  })
  return o
}

/* ───────────── actions ───────────── */

async function loadDialects() {
  try {
    const list = await DbHost.dialectsList()
    state.runtime.dialects = Array.isArray(list) ? list : list?.dialects || []
  } catch {
    state.runtime.dialects = [
      { id: 'mysql', label: 'MySQL' },
      { id: 'sqlite', label: 'SQLite' },
      { id: 'postgres', label: 'PostgreSQL' },
      { id: 'timescale', label: 'TimescaleDB' },
      { id: 'influxdb', label: 'InfluxDB' },
      { id: 'tdengine', label: 'TDengine' }
    ]
  }
}

function selectSession(id) {
  captureVisibleGrid()
  setActiveSession(id)
  const s = currentSession()
  if (s) state.selectedConnectionId = s.connectionId
  if (s && state.runtime.consoleSessionKeys.has(s.id)) state.runtime.sessionKeys.set(s.connectionId, state.runtime.consoleSessionKeys.get(s.id))
  openCurrentQuery()
  renderAll()
}

function requestDialog({ title, message = '', value, preview, confirm = '确认' }) {
  return new Promise((resolve) => {
    let resolved = false
    const done = (result) => { if (!resolved) { resolved = true; resolve(result) } }
    const modal = createDialog({ title, content: `<p>${esc(message)}</p>${value !== undefined ? `<input class="wb-search" data-value value="${esc(value)}" aria-label="${esc(title)}">` : ''}${preview !== undefined ? `<textarea class="wb-sql-preview" readonly aria-label="SQL 预览">${esc(preview)}</textarea>` : ''}<div class="form-actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-confirm>${esc(confirm)}</button></div>`, onClose: () => done(null) })
    const accept = () => { done(value !== undefined ? modal.body.querySelector('[data-value]').value : true); modal.close() }
    modal.body.querySelector('[data-confirm]').onclick = accept
    modal.body.querySelector('[data-cancel]').onclick = modal.close
    modal.body.querySelector('[data-value]')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); accept() } })
    const input = modal.body.querySelector('[data-value]'); input?.focus(); input?.select()
  })
}

async function newSession(connectionId) {
  captureVisibleGrid()
  if (!state.connections.length) {
    await openConnectionForm()
    return
  }
  const connId = connectionId || state.selectedConnectionId || state.connections[0].id
  const s = createSession({ connectionId: connId })
  if (!s) return
  s.origin = workbench?.mode || 'shell'
  schedulePersistSessions()
  state.selectedConnectionId = connId
  openCurrentQuery()
  renderAll()
  return s
}

async function onSideAction(tab) {
  if (tab === 'connections') await openConnectionForm()
  else if (tab === 'sessions') await newSession()
  else if (tab === 'tree') {
    const conn = currentConnection()
    if (conn) await side.refreshTree(conn)
  } else if (tab === 'history') {
    try { await persistNow(StorageKeys.queryHistory, []) } catch { return }
    state.queryHistory = []
    side.render()
  }
}

async function onSessionAction(id, act) {
  if (act === 'open') {
    selectSession(id)
    return
  }
  if (act === 'rename') {
    const s = state.sessions.find((x) => x.id === id)
    const name = await requestDialog({ title: '会话名称', value: s?.name || '' })
    if (name) {
      renameSession(id, name)
      renderAll()
    }
  } else if (act === 'pin') {
    togglePinSession(id)
    side.render()
  } else if (act === 'dup') {
    captureVisibleGrid(); duplicateSession(id)
    openCurrentQuery(); renderAll()
  } else if (act === 'export') {
    const s = state.sessions.find((x) => x.id === id)
    if (s) await exportSessions([s])
  } else if (act === 'del') {
    if (await requestDialog({ title: '删除控制台会话', message: '删除此会话及其查询文档？', confirm: '删除' })) {
      try { await closeConsole(state.sessions.find((session) => session.id === id)) } catch (error) { showLocalToast(error.message, 'warn'); return }
      for (const tab of [...getWorkspace().tabs]) if (tab.consoleId === id) { editor.releaseDocument(tab.editorId); state.results.delete(tab.editorId); removeWorkspaceTab(tab.id) }
      deleteSession(id)
      workbench.activateTab(getWorkspace().activeTabId); renderAll()
    }
  }
}

async function onConnectionAction(id, act) {
  captureVisibleGrid()
  state.selectedConnectionId = id
  if (act === 'connect' || act === 'open') {
    const origin = workbench?.mode || 'shell'
    let s = state.sessions.find((x) => x.connectionId === id && !x.objectContext && (x.origin || 'shell') === origin)
    if (!s) { s = createSession({ connectionId: id }); if (!s) return; s.origin = origin; schedulePersistSessions() }
    else setActiveSession(s.id)
    openCurrentQuery()
    renderAll()
    await toggleConnect(true, s)
  } else if (act === 'disconnect') {
    try { const sessions = state.sessions.filter((item) => item.connectionId === id); if (sessions.some((session) => session.transactionActive)) throw new Error('此连接仍有事务，请先提交或回滚'); if (sessions.some((session) => state.runtime.activeQuery?.consoleId === session.id || state.runtime.activeQuery?.consoleIds?.includes(session.id))) throw new Error('此连接仍有任务，请先取消或等待完成'); for (const session of sessions) await closeConsole(session); invalidateConnectionCompletion(id, '连接已断开'); await side?.invalidateConnection?.(id); renderAll() } catch (error) { showLocalToast(error.message, 'warn') }
  } else if (act === 'favorite') {
    const conn = getConnection(id); if (conn) { await saveConnection({ ...conn, favorite: !conn.favorite }); side.render() }
  } else if (act === 'edit') {
    await openConnectionForm(getConnection(id))
  } else if (act === 'dup' || act === 'copy') {
    try { await duplicateConnection(id) } catch { return }
    side.render()
    showLocalToast('已复制连接配置', 'success')
  } else if (act === 'test') {
    await testConnectionById(id)
  } else if (act === 'readonly') {
    const c = getConnection(id)
    if (!c) return
    try { await saveConnection({ ...c, readOnly: !c.readOnly }) } catch { return }
    connectionConfigRevisions.set(id, (connectionConfigRevisions.get(id) || 0) + 1)
    invalidateConnectionCompletion(id, '连接配置已改变', false)
    side.render()
    renderToolbar()
    showLocalToast(c.readOnly ? '已取消只读' : '已设为只读', 'success')
  } else if (act === 'export') {
    const c = getConnection(id)
    if (c) await exportConnections([c])
  } else if (act === 'del') {
    if (await requestDialog({ title: '删除连接', message: '删除连接配置及保存的凭据？数据库内容不会删除。', confirm: '删除' })) {
      const conn = getConnection(id)
      try { const sessions = state.sessions.filter((session) => session.connectionId === id); if (sessions.some((session) => session.transactionActive)) throw new Error('此连接仍有事务，请先提交或回滚'); for (const session of sessions) await closeConsole(session) } catch (error) { showLocalToast(error.message, 'warn'); renderAll(); return }
      await side?.invalidateConnection?.(id)
      invalidateConnectionCompletion(id, '连接已删除', false)
      connectionConfigRevisions.delete(id)
      for (const tab of [...getWorkspace().tabs]) if (tab.connectionId === id) { if (tab.editorId) { editor.releaseDocument(tab.editorId); state.results.delete(tab.editorId) }; removeWorkspaceTab(tab.id) }
      removeConnection(id)
      if (conn?.secretRef) {
        try {
          await Vault.remove(conn.secretRef)
        } catch {
          /* host lag */
        }
      }
      await workbench.activateTab(getWorkspace().activeTabId); workbench.render(); renderAll()
    }
  }
}

async function testConnectionById(id) {
  const conn = getConnection(id)
  if (!conn) return
  try {
    const res = await DbHost.test(toConnectionInput(conn))
    showLocalToast(
      res?.ok ? `连接成功 · ${res.message || ''} ${res.version || ''}` : `连接失败：${res?.message || '未知'}`,
      res?.ok ? 'success' : 'error'
    )
  } catch (e) {
    showLocalToast(hostLag(e) ? '功能未就绪' : String(e.message || e), 'warn')
  }
}

function connectionContext(id, ev) {
  state.selectedConnectionId = id
  const conn = getConnection(id)
  openCtxMenu(
    ev,
    [
      ['open', '连接'],
      ['edit', '编辑'],
      ['copy', '复制'],
      ['readonly', conn?.readOnly ? '取消只读' : '设为只读'],
      ['del', '删除', { danger: true }],
      'sep',
      ['test', '测试连接'],
      ['export', '导出配置']
    ],
    (k) => void onConnectionAction(id, k)
  )
}

function editorTabContext(editorId, ev, consoleId) {
  const sess = consoleId ? state.sessions.find((item) => item.id === consoleId) : currentSession()
  if (!sess) return
  openCtxMenu(
    ev,
    [
      ['close-others', '关闭其它'],
      ['rename', '重命名'],
      ['dup', '复制 Tab'],
      'sep',
      ['close', '关闭', { danger: true }]
    ],
    async (k) => {
      if (k === 'close-others') {
        for (const tab of [...getWorkspace().tabs]) if (tab.consoleId === sess.id && tab.editorId !== editorId) await workbench.closeTab(tab.id)
      } else if (k === 'rename') {
        const ed = sess.editors.find((x) => x.id === editorId)
        const name = await requestDialog({ title: '查询文档名称', value: ed?.title || '' })
        if (name && ed) {
          ed.title = name.trim() || ed.title
          ed.dirty = true; schedulePersistSessions()
          renderEditorTabs(); persistWorkspace()
        }
      } else if (k === 'dup') {
        const ed = sess.editors.find((x) => x.id === editorId)
        if (ed) { captureVisibleGrid(); setActiveSession(sess.id); createEditorTab(sess, `${ed.title.replace(/\.sql$/i, '')}-副本.sql`, ed.sql); openCurrentQuery() }
        renderAll()
      } else if (k === 'close') {
        const tab = getWorkspace().tabs.find((item) => item.editorId === editorId)
        if (tab) await workbench.closeTab(tab.id)
      }
    }
  )
}

function insertHistory(id) {
  const h = state.queryHistory.find((x) => x.id === id)
  const ed = currentEditor()
  if (!h || !ed) return
  if (!editor) return
  editor.insertText(h.sql)
  showLocalToast('已插入历史 SQL')
}

async function saveSessionNow() {
  const s = currentSession()
  const ed = currentEditor()
  if (ed) {
    ed.dirty = false
    ed.sql = editor.getValue()
    ed.cursor = editor.getCursor()
  }
  if (s) s.updatedAt = Date.now()
  try { await saveSessionsImmediate() } catch (error) { if (ed) ed.dirty = true; renderEditorTabs(); showLocalToast(error.message, 'error'); return }
  if (ed) ed.dirty = false
  renderEditorTabs()
  try {
    await api?.ui?.toast?.({ message: '控制台会话已保存', type: 'success' })
  } catch {
    showLocalToast('会话已保存', 'success')
  }
}

async function closeConsole(session) {
  if (!session) return
  if (session.transactionActive) throw new Error('此控制台仍有事务，请先提交或回滚')
  if ((state.runtime.activeQuery?.consoleId === session.id || state.runtime.activeQuery?.consoleIds?.includes(session.id))) throw new Error('此控制台仍有任务，请先取消或等待完成')
  const completionScope = completionScopeFor(session)
  const sessionKey = await completionConsoleLifecycle.close(session.id, completionScope)
  if (!sessionKey) return
  transactionWrites.delete(session.id)
  if (state.runtime.sessionKeys.get(session.connectionId) === sessionKey) {
    const other = state.sessions.find((item) => item.id !== session.id && item.connectionId === session.connectionId && state.runtime.consoleSessionKeys.has(item.id))
    if (other) state.runtime.sessionKeys.set(session.connectionId, state.runtime.consoleSessionKeys.get(other.id))
    else state.runtime.sessionKeys.delete(session.connectionId)
  }
}

async function ensureConsoleConnected(context) {
  const session = context.session, connection = context.connection || getConnection(session?.connectionId)
  if (!session || !connection) throw new Error('请先选择连接与控制台')
  if (completionConsoleLifecycle.isClosing(session.id)) throw new Error('此控制台正在断开，请稍后重试')
  const existing = state.runtime.consoleSessionKeys.get(session.id)
  if (existing) return existing
  if (connectingConsoles.has(session.id)) return connectingConsoles.get(session.id)
  const generation = consoleGenerations.get(session.id) || 0
  const promise = (async () => {
    const database = session.database || connection.database
    const preferred = `${sessionKeyOf(connection.id, database)}::console:${session.id}`
    const response = await DbHost.open({ config: consoleConnectionInput(connection, session, database), sessionKey: preferred })
    const sessionKey = response?.sessionKey || response?.key || preferred
    if (!state.sessions.includes(session) || generation !== (consoleGenerations.get(session.id) || 0)) { await DbHost.close(sessionKey); throw new Error('连接上下文已失效，请重新连接') }
    state.runtime.consoleSessionKeys.set(session.id, sessionKey)
    state.runtime.sessionKeys.set(connection.id, sessionKey)
    session.transactionActive = !!response?.transactionActive
    completionContexts.set(session.id, { contextKnown: true, sessionContextRevision: 0 })
    connection.lastConnectedAt = Date.now()
    if (response?.dialect) connection.dialect = response.dialect
    upsertConnection(connection)
    if (!session.objectContext) void warmConsoleCatalog(session, connection, sessionKey)
    return sessionKey
  })()
  connectingConsoles.set(session.id, promise)
  try { return await promise } finally { connectingConsoles.delete(session.id); side?.render() }
}

/** Discovery loads object names only; the engine lazily requests referenced columns. */
function warmConsoleCatalog(session, connection, targetKey) {
  if (warmingCatalogs.has(targetKey)) return warmingCatalogs.get(targetKey)
  const generation = consoleGenerations.get(session.id) || 0
  const valid = () => state.sessions.includes(session) && (consoleGenerations.get(session.id) || 0) === generation && state.runtime.consoleSessionKeys.get(session.id) === targetKey
  const promise = (async () => {
    try {
      if (!valid()) return
      const scope = completionScopeFor(session, connection, { sessionKey: targetKey })
      await warmCompletionCatalog(scope)
      if (valid()) return getCompletionCatalog(scope)
    } catch { /* Optional completion metadata does not interrupt user queries. */ }
    finally { warmingCatalogs.delete(targetKey) }
  })()
  warmingCatalogs.set(targetKey, promise)
  return promise
}

async function toggleConnect(forceOpen, sourceSession = currentSession()) {
  if (!sourceSession) { if (!currentConnection()) return openConnectionForm(); sourceSession = await newSession(currentConnection().id); if (!sourceSession) return }
  const conn = getConnection(sourceSession.connectionId)
  try {
    if (state.runtime.consoleSessionKeys.has(sourceSession.id) && !forceOpen) { await closeConsole(sourceSession); showLocalToast('已断开此控制台') }
    else { await ensureConsoleConnected({ session: sourceSession, connection: conn }); showLocalToast('连接已打开', 'success') }
  } catch (error) { showLocalToast(error.message, 'error') }
  renderToolbar(); renderStatus(); side?.render()
}

async function execute({ mode = 'current', explain = false } = {}) {
  const workspaceTab = activeWorkspaceTab()
  if (workspaceTab?.kind !== 'query' || workspaceTab.editorId !== currentEditor()?.id) return
  if (state.runtime.executing) return
  const conn = currentConnection()
  const ed = currentEditor()
  const s = currentSession()
  if (!conn || !ed) {
    toast('请先选择连接与编辑器', 'warn')
    return
  }
  if (quickDesktopPreview()) { showLocalToast('此桌面控制台请在桌面继续，或新建独立快捷查询', 'warn'); return }
  captureVisibleGrid()
  if (displayedResult && grid.hasPendingChanges()) { showLocalToast('请先提交或放弃当前结果的数据变更', 'warn'); return }
  const context = operationContext()
  ed.sql = editor.getValue()
  const stmt = editor.getSelectionOrStatement(mode)
  if (stmt.unsupportedReason) { showLocalToast(stmt.unsupportedReason, 'warn'); return }
  const sql = (stmt.sql || '').trim()
  if (!sql) {
    showLocalToast('没有可执行的 SQL', 'warn')
    return
  }
  const nativeQuery = /mongo|redis|neo4j|influx|elastic|opensearch/.test(conn.driver)
  const executionPlan = nativeQuery ? [] : planSqlScript(sql, conn.driver)
  const transactionStatements = executionPlan.filter(unit => unit.kind !== 'definition' && unit.kind !== 'directive').map(unit => maskSql(unit.sql, conn.driver).trim())
  const rollsBack = transactionStatements.some(statement => /^(ROLLBACK|ABORT)\b/i.test(statement))
  const fullRollback = transactionStatements.some(statement => /^(ROLLBACK|ABORT)\b/i.test(statement) && !/^ROLLBACK(?:\s+WORK)?\s+TO\b/i.test(statement))
  if (rollsBack && consoleHasLocalChanges(s)) { showLocalToast('此控制台还有本地待提交变更，请先写入事务或放弃本地变更，再回滚', 'warn'); return }

  if (!DbHost.supportsWorkbench() && (workbench?.mode === 'quick' || s.origin === 'quick') && !/mongo|redis|neo4j|influx|elastic|opensearch/.test(conn.driver) && !isReadQuery(sql)) {
    showLocalToast('Quick 仅执行单条只读查询；请在完整工作台继续', 'warn')
    return
  }

  const danger = detectDangerousSql(sql)
  const quickReadOnly = workbench?.mode === 'quick' || s.origin === 'quick'
  if (!quickReadOnly && danger && danger.level === 'danger') {
    if (!await requestDialog({ title: '确认危险操作', message: `检测到${danger.reason}，确认执行？`, preview: sql, confirm: '执行' })) return
  }
  const isWrite = /\b(insert|update|delete|drop|alter|truncate|create|replace|merge|upsert|call|exec|execute|do|declare|begin|start|commit|rollback|grant|revoke|set)\b/i.test(nativeQuery ? sql : maskSql(sql, conn.driver))
  const needConfirm =
    !quickReadOnly && isWrite && (conn.env === 'prod' || conn.env === 'production' || conn.options?.requireConfirm === true)
  if (needConfirm) {
    if (!await requestDialog({ title: '生产环境写操作', message: '确认在生产数据库执行以下语句？', preview: sql, confirm: '执行' })) return
  }

  if (state.runtime.executing) return
  const executionId = uid('execution')
  state.runtime.activeQuery = { sessionKey: '', executionId, editorId: ed.id, consoleId: s.id, tabId: context.tabId, kind: 'query', invalidatesResults: rollsBack }
  state.runtime.executing = true
  renderToolbar()
  renderStatus()
  const rs = getResultState(ed.id)
  const started = Date.now()
  let sessionKey = ''
  try {
    sessionKey = await ensureConsoleConnected(context)
    if (!contextValid(context)) throw new Error('查询上下文已失效')
    state.runtime.activeQuery.sessionKey = sessionKey
    const req = {
      sessionKey,
      executionId,
      sql,
      maxRows: quickReadOnly ? 200 : state.ui.maxRows || 1000,
      surface: quickReadOnly ? 'quick' : context.surface,
      confirmed: needConfirm || isWrite,
      database: s?.database || conn.database,
      schema: s?.schema || conn.schema
    }
    const raw = explain ? await DbHost.explain(req) : await DbHost.execute(req)
    if (!contextValid(context)) return
    await recordExecutionForCompletion(context, explain ? `EXPLAIN ${sql}` : sql, true, sessionKey)
    const list = Array.isArray(raw) ? raw : [raw]
    const transactionState = list.at(-1)?.transactionActive
    if (transactionState !== undefined) s.transactionActive = !!transactionState
    if (!s.transactionActive || fullRollback) transactionWrites.delete(s.id)
    else if (rollsBack && transactionWrites.has(s.id)) transactionWrites.set(s.id, -1)
    if (rollsBack) invalidateConsoleResults(s)
    rs.tabs = list.map((r, i) => ({
      id: uid('result'),
      label: explain ? `执行计划 ${i + 1}` : `结果 ${i + 1}`,
      result: r,
      tableRef: r?.tableRef || detectTableRef(sql, s, conn)
    }))
    rs.activeTab = 0
    rs.error = ''
    for (const tab of rs.tabs) void hydrateResultMetadata(context, tab)
    ed.lastRun = {
      sql,
      durationMs: list[0]?.durationMs ?? Date.now() - started,
      rowCount: list[0]?.rowCount ?? list[0]?.rows?.length ?? 0,
      ts: Date.now(),
      truncated: list[0]?.truncated
    }
    pushHistory({
      connectionId: conn.id,
      sql,
      durationMs: ed.lastRun.durationMs,
      rowCount: ed.lastRun.rowCount,
      sessionName: s?.name
    })
    showLocalToast(`完成 · ${ed.lastRun.rowCount} 行 · ${ed.lastRun.durationMs} ms`, 'success')
  } catch (e) {
    await recordExecutionForCompletion(context, explain ? `EXPLAIN ${sql}` : sql, false, sessionKey)
    await reconcileFailedExecution(context, { sessionKey, rollsBack, changesTransaction: !quickReadOnly && transactionStatements.some(statement => /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i.test(statement)) })
    const msg = String(e.message || e)
    rs.tabs = [
      {
        label: '错误',
        result: {
          columns: [{ name: 'error' }],
          rows: [[msg]],
          rowCount: 0,
          durationMs: Date.now() - started
        }
      }
    ]
    rs.error = msg
    pushHistory({
      connectionId: conn.id,
      sql,
      durationMs: Date.now() - started,
      rowCount: 0,
      error: msg,
      sessionName: s?.name
    })
    showLocalToast(hostLag(e) ? '功能未就绪' : msg.slice(0, 160), hostLag(e) ? 'warn' : 'error')
  } finally {
    state.runtime.executing = false
    state.runtime.activeQuery = null
    renderToolbar()
    if (currentEditor()?.id === ed.id) { renderResultTabs(); syncDockFromGrid(); renderRightPanel() }
    renderStatus(); renderEditorTabs()
  }
}

function detectTableRef(sql, session, conn) {
  const bare = String(sql || '').replace(/--[^\n]*/g, '')
  const m = bare.match(/\bfrom\s+(`?[\w$]+`?(?:\s*\.\s*`?[\w$]+`?)?)/i)
  if (!m) return null
  const parts = m[1].replace(/`/g, '').split('.')
  if (parts.length === 3) return { database: parts[0], schema: parts[1], table: parts[2] }
  if (parts.length === 2) return { schema: parts[0], table: parts[1] }
  return {
    database: session?.database || conn?.database,
    schema: session?.schema,
    table: parts[0]
  }
}

async function cancelQuery() {
  try {
    if (!state.runtime.activeQuery?.sessionKey || state.runtime.activeQuery.kind !== 'query') return
    await DbHost.cancel(state.runtime.activeQuery)
    showLocalToast('已请求取消', 'info')
  } catch (e) {
    showLocalToast(hostLag(e) ? '功能未就绪' : String(e.message || e), 'warn')
  }
}

async function commitChanges() {
  if (state.runtime.executing) return showLocalToast('请等待当前任务完成', 'warn')
  grid.captureState()
  const context = operationContext(), conn = context.connection, resultTab = context.resultTab
  const changes = grid.toRowChanges()
  if (!changes.length || !resultTab) return toast('无待提交变更', 'info')
  if (conn?.readOnly || context.surface === 'quick' || context.session?.origin === 'quick') return toast('连接只读，无法提交', 'error')
  const preview = grid.sqlPreview(changes)
  const withinTransaction = !!context.session?.transactionActive
  if (!await confirmBatchChanges(context, changes, preview)) return
  if (state.runtime.executing || !contextValid(context)) return showLocalToast('目标控制台已变化，请重新提交', 'warn')
  captureVisibleGrid()
  state.runtime.executing = true
  state.runtime.activeQuery = { sessionKey: context.sessionKey, consoleId: context.session.id, editorId: context.editor.id, tabId: context.tabId, kind: 'applyChanges' }
  if (displayedResult === resultTab) grid.setViewOptions({ readOnly: true })
  renderToolbar()
  try {
    const res = await DbHost.applyChanges({ sessionKey: context.sessionKey, changes, mode: 'stop-on-error', confirmed: true })
    if (!contextValid(context)) return
    captureVisibleGrid()
    const out = grid.applyBatchResultToState(resultTab.gridSnapshot, res, changes)
    resultTab.gridSnapshot = out.snapshot
    if (displayedResult === resultTab) grid.restoreState(out.snapshot)
    const affected = res?.results?.filter((entry) => entry.ok).length ?? 0
    if (withinTransaction && affected) { const staged = transactionWrites.get(context.session.id) || 0; transactionWrites.set(context.session.id, staged < 0 ? -1 : staged + affected) }
    const transactional = state.runtime.dialects.find(driver => driver.id === conn.driver)?.capabilities?.transaction?.state === 'available'
    const label = withinTransaction ? `已写入当前事务：${affected} 项，尚未提交` : transactional ? `事务批量提交完成：${affected} 项` : `批量提交完成：${affected} 项`
    toast(out.anyFail ? transactional ? '批次已回滚，失败及未执行的修改保留在表格中' : '部分操作失败，失败及未执行的修改保留在表格中' : label, out.anyFail ? 'warn' : 'success')
  } catch (error) { toast(hostLag(error) ? '功能未就绪' : error.message, 'error') }
  finally { state.runtime.executing = false; state.runtime.activeQuery = null; refreshResultSurface(); renderToolbar(); syncDockFromGrid(); renderRightPanel(); renderStatus() }
}

function confirmBatchChanges(context, changes, preview) {
  const counts = { insert: 0, update: 0, delete: 0 }
  changes.forEach(change => counts[change.type]++)
  const active = !!context.session?.transactionActive
  const transactional = state.runtime.dialects.find(driver => driver.id === context.connection.driver)?.capabilities?.transaction?.state === 'available'
  const message = active ? '本次变更写入当前控制台的事务。全部成功后仍需提交事务；失败时回滚本批次，保留事务中此前的操作。' : transactional ? '本批次使用一个事务提交。任一行失败则回滚整批，表格保留修改供检查和重试。' : '此驱动未报告事务能力。按顺序提交，遇到错误停止；已经成功的操作可能无法回滚。'
  return new Promise(resolve => {
    let settled = false
    const done = value => { if (!settled) { settled = true; resolve(value) } }
    const modal = createDialog({ title: active ? '写入当前事务' : '批量提交数据变更', className: 'db-batch-dialog', content: `<p>${esc(context.connection.name)} · ${esc(context.session.database || '默认数据库')}</p><div class="db-batch-summary"><span>修改 ${counts.update}</span><span>新增 ${counts.insert}</span><span>删除 ${counts.delete}</span></div><p class="db-batch-note">${message}</p><textarea class="wb-sql-preview" readonly aria-label="SQL 预览">${esc(preview)}</textarea><div class="form-actions"><button class="btn" data-cancel>取消</button><span class="spacer"></span><button class="btn primary" data-confirm>${active ? '写入事务' : transactional ? '事务提交' : '提交变更'}</button></div>`, onClose: () => done(false) })
    modal.body.querySelector('[data-confirm]').onclick = () => { done(true); modal.close() }
    modal.body.querySelector('[data-cancel]').onclick = () => modal.close()
  })
}

function showSqlPreview(kind) {
  const preview = grid.sqlPreview()
  if (kind === 'editor') {
    const s = currentSession()
    if (createEditorTab(s, `changes-${Date.now().toString(36)}.sql`, preview)) {
      openCurrentQuery(); renderAll()
      return
    }
  }
  void requestDialog({ title: 'SQL 预览', preview, confirm: '关闭' })
}

function openExportMenu(initialScope = 'all') {
  grid.captureState()
  const context = operationContext(), tableRef = grid.tableRef && { ...grid.tableRef }
  const scopes = Object.fromEntries(['all', 'page', 'selected'].map(scope => [scope, structuredClone(grid.getExportData(scope))]))
  const hasPending = grid.hasPendingChanges(), remote = !!context.resultTab?.browse
  const columns = scopes.all.cols
  if (!columns.length) return showLocalToast('没有可导出的结果', 'info')
  const chosen = new Set(columns.map((_name, index) => index))
  const groups = [
    { title: '导出为文件', formats: [['csv', 'CSV 文件'], ['tsv-file', 'TSV 文件'], ['json', 'JSON 文件'], ['sql', 'SQL INSERT 文件'], ['md', 'Markdown 文件']] },
    { title: '复制到剪贴板', formats: [['tsv-copy', '复制 TSV（Excel）'], ['json-copy', '复制 JSON'], ['sql-copy', '复制 SQL'], ['md-copy', '复制 Markdown']] }
  ]
  const modal = createDialog({ title: '导出结果', className: 'wb-export-dialog', content: `
    <div class="db-export-options"><label>数据范围<select data-export-scope><option value="all">${remote ? '服务器当前页（含筛选）' : '已加载的筛选结果'}</option><option value="page">表格当前显示页</option><option value="selected" ${scopes.selected.rows.length ? '' : 'disabled'}>选中的 ${scopes.selected.rows.length} 行</option></select></label>
    <label>文件名称<input data-export-name value="${esc(tableRef?.table || 'result')}" aria-label="导出文件名称"></label></div>
    <p class="muted" data-export-summary role="status"></p>
    ${hasPending ? '<p class="db-export-note">包含当前本地修改，不会因此写入数据库；已标记删除的行不导出。</p>' : ''}
    <details class="db-export-columns"><summary>导出字段 <span data-column-count></span></summary><div class="db-export-column-actions"><button class="btn" data-columns="all">全选</button><button class="btn" data-columns="none">清空</button></div><div class="db-export-column-list">${columns.map((name, i) => `<label><input type="checkbox" data-export-column="${i}" checked><span title="${esc(name)}">${esc(name)}</span></label>`).join('')}</div></details>
    <details><summary>CSV / SQL 选项</summary><div class="db-export-options"><label>CSV 分隔符<select data-export-delimiter><option value=",">逗号</option><option value=";">分号</option><option value="tab">制表符</option></select></label><label class="check"><input type="checkbox" data-export-bom ${state.ui.exportBom !== false ? 'checked' : ''}>CSV 使用 UTF-8 BOM</label><label class="check"><input type="checkbox" data-export-headers checked>CSV / TSV 包含字段名</label><label class="check"><input type="checkbox" data-export-transaction checked>SQL 文件包含事务语句</label></div></details>
    <div class="export-menu">${groups.map(group => `<div class="field-group-title">${group.title}</div>${group.formats.map(([format, label]) => `<button type="button" class="btn block" data-f="${format}">${label}</button>`).join('')}`).join('')}</div><p data-export-error role="alert"></p>` })
  const root = modal.body, select = root.querySelector('[data-export-scope]')
  select.value = initialScope in scopes ? initialScope : 'all'
  const update = () => {
    root.querySelector('[data-export-summary]').textContent = `${scopes[select.value].rows.length} 行 · ${chosen.size} 列${remote ? ' · 不会读取服务器其他页' : ''}`
    root.querySelector('[data-column-count]').textContent = `${chosen.size} / ${columns.length}`
    root.querySelectorAll('[data-f]').forEach(button => { button.disabled = !chosen.size || !scopes[select.value].rows.length })
  }
  select.onchange = update
  root.querySelectorAll('[data-export-column]').forEach(input => input.onchange = () => { if (input.checked) chosen.add(Number(input.dataset.exportColumn)); else chosen.delete(Number(input.dataset.exportColumn)); update() })
  root.querySelectorAll('[data-columns]').forEach(button => button.onclick = () => { const all = button.dataset.columns === 'all'; chosen.clear(); root.querySelectorAll('[data-export-column]').forEach(input => { input.checked = all; if (all) chosen.add(Number(input.dataset.exportColumn)) }); update() })
  root.querySelectorAll('[data-f]').forEach(button => button.onclick = async () => {
    const indices = [...chosen].sort((a, b) => a - b), source = scopes[select.value]
    const cols = indices.map(index => source.cols[index]), rows = source.rows.map(row => indices.map(index => row[index]))
    const raw = button.dataset.f, format = raw.replace(/-(copy|file)$/, '')
    const options = { ...state.ui, filename: root.querySelector('[data-export-name]').value, driver: context.connection?.driver || 'mysql', delimiter: root.querySelector('[data-export-delimiter]').value === 'tab' ? '\t' : root.querySelector('[data-export-delimiter]').value, exportBom: root.querySelector('[data-export-bom]').checked, headers: root.querySelector('[data-export-headers]').checked, transaction: root.querySelector('[data-export-transaction]').checked }
    button.disabled = true
    try {
      if (raw.endsWith('-copy')) { await copyResult(format, cols, rows, tableRef, options); modal.close() }
      else { const result = await exportResult(format, cols, rows, tableRef, options, { file: true }); if (result?.ok !== false && !result?.canceled) modal.close(); else if (result?.error) root.querySelector('[data-export-error]').textContent = result.error?.message || String(result.error) }
    } catch (error) { root.querySelector('[data-export-error]').textContent = error.message }
    finally { update() }
  })
  update()
}

function openImportWizard() {
  const context = operationContext()
  if (context.connection?.readOnly || context.surface === 'quick' || context.session?.origin === 'quick') { showLocalToast('此控制台只读，不能导入', 'warn'); return }
  const tableRef = grid?.tableRef || currentResultState()?.tableRefOverride || null
  const defaultTable = tableRef
    ? [tableRef.schema, tableRef.table].filter(Boolean).join('.')
    : ''
  createImportWizard(dom.modalRoot, {
    sessionKey: context.sessionKey,
    consoleId: context.session?.id, editorId: context.editor?.id, tabId: context.tabId,
    isCurrent: () => contextValid(context),
    hostReady: !!api?.db,
    tableRef,
    defaultTable
  })
}

async function openTableData(node, conn, view = 'data', forceRefresh = false) {
  if (!conn) return
  const policy = objectPolicy(node.type)
  if (!policy.browse) view = 'structure'
  captureVisibleGrid()
  const table = node.name || node.label, origin = node.origin || workbench?.mode || 'shell'
  const tableRef = { database: node.database || conn.database || '', schema: node.schema || '', table }
  const id = objectTabId(conn.id, tableRef.database, tableRef.schema, node.type || 'table', table, origin)
  let tab = getWorkspace().tabs.find((item) => item.id === id)
  let session = tab && state.sessions.find((item) => item.id === tab.consoleId)
  if (!session) {
    session = state.sessions.find((item) => item.objectContext === id)
    if (!session) { session = createSession({ connectionId: conn.id, database: tableRef.database, schema: tableRef.schema, name: `${table} · 数据` }); if (!session) return; session.objectContext = id; session.origin = origin }
  }
  const document = session.editors.find((item) => item.id === (tab?.editorId || session.activeEditorId)) || session.editors[0]
  setActiveSession(session.id); session.activeEditorId = document.id
  document.title = table; schedulePersistSessions()
  workbench.openObject({ ...node, database: tableRef.database, schema: tableRef.schema }, conn, session, document, view)
  renderAll()
  if (view === 'structure') return
  const rs = getResultState(document.id)
  const previous = rs.tabs[rs.activeTab]
  const stale = previous?.browse && previous.browse.generation !== (consoleGenerations.get(session.id) || 0)
  if (rs.tabs.length && !forceRefresh && !stale) return
  if (previous?.gridSnapshot && snapshotHasChanges(previous.gridSnapshot)) { showLocalToast('请先提交或放弃数据变更，再重新读取', 'warn'); return }
  if (rs.loading) return
  const context = { tabId: id, session, editor: document, connection: conn, surface: origin, generation: consoleGenerations.get(session.id) || 0 }
  rs.loading = true
  try {
    let sessionKey
    const request = { table: tableRef, offset: 0, limit: 200, filters: [], order: [] }
    const paged = state.runtime.dialects.find((driver) => driver.id === conn.driver)?.capabilities?.tablePage?.state === 'available'
    const result = await runDatabaseTask({ kind: 'browse', consoleId: session.id, editorId: document.id, tabId: id }, async () => {
      sessionKey = await ensureConsoleConnected(context)
      if (!contextValid(context)) throw new Error('对象连接上下文已失效')
      state.runtime.activeQuery.sessionKey = sessionKey
      if (DbHost.supportsWorkbench()) return paged ? DbHost.workbench('table.page', { sessionKey, ...request, surface: origin }) : DbHost.browse({ sessionKey, table: tableRef, maxRows: origin === 'quick' ? 200 : state.ui.maxRows || 1000, surface: origin })
      const values = await DbHost.execute({ sessionKey, sql: objectQuery(conn.driver, tableRef), maxRows: 200, database: tableRef.database, schema: tableRef.schema })
      return Array.isArray(values) ? values[0] : values
    })
    if (!contextValid(context)) return
    if (['view', 'materialized_view'].includes(policy.type)) result.readOnly = true
    document.sql = result.sql || objectQuery(conn.driver, tableRef)
    rs.tabs = [{ id: uid('result'), label: table, result, tableRef, browse: paged ? { sessionKey, request, consoleId: session.id, generation: context.generation, surface: origin } : null }]
    rs.activeTab = 0; rs.tableRefOverride = tableRef; rs.error = ''; schedulePersistSessions()
    void hydrateResultMetadata(context, rs.tabs[0])
  } catch (error) { rs.error = error.message; showLocalToast(error.message, 'error') }
  finally { rs.loading = false; if (currentEditor()?.id === document.id) renderAll(); else workbench.update() }
}

async function treeContext(node, conn, ev) {
  const table = node.name || node.label
  const policy = objectPolicy(node.type)
  const isObject = ['table', 'view', 'materialized_view', 'measurement', 'collection', 'supertable', 'key', 'other'].includes(policy.type)
  const items = isObject
    ? [
        ['data', '打开数据'],
        ['select', '生成读取语句'],
        ['count', '生成计数语句'],
        ['copy', '复制名称'],
        ['copy-qualified', '复制完整名称'],
        ['ddl', '查看 DDL'],
        'sep',
        ['refresh', '刷新']
      ]
    : policy.special ? [
        ['ddl', `查看${policy.label}定义`],
        ['copy', '复制名称'],
        ['copy-qualified', '复制完整名称'],
        'sep', ['refresh', '刷新']
      ] : [
        ['refresh', '刷新'],
        ['copy', '复制名称']
      ]
  openCtxMenu(ev, items, async (k) => {
    if (k === 'data') await openTableData(node, conn)
    else if (k === 'select' || k === 'count') {
      captureVisibleGrid()
      const session = createSession({ connectionId: conn.id, database: node.database || conn.database, schema: node.schema })
      if (!session) return
      session.origin = node.origin || workbench.mode
      const ed = activeEditor(); ed.sql = objectQuery(conn.driver, { database: node.database || conn.database, schema: node.schema, table }, k === 'count')
      schedulePersistSessions(); openCurrentQuery(); renderAll()
    } else if (k === 'copy') {
      await clipboardWrite(table)
      showLocalToast('已复制名称', 'success')
    } else if (k === 'copy-qualified') {
      await clipboardWrite(qualifiedName(conn.driver, { database: node.database || conn.database, schema: node.schema, table }))
      showLocalToast('已复制完整名称', 'success')
    } else if (k === 'ddl') {
      await openTableData(node, conn, 'structure')
    } else if (k === 'refresh') await side.refreshTree(conn)
  })
}

/* ───────────── connection form ───────────── */

function optionsToKv(options) {
  const obj = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  return Object.entries(obj).map(([k, v]) => ({
    key: String(k),
    value: typeof v === 'string' ? v : JSON.stringify(v)
  }))
}

function kvToOptions(rows) {
  const out = {}
  for (const r of rows || []) {
    const k = String(r.key || '').trim()
    if (!k) continue
    const raw = String(r.value ?? '')
    let val = raw
    if (raw === 'true') val = true
    else if (raw === 'false') val = false
    else if (/^[\[{]/.test(raw.trim())) { try { val = JSON.parse(raw) } catch { val = raw } }
    else if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) val = Number(raw)
    out[k] = val
  }
  return out
}

function defaultPortFor(driver) {
  return state.runtime.dialects.find((item) => item.id === driver)?.defaultPort ?? ({ mysql: 3306, mariadb: 3306, timescale: 5432, postgres: 5432, influxdb: 8086, influxdb2: 8086, influxdb3: 8181, tdengine: 6041, mongodb: 27017, redis: 6379, sqlserver: 1433, oracle: 1521, clickhouse: 8123 })[driver]
}

async function openConnectionForm(existing) {
  const c = existing ? structuredClone(existing) : { id: uid('conn'), name: '', driver: 'mysql', port: 3306, env: 'dev', options: {} }
  const dialects = state.runtime.dialects.length ? state.runtime.dialects : [{ id: 'mysql', label: 'MySQL' }, { id: 'sqlite', label: 'SQLite' }]
  const fields = ['uri', 'endpoint', 'ssl', 'org', 'bucket', 'authSource', 'localDataCenter', 'connectString']
  let kvRows = optionsToKv(Object.fromEntries(Object.entries(c.options || {}).filter(([key]) => !fields.includes(key) && !['file', 'filePath', 'sqlitePath'].includes(key))))
  const value = (key) => esc(c.options?.[key] ?? c[key] ?? '')
  const modal = createDialog({ title: existing ? '编辑连接' : '新建连接', className: 'wb-connection-dialog', content: `
    <div class="form-grid">
      <h3 class="span2 form-section-title">基本信息</h3>
      <label class="span2">名称<input data-k="name" value="${value('name')}" placeholder="例如：订单库 · 开发"></label>
      <label>数据库类型<select data-k="driver">${dialects.map((d) => `<option value="${esc(d.id)}" ${c.driver === d.id ? 'selected' : ''}>${esc(d.label || d.id)}</option>`).join('')}</select></label>
      <label>环境<select data-k="env">${Object.entries({ dev: '开发', staging: '预发', prod: '生产', test: '测试' }).map(([id, label]) => `<option value="${id}" ${c.env === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <p class="span2 muted" data-description></p>
      <label data-f="net">主机<input data-k="host" value="${value('host')}" placeholder="127.0.0.1"></label>
      <label data-f="net">端口<input data-k="port" type="number" min="1" max="65535" value="${value('port')}"></label>
      <label class="span2" data-f="uri">连接 URI<input data-k="uri" value="${value('uri')}" placeholder="留空时使用主机与端口；密码请填写在下方"></label>
      <label class="span2" data-f="http">HTTP 端点<input data-k="endpoint" value="${value('endpoint')}" placeholder="https://database.example.com:8086"></label>
      <label data-f="net">数据库 / Keyspace<input data-k="database" value="${value('database')}"></label>
      <h3 class="span2 form-section-title" data-f="net">身份与安全</h3>
      <label data-f="net">用户名<input data-k="username" value="${value('username')}" autocomplete="off"></label>
      <label class="span2" data-f="net">密码 / Token<input data-k="secret" type="password" autocomplete="new-password" placeholder="${c.secretRef ? '已保存，留空保留' : '仅保存在本机凭据库'}"></label>
      <label class="span2" data-f="file">数据库文件<div class="row"><input data-k="fileLabel" readonly value="${esc(c.fileLabel || c.filePath || c.sqlitePath || '')}" placeholder="通过宿主选择文件并授权"><button class="btn" data-act="pick-sqlite">选择文件</button><button class="btn" data-act="create-sqlite">新建文件</button></div></label>
      <label data-f="influx">组织 Org<input data-k="org" value="${value('org')}"></label><label data-f="influx">Bucket<input data-k="bucket" value="${value('bucket')}"></label>
      <label data-f="mongo">认证数据库<input data-k="authSource" value="${value('authSource')}" placeholder="admin"></label>
      <label data-f="cassandra">本地数据中心<input data-k="localDataCenter" value="${value('localDataCenter')}" placeholder="datacenter1"></label>
      <label class="span2" data-f="oracle">Oracle 连接串<input data-k="connectString" value="${value('connectString')}" placeholder="host:1521/service"></label>
      <div class="form-check-row span2"><label><input data-k="readOnly" type="checkbox" ${c.readOnly ? 'checked' : ''}> 只读</label><label><input data-k="favorite" type="checkbox" ${c.favorite ? 'checked' : ''}> 收藏</label><label data-f="net"><input data-k="ssl" type="checkbox" ${c.options?.ssl ? 'checked' : ''}> TLS 加密连接</label></div>
      <details class="span2"><summary>高级选项与备注</summary><label>备注<input data-k="note" value="${value('note')}"></label><p class="muted">驱动选项支持字符串、数字、布尔值和 JSON。密码、Token 请使用上方凭据字段。</p><div data-el="kv"></div><button class="btn" data-act="kv-add">添加选项</button></details>
    </div><p class="hint" data-el="form-hint" role="status"></p><div class="form-actions"><button class="btn" data-act="test">测试连接</button><button class="btn" data-act="clear-secret" ${c.secretRef ? '' : 'disabled'}>清除密码</button><span class="spacer"></span><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="save">保存</button></div>` })
  const root = modal.body, get = (key) => root.querySelector(`[data-k=${key}]`), hint = root.querySelector('[data-el=form-hint]')
  const fail = (message) => { hint.textContent = message; hint.classList.add('hint-error') }
  const renderKv = () => { root.querySelector('[data-el=kv]').innerHTML = kvRows.map((row, i) => `<div class="kv-row"><input data-index="${i}" data-part="key" value="${esc(row.key)}" placeholder="选项名"><input data-index="${i}" data-part="value" value="${esc(row.value)}" placeholder="值"><button class="btn" data-remove="${i}" aria-label="删除选项">×</button></div>`).join(''); root.querySelectorAll('[data-index]').forEach((input) => input.oninput = () => kvRows[input.dataset.index][input.dataset.part] = input.value); root.querySelectorAll('[data-remove]').forEach((button) => button.onclick = () => { kvRows.splice(Number(button.dataset.remove), 1); renderKv() }) }
  const sync = () => {
    const driver = get('driver').value, descriptor = dialects.find((item) => item.id === driver), file = ['sqlite', 'duckdb'].includes(driver)
    const visible = { file, net: !file, uri: ['mongodb', 'redis', 'neo4j', 'tdengine'].includes(driver), http: ['influxdb', 'influxdb1', 'influxdb3', 'elasticsearch', 'opensearch', 'clickhouse'].includes(driver), influx: /^influx/.test(driver), mongo: driver === 'mongodb', cassandra: ['cassandra', 'scylladb'].includes(driver), oracle: driver === 'oracle' }
    root.querySelectorAll('[data-f]').forEach((field) => field.hidden = !visible[field.dataset.f])
    root.querySelector('[data-description]').textContent = descriptor?.capabilities?.connect?.reason || `${descriptor?.language || 'SQL'} · ${file ? '本地文件' : descriptor?.transport || '数据库原生协议'}。连接后按驱动能力显示可用操作。`
    hint.textContent = ''; hint.classList.remove('hint-error')
  }
  const read = () => {
    const driver = get('driver').value, file = ['sqlite', 'duckdb'].includes(driver), options = kvToOptions(kvRows)
    for (const key of fields) { if (key === 'ssl') { options.ssl = get(key).checked; continue } const field = get(key); if (!field.closest('[hidden]') && field.value.trim()) options[key] = field.value.trim() }
    return { ...c, driver, dialect: driver, name: get('name').value.trim(), host: file ? '' : get('host').value.trim(), port: file ? undefined : Number(get('port').value) || undefined, database: file ? '' : get('database').value.trim(), username: file ? '' : get('username').value.trim(), fileHandleId: file ? c.fileHandleId : undefined, fileLabel: file ? get('fileLabel').value : undefined, env: get('env').value, readOnly: get('readOnly').checked, favorite: get('favorite').checked, note: get('note').value.trim(), options }
  }
  const validate = (form) => {
    if (!form.name) throw new Error('请填写连接名称')
    if (['sqlite', 'duckdb'].includes(form.driver)) { if (!form.fileHandleId && !form.fileLabel) throw new Error('请选择并授权数据库文件') }
    else if (!form.host && !form.options.uri && !form.options.endpoint && !form.options.connectString) throw new Error('请填写主机、连接 URI 或 HTTP 端点')
    if (form.port && (form.port < 1 || form.port > 65535)) throw new Error('端口范围为 1–65535')
    for (const key of ['uri', 'endpoint']) if (form.options[key]) { let parsed; try { parsed = new URL(form.options[key]) } catch { throw new Error(`${key === 'uri' ? '连接 URI' : 'HTTP 端点'}格式不正确`) } if (parsed.password || [...parsed.searchParams.keys()].some((name) => /password|token|secret|api.?key/i.test(name))) throw new Error('连接地址中不能包含密码或 Token，请移至凭据字段') }
    if (Object.keys(form.options).some((key) => /password|token|secret|api.?key|^(file|filePath|sqlitePath)$/i.test(key))) throw new Error('高级选项不能保存密码、Token 或本地文件路径，请使用对应授权字段')
  }
  root.querySelector('[data-act=close]').onclick = modal.close
  root.querySelector('[data-act=kv-add]').onclick = () => { kvRows.push({ key: '', value: '' }); renderKv() }
  get('driver').onchange = () => { get('port').value = defaultPortFor(get('driver').value) ?? ''; sync() }
  get('readOnly').onchange = () => { c.fileHandleId = undefined }
  root.querySelector('[data-act=create-sqlite]').onclick = async () => { try { const picked = await DbHost.pickSqliteFile({ createIfMissing: true }); if (picked?.id) { c.fileHandleId = picked.id; c.createIfMissing = true; get('readOnly').checked = false; get('fileLabel').value = picked.displayPath || picked.name } } catch (error) { fail(error.message) } }
  root.querySelector('[data-act=pick-sqlite]').onclick = async () => { try { const picked = await DbHost.pickSqliteFile({ readOnly: get('readOnly').checked }); if (picked?.id) { c.fileHandleId = picked.id; get('fileLabel').value = picked.displayPath || picked.name } } catch (error) { fail(error.message) } }
  root.querySelector('[data-act=clear-secret]').onclick = async (event) => { try { await Vault.remove(c.secretRef); c.secretRef = ''; event.target.disabled = true; hint.textContent = '已清除保存的凭据' } catch (error) { fail(`清除失败：${error.message}`) } }
  const submit = async (test, button) => {
    button.disabled = true; hint.classList.remove('hint-error')
    try {
      const form = read(); delete form.filePath; delete form.sqlitePath; validate(form)
      if (get('secret').value) { const result = await Vault.set(`conn:${form.id}:auth`, get('secret').value); form.secretRef = result?.secretRef || result; if (!form.secretRef) throw new Error('凭据库未返回引用，连接未保存'); c.secretRef = form.secretRef }
      if (test) { hint.textContent = '正在测试连接…'; const result = await DbHost.test(toConnectionInput(form)); if (!result?.ok) throw new Error(result?.message || '连接失败'); hint.textContent = `连接成功 ${result.version || ''}` }
      else {
        hint.textContent = '正在保存…'
        if (existing) {
          const sessions = state.sessions.filter(session => session.connectionId === existing.id)
          if (sessions.some(session => session.transactionActive)) throw new Error('此连接仍有事务，请先提交或回滚后再修改配置')
          if (sessions.some(session => state.runtime.activeQuery?.consoleId === session.id || state.runtime.activeQuery?.consoleIds?.includes(session.id))) throw new Error('此连接仍有任务，请先等待完成')
          for (const session of sessions) await closeConsole(session)
        }
        const saved = await saveConnection(form)
        connectionConfigRevisions.set(saved.id, (connectionConfigRevisions.get(saved.id) || 0) + 1)
        invalidateConnectionCompletion(saved.id, '连接配置已保存', false)
        await side?.invalidateConnection?.(saved.id)
        state.selectedConnectionId = saved.id; modal.close(); renderAll(); toast('连接已保存', 'success')
      }
    } catch (error) { fail(error.message || String(error)) } finally { button.disabled = false }
  }
  root.querySelector('[data-act=test]').onclick = (event) => void submit(true, event.target)
  root.querySelector('[data-act=save]').onclick = (event) => void submit(false, event.target)
  renderKv(); sync(); get('name').focus()
}

/* ───────────── chrome ───────────── */

function bindChrome() {
  dom.topMore?.addEventListener('click', (e) => openChromeMenu(e))
  dom.fabRun?.addEventListener('click', () => void execute({ mode: 'current' }))
}

function bindResizers() {
  bindDockResize($('#resizer-bottom'), dom.results, { axis: 'y', min: 120, max: 650, invert: true, onChange: (v) => setUiPref('bottomHeight', v) })
  bindDockResize($('#resizer-right'), dom.rightPanel, { min: 220, max: 600, invert: true, onChange: (v) => setUiPref('rightWidth', v) })
}

function showLocalToast(message, type = 'info') {
  if (workbench?.mode === 'quick' && type === 'success') return
  const el = dom.toastLocal
  el.textContent = String(message ?? '').slice(0, 200)
  el.dataset.type = type
  el.hidden = false
  el.classList.add('show')
  clearTimeout(showLocalToast._t)
  showLocalToast._t = setTimeout(() => {
    el.classList.remove('show')
    el.hidden = true
  }, 3200)
}

void boot()
