/**
 * main.js — 数据库插件入口
 * 数据：enest.storage KV；密钥：enest.vault.set → secretRef
 * Host：db.* Spec 方法名；宿主滞后 try/catch → toast/状态
 * UI：顶栏连接 chip + ⋯；侧栏可折叠图标轨；FAB 执行；右键/菜单收纳次要操作
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
  closeEditorTab,
  updateSessionEditorSql,
  saveSessionsImmediate,
  schedulePersistSessions,
  pushHistory,
  getResultState,
  setUiPref,
  uid
} from './store.js'
import { SqlEditor } from './monacoEditor.js'
import { DatabaseWorkbench } from './workbench.js'
import { createDialog, bindDockResize } from '@enest/plugin-kit/workbench'
import { isReadQuery } from './comparison.js'
import { objectQuery } from './queryTemplates.js'
import { ResultGrid } from './resultGrid.js'
import {
  setCatalog,
  invalidateCatalog,
  detectDdl,
  kindMeta,
  warmCatalogFromHost,
  patchCatalogTable,
  dialectOf
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
  const conn = currentConnection()
  return conn?.dialect || conn?.driver || 'mysql'
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
  await registerPluginSettings()
  await applyShellTheme()
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
    getCompletionScope: () => {
      const conn = currentConnection()
      const s = currentSession()
      return {
        database: s?.database || conn?.database,
        schema: s?.schema || conn?.schema,
        usageBoost: state.completionUsage,
        autoAliasAfterTable: state.ui.autoAliasAfterTable !== false
      }
    }
  })

  grid = new ResultGrid(dom.results, {
    onCommit: () => void commitChanges(),
    onRevert: () => {
      syncDockFromGrid()
      renderRightPanel()
    },
    onExport: () => openExportMenu(),
    onExportCsv: () => {
      const { cols, rows } = grid.getExportData(grid.selectedRows.size ? 'selected' : 'all')
      void exportResult('csv', cols, rows, grid.tableRef, state.ui)
    },
    onImport: () => openImportWizard(),
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
    onConnectionAction: (id, act) => void onConnectionAction(id, act),
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
    onOpenTable: (node, conn) => void openTableData(node, conn),
    onTreeContext: (node, conn, ev) => void treeContext(node, conn, ev),
    onCatalogPatch: (connId, tableName, columns) => {
      const sk = state.runtime.sessionKeys.get(connId)
      if (!sk || !tableName) return
      patchCatalogTable(sk, tableName, {
        name: tableName,
        columns: (columns || []).map((c) => ({
          name: c.name,
          type: c.type || c.dataType,
          comment: c.comment,
          pk: !!(c.pk || c.primaryKey)
        }))
      })
    }
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
  await loadDialects()
  workbench = new DatabaseWorkbench({
    editor: () => editor, connection: currentConnection, session: currentSession, sessionKey: currentSessionKey,
    isConnected: currentConnected,
    execute, cancel: cancelQuery, save: saveSessionNow, export: openExportMenu, message: showLocalToast,
    newConnection: openConnectionForm,
    browse: (node) => openTableData(node, currentConnection()),
    surfaceChanged: refreshResultSurface,
    newQuery: async () => { const session = currentSession(); if (session && !quickDesktopPreview()) createEditorTab(session); else await newSession(currentConnection()?.id); renderAll() },
    newQuick: async () => { await newSession(currentConnection()?.id); workbench.navigate('query') },
    connect: () => toggleConnect(false),
    selectConnection: async (id) => { await onConnectionAction(id, 'connect'); if (!currentConnected()) throw new Error('连接未成功，请检查连接配置') },
    switchDatabase: async (database) => {
      const conn = currentConnection(), session = currentSession(); if (!conn || !session) return
      if (session.transactionActive) throw new Error('此控制台仍有事务，请先提交或回滚后再切换数据库')
      const previous = state.runtime.consoleSessionKeys.get(session.id)
      const preferred = `${sessionKeyOf(conn.id, database)}::console:${session.id}`
      const response = await DbHost.open({ config: consoleConnectionInput(conn, session, database), sessionKey: preferred })
      const next = response.sessionKey || preferred
      if (previous && previous !== next) { try { await DbHost.close(previous) } catch (error) { await DbHost.close(next); throw error } }
      state.runtime.consoleSessionKeys.set(session.id, next); state.runtime.sessionKeys.set(conn.id, next); session.database = database; schedulePersistSessions(); renderAll()
    },
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
  side.setTab(state.ui.leftTab || 'sessions')

  api?.onEnter?.((event) => {
    if (event?.code === 'settings') workbench.navigate('settings')
    side?.render()
    renderAll()
  })
  api?.onBeforeClose?.(async () => {
    try {
      await flushPendingPersist()
    } catch {
      /* ignore */
    }
  })
  window.addEventListener('pagehide', () => {
    try {
      void flushPendingPersist().catch(() => {})
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
  const s = currentSession()
  const editors = s?.editors || []
  if (!editors.length) {
    dom.editorTabs.innerHTML = `<span class="muted sm">—</span>
      <button type="button" class="btn icon" data-e="new" title="新建查询">＋</button>`
    dom.editorTabs.querySelector('[data-e=new]')?.addEventListener('click', () => {
      const sess = currentSession()
      if (sess) createEditorTab(sess)
      else void newSession()
      renderAll()
    })
    return
  }
  dom.editorTabs.innerHTML =
    editors
      .map(
        (e) =>
          `<div class="tab ed-tab${e.id === s.activeEditorId ? ' active' : ''}" data-id="${e.id}">
            ${esc(e.title)}${e.dirty ? ' *' : ''}
            <button type="button" class="tab-x" data-close="${e.id}" title="关闭">×</button>
          </div>`
      )
      .join('') +
    `<button type="button" class="btn icon" data-e="new" title="新建查询">＋</button>`
  dom.editorTabs.querySelectorAll('.ed-tab').forEach((el) => {
    el.addEventListener('click', () => {
      const sess = currentSession()
      if (!sess) return
      const ed = sess.editors.find((x) => x.id === el.dataset.id)
      if (!ed) return
      sess.activeEditorId = ed.id
      renderEditorTabs()
      renderEditorValue()
      renderResultTabs()
      renderStatus()
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      editorTabContext(el.dataset.id, e)
    })
  })
  dom.editorTabs.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const sess = currentSession()
      if (!sess) return
      closeEditorTab(sess, btn.dataset.close)
      renderAll()
    })
  })
  dom.editorTabs.querySelector('[data-e=new]')?.addEventListener('click', () => {
    const sess = currentSession()
    if (sess) createEditorTab(sess)
    else void newSession()
    renderAll()
  })
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
    const label = busy ? '执行中…' : '执行当前语句'
    setTip(dom.fabRun, label)
    dom.fabRun.innerHTML = busy ? '…' : '▶'
  }
  workbench?.update()
}

/** 顶栏 ⋯：执行 + 次要操作 */
function openChromeMenu(ev) {
  const conn = currentConnection()
  const open = currentConnected()
  const busy = !!state.runtime.executing
  const dirty = !!(grid && grid.pendingChanges().length)
  const items = menuItems([
    ['run-all', '全部执行'],
    ['run-sel', '执行选中'],
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
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  const tabs = rs?.tabs || []
  const hasData = tabs.length > 0
  // 结果列表：执行并拿到数据后才显示
  setResultsVisible(hasData)
  if (!hasData) {
    const tabsEl = dom.results?.querySelector('.result-tabs')
    if (tabsEl) tabsEl.hidden = true
    const conn = currentConnection()
    grid?.setResult({
      result: null,
      tableRef: null,
      readOnly: !!conn?.readOnly,
      driverUpdatable: !['influxdb'].includes(conn?.driver),
      pageSize: ed?.gridState?.pageSize
    })
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
  const ed = currentEditor()
  const rs = ed ? getResultState(ed.id) : null
  const tab = rs?.tabs?.[rs.activeTab]
  const conn = currentConnection()
  renderServerPager(tab)
  const descriptor = state.runtime.dialects.find((driver) => driver.id === conn?.driver)
  const editCapability = descriptor?.capabilities?.edit || descriptor?.capabilities?.crud
  const driverUpdatable = editCapability ? editCapability.state === 'available' : !/influx|tdengine|redis/.test(conn?.driver || '')
  if (!tab) {
    grid.setResult({
      result: null,
      tableRef: null,
      readOnly: !!conn?.readOnly,
      driverUpdatable,
      pageSize: ed?.gridState?.pageSize
    })
    renderQuickResultBar(tab)
    return
  }
  grid.setResult({
    result: tab.result,
    serverPage: quickDesktopPreview() ? undefined : tab.browse?.request,
    tableRef: tab.tableRef || rs.tableRefOverride,
    readOnly: workbench?.mode === 'quick' || currentSession()?.origin === 'quick' || !!conn?.readOnly || !!tab.result?.readOnly,
    driverUpdatable,
    pageSize: ed?.gridState?.pageSize
  })
  renderQuickResultBar(tab)
}

function refreshResultSurface() {
  const rs = currentResultState(), tab = rs?.tabs?.[rs.activeTab]
  // Change presentation without reloading results or dropping uncommitted cell edits.
  grid.setViewOptions({
    readOnly: workbench?.mode === 'quick' || currentSession()?.origin === 'quick' || !!currentConnection()?.readOnly || !!tab?.result?.readOnly,
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
  bar.querySelector('[data-export-results]').onclick = () => { const { cols, rows } = grid.getExportData('all'); void exportResult('csv', cols, rows, grid.tableRef, state.ui) }
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
  bar.innerHTML = `<span title="${paging.stableOrder ? '稳定排序' : '无唯一排序，翻页结果可能变化'}">服务器分页 · ${offset + (rows ? 1 : 0)}–${offset + rows} 行${request.filters?.length ? ` · ${request.filters.length} 条件` : ''}</span><span class="muted">${paging.stableOrder ? '稳定排序' : '无唯一排序，翻页结果可能变化'}</span><span class="spacer"></span><button class="btn" data-server-filter>筛选${request.filters?.length ? ` (${request.filters.length})` : ''}</button><button class="btn" data-server-prev ${offset === 0 ? 'disabled' : ''}>上一页</button><button class="btn" data-server-next ${!paging.hasMore ? 'disabled' : ''}>下一页</button><select aria-label="服务器每页行数">${[50, 100, 200, ...(workbench?.mode === 'quick' ? [] : [500, 1000])].map((size) => `<option ${size === limit ? 'selected' : ''}>${size}</option>`).join('')}</select><button class="btn" data-server-refresh>刷新</button><span class="muted">导出范围：当前页</span>`
  dom.results.append(bar)
  bar.querySelector('[data-server-prev]').onclick = () => void fetchTablePage(tab, { offset: Math.max(0, offset - (workbench?.mode === 'quick' ? Math.min(200, limit) : limit)) })
  bar.querySelector('[data-server-next]').onclick = () => void fetchTablePage(tab, { offset: offset + limit })
  bar.querySelector('[data-server-refresh]').onclick = () => void fetchTablePage(tab)
  bar.querySelector('select').onchange = (event) => void fetchTablePage(tab, { limit: Number(event.target.value), offset: 0 })
  bar.querySelector('[data-server-filter]').onclick = () => openServerFilters(tab)
}

async function fetchTablePage(tab, changes = {}) {
  if (!tab?.browse || tab.browse.loading) return false
  if (quickDesktopPreview()) { showLocalToast('此桌面控制台请在桌面继续，或新建独立快捷查询', 'warn'); return false }
  if (grid.pendingChanges().length) { showLocalToast('请先提交或放弃当前页的数据变更，再进行服务器分页、排序或筛选', 'warn'); return false }
  const request = { ...tab.browse.request, ...changes }, { sessionKey } = tab.browse
  if (workbench?.mode === 'quick') request.limit = Math.min(200, request.limit)
  tab.browse.loading = true
  try {
    const result = await DbHost.workbench('table.page', { sessionKey, ...request, surface: workbench?.mode || 'shell' })
    tab.result = result; tab.browse.request = { ...request, offset: result.page?.offset ?? request.offset, limit: result.page?.limit ?? request.limit }
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
  setActiveSession(id)
  const s = currentSession()
  if (s) state.selectedConnectionId = s.connectionId
  if (s && state.runtime.consoleSessionKeys.has(s.id)) state.runtime.sessionKeys.set(s.connectionId, state.runtime.consoleSessionKeys.get(s.id))
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
  if (!state.connections.length) {
    await openConnectionForm()
    return
  }
  const connId = connectionId || state.selectedConnectionId || state.connections[0].id
  const s = createSession({ connectionId: connId })
  if (!s) return
  s.origin = workbench?.mode || 'shell'
  state.selectedConnectionId = connId
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
    duplicateSession(id)
    renderAll()
  } else if (act === 'export') {
    const s = state.sessions.find((x) => x.id === id)
    if (s) await exportSessions([s])
  } else if (act === 'del') {
    if (await requestDialog({ title: '删除控制台会话', message: '删除此会话及其查询文档？', confirm: '删除' })) {
      try { await closeConsole(state.sessions.find((session) => session.id === id)) } catch (error) { showLocalToast(error.message, 'warn'); return }
      deleteSession(id)
      renderAll()
    }
  }
}

async function onConnectionAction(id, act) {
  state.selectedConnectionId = id
  if (act === 'connect' || act === 'open') {
    const origin = workbench?.mode || 'shell'
    let s = state.sessions.find((x) => x.connectionId === id && (x.origin || 'shell') === origin)
    if (!s) { s = createSession({ connectionId: id }); s.origin = origin; schedulePersistSessions() }
    else setActiveSession(s.id)
    renderAll()
    await toggleConnect(true)
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
      removeConnection(id)
      if (conn?.secretRef) {
        try {
          await Vault.remove(conn.secretRef)
        } catch {
          /* host lag */
        }
      }
      renderAll()
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

function editorTabContext(editorId, ev) {
  const sess = currentSession()
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
        ;(sess.editors || []).slice().forEach((e) => {
          if (e.id !== editorId) closeEditorTab(sess, e.id)
        })
        if (!sess.editors.some((e) => e.id === editorId) && sess.editors[0]) {
          sess.activeEditorId = sess.editors[0].id
        } else {
          sess.activeEditorId = editorId
        }
        renderAll()
      } else if (k === 'rename') {
        const ed = sess.editors.find((x) => x.id === editorId)
        const name = await requestDialog({ title: '查询文档名称', value: ed?.title || '' })
        if (name && ed) {
          ed.title = name.trim() || ed.title
          ed.dirty = true
          renderEditorTabs()
        }
      } else if (k === 'dup') {
        const ed = sess.editors.find((x) => x.id === editorId)
        if (ed) createEditorTab(sess, `${ed.title.replace(/\.sql$/i, '')}-副本.sql`, ed.sql)
        renderAll()
      } else if (k === 'close') {
        closeEditorTab(sess, editorId)
        renderAll()
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
  const sessionKey = state.runtime.consoleSessionKeys.get(session.id)
  if (!sessionKey) return
  await DbHost.close(sessionKey)
  state.runtime.consoleSessionKeys.delete(session.id); invalidateCatalog(sessionKey)
  if (state.runtime.sessionKeys.get(session.connectionId) === sessionKey) {
    const other = state.sessions.find((item) => item.id !== session.id && item.connectionId === session.connectionId && state.runtime.consoleSessionKeys.has(item.id))
    if (other) state.runtime.sessionKeys.set(session.connectionId, state.runtime.consoleSessionKeys.get(other.id))
    else state.runtime.sessionKeys.delete(session.connectionId)
  }
}

async function toggleConnect(forceOpen) {
  const conn = currentConnection()
  const s = currentSession()
  if (!conn) {
    await openConnectionForm()
    return
  }
  if (!s) { await newSession(conn.id); return toggleConnect(forceOpen) }
  const existing = state.runtime.consoleSessionKeys.get(s.id)
  if (existing && !forceOpen) {
    try {
      await closeConsole(s)
    } catch (e) {
      showLocalToast(String(e.message || e).slice(0, 120), 'warn')
      return
    }
    renderToolbar()
    renderStatus()
    showLocalToast('已断开连接')
    return
  }
  if (existing && forceOpen) { state.runtime.sessionKeys.set(conn.id, existing); return }
  try {
    const database = s?.database || conn.database
    const preferredKey = `${sessionKeyOf(conn.id, database)}::console:${s.id}`
    const res = await DbHost.open({
      config: consoleConnectionInput(conn, s, database),
      sessionKey: preferredKey
    })
    const sessionKey = res?.sessionKey || res?.key || preferredKey
    state.runtime.sessionKeys.set(conn.id, sessionKey)
    state.runtime.consoleSessionKeys.set(s.id, sessionKey)
    s.transactionActive = !!res?.transactionActive
    conn.lastConnectedAt = Date.now()
    if (res?.dialect) conn.dialect = res.dialect
    upsertConnection(conn)
    if (res?.catalog) setCatalog(sessionKey, res.catalog)
    // 预热本地 catalog（宿主 completion 会话未就绪时仍可提示表/列）
    void warmCatalogFromHost(sessionKey, {
      driver: conn.driver,
      database,
      schema: s?.schema || conn.schema,
      tablesFn: (q) => DbHost.schema.tables(q),
      describeFn: (q) => DbHost.schema.describe(q)
    })
    showLocalToast('连接已打开', 'success')
    try {
      await notify({ title: '数据库', body: `已连接 ${conn.name}` })
    } catch {
      /* ignore */
    }
  } catch (e) {
    const msg = hostLag(e) ? '功能未就绪' : String(e.message || e).slice(0, 160)
    showLocalToast(msg, hostLag(e) ? 'warn' : 'error')
  }
  renderToolbar()
  renderStatus()
}

async function execute({ mode = 'current', explain = false } = {}) {
  if (state.runtime.executing) return
  const conn = currentConnection()
  const ed = currentEditor()
  const s = currentSession()
  if (!conn || !ed) {
    toast('请先选择连接与编辑器', 'warn')
    return
  }
  if (quickDesktopPreview()) { showLocalToast('此桌面控制台请在桌面继续，或新建独立快捷查询', 'warn'); return }
  ed.sql = editor.getValue()
  const stmt = editor.getSelectionOrStatement(mode)
  const sql = (stmt.sql || '').trim()
  if (!sql) {
    showLocalToast('没有可执行的 SQL', 'warn')
    return
  }

  if (!DbHost.supportsWorkbench() && (workbench?.mode === 'quick' || s.origin === 'quick') && !/mongo|redis|neo4j|influx|elastic|opensearch/.test(conn.driver) && !isReadQuery(sql)) {
    showLocalToast('Quick 仅执行单条只读查询；请在完整工作台继续', 'warn')
    return
  }

  const danger = detectDangerousSql(sql)
  const quickReadOnly = workbench?.mode === 'quick' || s.origin === 'quick'
  if (!quickReadOnly && danger && danger.level === 'danger') {
    if (!await requestDialog({ title: '确认危险操作', message: `检测到${danger.reason}，确认执行？`, preview: sql, confirm: '执行' })) return
  }
  const isWrite = /\b(insert|update|delete|drop|alter|truncate|create|replace|merge|upsert)\b/i.test(sql)
  const needConfirm =
    !quickReadOnly && isWrite && (conn.env === 'prod' || conn.env === 'production' || conn.options?.requireConfirm === true)
  if (needConfirm) {
    if (!await requestDialog({ title: '生产环境写操作', message: '确认在生产数据库执行以下语句？', preview: sql, confirm: '执行' })) return
  }

  if (!state.runtime.consoleSessionKeys.has(s.id)) {
    await toggleConnect(true)
    if (!state.runtime.consoleSessionKeys.has(s.id)) {
      showLocalToast('未连接，无法执行', 'warn')
      return
    }
  }
  const sessionKey = currentSessionKey()
  const executionId = uid('execution')
  state.runtime.activeQuery = { sessionKey, executionId, editorId: ed.id }
  state.runtime.executing = true
  renderToolbar()
  renderStatus()
  const rs = currentResultState()
  const started = Date.now()
  try {
    const req = {
      sessionKey,
      executionId,
      sql,
      maxRows: workbench?.mode === 'quick' ? 200 : state.ui.maxRows || 1000,
      surface: workbench?.mode || 'shell',
      confirmed: needConfirm || isWrite,
      database: s?.database || conn.database,
      schema: s?.schema || conn.schema
    }
    const raw = explain ? await DbHost.explain(req) : await DbHost.execute(req)
    const list = Array.isArray(raw) ? raw : [raw]
    s.transactionActive = !!list.at(-1)?.transactionActive
    rs.tabs = list.map((r, i) => ({
      label: explain ? `执行计划 ${i + 1}` : `结果 ${i + 1}`,
      result: r,
      tableRef: r?.tableRef || detectTableRef(sql, s, conn)
    }))
    rs.activeTab = 0
    rs.error = ''
    ed.lastRun = {
      sql,
      durationMs: list[0]?.durationMs ?? Date.now() - started,
      rowCount: list[0]?.rowCount ?? list[0]?.rows?.length ?? 0,
      ts: Date.now(),
      truncated: list[0]?.truncated
    }
    if (detectDdl(sql)) {
      invalidateCatalog(sessionKey)
      void warmCatalogFromHost(sessionKey, {
        driver: conn.driver,
        database: s?.database || conn.database,
        schema: s?.schema || conn.schema,
        tablesFn: (q) => DbHost.schema.tables(q),
        describeFn: (q) => DbHost.schema.describe(q)
      })
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
    renderResultTabs()
    renderStatus()
    syncDockFromGrid()
    renderRightPanel()
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
    if (!state.runtime.activeQuery) return
    await DbHost.cancel(state.runtime.activeQuery)
    showLocalToast('已请求取消', 'info')
  } catch (e) {
    showLocalToast(hostLag(e) ? '功能未就绪' : String(e.message || e), 'warn')
  }
}

async function commitChanges() {
  const conn = currentConnection()
  const changes = grid.toRowChanges()
  if (!changes.length) {
    toast('无待提交变更', 'info')
    return
  }
  if (conn?.readOnly || workbench?.mode === 'quick' || currentSession()?.origin === 'quick') {
    toast('连接只读，无法提交', 'error')
    return
  }
  const preview = grid.sqlPreview(changes)
  if (!await requestDialog({ title: '提交数据变更', message: `将提交 ${changes.length} 条变更，请核对 SQL。`, preview, confirm: '提交' })) return
  try {
    const res = await DbHost.applyChanges({
      sessionKey: currentSessionKey(),
      changes,
      mode: 'stop-on-error',
      // UI 已二次确认；prod/requireConfirm 宿主也要求 confirmed
      confirmed: true
    })
    const out = grid.applyBatchResult(res, changes)
    const affected = res?.results?.filter((r) => r.ok).length ?? 0
    toast(
      `提交完成：${affected} 成功${out.anyFail ? '，部分失败' : ''}`,
      out.anyFail ? 'warn' : 'success'
    )
  } catch (e) {
    toast(
      hostLag(e) ? '功能未就绪' : String(e.message || e).slice(0, 160),
      hostLag(e) ? 'warn' : 'error'
    )
  }
  syncDockFromGrid()
  renderRightPanel()
  renderStatus()
}

function showSqlPreview(kind) {
  const preview = grid.sqlPreview()
  if (kind === 'editor') {
    const s = currentSession()
    if (createEditorTab(s, `changes-${Date.now().toString(36)}.sql`, preview)) {
      renderAll()
      return
    }
  }
  void requestDialog({ title: 'SQL 预览', preview, confirm: '关闭' })
}

function openExportMenu() {
  const { cols, rows } = grid.getExportData('all')
  const groups = [
    { title: '导出为文件', formats: [
      ['csv', 'CSV 文件'],
      ['json', 'JSON 文件'],
      ['sql', 'SQL INSERT 文件'],
      ['md', 'Markdown 文件']
    ] },
    { title: '复制到剪贴板', formats: [
      ['tsv', '复制 TSV（Excel）'],
      ['json-copy', '复制 JSON'],
      ['sql-copy', '复制 SQL'],
      ['md-copy', '复制 Markdown']
    ] }
  ]
  dom.modalRoot.innerHTML = `
    <div class="modal-mask">
      <div class="modal small">
        <div class="modal-head"><strong>导出结果</strong><button type="button" class="btn ghost" data-act="close">关闭</button></div>
        <div class="modal-body export-menu">
          ${groups
            .map(
              (g) => `<div class="field-group-title">${g.title}</div>${g.formats
                .map(([k, label]) => `<button type="button" class="btn block" data-f="${k}">${label}</button>`)
                .join('')}`
            )
            .join('')}
        </div>
      </div>
    </div>`
  const close = () => (dom.modalRoot.innerHTML = '')
  dom.modalRoot.querySelector('[data-act=close]')?.addEventListener('click', close)
  dom.modalRoot.querySelectorAll('[data-f]').forEach((b) => {
    b.addEventListener('click', async () => {
      const f = b.dataset.f
      close()
      if (f.endsWith('-copy')) await copyResult(f.replace('-copy', ''), cols, rows)
      else await exportResult(f, cols, rows, grid.tableRef, state.ui)
    })
  })
}

function openImportWizard() {
  const tableRef = grid?.tableRef || currentResultState()?.tableRefOverride || null
  const defaultTable = tableRef
    ? [tableRef.schema, tableRef.table].filter(Boolean).join('.')
    : ''
  createImportWizard(dom.modalRoot, {
    sessionKey: currentSessionKey(),
    hostReady: !!api?.db,
    tableRef,
    defaultTable
  })
}

async function openTableData(node, conn) {
  const table = node.name || node.label
  const tableRef = {
    database: node.database || conn?.database,
    schema: node.schema,
    table
  }
  if (DbHost.supportsWorkbench()) {
    if (currentSession()?.connectionId !== conn.id) await onConnectionAction(conn.id, 'connect')
    else if (!currentConnected()) await toggleConnect(true)
    if (!currentConnected()) return
    try {
      const sessionKey = currentSessionKey(), request = { table: tableRef, offset: 0, limit: 200, filters: [], order: [] }
      const paged = state.runtime.dialects.find((driver) => driver.id === conn.driver)?.capabilities?.tablePage?.state === 'available'
      const result = paged ? await DbHost.workbench('table.page', { sessionKey, ...request, surface: workbench?.mode || 'shell' }) : await DbHost.browse({ sessionKey, table: tableRef, maxRows: workbench?.mode === 'quick' ? 200 : state.ui.maxRows || 1000, surface: workbench?.mode || 'shell' })
      const session = currentSession(); const document = createEditorTab(session, `${table} · 数据`)
      document.sql = result.sql || ''
      const rs = currentResultState(); rs.tabs = [{ label: table, result, tableRef, browse: paged ? { sessionKey, request } : null }]; rs.activeTab = 0; rs.tableRefOverride = tableRef; rs.error = ''
      renderAll(); workbench.navigate('query')
    } catch (error) { showLocalToast(error.message, 'error') }
    return
  }
  const sql = objectQuery(conn.driver, tableRef)
  let s = currentSession()
  if (!s || s.connectionId !== conn.id) {
    s = createSession({ connectionId: conn.id, name: `${table} 数据` })
    state.selectedConnectionId = conn.id
  }
  const ed = currentEditor()
  if (ed) {
    ed.sql = sql
    ed.title = `${table}.sql`
  }
  const rs = currentResultState()
  if (rs) rs.tableRefOverride = tableRef
  renderAll()
  await execute({ mode: 'current' })
  const rs2 = currentResultState()
  if (rs2) {
    rs2.tableRefOverride = tableRef
    if (rs2.tabs?.[rs2.activeTab]) rs2.tabs[rs2.activeTab].tableRef = tableRef
    loadResultIntoGrid()
  }
}

async function treeContext(node, conn, ev) {
  const table = node.name || node.label
  const isTable =
    ['table', 'view', 'measurement', 'collection', 'key', 'other'].includes(node.type)
  const items = isTable
    ? [
        ['data', '打开数据'],
        ['select', '生成读取语句'],
        ['count', '生成计数语句'],
        ['copy', '复制名称'],
        ['ddl', '查看 DDL'],
        'sep',
        ['refresh', '刷新']
      ]
    : [
        ['refresh', '刷新'],
        ['copy', '复制名称']
      ]
  openCtxMenu(ev, items, async (k) => {
    if (k === 'data') await openTableData(node, conn)
    else if (k === 'select' || k === 'count') {
      const sql = objectQuery(conn.driver, { database: node.database || conn.database, schema: node.schema, table }, k === 'count')
      const ed = currentEditor()
      if (ed) {
        ed.sql = sql
        editor.setValue(sql, { silent: true })
      }
      renderEditorTabs()
    } else if (k === 'copy') {
      await clipboardWrite(table)
      showLocalToast('已复制名称', 'success')
    } else if (k === 'ddl') {
      try {
        const sessionKey =
          state.runtime.sessionKeys.get(conn.id) || sessionKeyOf(conn.id, conn.database)
        const res = await DbHost.schema.ddl({
          sessionKey,
          database: node.database || conn.database,
          schema: node.schema,
          table
        })
        const ddl = typeof res === 'string' ? res : res?.ddl || JSON.stringify(res, null, 2)
        const rs = currentResultState()
        if (rs) rs.ddl = ddl
        state.ui.rightOpen = true
        setUiPref('rightOpen', true)
        rightMode = 'ddl'
        renderRightPanel()
      } catch (e) {
        showLocalToast(hostLag(e) ? '功能未就绪' : String(e.message || e).slice(0, 120), 'warn')
      }
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
      <label class="span2">名称<input data-k="name" value="${value('name')}" placeholder="例如：订单库 · 开发"></label>
      <label>数据库类型<select data-k="driver">${dialects.map((d) => `<option value="${esc(d.id)}" ${c.driver === d.id ? 'selected' : ''}>${esc(d.label || d.id)}</option>`).join('')}</select></label>
      <label>环境<select data-k="env">${Object.entries({ dev: '开发', staging: '预发', prod: '生产', test: '测试' }).map(([id, label]) => `<option value="${id}" ${c.env === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <p class="span2 muted" data-description></p>
      <label data-f="net">主机<input data-k="host" value="${value('host')}" placeholder="127.0.0.1"></label>
      <label data-f="net">端口<input data-k="port" type="number" min="1" max="65535" value="${value('port')}"></label>
      <label class="span2" data-f="uri">连接 URI<input data-k="uri" value="${value('uri')}" placeholder="留空时使用主机与端口；密码请填写在下方"></label>
      <label class="span2" data-f="http">HTTP 端点<input data-k="endpoint" value="${value('endpoint')}" placeholder="https://database.example.com:8086"></label>
      <label data-f="net">数据库 / Keyspace<input data-k="database" value="${value('database')}"></label>
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
      else { hint.textContent = '正在保存…'; const saved = await saveConnection(form); state.selectedConnectionId = saved.id; modal.close(); renderAll(); toast('连接已保存', 'success') }
    } catch (error) { fail(error.message || String(error)) } finally { button.disabled = false }
  }
  root.querySelector('[data-act=test]').onclick = (event) => void submit(true, event.target)
  root.querySelector('[data-act=save]').onclick = (event) => void submit(false, event.target)
  renderKv(); sync(); get('name').focus()
}

/* ───────────── chrome ───────────── */

function bindChrome() {
  dom.sideToggle?.addEventListener('click', () => {
    setSidebarCollapsed(!state.ui.sidebarCollapsed)
  })
  dom.topMore?.addEventListener('click', (e) => openChromeMenu(e))
  dom.fabRun?.addEventListener('click', () => void execute({ mode: 'current' }))
}

function bindResizers() {
  bindDockResize($('#resizer-left'), dom.side, { min: 190, max: 460, onChange: (v) => setUiPref('leftWidth', v) })
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
