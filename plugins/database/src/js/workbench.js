import { CommandRegistry, createDialog, escapeHtml as esc, normalizeShortcut as sharedShortcut } from '@enest/plugin-kit/workbench'
import { api, DbHost, StorageKeys, storageSet, saveTextFile } from './api.js'
import { state, setUiPref, getConnection } from './store.js'
import { structureDiff } from './comparison.js'
import { queryTemplates, objectInvocationTemplate } from './queryTemplates.js'
import { objectPolicy, readDatabaseObject, renderDatabaseObjectDetails } from './databaseObjectDetails.js'
import { openTableDesigner } from './tableDesigner.js'
import { getWorkspace, activeWorkspaceTab, openWorkspaceTab, activateWorkspaceTab, removeWorkspaceTab, moveWorkspaceTab, ensureQueryTab, persistWorkspace } from './workspaceState.js'
import { NavigationMotion } from './navigationMotion.js'
import { queryLanguage } from './monacoEditor.js'
import { runDatabaseTask } from './operationTask.js'
import { openCtxMenu } from './ctxMenu.js'
import { svg as navIcon } from './schemaTree.js'
import { getCompletionCatalog, warmCompletionCatalog, ensureCompletionColumns, previewSqlCompletion, completionContextKey, captureCompletionMetadataRead, validateCompletionMetadataRead } from './completion.js'

// Modified Option keys can produce non-letter glyphs on macOS; bindings use the physical letter.
export function normalizeShortcut(event) {
  const key = event.altKey && (event.metaKey || event.ctrlKey) && /^Key[A-Z]$/.test(event.code || '') ? event.code.slice(3) : event.key
  return sharedShortcut({ key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey })
}

const statusLabel = { equal: '相同', different: '修改', 'left-only': '仅左侧', 'right-only': '仅右侧', ambiguous: '键不唯一' }
const inspectTabs = { client: '本插件连接池', sessions: '服务器会话', queries: '运行中查询', resources: '资源指标', locks: '锁与阻塞', jobs: '后台任务' }
const textValue = (value) => value === null ? 'NULL' : value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const WORKBENCH_THEMES = new Map([
  ['graphite', { label: '石墨控制室', desc: '低反射石墨底与冷蓝操作轴，适合长时间数据阅读' }],
  ['paper', { label: '冷调纸面', desc: '高亮度纸面与青蓝强调，适合明亮办公环境' }]
])
const normalizeWorkbenchTheme = (value) => WORKBENCH_THEMES.has(value) ? value : 'graphite'

function tableHtml(columns, rows, empty = '没有数据') {
  if (!rows?.length) return `<div class="wb-empty">${esc(empty)}</div>`
  return `<div class="wb-table-wrap"><table class="wb-table"><thead><tr>${columns.map((column) => `<th>${esc(column.name || column)}${column.unit ? ` <small>${esc(column.unit)}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td title="${esc(textValue(cell))}">${esc(textValue(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

/* —— 资源中心：按 kind 提取关键指标（中英文列名包含匹配），匹配不到回退带 unit 的数值列 —— */
const OBSERVE_KPI_PLANS = {
  client: [{ label: '连接总数', match: ['total', 'count', 'pool', 'size', '总数'] }, { label: '活跃', match: ['active', 'busy', 'used', '活跃'] }, { label: '空闲', match: ['idle', 'free', '空闲'] }, { label: '等待中', match: ['wait', 'pending', 'queue', '等待'] }],
  sessions: [{ label: '会话总数', match: ['total', 'count', '总数'] }, { label: '活跃', match: ['active', 'running', '活跃'] }, { label: '睡眠', match: ['sleep', '睡眠'] }],
  queries: [{ label: '运行中', match: ['count', 'total', '运行'] }, { label: '最长耗时', match: ['time', 'duration', '耗时'] }],
  locks: [{ label: '等待锁', match: ['wait', '等待'] }, { label: '持有锁', match: ['hold', 'grant', '持有'] }],
  jobs: [{ label: '进行中', match: ['running', 'active', '进行'] }, { label: '排队', match: ['wait', 'pending', 'queue', '排队'] }]
}
function observeKpiEntries(kind, columns, rows) {
  if (!rows?.length) return []
  const cols = columns.map((column, index) => ({ name: String(column?.name ?? column), unit: column?.unit || '', index }))
  const first = rows[0]
  const entries = []
  for (const plan of OBSERVE_KPI_PLANS[kind] || []) {
    const col = cols.find((item) => plan.match.some((needle) => item.name.toLowerCase().includes(needle)))
    const value = col ? first[col.index] : undefined
    if (value !== null && value !== undefined && value !== '') entries.push({ label: plan.label, value: textValue(value), unit: col?.unit || '' })
  }
  if (entries.length < 2) {
    for (const col of cols) {
      if (!col.unit || entries.some((entry) => entry.label === col.name)) continue
      const value = first[col.index]
      if (value !== null && value !== undefined && /^-?\d/.test(textValue(value))) entries.push({ label: col.name, value: textValue(value), unit: col.unit })
      if (entries.length >= 4) break
    }
  }
  if (entries.length < 2) entries.push({ label: '记录数', value: String(rows.length), unit: '行' })
  return entries.slice(0, 4)
}
function observeKpiHtml(kind, columns, rows) {
  const entries = observeKpiEntries(kind, columns, rows)
  if (!entries.length) return ''
  return `<div class="wb-observe-kpis">${entries.map((entry) => `<div class="wb-observe-kpi"><b>${esc(entry.value)}${entry.unit ? `<small>${esc(entry.unit)}</small>` : ''}</b><span>${esc(entry.label)}</span></div>`).join('')}</div>`
}

/* —— 资源中心表格：数值右对齐 + 状态徽章 + 斑马纹（不改动共用 tableHtml）—— */
const OBSERVE_STATE_TONES = [
  [/run|active|执行|运行|进行|grant/i, 'run'],
  [/sleep|idle|空闲|睡眠/i, 'idle'],
  [/wait|pend|等待|阻塞|block|lock/i, 'wait'],
  [/error|fail|dead|abort|取消|失败|kill/i, 'bad']
]
function observeStateTone(text) {
  for (const [pattern, tone] of OBSERVE_STATE_TONES) if (pattern.test(text)) return tone
  return ''
}
function inspectTableHtml(columns, rows, empty = '没有数据') {
  if (!rows?.length) return `<div class="wb-observe-card"><strong>${esc(empty)}</strong><p>当前分类没有可显示的数据。</p></div>`
  const cols = columns.map((column, index) => {
    const name = String(column?.name ?? column)
    const numeric = rows.slice(0, 20).filter((row) => row[index] !== null && row[index] !== '' && /^-?[\d.,]+\s*[kmgbi%]?$|^null$/i.test(textValue(row[index]))).length >= Math.min(rows.length, 5)
    // 仅明确的「状态」列渲染徽章，避免把普通文本列（如等待原因）误判为状态
    const state = /state|status|状态/i.test(name)
    return { name, unit: column?.unit || '', numeric, state, index }
  })
  return `<div class="wb-observe-table-wrap"><table class="wb-observe-table"><thead><tr>${cols.map((col) => `<th class="${col.numeric ? 'num' : ''}">${esc(col.name)}${col.unit ? ` <small>${esc(col.unit)}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${cols.map((col) => {
    const text = textValue(row[col.index])
    if (col.state) { const tone = observeStateTone(text.slice(0, 24)); if (tone) return `<td><span class="wb-observe-badge tone-${tone}" title="${esc(text)}">${esc(text)}</span></td>` }
    return `<td class="${col.numeric ? 'num' : ''} ${col.index === 0 ? 'lead' : ''}" title="${esc(text)}">${esc(text)}</td>`
  }).join('')}</tr>`).join('')}</tbody></table></div>`
}

export class DatabaseWorkbench {
  constructor(context) {
    this.ctx = context; this.mode = 'shell'; this.page = 'empty'; this.resourceKind = 'client'; this.registry = new CommandRegistry()
    this.root = document.querySelector('#app'); this.workspace = this.root.querySelector('.workspace'); this.querySurface = this.root.querySelector('#query-surface')
    this.header = this.root.querySelector('.mid-chrome'); this.tabList = this.root.querySelector('#workspace-tabs')
    this.pageHost = document.createElement('div'); this.pageHost.className = 'wb-page-host'; this.workspace.querySelector('.mid-col').append(this.pageHost)
    // 右侧功能轨：进入连接后显示（表结构 / 资源中心 / 数据比较），视觉镜像左侧 toolrail
    this.funcRail = document.createElement('nav')
    this.funcRail.className = 'wb-func-rail'; this.funcRail.setAttribute('aria-label', '连接功能'); this.funcRail.hidden = true
    this.funcRail.innerHTML = [['structure', '表结构'], ['resources', '资源中心'], ['compare', '数据比较']].map(([id, label]) => `<button type="button" class="nav-toolrail-button" data-func="${id}" aria-label="${label}" title="${label}">${navIcon(id === 'structure' ? 'table' : id)}</button>`).join('')
    this.workspace.insertBefore(this.funcRail, this.workspace.querySelector('.right-panel'))
    this.pages = new Map(); this.pageRoot = document.createElement('section'); this.pageRoot.className = 'wb-page'; this.pageHost.append(this.pageRoot)
    this.status = document.createElement('footer'); this.status.className = 'wb-status'; this.root.append(this.status)
    this.navigation = new NavigationMotion(this.root)
    this.ctx.editor().fontSize = state.ui.editorFontSize || 13
    this.makeCommands(); this.ctx.editor().commandRegistry = this.registry; this.bind()
    document.addEventListener('database-run-command', (event) => {
      const command = this.registry.commands.get(event.detail?.id)
      if (command) void this.registry.run(command.id)
    })
  }
  async initialize() {
    this.registry.bindings = Object.fromEntries(Object.entries(state.ui.shortcuts || {}).filter(([id, value]) => this.registry.commands.has(id) && typeof value === 'string'))
    this.mode = await api?.getLaunchMode?.() === 'quick' ? 'quick' : 'shell'
    api?.onModeChange?.((mode) => this.setMode(mode))
    let active = activeWorkspaceTab()
    if (this.mode === 'quick' && active && !['query', 'object'].includes(active.kind)) active = [...getWorkspace().tabs].reverse().find((tab) => ['query', 'object'].includes(tab.kind))
    if (active) await this.activateTab(active.id)
    else this.render()
  }
  makeCommands() {
    const query = () => activeWorkspaceTab()?.kind === 'query'
    const hasResults = () => ['query', 'object'].includes(activeWorkspaceTab()?.kind) && !!state.results.get(activeWorkspaceTab()?.editorId)?.tabs?.length
    const register = (id, label, shortcut, run, enabled, group = '工作台', scope = 'workbench') => this.registry.register({
      id, label, shortcut, group, scope, inEditor: scope !== 'grid', enabled,
      run: async () => { try { return await run() } catch (error) { this.ctx.message(error.message || String(error), 'error') } }
    })
    const canRun = () => query() && !!this.ctx.connection() && !state.runtime.executing && (this.mode !== 'quick' || this.ctx.session()?.origin === 'quick')
    register('run', '执行选区或当前语句', 'Mod+Enter', () => this.ctx.execute({ mode: 'selection' }), canRun, '查询', 'query')
    register('runF5', '执行当前语句或选区（F5）', 'F5', () => this.ctx.execute({ mode: 'current' }), canRun, '查询', 'query')
    register('runAll', '执行整篇查询', 'Mod+Shift+Enter', () => this.ctx.execute({ mode: 'all' }), () => canRun() && this.mode === 'shell', '查询', 'query')
    register('cancel', '取消正在执行的查询', 'Alt+Escape', () => this.ctx.cancel(), () => state.runtime.executing && state.runtime.activeQuery?.kind === 'query', '查询')
    register('save', '保存查询文档', 'Mod+S', () => this.ctx.save(), query, '查询', 'query')
    register('templates', '查询模板与原生语法', 'Mod+Shift+Space', () => this.openTemplates(), query, '查询', 'query')
    register('format', '格式化整篇查询', 'Mod+Shift+F', () => this.ctx.editor().formatDocument(), query, '编辑器', 'editor')
    register('formatSelection', '格式化选中内容', 'Mod+Alt+Shift+F', () => this.ctx.editor().formatDocument(true), query, '编辑器', 'editor')
    register('comment', '切换行注释', 'Mod+/', () => this.ctx.editor().toggleComment(), query, '编辑器', 'editor')
    register('indent', '增加缩进', 'Mod+]', () => this.ctx.editor().indentSelection(1), query, '编辑器', 'editor')
    register('outdent', '减少缩进', 'Mod+[', () => this.ctx.editor().indentSelection(-1), query, '编辑器', 'editor')
    register('completion', '显示查询补全', 'Mod+Space', () => this.ctx.editor().triggerCompletion(true), query, '编辑器', 'editor')
    register('expandColumns', '展开全部／常用字段', '', () => this.ctx.editor().expandColumns(), query, '编辑器', 'editor')
    register('find', '查找查询文本', 'Mod+F', () => this.ctx.editor().openFind(), query, '编辑器', 'editor')
    register('replace', '查找与替换', 'Mod+Alt+H', () => this.ctx.editor().openFind(true), query, '编辑器', 'editor')
    register('export', '导出当前结果', 'Mod+Shift+E', () => this.ctx.export(), hasResults, '结果')
    const gridCommands = [
      ['selectAll', '选择当前结果全部行', 'Mod+A'], ['insertRow', '插入一行', 'Mod+Alt+N'],
      ['duplicateRow', '复制选中行', 'Mod+D'], ['deleteRows', '标记删除选中行', 'Delete'],
      ['revertRows', '还原选中行修改', 'Mod+Alt+Backspace'], ['editRows', '批量编辑选中行', 'Mod+Alt+B'],
      ['paste', '粘贴表格数据', 'Mod+V'], ['commit', '预览并提交行修改', 'Mod+Enter'],
      ['exportSelected', '导出选中行', 'Mod+Alt+E']
    ]
    for (const [id, label, shortcut] of gridCommands) register(`grid.${id}`, label, shortcut, () => this.ctx.gridAction?.(id), () => hasResults() && this.ctx.gridAvailable?.(id) === true, '结果', 'grid')
    register('newQuery', '新建查询', 'Mod+T', () => this.ctx.newQuery())
    register('compare', '比较数据与结构', 'Mod+Shift+D', () => this.openComparison(), () => this.mode === 'shell')
    register('settings', '插件设置与快捷键', 'Mod+,', () => this.navigate('settings'))
    register('palette', '搜索工作台命令', 'Mod+Shift+P', () => this.openPalette())
    register('resources', '打开资源中心', 'Mod+Shift+R', () => this.navigate('resources'), () => this.mode === 'shell')
    register('documents', '打开查询文档', '', () => this.navigate('documents'))
    register('history', '打开查询历史', '', () => this.navigate('history'))
  }
  shortcutContext(target) {
    const editor = !!target.closest?.('.editor-host') && !target.closest?.('.find-widget, .db-editor-find, .suggest-input-container') && (target === this.ctx.editor().el.ta || !!target.closest?.('.monaco-editor') && !!target.matches?.('textarea.inputarea, .native-edit-context'))
    const input = !!target.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')
    return { editor, input, grid: !input && !!this.ctx.gridFocused?.(), query: activeWorkspaceTab()?.kind === 'query' }
  }
  setCommandBinding(id, chord) {
    const command = this.registry.commands.get(id)
    const overlap = (other) => command.scope === 'workbench' || other.scope === 'workbench' || (command.scope === 'grid') === (other.scope === 'grid')
    const duplicate = this.registry.list().find(other => other.id !== id && chord && this.registry.shortcut(other.id) === chord && overlap(other))
    if (duplicate) throw new Error(`与“${duplicate.label}”冲突`)
    this.registry.bindings[id] = chord
  }
  handleShortcut(event) {
    if (event.isComposing || event.defaultPrevented) return false
    const context = this.shortcutContext(event.target)
    if (context.input && !context.editor) return false
    const matchesScope = command => command.scope === 'editor' ? context.editor && context.query : command.scope === 'grid' ? context.grid : command.scope === 'query' ? context.query && !context.grid : true
    const chord = normalizeShortcut(event), commands = this.registry.list()
    const bound = commands.find(command => this.registry.shortcut(command.id) === chord && matchesScope(command))
    if (bound) {
      // Own a configured chord even while disabled: Monaco/browser defaults must not turn it into a different action.
      event.preventDefault(); event.stopPropagation()
      if (['run', 'runF5', 'runAll'].includes(bound.id) && this.mode === 'quick' && this.ctx.session()?.origin !== 'quick') this.ctx.message('此桌面控制台请在桌面继续，或新建独立快捷查询', 'warn')
      else void this.registry.run(bound.id)
      return true
    }
    if (commands.some(command => command.shortcut === chord && this.registry.shortcut(command.id) !== chord && matchesScope(command))) {
      event.preventDefault(); event.stopPropagation(); return true
    }
    return false
  }
  bind() {
    this.funcRail.addEventListener('click', (event) => {
      const button = event.target.closest('[data-func]'); if (!button) return
      void this.navigate(button.dataset.func)
    })
    document.addEventListener('keydown', (event) => {
      if (event.target.matches?.('[data-key]')) return
      if (document.querySelector('dialog[open]') || document.querySelector('#modal-root .modal') || event.target.closest?.('.ctx-menu')) return
      if (event.key === 'Escape' && this.navigation.isOpen()) { event.preventDefault(); this.navigation.close(); return }
      this.handleShortcut(event)
    }, true)
    document.addEventListener('focusin', (event) => {
      const target = event.target
      const context = target.closest?.('dialog[open], .modal, .ctx-menu') ? 'overlay' : target.closest?.('.editor-host, textarea, input') ? 'editor' : 'workbench'
      api?.ui?.setInputContext?.(context)
    })
    this.header.addEventListener('click', (event) => {
      const action = event.target.closest('[data-wb]')?.dataset.wb
      if (action === 'newQuery') void this.ctx.newQuery()
      else if (action === 'openShell') void this.openShellAnd(null)
      else if (action === 'palette') this.openPalette()
      else if (action === 'tabs') this.openTabList()
    })
    this.tabList.addEventListener('click', (event) => {
      const close = event.target.closest('[data-close-tab]')
      if (close) { void this.closeTab(close.dataset.closeTab); return }
      const tab = event.target.closest('[data-workspace-tab]'); if (tab) void this.activateTab(tab.dataset.workspaceTab)
    })
    this.tabList.addEventListener('contextmenu', (event) => { const id = event.target.closest('[data-workspace-tab]')?.dataset.workspaceTab; const tab = getWorkspace().tabs.find((item) => item.id === id); if (tab?.kind === 'query') { event.preventDefault(); this.ctx.queryContextMenu?.(tab, event) } })
    this.tabList.addEventListener('keydown', (event) => {
      const button = event.target.closest('[role=tab]'); if (!button) return
      const tabs = getWorkspace().tabs, index = tabs.findIndex((tab) => tab.id === button.dataset.workspaceTab)
      if (event.key === 'Delete') { event.preventDefault(); void this.closeTab(button.dataset.workspaceTab); return }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      if (event.altKey) { const reordered = [...tabs]; const [item] = reordered.splice(index, 1); reordered.splice(next, 0, item); moveWorkspaceTab(item.id, reordered[next + 1]?.id || null); this.renderTabs() }
      else void this.activateTab(tabs[next].id).then(() => this.tabList.querySelector('[aria-selected=true]')?.focus())
    })
    this.tabList.addEventListener('dragstart', (event) => { const item = event.target.closest('[data-workspace-tab]'); if (item) { this.draggedTab = item.dataset.workspaceTab; event.dataTransfer.setData('text/plain', this.draggedTab); event.dataTransfer.effectAllowed = 'move' } })
    this.tabList.addEventListener('dragover', (event) => { if (!this.draggedTab) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move' })
    this.tabList.addEventListener('drop', (event) => { if (!this.draggedTab) return; event.preventDefault(); const target = event.target.closest('[data-workspace-tab]'); moveWorkspaceTab(this.draggedTab, target?.dataset.workspaceTab || null); this.draggedTab = null; this.renderTabs() })
    this.tabList.addEventListener('dragend', () => { this.draggedTab = null })
    document.addEventListener('visibilitychange', () => this.scheduleRefresh())
    window.addEventListener('pagehide', () => { clearTimeout(this.refreshTimer); this.completionSettings?.destroy(); this.settingsObserver?.disconnect(); this.navigation.destroy(); this.ctx.editor().themeObserver?.disconnect() })
  }
  setMode(mode) {
    const next = mode === 'quick' ? 'quick' : 'shell'; if (next === this.mode) return
    this.mode = next; this.navigation.close(false)
    if (next === 'quick' && !['query', 'object', 'empty'].includes(this.page)) { const tab = [...getWorkspace().tabs].reverse().find((item) => ['query', 'object'].includes(item.kind)); if (tab) void this.activateTab(tab.id); else { this.page = 'empty'; this.render() } } else this.render()
    this.ctx.surfaceChanged?.()
  }
  async activateTab(id) {
    const tab = getWorkspace().tabs.find((item) => item.id === id); if (!tab) return
    if (this.mode === 'quick' && !['query', 'object'].includes(tab.kind)) return this.openShellAnd(tab.kind)
    const sequence = this.activationSequence = (this.activationSequence || 0) + 1
    this.ctx.beforeNavigate?.(); activateWorkspaceTab(id)
    if (await this.ctx.activateTab?.(tab) === false || sequence !== this.activationSequence) return
    this.page = tab.kind === 'object' ? tab.view === 'structure' ? 'structure' : 'object' : tab.kind === 'history' && tab.view === 'documents' ? 'documents' : tab.kind
    this.render(); this.navigation.close(false)
    api?.ui?.setInputContext?.(this.page === 'query' ? 'editor' : 'workbench')
  }
  async closeTab(id) {
    const tab = getWorkspace().tabs.find((item) => item.id === id); if (!tab) return
    if (await this.ctx.closeTab?.(tab) === false) return
    if (tab.kind === 'settings') { this.completionSettings?.destroy(); this.completionSettings = null; this.settingsObserver?.disconnect(); this.settingsObserver = null }
    this.pages.get(id)?.remove(); this.pages.delete(id); removeWorkspaceTab(id)
    const active = activeWorkspaceTab(); if (active) await this.activateTab(active.id); else { this.page = 'empty'; this.render() }
  }
  openQuery(session, editor) {
    const tab = ensureQueryTab(session, editor, { activate: true })
    if (tab) { this.page = 'query'; this.render(); this.navigation.close(false) }
    return tab
  }
  openObject(node, connection, session, editor, view = 'data') {
    const tab = openWorkspaceTab({ kind: 'object', origin: session.origin || 'shell', title: node.name || node.label, connectionId: connection.id, consoleId: session.id, editorId: editor.id, database: node.database || session.database || connection.database || '', schema: node.schema || session.schema || '', objectName: node.name || node.label, objectType: node.type || 'table', view }, { activate: true })
    this.page = view === 'structure' ? 'structure' : 'object'; this.render(); this.navigation.close(false); return tab
  }
  navigate(page) {
    this.ctx.beforeNavigate?.()
    if (page === 'home') { this.navigation.open(); return }
    if (page === 'console') { void this.ctx.newQuery?.(); this.navigation.close(false); return }
    if (page === 'compare') return this.openComparison()
    if (this.mode === 'quick' && !['query', 'object'].includes(page)) return this.openShellAnd(page)
    if (page === 'query') {
      const context = this.ctx.getQueryContext?.() || { session: this.ctx.session(), editor: this.ctx.session()?.editors?.find((item) => item.id === this.ctx.session()?.activeEditorId) }
      if (context.session && context.editor) return this.openQuery(context.session, context.editor)
      this.page = 'empty'; this.render(); return
    }
    const titles = { resources: '资源', structure: '结构', settings: '设置', history: '历史' }
    const session = this.ctx.session(), connection = this.ctx.connection()
    // 文档列表并入查询历史页：kind 统一为 history，子标签存 tab.view
    const kind = page === 'documents' ? 'history' : page
    const tab = openWorkspaceTab({ kind, title: titles[kind] || kind, ...(['resources', 'structure'].includes(kind) ? { connectionId: connection?.id, consoleId: session?.id, database: session?.database, schema: session?.schema } : {}) }, { activate: true })
    if (page === 'documents') { tab.view = 'documents'; persistWorkspace() }
    this.page = page; this.render(); this.navigation.close(false); return tab
  }
  async openShellAnd(page, run) {
    if (this.mode === 'quick') {
      try { const opened = await api?.ui?.openInShell?.(); if (opened === false || opened === undefined) throw new Error('无法打开完整工作台，请更新宿主后重试'); this.setMode('shell') } catch (error) { this.ctx.message(error.message, 'error'); return }
    }
    if (page && page !== 'home') this.navigate(page); await run?.()
  }
  newConnection(existing) { return this.openShellAnd(null, () => this.ctx.newConnection(existing)) }
  renderTabs() {
    const workspace = getWorkspace(), active = activeWorkspaceTab()
    const icons = { query: 'SQL', object: '▦', resources: '◷', compare: '⇄', documents: '▤', history: '↶', settings: '⚙', structure: '▦' }
    this.tabList.innerHTML = workspace.tabs.map((tab) => {
      const session = state.sessions.find((item) => item.id === tab.consoleId), editor = session?.editors?.find((item) => item.id === tab.editorId)
      const title = tab.kind === 'query' ? editor?.title || tab.title || '查询' : tab.title
      const running = state.runtime.executing && (state.runtime.activeQuery?.tabId === tab.id || !!tab.editorId && state.runtime.activeQuery?.editorId === tab.editorId)
      return `<div class="wb-tab ${active?.id === tab.id ? 'active' : ''}" draggable="true" data-workspace-tab="${esc(tab.id)}"><button type="button" role="tab" id="tab-${esc(tab.id)}" aria-selected="${active?.id === tab.id}" aria-controls="${['query', 'object'].includes(tab.kind) ? 'query-surface' : `page-${esc(tab.id)}`}" tabindex="${active?.id === tab.id ? '0' : '-1'}" data-workspace-tab="${esc(tab.id)}" title="${esc([getConnection(tab.connectionId)?.name, tab.database, tab.schema, title].filter(Boolean).join(' / '))}"><span class="wb-tab-icon ${running ? 'running' : ''}">${running ? '◌' : icons[tab.kind] || '▤'}</span><span class="wb-tab-title">${esc(title)}</span>${session?.transactionActive ? '<span class="wb-tab-transaction" title="此控制台有活动事务">•</span>' : ''}</button><button type="button" class="wb-tab-close" data-close-tab="${esc(tab.id)}" aria-label="关闭 ${esc(title)}" title="关闭标签">×</button></div>`
    }).join('')
    this.tabList.querySelector('.wb-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  openTabList() {
    const modal = createDialog({ title: '打开的标签', content: `<div class="wb-command-list">${getWorkspace().tabs.map((tab) => `<button data-jump-tab="${esc(tab.id)}">${esc(tab.title)}<small>${esc(getConnection(tab.connectionId)?.name || '')}</small></button>`).join('') || '<p class="muted">尚未打开标签</p>'}</div>` })
    modal.body.querySelectorAll('[data-jump-tab]').forEach((button) => button.onclick = () => { modal.close(); void this.activateTab(button.dataset.jumpTab) })
  }
  render() {
    const active = activeWorkspaceTab(), connected = this.ctx.isConnected()
    this.root.dataset.surface = this.mode; this.root.dataset.page = this.page; this.root.dataset.resultDock = state.ui.resultDock || 'bottom'; this.root.dataset.workbenchTheme = normalizeWorkbenchTheme(state.ui.workbenchTheme)
    this.navigation.update(); this.renderTabs()
    const railPage = this.page === 'documents' ? 'history' : this.page
    this.root.querySelectorAll('[data-nav]').forEach((button) => { const selected = button.dataset.nav === railPage; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)) })
    // 右侧功能轨：仅在 shell 模式且已有控制台连接时显示；active 随当前页
    const funcVisible = this.mode !== 'quick' && !!(active?.consoleId || this.ctx.isConnected())
    this.funcRail.hidden = !funcVisible
    this.funcRail.querySelectorAll('[data-func]').forEach((button) => button.classList.toggle('active', button.dataset.func === this.page))
    this.ctx.onPageChange?.(this.page)
    const queryVisible = ['query', 'object'].includes(this.page)
    this.workspace.hidden = false; this.querySurface.hidden = !queryVisible; this.pageHost.hidden = queryVisible
    this.root.querySelector('[data-wb=openShell]').hidden = this.mode !== 'quick'
    if (!queryVisible) {
      const key = active?.id || 'empty'; let page = this.pages.get(key)
      const fresh = !page
      if (!page) { page = document.createElement('section'); page.className = 'wb-page'; page.id = `page-${key}`; page.setAttribute('role', 'tabpanel'); this.pages.set(key, page); this.pageHost.append(page) }
      this.pageHost.replaceChildren(page); this.pageRoot = page
      if (this.page === 'empty') this.renderEmpty()
      else if (this.page === 'documents' || this.page === 'history') this.renderLibrary(this.page)
      else if (this.page === 'settings' && fresh) this.renderSettings()
      else if (this.page === 'resources') void this.renderResources()
      else if (this.page === 'structure') void this.renderStructure()
      else if (this.page === 'compare' && fresh) this.renderComparison()
    } else this.renderQueryBar()
    this.updateStatus(); void this.ctx.editor().setSurface(this.mode, connected && this.page === 'query'); this.scheduleRefresh()
  }
  updateStatus() {
    const tab = activeWorkspaceTab(), conn = getConnection(tab?.connectionId) || this.ctx.connection(), session = state.sessions.find((item) => item.id === tab?.consoleId) || this.ctx.session(), connected = this.ctx.isConnected()
    const resultState = tab?.editorId && state.results.get(tab.editorId), result = resultState?.tabs?.[resultState.activeTab]?.result
    const details = result ? `${result.rowCount ?? result.rows?.length ?? 0} 行${result.durationMs != null ? ` · ${result.durationMs} ms` : ''}` : '查询控制台自动保存'
    this.status.innerHTML = `<span class="wb-status-dot ${connected ? 'on' : ''}"></span><span>${esc(conn?.name || '选择左侧连接以开始')}</span><span>${session?.transactionActive ? this.transactionLabel(session) : state.runtime.executing ? '查询执行中' : connected ? '已连接' : '尚未重新读取'}</span><span class="spacer"></span><span>${this.mode === 'quick' ? '只读 · 最多 200 行' : details}</span>`
  }
  update() { this.renderTabs(); if (['query', 'object'].includes(this.page)) this.renderQueryBar(); this.updateStatus(); this.navigation.update(); void this.ctx.editor().setSurface(this.mode, this.ctx.isConnected() && this.page === 'query') }
  renderEmpty() {
    this.pageRoot.innerHTML = `<div class="wb-welcome"><div class="wb-welcome-symbol" aria-hidden="true">▦</div><h1>数据库工作台</h1><p>从左侧选择连接，打开数据表或开始一段查询。</p><div><button class="btn primary" data-new>新建连接</button><button class="btn" data-documents>打开文档</button></div><p class="wb-welcome-hint"><kbd>⌘ / Ctrl T</kbd> 新建查询 <span>·</span> <kbd>⌘ / Ctrl ⇧ P</kbd> 搜索命令</p></div>`
    this.pageRoot.querySelector('[data-new]').onclick = () => this.newConnection(); this.pageRoot.querySelector('[data-documents]').onclick = () => this.navigate('documents')
  }
  renderLibrary(kind) {
    // 文档与历史合并为一页，子标签存 tab.view（documents | history）
    const sub = kind === 'documents' ? 'documents' : 'history'
    const tab = activeWorkspaceTab()
    const documents = state.sessions.flatMap((session) => (session.editors || []).map((editor) => ({ id: editor.id, session, title: editor.title || '未命名查询', sql: editor.sql || editor.content || '', connectionId: session.connectionId })))
    const history = state.queryHistory.map((item) => ({ ...item, title: item.sql?.split('\n')[0] || '查询', date: item.ts || item.createdAt }))
    const items = sub === 'documents' ? documents : history
    const labels = { documents: { title: '查询文档', desc: '关闭标签后，查询文档仍保留在这里。', search: '搜索文档或连接' }, history: { title: '查询历史', desc: '重新打开查询文本，确认后执行。', search: '搜索查询或连接' } }
    this.pageRoot.innerHTML = `<div class="wb-page-title"><div><h1>查询中心</h1><p class="muted">${esc(labels[sub].desc)}</p></div></div><nav class="wb-subtabs wb-library-tabs" role="tablist" aria-label="查询中心">${[['documents', `文档 · ${documents.length}`], ['history', `历史 · ${history.length}`]].map(([id, label]) => `<button type="button" role="tab" aria-selected="${sub === id}" data-library-tab="${id}" class="${sub === id ? 'active' : ''}">${label}</button>`).join('')}</nav><input class="wb-search" type="search" placeholder="${esc(labels[sub].search)}" aria-label="搜索${sub === 'documents' ? '文档' : '历史'}"><div class="wb-library"></div>`
    this.pageRoot.querySelectorAll('[data-library-tab]').forEach((button) => button.onclick = () => {
      const next = button.dataset.libraryTab
      if (tab && tab.kind === 'history') { tab.view = next; persistWorkspace() }
      this.page = next; this.renderLibrary(next)
    })
    const render = (query = '') => {
      const filtered = items.filter((item) => `${item.title} ${item.sql} ${getConnection(item.connectionId)?.name || ''}`.toLowerCase().includes(query.toLowerCase()))
      this.pageRoot.querySelector('.wb-library').innerHTML = filtered.map((item) => `<article class="wb-library-row"><button data-open-document="${esc(item.id)}"><strong>${esc(item.title.slice(0, 100))}</strong><span>${esc(getConnection(item.connectionId)?.name || '连接已删除')}${item.date ? ` · ${new Date(item.date).toLocaleString()}` : ''}</span><code>${esc(item.sql?.slice(0, 220) || '空白查询')}</code></button></article>`).join('') || `<div class="wb-empty">没有匹配的${sub === 'documents' ? '查询文档' : '查询历史'}</div>`
      this.pageRoot.querySelectorAll('[data-open-document]').forEach((button) => button.onclick = async () => {
        const item = items.find((entry) => entry.id === button.dataset.openDocument)
        if (sub === 'documents') await this.ctx.openDocument?.(item.session.id, item.id)
        else await this.ctx.historyAction?.(item.id, 'insert')
      })
    }
    render(); this.pageRoot.querySelector('.wb-search').oninput = (event) => render(event.target.value)
  }
  renderQueryBar() {
    let toolbar = this.workspace.querySelector('.wb-querybar')
    if (!toolbar) { toolbar = document.createElement('div'); toolbar.className = 'wb-querybar'; this.querySurface.prepend(toolbar) }
    const conn = this.ctx.connection(), session = this.ctx.session(), connected = this.ctx.isConnected(), tab = activeWorkspaceTab()
    this.querySurface.querySelector('.wb-object-state')?.remove()
    if (tab?.kind === 'object') {
      const policy = objectPolicy(tab.objectType)
      const results = state.results.get(tab.editorId), hasData = !!results?.tabs?.[results.activeTab || 0]?.result
      toolbar.innerHTML = `<div class="wb-object-identity"><strong>${esc(tab.objectName)}</strong><span>${esc([conn?.name, tab.database, tab.schema].filter(Boolean).join(' / '))}</span></div><div class="wb-segmented" role="tablist" aria-label="对象视图"><button role="tab" aria-selected="${tab.view !== 'structure'}" data-object-view="data">数据</button><button role="tab" aria-selected="${tab.view === 'structure'}" data-object-view="structure">结构</button></div><span class="spacer"></span><button class="btn" data-object-refresh ${results?.loading ? 'disabled' : ''}>${results?.loading ? '读取中…' : '重新读取'}</button>`
      if (!hasData) { const empty = document.createElement('div'); empty.className = 'wb-object-state'; empty.setAttribute('role', 'status'); const error = results?.error?.message || results?.error; empty.innerHTML = `<strong>${results?.loading ? '正在读取数据…' : error ? '无法读取数据' : '尚未重新读取'}</strong><p>${esc(error || (results?.loading ? '读取完成后会显示此对象的数据。' : '点击右上角“重新读取”连接并加载当前对象。'))}</p>`; toolbar.after(empty) }
      toolbar.querySelectorAll('[data-object-view]').forEach((button) => button.onclick = () => { tab.view = button.dataset.objectView; void persistWorkspace(); this.page = tab.view === 'structure' ? 'structure' : 'object'; this.render() })
      toolbar.querySelector('[data-object-refresh]').onclick = () => void this.ctx.browse({ name: tab.objectName, type: tab.objectType, origin: tab.origin, database: tab.database, schema: tab.schema }, conn, 'data', true)
      if (!policy.browse) { tab.view = 'structure'; this.page = 'structure'; this.render(); return }
      this.appendTransactionControls(toolbar, session, conn)
      return
    }
    if (this.mode === 'quick' && session && session.origin !== 'quick') {
      toolbar.innerHTML = '<span class="wb-session-note" role="status">桌面控制台，请在桌面执行</span><span class="spacer"></span><button class="btn" data-action="desktop">桌面继续</button><button class="btn" data-action="newQuick" title="创建空白、独立、只读的快捷控制台">新建快捷查询</button>'
      toolbar.onclick = (event) => { const action = event.target.closest('[data-action]')?.dataset.action; if (action === 'desktop') void this.openShellAnd(null); else if (action === 'newQuick') void this.ctx.newQuick() }
      return
    }
    const queryRunning = state.runtime.executing && state.runtime.activeQuery?.kind === 'query'
    const runningDocument = state.sessions.flatMap((item) => item.editors || []).find((item) => item.id === state.runtime.activeQuery?.editorId)
    // Query construction belongs to the editor and its command shortcuts. The bar keeps
    // only stateful controls: cancellation, connection context, and transactions.
    toolbar.innerHTML = `${queryRunning ? `<button class="btn danger" data-action="cancel" title="取消 ${esc(runningDocument?.title || '正在执行的查询')}">取消查询</button>` : ''}<span class="wb-query-context" title="${esc(conn?.name || '未选择连接')}">${esc(conn?.name || '未选择连接')}</span><button class="btn" data-action="connect">${connected ? '断开' : '连接'}</button><label class="wb-database-label">数据库 <button class="btn" data-action="database">${esc(session?.database || conn?.database || '默认')}</button></label><span class="spacer"></span>`
    this.updateCommandLabels()
    this.appendTransactionControls(toolbar, session, conn)
    toolbar.onclick = async (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return
      if (action === 'database') return this.chooseDatabase()
      if (action === 'connect') { await this.ctx.connect(); this.update(); return }
      if (action === 'cancel') void this.registry.run('cancel')
    }
  }
  transactionLabel(session) {
    const pending = this.ctx.transactionPending?.(session) || 0
    if (session?.transactionActive && pending === -2) return '事务状态待核实，请重试事务操作'
    if (session?.transactionActive && pending < 0) return '事务中 · 写入已部分回滚，请检查后提交'
    return session?.transactionActive ? pending ? `事务中 · ${pending} 项待提交` : '事务进行中' : '自动提交'
  }
  appendTransactionControls(toolbar, session, connection) {
    if (this.mode !== 'shell' || !session) return
    const status = document.createElement('span'); status.className = `wb-transaction-status ${session.transactionActive ? 'active' : ''}`; status.textContent = this.transactionLabel(session)
    const trigger = document.createElement('button'); trigger.className = 'btn'; trigger.type = 'button'; trigger.textContent = '事务 ⌄'; trigger.dataset.objectTransaction = ''; trigger.setAttribute('aria-haspopup', 'menu')
    toolbar.append(status, trigger)
    trigger.onclick = () => {
      const capability = state.runtime.dialects.find(driver => driver.id === connection?.driver)?.capabilities?.transaction
      const reason = state.runtime.executing ? '请等待当前任务完成' : !this.ctx.isConnected() ? '请先连接并读取此对象' : connection?.readOnly || session.origin === 'quick' ? '当前会话只读' : capability?.state !== 'available' ? capability?.reason || '当前驱动不支持事务' : ''
      const rect = trigger.getBoundingClientRect(), labels = { begin: '开始事务', commit: '提交事务', rollback: '回滚事务' }
      const menu = openCtxMenu({ clientX: rect.right - 180, clientY: rect.bottom + 4 }, Object.entries(labels), async operation => {
        trigger.focus()
        try { await this.ctx.transaction(operation, session); this.update(); if (this.page === 'structure' && toolbar.isConnected) { status.textContent = this.transactionLabel(session); status.classList.toggle('active', !!session.transactionActive) }; this.ctx.message({ begin: '事务已开始', commit: '事务已提交', rollback: '事务已回滚' }[operation], 'success') } catch (error) { this.ctx.message(error.message, 'error') }
      })
      menu.querySelectorAll('[data-k]').forEach(button => { const unavailable = reason || (button.dataset.k === 'begin' ? session.transactionActive ? '此控制台已有活动事务' : '' : !session.transactionActive ? '此控制台没有活动事务' : ''); button.disabled = !!unavailable; button.title = unavailable })
      menu.querySelector('button:not(:disabled)')?.focus()
      menu.addEventListener('keydown', event => { if (event.key === 'Escape') { trigger.focus(); return }; if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus() })
    }
  }
  async chooseDatabase() {
    const sourceSession = this.ctx.session(), sourceKey = this.ctx.sessionKey()
    const modal = createDialog({ title: '切换数据库', content: '<p class="muted">正在读取数据库…</p>' })
    try {
      const databases = await DbHost.schema.databases({ sessionKey: sourceKey })
      modal.body.innerHTML = `<div class="wb-command-list">${databases.map((db) => `<button data-db="${esc(db.name || db.label)}">${esc(db.name || db.label)}</button>`).join('') || '<p>当前驱动未返回数据库列表。</p>'}</div>`
      modal.body.querySelectorAll('[data-db]').forEach((button) => button.onclick = async () => { try { await this.ctx.switchDatabase(button.dataset.db, sourceSession); modal.close(); this.update() } catch (error) { this.ctx.message(error.message, 'error') } })
    } catch (error) { modal.body.textContent = error.message }
  }
  openTemplates() {
    const connection = this.ctx.connection(); if (!connection) return this.ctx.message('请先选择数据库连接', 'warn')
    if (queryLanguage(connection.driver) === 'sql') return this.ctx.editor().showTemplates()
    const templates = queryTemplates(connection.driver, connection)
    const modal = createDialog({ title: `${connection.driver} 查询模板`, content: `<p class="muted">选择后在新查询中打开，修改对象名称后执行。文档数据可双击单元格查看 JSON 树。</p><div class="wb-command-list">${templates.map((item, index) => `<button data-template="${index}">${esc(item.label)}</button>`).join('')}</div>` })
    modal.body.querySelectorAll('[data-template]').forEach((button) => button.onclick = async () => { await this.ctx.newQuery(); this.ctx.editor().setValue(templates[Number(button.dataset.template)].text); modal.close(); this.navigate('query') })
  }
  openPalette() {
    const modal = createDialog({ title: '工作台命令', content: '<input class="wb-search" type="search" placeholder="搜索操作…" aria-label="搜索操作"><div class="wb-command-list" role="listbox"></div>' })
    const search = modal.body.querySelector('input'), list = modal.body.querySelector('[role=listbox]'); let active = 0, commands = []
    const render = () => { commands = this.registry.list(search.value); active = Math.min(active, Math.max(0, commands.length - 1)); list.innerHTML = commands.map((command, index) => `<button role="option" aria-selected="${index === active}" data-command="${command.id}" ${command.enabled?.() === false ? 'disabled' : ''}>${esc(command.label)}<kbd>${esc(this.registry.shortcut(command.id))}</kbd></button>`).join(''); list.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }) }
    search.oninput = () => { active = 0; render() }; search.onkeydown = (event) => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % Math.max(commands.length, 1); render() } else if (event.key === 'Enter' && commands[active]?.enabled?.() !== false) { event.preventDefault(); const id = commands[active]?.id; modal.close(); void this.registry.run(id) } }
    list.onclick = (event) => { const id = event.target.closest('[data-command]')?.dataset.command; if (id) { modal.close(); void this.registry.run(id) } }; render(); search.focus()
  }
  renderSettings() {
    this.settingsObserver?.disconnect(); this.settingsObserver = null
    const theme = normalizeWorkbenchTheme(state.ui.workbenchTheme)
    this.pageRoot.innerHTML = `<div class="wb-settings"><div class="wb-page-title"><div><p class="wb-eyebrow">PLUGIN PREFERENCES</p><h1>数据库设置</h1><p class="muted">仅影响数据库插件。字体和全局动画继续跟随 eNest，工作台界面主题在这里单独保存。</p></div><button class="btn" data-back>返回查询</button></div><div class="wb-settings-body"><section class="wb-settings-section" id="settings-appearance"><h2>界面主题</h2><div class="wb-setting-row"><div class="wb-setting-label">工作台外观</div><div class="wb-setting-control"><div class="wb-theme-options" role="group" aria-label="工作台界面主题">${[...WORKBENCH_THEMES].map(([id, item]) => `<button type="button" class="wb-theme-option" data-theme-option="${id}" aria-pressed="${theme === id}"><span class="wb-theme-swatch" aria-hidden="true"><i></i><i></i><i></i></span><span class="wb-theme-copy"><strong>${item.label}</strong><small>${item.desc}</small></span></button>`).join('')}</div></div></div><p class="wb-setting-note">选择立即生效，只保存在数据库插件设置中；不会修改 eNest 全局主题或其它插件。</p></section><section class="wb-settings-section" id="settings-editor"><h2>编辑器与查询</h2><div class="wb-setting-row"><div class="wb-setting-label">工作台最大返回行数</div><div class="wb-setting-control"><input type="number" min="200" max="10000" step="200" data-pref="maxRows" value="${state.ui.maxRows || 1000}"></div></div><div class="wb-setting-row"><div class="wb-setting-label">编辑器字号</div><div class="wb-setting-control"><input type="number" min="11" max="24" data-pref="editorFontSize" value="${state.ui.editorFontSize || 13}"></div></div><div class="wb-setting-row"><div class="wb-setting-label">资源中心自动刷新</div><div class="wb-setting-control"><label class="wb-setting-check"><input type="checkbox" data-pref="resourceAutoRefresh" ${state.ui.resourceAutoRefresh ? 'checked' : ''}> 可见时每 5 秒刷新</label></div></div><p class="wb-setting-note">Quick 固定最多 200 行，只读查询。服务器不支持的指标会显示原因。</p></section><section class="wb-settings-section" id="settings-layout"><h2>布局与数据</h2><div class="wb-setting-row"><div class="wb-setting-label">结果区域位置</div><div class="wb-setting-control"><select data-pref="resultDock"><option value="bottom" ${state.ui.resultDock !== 'right' ? 'selected' : ''}>编辑器下方</option><option value="right" ${state.ui.resultDock === 'right' ? 'selected' : ''}>编辑器右侧</option></select></div></div><div class="wb-setting-row"><div class="wb-setting-label">恢复默认布局</div><div class="wb-setting-control"><button class="btn" data-reset-layout>重置侧栏与结果区</button></div></div><div class="wb-setting-row"><div class="wb-setting-label">清空查询历史</div><div class="wb-setting-control"><button class="btn" data-clear-history>清空本插件历史</button></div></div><p class="wb-setting-note">查询包含的文本会保存在本机。不要在查询或连接附加参数中保存明文密码。</p></section><section class="wb-settings-section wb-shortcuts" id="settings-shortcuts"><div class="wb-section-heading"><h2>快捷键</h2><button class="btn" data-reset-keys>恢复全部默认</button></div><p class="wb-setting-note">点击快捷键后按组合键，Backspace 停用，Escape 退出录制。Mod 在 macOS 为 Command，在 Windows/Linux 为 Ctrl。</p><div class="db-shortcut-filters"><input type="search" class="wb-search" data-shortcut-search aria-label="搜索快捷键" placeholder="搜索命令、按键或作用域"><select data-shortcut-group aria-label="快捷键分组"><option value="">全部分组</option>${['查询', '编辑器', '结果', '工作台'].map(group => `<option>${group}</option>`).join('')}</select></div><p class="db-shortcut-status" data-shortcut-status role="status" aria-live="polite">普通输入框保留系统编辑快捷键；结果命令仅在表格内生效。</p><div data-shortcut-list></div><p class="wb-setting-note">编辑器内 Enter 自动缩进；Tab / Shift+Tab 调整选中行缩进。表格方向键导航，F2 / Enter 编辑，Mod+C 复制，Mod+Z 撤销。查找框、连接表单和单元格输入保留原生按键。</p></section><section class="wb-settings-section" id="settings-completion"><h2>SQL 补全</h2><div data-completion-settings></div></section></div></div>`
    this.pageRoot.querySelector('[data-back]').onclick = () => this.navigate('query')
    this.pageRoot.querySelectorAll('[data-pref]').forEach((input) => input.onchange = () => {
      const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) || Number(input.min))) : input.value
      setUiPref(input.dataset.pref, value); this.ctx.editor().fontSize = state.ui.editorFontSize || 13; this.root.dataset.resultDock = state.ui.resultDock || 'bottom'; this.ctx.editor().instance?.updateOptions({ fontSize: state.ui.editorFontSize || 13 })
    })
    this.pageRoot.querySelectorAll('[data-theme-option]').forEach((button) => button.onclick = () => {
      const next = normalizeWorkbenchTheme(button.dataset.themeOption)
      setUiPref('workbenchTheme', next)
      this.root.dataset.workbenchTheme = next
      this.pageRoot.querySelectorAll('[data-theme-option]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)))
      document.dispatchEvent(new CustomEvent('database-workbench-theme', { detail: { theme: next } }))
    })
    this.bindShortcutSettings()
    void this.bindCompletionSettings().catch(error => this.ctx.message(error.message, 'error'))
    this.pageRoot.querySelector('[data-reset-layout]').onclick = () => { for (const [key, value] of Object.entries({ leftWidth: 240, rightWidth: 280, bottomHeight: 300, resultDock: 'bottom', sidebarCollapsed: false })) setUiPref(key, value); this.root.dataset.resultDock = 'bottom'; this.ctx.resetLayout(); this.ctx.message('默认布局已恢复', 'success') }
    this.pageRoot.querySelector('[data-clear-history]').onclick = async () => { try { await storageSet(StorageKeys.queryHistory, []); state.queryHistory = []; this.ctx.message('查询历史已清空', 'success') } catch (error) { this.ctx.message(error.message, 'error') } }
    this.bindSettingsObserver()
  }
  /** 设置目录滚动联动：进入视口的区块高亮左侧目录项 */
  bindSettingsObserver() {
    const sections = [...this.pageRoot.querySelectorAll('.wb-settings-section[id]')]
    if (!sections.length) return
    const jumpButtons = () => [...document.querySelectorAll('[data-settings-jump]')]
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]?.target
      if (!visible) return
      jumpButtons().forEach((button) => button.classList.toggle('active', button.dataset.settingsJump === visible.id))
    }, { root: this.pageHost, rootMargin: '-12% 0px -60% 0px', threshold: [0, 0.25, 0.6] })
    sections.forEach((section) => observer.observe(section))
    this.settingsObserver = observer
  }
  async bindCompletionSettings() {
    this.completionSettings?.destroy()
    const root = this.pageRoot.querySelector('[data-completion-settings]')
    const ticket = this.completionSettingsTicket = (this.completionSettingsTicket || 0) + 1
    const [{ mountCompletionSettings }, { normalizeConfig }, { settingsMetadataScope }] = await Promise.all([
      import('@db/sql-intelligence/settings/completionSettings.js'),
      import('@db/sql-intelligence/configuration/index.js'),
      import('@db/sql-intelligence/settings/metadataScope.js')
    ])
    if (!root.isConnected || ticket !== this.completionSettingsTicket) return
    const currentScope = () => {
      const scope = this.ctx.editor().completionScope()
      return { ...scope, dialectId: scope.dialect || this.ctx.connection()?.driver }
    }
    const metadataScope = (input, explicit = false) => {
      const active = currentScope(), connection = getConnection(input.connectionId || active.connectionId)
      if (!connection) throw new Error('请先选择连接')
      // Choosing another saved connection never borrows the active transaction console.
      return settingsMetadataScope(input, active, connection, this.mode, explicit)
    }
    this.completionSettings = mountCompletionSettings(root, {
      getConfig: () => state.ui.completion || normalizeConfig({}, state.ui),
      getConnections: () => state.connections,
      getScope: currentScope,
      getCatalog: scope => getCompletionCatalog(metadataScope(scope)),
      ensureCatalog: async (scope, request) => {
        const target = metadataScope(scope, true)
        await warmCompletionCatalog(target)
        if (request.table) await ensureCompletionColumns(target, [{ name: request.table, schema: request.schema === undefined ? target.schema : request.schema ?? '', database: target.database }])
        return getCompletionCatalog(target)
      },
      getQueryColumnSet: async () => {
        const editor = this.ctx.editor(), sql = editor.getValue(), position = editor.getCursor()
        const cursor = sql.split('\n').slice(0, position.line).reduce((length, line) => length + line.length + 1, 0) + position.ch
        const scope = currentScope(), key = completionContextKey(scope), documentId = editor.documentId
        const current = () => editor.documentId === documentId && editor.getValue() === sql && key === completionContextKey(currentScope())
        const { queryColumnSet } = await import('@db/sql-intelligence/settings/queryColumnSet.js')
        const metadataTicket = await captureCompletionMetadataRead(scope)
        let catalog = await getCompletionCatalog(scope)
        if (scope.connected && ['unloaded', 'stale'].includes(catalog.status)) {
          await warmCompletionCatalog(scope); catalog = await getCompletionCatalog(scope)
        }
        const request = { ...scope, sql, cursor }
        let selection = queryColumnSet(request, catalog)
        if (selection.requiredTables.length) {
          if (!scope.connected) throw new Error('请先连接来源数据库，再提取查询字段。')
          await ensureCompletionColumns(scope, selection.requiredTables)
          catalog = await getCompletionCatalog(scope)
          selection = queryColumnSet(request, catalog)
        }
        const metadataCurrent = await validateCompletionMetadataRead(scope, metadataTicket)
        if (!current() || !metadataCurrent) throw new Error('来源查询或连接已变化，请重新提取字段。')
        if (!selection.columns.length) throw new Error(selection.reason)
        return selection
      },
      previewCompletion: previewSqlCompletion,
      showMessage: message => this.ctx.message(message, 'info'),
      exportConfig: text => saveTextFile('enest-sql-completion.json', text),
      clearUsage: async () => {
        await storageSet(StorageKeys.completionUsage, {})
        state.completionUsage = {}
      },
      saveConfig: async config => {
        const updates = { completion: config, autoAliasAfterTable: config.behavior.autoAlias, learnUsage: config.behavior.learnUsage }
        await storageSet(StorageKeys.ui, { ...state.ui, ...updates })
        Object.assign(state.ui, updates)
        this.ctx.editor().closeCompletion()
        this.ctx.editor().updateCompletionOptions?.()
        this.ctx.editor().scheduleDiagnostics?.()
      }
    })
  }
  bindShortcutSettings() {
    const root = this.pageRoot.querySelector('.wb-shortcuts'), search = root.querySelector('[data-shortcut-search]'), group = root.querySelector('[data-shortcut-group]'), status = root.querySelector('[data-shortcut-status]')
    search.value = this.shortcutSearch || ''; group.value = this.shortcutGroup || ''
    const scopes = { editor: '查询编辑器', query: '查询标签', grid: '结果表格', workbench: '工作台' }
    const setStatus = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error) }
    const save = () => { setUiPref('shortcuts', { ...this.registry.bindings }); this.updateCommandLabels() }
    const render = () => {
      this.shortcutSearch = search.value; this.shortcutGroup = group.value
      const query = search.value.trim().toLowerCase()
      const commands = this.registry.list().filter(command => (!group.value || command.group === group.value) && `${command.label} ${command.id} ${command.group} ${scopes[command.scope]} ${this.registry.shortcut(command.id)}`.toLowerCase().includes(query))
      root.querySelector('[data-shortcut-list]').innerHTML = ['查询', '编辑器', '结果', '工作台'].map(name => {
        const items = commands.filter(command => command.group === name)
        return items.length ? `<section class="db-shortcut-group"><h3>${name}</h3>${items.map(command => `<div class="db-shortcut-row" data-command-row="${command.id}"><label for="shortcut-${command.id}"><strong>${esc(command.label)}</strong><span>${scopes[command.scope]} · 默认 ${esc(command.shortcut || '未分配')}</span></label><input id="shortcut-${command.id}" readonly aria-label="${esc(command.label)}快捷键" data-key="${command.id}" value="${esc(this.registry.shortcut(command.id))}" placeholder="未分配" title="点击后按组合键"><button class="btn" type="button" data-reset-key="${command.id}" ${Object.hasOwn(this.registry.bindings, command.id) ? '' : 'disabled'} aria-label="恢复${esc(command.label)}默认快捷键">恢复</button></div>`).join('')}</section>` : ''
      }).join('') || '<div class="wb-empty">没有匹配的快捷键</div>'
      root.querySelectorAll('[data-key]').forEach(input => {
        input.onfocus = () => { input.closest('.db-shortcut-row').classList.add('recording'); setStatus(`正在录制“${this.registry.commands.get(input.dataset.key).label}”：请按组合键，或按 Escape 退出。`) }
        input.onblur = () => input.closest('.db-shortcut-row').classList.remove('recording')
        input.onkeydown = event => {
          if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) return
          event.preventDefault(); event.stopPropagation()
          if (event.isComposing || ['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return
          if (event.key === 'Escape') { input.blur(); setStatus('已退出录制。'); return }
          const chord = event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey ? '' : normalizeShortcut(event)
          const command = this.registry.commands.get(input.dataset.key)
          if (chord && !event.metaKey && !event.ctrlKey && !event.altKey && !/^F\d{1,2}$/.test(event.key)) { setStatus('请使用组合键或功能键，避免占用输入与导航键。', true); return }
          if (['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Y', 'Mod+Shift+Z'].includes(chord) && !(command.scope === 'grid' && command.shortcut === chord)) { setStatus('此按键用于文本选择、剪贴板或撤销，请使用其他组合键。', true); return }
          try {
            this.setCommandBinding(command.id, chord); input.value = this.registry.shortcut(command.id)
            input.closest('.db-shortcut-row').querySelector('[data-reset-key]').disabled = false
            save(); setStatus(`${command.label}：${chord || '已停用快捷键'}，已保存。`)
          } catch (error) { setStatus(error.message, true) }
        }
      })
      root.querySelectorAll('[data-reset-key]').forEach(button => button.onclick = () => {
        const command = this.registry.commands.get(button.dataset.resetKey)
        try { this.setCommandBinding(command.id, command.shortcut || ''); delete this.registry.bindings[command.id]; save(); render(); setStatus(`“${command.label}”已恢复默认。`) } catch (error) { setStatus(`无法恢复：${error.message}`, true) }
      })
    }
    search.oninput = render; group.onchange = render; render()
    root.querySelector('[data-reset-keys]').onclick = () => { this.registry.bindings = {}; save(); render(); setStatus('全部快捷键已恢复默认。') }
  }
  updateCommandLabels() {
    this.root.querySelectorAll('[data-action]').forEach(button => {
      const id = button.dataset.action, command = this.registry.commands.get(id)
      if (command) button.title = `${command.label}${this.registry.shortcut(id) ? ` · ${this.registry.shortcut(id)}` : ''}`
    })
  }
  scheduleRefresh() {
    clearTimeout(this.refreshTimer)
    if (this.page === 'resources' && !document.hidden && state.ui.resourceAutoRefresh) this.refreshTimer = setTimeout(async () => { await this.renderResources(); this.scheduleRefresh() }, 5000)
  }
  async renderResources() {
    const tab = activeWorkspaceTab(); this.resourceKind = tab?.view || 'client'
    const ticket = this.resourceTicket = (this.resourceTicket || 0) + 1
    const auto = !!state.ui.resourceAutoRefresh
    const lastTime = this.lastInspection?.sampledAt ? ` · 更新 ${new Date(this.lastInspection.sampledAt).toLocaleTimeString()}` : ''
    this.pageRoot.innerHTML = `<div class="wb-observe"><div class="wb-page-title"><div><p class="wb-eyebrow">OBSERVABILITY</p><h1>资源中心</h1><p class="muted">${esc(this.ctx.connection()?.name || '请先连接数据库')} · 客户端与服务器指标分别标注来源</p></div><div class="wb-observe-actions">${auto ? `<span class="wb-observe-auto" title="设置中开启了自动刷新">${navIcon('history')}每 5s 自动刷新${esc(lastTime)}</span>` : ''}<button class="btn" data-refresh>刷新</button></div></div><nav class="wb-subtabs wb-observe-tabs" role="tablist" aria-label="资源中心分类">${Object.entries(inspectTabs).map(([id, label]) => `<button type="button" role="tab" aria-selected="${this.resourceKind === id}" data-kind="${id}" class="${this.resourceKind === id ? 'active' : ''}">${label}</button>`).join('')}</nav><div data-inspection aria-live="polite"><div class="wb-observe-skeleton" aria-hidden="true">${'<div class="wb-observe-sk-row"></div>'.repeat(6)}</div></div></div>`
    this.pageRoot.querySelector('[data-refresh]').onclick = () => void this.renderResources()
    this.pageRoot.querySelectorAll('[data-kind]').forEach((button) => button.onclick = () => { this.resourceKind = button.dataset.kind; if (tab) { tab.view = this.resourceKind; persistWorkspace() }; void this.renderResources() })
    try {
      const context = this.ctx.contextForTab?.(activeWorkspaceTab()), requestKind = this.resourceKind
      let sessionKey = context?.sessionKey
      if (requestKind !== 'client' && !sessionKey) { const target = this.pageRoot.querySelector('[data-inspection]'); target.innerHTML = this.observeEmptyCard('尚未重新读取', '连接后读取当前数据库的资源指标。', [{ label: '连接并读取', action: 'connect' }]); target.querySelector('[data-observe-connect]')?.addEventListener('click', async () => { try { await this.ctx.ensureConnected(context); if (target.isConnected && ticket === this.resourceTicket) await this.renderResources() } catch (error) { this.ctx.message(error.message, 'error') } }); return }
      const result = await DbHost.inspect({ sessionKey, kind: requestKind })
      if (this.page !== 'resources' || ticket !== this.resourceTicket) return
      this.lastInspection = result
      const target = this.pageRoot.querySelector('[data-inspection]')
      target.innerHTML = result.state === 'available'
        ? `<div class="wb-observe-meta"><span class="wb-observe-source">${result.source === 'enest-client' ? '本插件客户端' : '数据库服务器'}</span><span>采样 ${new Date(result.sampledAt).toLocaleTimeString()}</span><span class="spacer"></span><button class="btn" data-export-inspection>导出 JSON</button></div>${observeKpiHtml(requestKind, result.columns, result.rows)}${inspectTableHtml(result.columns, result.rows)}${result.note ? `<p class="wb-setting-note">${esc(result.note)}</p>` : ''}`
        : this.observeEmptyCard(result.state === 'permission-denied' ? '权限不足' : '当前指标不可用', result.reason || '当前驱动未提供此能力')
      target.querySelector('[data-export-inspection]')?.addEventListener('click', () => void saveTextFile(`database-${this.resourceKind}.json`, JSON.stringify(result, null, 2)))
    } catch (error) { if (this.page === 'resources' && ticket === this.resourceTicket) this.pageRoot.querySelector('[data-inspection]').innerHTML = this.observeEmptyCard('无法读取资源', error.message) }
  }
  observeEmptyCard(title, desc, actions = []) {
    return `<div class="wb-observe-card">${navIcon('resources')}<strong>${esc(title)}</strong><p>${esc(desc)}</p>${actions.map((action) => `<button type="button" class="btn primary" data-observe-connect>${esc(action.label)}</button>`).join('')}</div>`
  }
  async renderStructure() {
    const tab = activeWorkspaceTab()
    if (tab?.kind === 'object') {
      this.pageRoot.innerHTML = '<div class="wb-object-context"></div><section data-definition></section>'
      const bar = this.pageRoot.querySelector('.wb-object-context')
      bar.innerHTML = `<div class="wb-object-identity"><strong>${esc(tab.objectName)}</strong><span>${esc([getConnection(tab.connectionId)?.name, tab.database, tab.schema].filter(Boolean).join(' / '))}</span></div><div class="wb-segmented" role="tablist" aria-label="对象视图"><button role="tab" aria-selected="false" data-data>数据</button><button role="tab" aria-selected="true">结构</button></div><span class="spacer"></span><button class="btn" data-create-table>设计新表</button>`
      const policy = objectPolicy(tab.objectType)
      if (!policy.browse) bar.querySelector('[data-data]').hidden = true
      if (!policy.design) bar.querySelector('[data-create-table]').hidden = true
      this.appendTransactionControls(bar, this.ctx.session(), getConnection(tab.connectionId))
      const create = bar.querySelector('[data-create-table]'); const capability = state.runtime.dialects.find((driver) => driver.id === getConnection(tab.connectionId)?.driver)?.capabilities?.tableDesign; create.disabled = capability?.state !== 'available'; create.title = capability?.reason || '预览并执行建表 DDL'; create.onclick = () => this.createTableDesigner()
      bar.querySelector('[data-data]').onclick = () => void this.ctx.browse({ name: tab.objectName, type: tab.objectType, origin: tab.origin, database: tab.database, schema: tab.schema }, getConnection(tab.connectionId), 'data')
      return this.showDefinition(tab.objectName)
    }
    this.pageRoot.innerHTML = `<div class="wb-page-title"><div><p class="wb-eyebrow">DATABASE STRUCTURE</p><h1>结构与关系</h1><p class="muted">浏览字段、索引、外键与对象定义；DDL 先打开为查询文档。</p></div><button class="btn" data-create-table>设计新表</button></div><div class="wb-structure-layout"><aside data-objects><div class="wb-empty">读取对象…</div></aside><section data-definition><div class="wb-empty">选择左侧对象查看结构</div></section></div>`
    const designCapability = state.runtime.dialects.find((driver) => driver.id === this.ctx.connection()?.driver)?.capabilities?.tableDesign
    const create = this.pageRoot.querySelector('[data-create-table]'); create.disabled = designCapability?.state !== 'available'; create.title = designCapability?.reason || (create.disabled ? '当前驱动不支持结构设计' : '预览并执行建表 DDL')
    create.onclick = () => this.createTableDesigner()
    if (this.ctx.connection()?.driver === 'redis') return this.renderRedisKeys()
    try {
      const list = await DbHost.schema.tables({ sessionKey: this.ctx.sessionKey(), database: this.ctx.session()?.database || this.ctx.connection()?.database, schema: this.ctx.session()?.schema })
      if (this.page !== 'structure') return
      const objects = Array.isArray(list) ? list : list.nodes || []
      this.pageRoot.querySelector('[data-objects]').innerHTML = `<input class="wb-search" placeholder="筛选表或视图" aria-label="筛选对象"><div class="wb-object-list">${objects.map((node) => `<button data-object="${esc(node.name || node.label)}">${esc(node.name || node.label)}<small>${esc(node.type || 'table')}</small></button>`).join('') || '<p class="muted">没有可见对象</p>'}</div>`
      this.pageRoot.querySelector('[data-objects] input').oninput = (event) => this.pageRoot.querySelectorAll('[data-object]').forEach((button) => button.hidden = !button.dataset.object.toLowerCase().includes(event.target.value.toLowerCase()))
      this.pageRoot.querySelectorAll('[data-object]').forEach((button) => button.onclick = () => void this.showDefinition(button.dataset.object))
    } catch (error) { if (this.page === 'structure') this.pageRoot.querySelector('[data-objects]').textContent = error.message }
  }
  async renderRedisKeys() {
    const target = this.pageRoot.querySelector('[data-objects]'); let cursor = '0', keys = new Set()
    target.innerHTML = '<label class="wb-field">键模式 MATCH<input data-pattern value="*" aria-label="Redis 键模式"></label><button class="btn" data-scan>扫描</button><div class="wb-object-list"></div><button class="btn" data-scan-more hidden>继续扫描</button><p class="muted" data-scan-status></p>'
    const scan = async (restart) => {
      const status = target.querySelector('[data-scan-status]'); if (restart) { cursor = '0'; keys = new Set() }; status.textContent = '扫描中…'
      try { const result = await DbHost.workbench('redis.scan', { sessionKey: this.ctx.sessionKey(), cursor, match: target.querySelector('[data-pattern]').value || '*', count: 200 }); if (!target.isConnected) return; cursor = result.cursor; result.keys.forEach((key) => keys.add(key)); target.querySelector('.wb-object-list').innerHTML = [...keys].map((key) => `<button data-object="${esc(key)}">${esc(key)}</button>`).join(''); target.querySelectorAll('[data-object]').forEach((button) => button.onclick = () => void this.showDefinition(button.dataset.object)); target.querySelector('[data-scan-more]').hidden = cursor === '0'; status.textContent = `已扫描 ${keys.size} 个键${cursor === '0' ? ' · 本轮完成' : ' · 仍有后续游标'}` } catch (error) { status.textContent = error.message }
    }
    target.querySelector('[data-scan]').onclick = () => void scan(true); target.querySelector('[data-scan-more]').onclick = () => void scan(false); await scan(true)
  }
  async showDefinition(table) {
    const ticket = this.definitionTicket = (this.definitionTicket || 0) + 1
    const target = this.pageRoot.querySelector('[data-definition]'); target.innerHTML = '<div class="wb-empty">读取结构…</div>'
    const context = this.ctx.contextForTab?.(activeWorkspaceTab()) || { sessionKey: this.ctx.sessionKey(), session: this.ctx.session(), connection: this.ctx.connection() }
    const objectTab = activeWorkspaceTab()
    const req = { sessionKey: context.sessionKey, database: objectTab?.database || context.session?.database || context.connection?.database, schema: objectTab?.schema || context.session?.schema, table }
    const connection = context.connection
    try {
      if (!req.sessionKey) { target.innerHTML = '<div class="wb-empty"><strong>尚未重新读取</strong><p>连接后读取此对象的字段、索引和关系。</p><button class="btn primary" data-read-definition>连接并读取</button></div>'; target.querySelector('[data-read-definition]').onclick = async () => { try { await this.ctx.ensureConnected(context); if (target.isConnected && ticket === this.definitionTicket) await this.showDefinition(table) } catch (error) { this.ctx.message(error.message, 'error') } }; return }
      const policy = objectPolicy(objectTab?.objectType || 'table')
      if (policy.special || policy.type === 'view' && ['mysql', 'mariadb'].includes(connection?.driver)) {
        const object = { name: table, type: policy.type, database: req.database, schema: req.schema }
        const detail = await readDatabaseObject(connection, object, { surface: this.mode, isCurrent: () => target.isConnected && ticket === this.definitionTicket && this.ctx.contextValid(context) })
        if (!target.isConnected || ticket !== this.definitionTicket || !this.ctx.contextValid(context)) return
        target.innerHTML = `<div class="wb-section-heading"><h2>${esc(policy.label)} · ${esc(table)}</h2>${policy.browse ? '<button class="btn" data-browse>打开数据</button>' : ''}<button class="btn" data-object-definition>在查询中打开定义</button>${policy.template ? '<button class="btn" data-invocation>生成调用模板</button>' : ''}<button class="btn" data-refresh-definition>重新读取</button></div>${renderDatabaseObjectDetails(detail)}`
        target.querySelector('[data-browse]')?.addEventListener('click', () => this.ctx.browse(object, connection, 'data'))
        const definition = target.querySelector('[data-object-definition]'); definition.disabled = !detail.definition; definition.title = detail.definition ? '打开为查询文档，确认后手动执行' : detail.reason || '服务器未返回定义'; definition.onclick = () => this.ctx.openSqlDocument(context, detail.definition, `${table}.definition.sql`)
        const invocation = target.querySelector('[data-invocation]')
        if (invocation) { invocation.disabled = detail.state !== 'available' || detail.parametersKnown === false; invocation.title = invocation.disabled ? '未完整读取参数，不能生成调用模板' : '生成带参数说明的注释模板，不自动执行'; invocation.onclick = () => this.ctx.openSqlDocument(context, objectInvocationTemplate(connection.driver, { ...object, parametersKnown: detail.parametersKnown }, detail.parameters), `${table}.call.sql`) }
        target.querySelector('[data-refresh-definition]').onclick = () => void this.showDefinition(table)
        return
      }
      const metadata = await readDatabaseObject(connection, { name: table, type: policy.type, database: req.database, schema: req.schema }, { surface: this.mode, isCurrent: () => target.isConnected && ticket === this.definitionTicket && this.ctx.contextValid(context) })
      if (!target.isConnected || ticket !== this.definitionTicket || !this.ctx.contextValid(context)) return
      if (metadata.state !== 'available') { target.innerHTML = renderDatabaseObjectDetails(metadata); return }
      const detail = metadata.describe || { columns: metadata.columns || [] }
      if (connection?.driver === 'redis') {
        const metadata = detail.metadata || {}, ttl = metadata.ttlState === 'persistent' ? '永不过期' : metadata.ttlState === 'expired' ? '键已不存在' : metadata.ttlSeconds !== undefined ? `${metadata.ttlSeconds} 秒（本次采样）` : '未返回'
        target.innerHTML = `<div class="wb-section-heading"><h2>${esc(table)}</h2><button class="btn" data-browse>读取值</button><button class="btn" data-key-refresh>刷新</button></div>${tableHtml([{ name: '属性' }, { name: '值' }], [['类型', metadata.type || '未返回'], ['TTL', ttl]])}<p class="muted">读取时按键类型选择命令。列表、集合和流使用有界范围；大型值可通过原生查询继续读取。</p>`
        target.querySelector('[data-browse]').onclick = () => this.ctx.browse({ name: table, type: objectTab?.objectType || 'key', origin: objectTab?.origin, database: req.database }, connection); target.querySelector('[data-key-refresh]').onclick = () => void this.showDefinition(table); return
      }
      target.innerHTML = `<div class="wb-section-heading"><h2>${esc(table)}</h2><button class="btn" data-browse>打开数据</button><button class="btn" data-design>表设计</button><button class="btn" data-ddl>在编辑器打开 DDL</button></div><h3>字段</h3>${tableHtml([{ name: '名称' }, { name: '类型' }, { name: '可空' }, { name: '默认值' }, { name: '主键' }], (detail.columns || []).map((col) => [col.name, col.dataType || col.type, col.nullable === undefined ? '未知' : col.nullable ? '是' : '否', col.defaultValue ?? col.default, col.primaryKey || col.pk ? 'PK' : '']))}<h3>索引</h3>${tableHtml([{ name: '名称' }, { name: '列' }, { name: '唯一' }], (detail.indexes || []).map((index) => [index.name, index.columns, index.unique ? '是' : '否']), '当前对象没有返回索引信息')}<h3>关系图</h3><div class="wb-er"><article><strong>${esc(table)}</strong>${(detail.columns || []).map((col) => `<div>${col.primaryKey || col.pk ? 'PK · ' : ''}${esc(col.name)}<small>${esc(col.dataType || col.type)}</small></div>`).join('')}</article>${(detail.foreignKeys || []).map((fk) => `<div class="wb-er-edge"><span>${esc((fk.columns || []).join(', '))} → ${esc((fk.referencedColumns || []).join(', '))}</span><span class="wb-er-line"></span></div><article><strong>${esc(fk.referencedTable || fk.targetTable || '引用表')}</strong><p>${esc(fk.name || '外键关系')}</p></article>`).join('')}</div>${!detail.foreignKeys?.length ? '<p class="muted">没有返回外键关系；不会按字段名称推测关系。</p>' : ''}`
      if (detail.comment) { const note = document.createElement('p'); note.className = 'muted'; note.textContent = detail.comment; target.prepend(note) }
      if (detail.metadata?.tags) { const tags = document.createElement('section'); tags.innerHTML = `<h3>TDengine 标签</h3>${tableHtml([{ name: '标签' }, { name: '类型' }], detail.metadata.tags.map((tag) => [tag.name, tag.dataType]), '此对象没有标签')}`; target.prepend(tags) }
      target.querySelector('[data-browse]').onclick = () => this.ctx.browse({ name: table, type: objectTab?.objectType || 'table', origin: objectTab?.origin, database: req.database, schema: req.schema }, connection)
      const design = target.querySelector('[data-design]'); design.hidden = !policy.design; design.disabled = !policy.design || state.runtime.dialects.find((driver) => driver.id === connection?.driver)?.capabilities?.tableDesign?.state !== 'available'; design.onclick = () => this.createTableDesigner(table, detail, context)
      const ddl = target.querySelector('[data-ddl]'); ddl.disabled = !metadata.definition; ddl.title = metadata.definition ? '打开为查询文档，确认后手动执行' : metadata.reason || '当前驱动没有返回对象定义'
      ddl.onclick = async () => { try { await this.ctx.openSqlDocument(context, metadata.definition, `${table}.ddl.sql`) } catch (error) { this.ctx.message(error.message, 'error') } }
    } catch (error) { if (target.isConnected && ticket === this.definitionTicket) target.textContent = error.message }
  }
  createTableDesigner(table, detail, capturedContext) {
    if (this.mode === 'quick') return this.openShellAnd('structure', () => this.createTableDesigner(table, detail, capturedContext))
    const context = capturedContext || this.ctx.contextForTab?.(activeWorkspaceTab()) || { sessionKey: this.ctx.sessionKey(), session: this.ctx.session(), connection: this.ctx.connection() }; const tabId = activeWorkspaceTab()?.id
    return openTableDesigner({ sessionKey: context.sessionKey, taskContext: { consoleId: context.session?.id, editorId: context.editor?.id, tabId: context.tabId }, isCurrent: () => this.ctx.contextValid(context), table: { database: context.session?.database || context.connection?.database, schema: context.session?.schema, table }, detail, readOnly: context.connection?.readOnly || context.session?.origin === 'quick', onApplied: () => { if (activeWorkspaceTab()?.id === tabId && this.page === 'structure') return table ? this.showDefinition(table) : this.renderStructure() } })
  }
  openComparison() {
    if (this.mode === 'quick') return this.openShellAnd('compare')
    this.ctx.beforeNavigate?.()
    openWorkspaceTab({ kind: 'compare', title: '比较' }, { activate: true }); this.page = 'compare'; this.render(); this.navigation.close(false)
  }
  renderComparison() {
    const sourceTabId = activeWorkspaceTab()?.id
    const sessions = state.sessions.filter((session) => state.runtime.consoleSessionKeys.has(session.id))
    const options = sessions.map((session) => `<option value="${esc(session.id)}" ${session.id === this.ctx.session()?.id ? 'selected' : ''}>${esc(getConnection(session.connectionId)?.name || '连接已删除')} / ${esc(session.name || '控制台')}${session.database ? ` / ${esc(session.database)}` : ''}${session.transactionActive ? ' · 事务进行中' : ''}</option>`).join('')
    const sql = this.ctx.editor().getValue()
    const modal = { body: this.pageRoot }; modal.body.innerHTML = `<div class="wb-page-title"><div><h1>数据与结构比较</h1><p class="muted">独立读取两侧数据源，只读比较。</p></div></div><div class="wb-compare-controls"><label>比较内容<select data-kind><option value="data">数据</option><option value="structure">结构</option></select></label><label>对齐键列<input data-keys placeholder="id 或 id,region"></label><label>每侧行数上限<input data-limit type="number" value="1000" min="1" max="10000"></label><button class="btn" data-swap>交换左右</button><button class="btn primary" data-compare ${!sessions.length ? 'disabled' : ''}>开始比较</button></div><p class="muted">${sessions.length ? '数据输入只读查询；结构输入表名。两侧分别读取，结果不是同一时刻的事务快照。' : '请先连接至少一个数据源，再进行比较。'}</p><details class="wb-compare-advanced"><summary>列映射与比较规则</summary><p class="muted">留空时按同名列比较；填写后仅比较映射的列。对齐键使用左侧列名。严格模式区分类型，文本模式按文本，数字模式按数值，JSON 模式按结构比较。</p><label>默认规则<select data-default-rule><option value="strict">严格类型</option><option value="text">文本</option><option value="numeric">数值</option><option value="json">JSON 结构</option></select></label><div data-mappings></div><button class="btn" data-add-mapping>添加列映射</button></details><div class="wb-compare-inputs">${['left', 'right'].map((side) => `<section><label>${side === 'left' ? '左侧来源' : '右侧来源'}<select data-side="${side}">${options}</select></label><textarea data-query="${side}" rows="4" spellcheck="false" aria-label="${side === 'left' ? '左' : '右'}侧查询或表名">${esc(sql)}</textarea></section>`).join('')}</div><div class="wb-compare-summary" role="status">尚未比较</div><div class="wb-compare-actions" hidden><label><input type="checkbox" data-diff-only> 仅看差异</label><button class="btn" data-prev>上一个差异</button><button class="btn" data-next>下一个差异</button><span class="spacer"></span><button class="btn" data-export>导出比较结果</button></div><div class="wb-compare-results"></div>`
    const mappings = []
    const renderMappings = () => { modal.body.querySelector('[data-mappings]').innerHTML = mappings.map((mapping, index) => `<div class="wb-mapping-row"><input data-mapping="${index}" data-prop="left" aria-label="左侧列名" placeholder="左侧列名" value="${esc(mapping.left)}"><span>→</span><input data-mapping="${index}" data-prop="right" aria-label="右侧列名" placeholder="右侧列名" value="${esc(mapping.right)}"><select data-mapping="${index}" data-prop="rule" aria-label="比较规则">${Object.entries({ '': '默认规则', strict: '严格类型', text: '文本', numeric: '数值', json: 'JSON 结构' }).map(([id, label]) => `<option value="${id}" ${mapping.rule === id ? 'selected' : ''}>${label}</option>`).join('')}</select><button class="btn" data-remove-mapping="${index}" aria-label="移除映射">×</button></div>`).join(''); modal.body.querySelectorAll('[data-mapping]').forEach((input) => input.oninput = () => mappings[input.dataset.mapping][input.dataset.prop] = input.value.trim()); modal.body.querySelectorAll('[data-remove-mapping]').forEach((button) => button.onclick = () => { mappings.splice(Number(button.dataset.removeMapping), 1); renderMappings() }) }
    modal.body.querySelector('[data-add-mapping]').onclick = () => { mappings.push({ left: '', right: '', rule: '' }); renderMappings() }
    let result = null, kind = 'data', differenceIndex = -1
    const render = () => {
      if (!result) return
      const rows = result.rows.filter((row) => !modal.body.querySelector('[data-diff-only]').checked || row.status !== 'equal')
      const projected = (side) => kind === 'data' && result.columnMappings?.length ? result.columnMappings.map((mapping) => result[side].columns.find((column) => column.name === mapping[side])).filter(Boolean) : result[side].columns || []
      const columns = projected('left'), rightColumns = projected('right')
      const renderSide = (side, cols) => `<section class="wb-diff-pane" data-pane="${side}"><div class="wb-diff-scroll"><table class="wb-table"><thead><tr><th>差异</th>${kind === 'data' ? cols.map((col) => `<th>${esc(col.name)}</th>`).join('') : '<th>结构定义</th>'}</tr></thead><tbody>${rows.map((row, index) => `<tr data-diff-row="${index}" data-status="${row.status}"><td>${statusLabel[row.status]}</td>${kind === 'data' ? cols.map((col) => `<td>${esc(textValue(row[side]?.[result[side].columns.findIndex((source) => source.name === col.name)]))}</td>`).join('') : `<td><pre>${esc(row[side] ? JSON.stringify(row[side], null, 2) : '—')}</pre></td>`}</tr>`).join('')}</tbody></table></div></section>`
      modal.body.querySelector('.wb-compare-results').innerHTML = renderSide('left', columns) + renderSide('right', rightColumns)
      const panes = [...modal.body.querySelectorAll('.wb-diff-scroll')]; let synchronizing = false
      panes.forEach((pane, index) => pane.onscroll = () => { if (synchronizing) return; synchronizing = true; panes[1 - index].scrollTop = pane.scrollTop; panes[1 - index].scrollLeft = pane.scrollLeft; requestAnimationFrame(() => synchronizing = false) })
    }
    modal.body.querySelector('[data-kind]').onchange = (event) => { kind = event.target.value; modal.body.querySelector('[data-keys]').disabled = kind === 'structure'; modal.body.querySelector('[data-limit]').disabled = kind === 'structure'; modal.body.querySelectorAll('[data-query]').forEach((input) => { input.placeholder = kind === 'data' ? 'SELECT …' : '表名'; input.value = '' }) }
    modal.body.querySelector('[data-swap]').onclick = () => { for (const attr of ['data-side', 'data-query']) { const left = modal.body.querySelector(`[${attr}=left]`), right = modal.body.querySelector(`[${attr}=right]`); [left.value, right.value] = [right.value, left.value] } }
    modal.body.querySelector('[data-compare]').onclick = async (event) => {
      const button = event.target, summary = modal.body.querySelector('.wb-compare-summary'); button.disabled = true; summary.textContent = '正在读取两侧并比较…'
      const controls = [...modal.body.querySelectorAll('input,select,textarea,[data-swap],[data-add-mapping],[data-remove-mapping]')]; controls.forEach((control) => { control.dataset.wasDisabled = String(control.disabled); control.disabled = true })
      try {
        const readSide = (side) => ({ sessionKey: state.runtime.consoleSessionKeys.get(modal.body.querySelector(`[data-side=${side}]`).value), sql: modal.body.querySelector(`[data-query=${side}]`).value.trim() })
        const left = readSide('left'), right = readSide('right')
        const task = { kind: 'compare', tabId: sourceTabId, sessionKey: left.sessionKey, consoleIds: [...state.runtime.consoleSessionKeys].filter(([, key]) => key === left.sessionKey || key === right.sessionKey).map(([id]) => id) }
        if (!left.sessionKey || !right.sessionKey) throw new Error('所选来源已断开，请重新连接后比较')
        if (!left.sql || !right.sql) throw new Error('请填写左右两侧的查询或表名')
        if (kind === 'data') {
          const keyColumns = modal.body.querySelector('[data-keys]').value.split(',').map((key) => key.trim()).filter(Boolean)
          if (!keyColumns.length) throw new Error('请选择可唯一标识数据行的对齐键列')
          if (mappings.some((mapping) => !mapping.left || !mapping.right)) throw new Error('请填写每行映射的左右列名')
          result = await runDatabaseTask(task, () => DbHost.compare({ left, right, keyColumns, defaultRule: modal.body.querySelector('[data-default-rule]').value, columnMappings: mappings.map((mapping) => ({ left: mapping.left, right: mapping.right, ...(mapping.rule ? { rule: mapping.rule } : {}) })), maxRows: Math.min(10000, Math.max(1, Number(modal.body.querySelector('[data-limit]').value) || 1000)) }))
        } else {
          const [l, r] = await runDatabaseTask(task, () => Promise.all([DbHost.schema.describe({ sessionKey: left.sessionKey, table: left.sql }), DbHost.schema.describe({ sessionKey: right.sessionKey, table: right.sql })])); result = { left: l, right: r, rows: structureDiff(l, r), comparedAt: Date.now(), partial: false, snapshot: 'independent-query-snapshots' }
        }
        summary.textContent = `${result.coverage ? `左侧 ${result.coverage.leftRows} 行 / 右侧 ${result.coverage.rightRows} 行 · ` : ''}${result.rows.length} 个对齐键 · ${result.rows.filter((row) => row.status !== 'equal').length} 项差异${result.partial ? ' · 仅比较已读取的部分数据，不能据此判断全部相同' : ''}${result.rows.some((row) => row.status === 'ambiguous') ? ' · 存在重复键，请更换键列' : ''}`
        modal.body.querySelector('.wb-compare-actions').hidden = false; render()
      } catch (error) { summary.textContent = error.message } finally { button.disabled = false; controls.forEach((control) => { control.disabled = control.dataset.wasDisabled === 'true' }) }
    }
    modal.body.querySelector('[data-diff-only]').onchange = render
    const jump = (direction) => { const rows = [...modal.body.querySelectorAll('[data-pane=left] tr[data-status]')].filter((row) => row.dataset.status !== 'equal'); if (!rows.length) return; differenceIndex = (differenceIndex + direction + rows.length) % rows.length; rows[differenceIndex].scrollIntoView({ block: 'center' }); rows.forEach((row, index) => row.classList.toggle('diff-current', index === differenceIndex)) }
    modal.body.querySelector('[data-prev]').onclick = () => jump(-1); modal.body.querySelector('[data-next]').onclick = () => jump(1)
    modal.body.querySelector('[data-export]').onclick = () => void saveTextFile(`database-${kind}-comparison.json`, JSON.stringify({ kind, ...result }, null, 2))
  }
}
