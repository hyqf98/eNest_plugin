import { CommandRegistry, createDialog, escapeHtml as esc, normalizeShortcut } from '@enest/plugin-kit/workbench'
import { api, DbHost, StorageKeys, storageSet, saveTextFile } from './api.js'
import { state, setUiPref, getConnection, schedulePersistSessions } from './store.js'
import { structureDiff } from './comparison.js'
import { queryTemplates } from './queryTemplates.js'
import { openTableDesigner } from './tableDesigner.js'

const statusLabel = { equal: '相同', different: '修改', 'left-only': '仅左侧', 'right-only': '仅右侧', ambiguous: '键不唯一' }
const inspectTabs = { client: '本插件连接池', sessions: '服务器会话', queries: '运行中查询', resources: '资源指标', locks: '锁与阻塞', jobs: '后台任务' }
const textValue = (value) => value === null ? 'NULL' : value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

function tableHtml(columns, rows, empty = '没有数据') {
  if (!rows?.length) return `<div class="wb-empty">${esc(empty)}</div>`
  return `<div class="wb-table-wrap"><table class="wb-table"><thead><tr>${columns.map((column) => `<th>${esc(column.name || column)}${column.unit ? ` <small>${esc(column.unit)}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td title="${esc(textValue(cell))}">${esc(textValue(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

export class DatabaseWorkbench {
  constructor(context) {
    this.ctx = context; this.mode = 'shell'; this.page = 'query'; this.resourceKind = 'client'; this.registry = new CommandRegistry(); this.compareState = null
    this.root = document.querySelector('#app'); this.workspace = this.root.querySelector('.workspace')
    this.header = document.createElement('header'); this.header.className = 'wb-header'; this.root.prepend(this.header)
    this.pageRoot = document.createElement('section'); this.pageRoot.className = 'wb-page'; this.pageRoot.hidden = true; this.root.append(this.pageRoot)
    this.status = document.createElement('footer'); this.status.className = 'wb-status'; this.root.append(this.status)
    this.ctx.editor().fontSize = state.ui.editorFontSize || 13
    this.makeCommands(); this.ctx.editor().commandRegistry = this.registry; this.bind()
  }
  async initialize() {
    this.registry.bindings = { ...(state.ui.shortcuts || {}) }
    const value = await api?.getLaunchMode?.()
    this.mode = value === 'quick' ? 'quick' : 'shell'
    this.page = this.mode === 'quick' || !this.ctx.connection() ? 'home' : 'query'
    api?.onModeChange?.((mode) => this.setMode(mode))
    this.render()
  }
  makeCommands() {
    const register = (id, label, shortcut, run, enabled) => this.registry.register({ id, label, shortcut, run, enabled, inEditor: true })
    register('run', '执行选区或当前语句', 'Mod+Enter', () => this.ctx.execute({ mode: 'selection' }), () => !!this.ctx.connection() && !state.runtime.executing && (this.mode !== 'quick' || this.ctx.session()?.origin === 'quick'))
    register('runAll', '执行全部语句', 'Mod+Shift+Enter', () => this.ctx.execute({ mode: 'all' }), () => this.mode === 'shell' && !state.runtime.executing)
    register('cancel', '取消当前查询', 'Alt+Escape', () => this.ctx.cancel(), () => state.runtime.executing)
    register('newQuery', '新建查询', 'Mod+T', () => this.ctx.newQuery())
    register('templates', '查询模板与原生语法', 'Mod+Shift+Space', () => this.openTemplates())
    register('save', '保存查询文档', 'Mod+S', () => this.ctx.save())
    register('format', '格式化查询', 'Mod+Shift+F', () => this.ctx.editor().formatDocument().catch((error) => this.ctx.message(error.message, 'error')))
    register('export', '导出当前结果', 'Mod+Shift+E', () => this.ctx.export())
    register('compare', '比较数据与结构', 'Mod+Shift+D', () => this.openComparison(), () => this.mode === 'shell')
    register('settings', '插件设置与快捷键', 'Mod+,', () => this.navigate('settings'))
    register('palette', '搜索工作台命令', 'Mod+Shift+P', () => this.openPalette())
    register('resources', '打开资源中心', 'Mod+Shift+R', () => this.navigate('resources'), () => this.mode === 'shell')
  }
  bind() {
    document.addEventListener('keydown', (event) => {
      if (event.target.matches?.('[data-key]')) return
      if (document.querySelector('dialog[open]') || document.querySelector('#modal-root .modal')) return
      if (this.mode === 'quick' && this.ctx.session()?.origin !== 'quick' && ['run', 'runAll'].some((id) => this.registry.shortcut(id) === normalizeShortcut(event))) {
        event.preventDefault(); event.stopPropagation(); this.ctx.message('此桌面控制台请在桌面继续，或新建独立快捷查询', 'warn'); return
      }
      this.registry.handle(event, { inEditor: !!event.target.closest?.('.editor-host') })
    }, true)
    document.addEventListener('focusin', (event) => {
      const target = event.target
      const context = target.closest?.('dialog[open], .modal, .ctx-menu') ? 'overlay' : target.closest?.('.editor-host, textarea, input') ? 'editor' : 'workbench'
      api?.ui?.setInputContext?.(context)
    })
    this.header.addEventListener('click', (event) => {
      const button = event.target.closest('[data-wb]'); if (!button) return
      const action = button.dataset.wb
      if (action === 'newConnection') this.newConnection()
      else if (action === 'openShell') void this.openShellAnd(this.page)
      else if (action === 'focusSearch') api?.ui?.focusSearch?.()
      else if (action === 'compare') this.openComparison()
      else if (action === 'palette') this.openPalette()
      else if (action === 'run') this.ctx.execute({ mode: 'selection' })
      else if (action === 'cancel') this.ctx.cancel()
      else if (action === 'connect') this.ctx.connect().then(() => this.render())
      else if (action === 'format') void this.registry.run('format')
      else this.navigate(action)
    })
    document.addEventListener('visibilitychange', () => this.scheduleRefresh())
    window.addEventListener('pagehide', () => { clearTimeout(this.refreshTimer); this.ctx.editor().themeObserver?.disconnect() })
  }
  setMode(mode) {
    const next = mode === 'quick' ? 'quick' : 'shell'; if (next === this.mode) return
    state.ui.surfaces ||= {}; state.ui.surfaces[this.mode] = { page: this.page }
    const currentPage = this.page
    this.mode = next; this.page = this.nextPageIntent || (next === 'shell' ? currentPage : state.ui.surfaces.quick?.page || 'home'); this.nextPageIntent = null
    if (next === 'quick' && !['home', 'query', 'settings'].includes(this.page)) this.page = 'home'
    void storageSet(StorageKeys.ui, state.ui).catch(() => {}); this.render(); this.ctx.surfaceChanged?.()
  }
  navigate(page) { if (this.mode === 'quick' && !['home', 'query'].includes(page)) return this.openShellAnd(page); this.page = page; this.render(); if (page === 'query') this.ctx.editor().focus(); else if (page === 'home') this.pageRoot.querySelector('.wb-search')?.focus(); api?.ui?.setInputContext?.(page === 'query' ? 'editor' : 'workbench') }
  async openShellAnd(page, run) {
    if (this.mode === 'quick') {
      this.nextPageIntent = page
      try { const opened = await api?.ui?.openInShell?.(); if (opened === false || opened === undefined) throw new Error('无法打开完整工作台，请更新宿主后重试'); this.setMode('shell') } catch (error) { this.nextPageIntent = null; this.ctx.message(error.message, 'error'); return }
    }
    this.navigate(page); await run?.()
  }
  newConnection(existing) { return this.openShellAnd('home', () => this.ctx.newConnection(existing)) }
  render() {
    const connection = this.ctx.connection(), connected = this.ctx.isConnected()
    this.root.dataset.surface = this.mode; this.root.dataset.page = this.page
    this.root.dataset.resultDock = state.ui.resultDock || 'bottom'
    this.header.innerHTML = `<div class="wb-brand">数据库 <span>${this.mode === 'quick' ? 'Quick' : 'Workbench'}</span></div><nav aria-label="数据库导航">${[['home', '连接'], ['query', '查询'], ...(this.mode === 'shell' ? [['structure', '结构'], ['resources', '资源'], ['settings', '设置']] : [])].map(([id, label]) => `<button type="button" data-wb="${id}" class="${this.page === id ? 'active' : ''}">${label}</button>`).join('')}</nav><div class="spacer"></div>${this.mode === 'shell' ? '<button class="btn" data-wb="compare">比较</button><button class="btn" data-wb="palette" title="搜索命令 · Mod+Shift+P">命令</button>' : '<button class="btn" data-wb="focusSearch">搜索</button><button class="btn" data-wb="openShell">工作台</button>'}`
    this.workspace.hidden = this.page !== 'query'; this.pageRoot.hidden = this.page === 'query'
    this.status.innerHTML = `<span class="wb-status-dot ${connected ? 'on' : ''}"></span><span>${esc(connection?.name || '未选择连接')}</span><span>${connected ? '已连接' : '未连接'}</span><span class="spacer"></span><span>${this.mode === 'quick' ? '只读速览 · 最多 200 行' : '查询文档自动保存'}</span>`
    if (this.page === 'home') this.renderHome()
    else if (this.page === 'settings') this.renderSettings()
    else if (this.page === 'resources') void this.renderResources()
    else if (this.page === 'structure') void this.renderStructure()
    else this.renderQueryBar()
    void this.ctx.editor().setSurface(this.mode, connected && this.page === 'query')
    this.scheduleRefresh()
    if (this.page === 'home') this.pageRoot.querySelector('.wb-search')?.focus()
    else if (this.page === 'query') this.ctx.editor().focus()
  }
  update() {
    const conn = this.ctx.connection(), connected = this.ctx.isConnected()
    if (this.page === 'query') this.renderQueryBar()
    else if (this.page === 'home') this.renderHome()
    this.status.innerHTML = `<span class="wb-status-dot ${connected ? 'on' : ''}"></span><span>${esc(conn?.name || '未选择连接')}</span><span>${state.runtime.executing ? '执行中' : connected ? '已连接' : '未连接'}</span><span class="spacer"></span><span>${this.mode === 'quick' ? '只读速览 · 最多 200 行' : `${state.sessions.length} 个会话`}</span>`
    void this.ctx.editor().setSurface(this.mode, connected && this.page === 'query')
  }
  renderHome() {
    const restoreSearch = document.activeElement?.matches?.('.wb-search') || (this.mode === 'quick' && document.activeElement === document.body)
    const query = this.homeSearch || '', connections = state.connections.filter((conn) => `${conn.name} ${conn.host} ${conn.driver}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0))
    this.pageRoot.innerHTML = `<div class="wb-home"><div class="wb-page-title"><div><p class="wb-eyebrow">${this.mode === 'quick' ? 'QUICK CONNECT' : 'CONNECTIONS'}</p><h1>连接数据库</h1><p class="muted">${this.mode === 'quick' ? '查一段数据，接着处理手头的工作。' : '选择连接，恢复查询和结果。'}</p></div><button class="btn primary" data-new>新建连接</button></div><input class="wb-search" type="search" placeholder="搜索名称、地址或数据库类型" aria-label="搜索连接" value="${esc(query)}"><div class="wb-connection-list">${connections.length ? connections.map((conn) => `<div class="wb-connection-row"><button data-connect="${esc(conn.id)}"><span class="wb-engine">${esc(conn.driver.slice(0, 3).toUpperCase())}</span><span><strong>${esc(conn.name)}</strong><small>${esc(conn.driver)} · ${esc(conn.host || conn.fileLabel || '本地数据库')}${conn.database ? ` / ${esc(conn.database)}` : ''}</small></span><span class="spacer"></span>${conn.env === 'prod' ? '<span class="badge warn">生产</span>' : ''}${conn.readOnly ? '<span class="badge">只读</span>' : ''}<span class="wb-connect-arrow">连接</span></button><button class="btn ghost" data-edit="${esc(conn.id)}" aria-label="编辑 ${esc(conn.name)}">编辑</button></div>`).join('') : `<div class="wb-empty"><strong>${query ? '没有匹配的连接' : '从第一个连接开始'}</strong><p>密码保存在本机凭据库，查询文档按连接保存。</p></div>`}</div>${state.queryHistory.length ? `<div class="wb-section-heading"><h2>最近查询</h2><span>点击插入，确认后执行</span></div><div class="wb-recent">${state.queryHistory.slice(0, this.mode === 'quick' ? 4 : 8).map((history) => `<button data-history="${esc(history.id)}"><code>${esc(history.sql.slice(0, 140))}</code><small>${esc(getConnection(history.connectionId)?.name || '连接已删除')} · ${new Date(history.ts || history.createdAt || Date.now()).toLocaleString()}</small></button>`).join('')}</div>` : ''}</div>`
    this.pageRoot.querySelector('[data-new]').onclick = () => this.newConnection()
    this.pageRoot.querySelector('.wb-search').oninput = (event) => { this.homeSearch = event.target.value; const cursor = event.target.selectionStart; this.renderHome(); const input = this.pageRoot.querySelector('.wb-search'); input.focus(); try { input.setSelectionRange(cursor, cursor) } catch { /* search inputs may not expose selection */ } }
    this.pageRoot.querySelectorAll('[data-connect]').forEach((button) => button.onclick = async () => { button.disabled = true; button.querySelector('.wb-connect-arrow').textContent = '连接中…'; try { await this.ctx.selectConnection(button.dataset.connect); this.navigate('query') } catch (error) { this.ctx.message(error.message, 'error') } finally { if (this.page === 'home') this.renderHome() } })
    this.pageRoot.querySelectorAll('[data-edit]').forEach((button) => button.onclick = () => this.newConnection(getConnection(button.dataset.edit)))
    const buttons = [...this.pageRoot.querySelectorAll('[data-connect]')]
    const search = this.pageRoot.querySelector('.wb-search')
    this.homeIndex = Math.min(this.homeIndex || 0, Math.max(0, buttons.length - 1))
    const select = () => buttons.forEach((button, index) => { button.parentElement.classList.toggle('active', index === this.homeIndex); button.setAttribute('aria-selected', String(index === this.homeIndex)); if (state.runtime.sessionKeys.has(button.dataset.connect)) button.querySelector('.wb-connect-arrow').textContent = '继续' })
    search.onkeydown = (event) => {
      if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); this.homeIndex = (this.homeIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % Math.max(1, buttons.length); select(); buttons[this.homeIndex]?.scrollIntoView({ block: 'nearest' }) }
      else if (event.key === 'Enter' && buttons[this.homeIndex]) { event.preventDefault(); buttons[this.homeIndex].click() }
    }
    select()
    if (restoreSearch) search.focus()
    this.pageRoot.querySelectorAll('[data-history]').forEach((button) => button.onclick = async () => { const history = state.queryHistory.find((item) => item.id === button.dataset.history); if (!getConnection(history.connectionId)) return this.ctx.message('原连接已删除，请先选择新的连接', 'warn'); try { await this.ctx.selectConnection(history.connectionId); this.ctx.editor().setValue(history.sql); this.navigate('query') } catch (error) { this.ctx.message(error.message, 'error') } })
  }
  renderQueryBar() {
    let toolbar = this.workspace.querySelector('.wb-querybar')
    if (!toolbar) { toolbar = document.createElement('div'); toolbar.className = 'wb-querybar'; this.workspace.querySelector('.mid-col').insertBefore(toolbar, this.workspace.querySelector('.editor-pane')) }
    const conn = this.ctx.connection(), session = this.ctx.session(), connected = this.ctx.isConnected()
    if (this.mode === 'quick' && session && session.origin !== 'quick') {
      toolbar.innerHTML = '<span class="wb-session-note" role="status">桌面控制台，请在桌面执行</span><span class="spacer"></span><button class="btn" data-action="desktop">桌面继续</button><button class="btn" data-action="newQuick" title="创建空白、独立、只读的快捷控制台">新建快捷查询</button>'
      toolbar.onclick = (event) => { const action = event.target.closest('[data-action]')?.dataset.action; if (action === 'desktop') void this.openShellAnd('query'); else if (action === 'newQuick') void this.ctx.newQuick() }
      return
    }
    toolbar.innerHTML = `<button class="btn primary" data-action="${state.runtime.executing ? 'cancel' : 'run'}" ${!conn ? 'disabled' : ''}>${state.runtime.executing ? '取消查询' : '执行'}</button>${this.mode === 'shell' ? '<button class="btn" data-action="format">格式化</button><button class="btn" data-action="templates">模板</button><button class="btn" data-action="explain">执行计划</button>' : ''}<span class="wb-divider"></span><button class="btn" data-action="connect">${connected ? '断开' : '连接'}</button><label class="wb-database-label">数据库 <button class="btn" data-action="database">${esc(session?.database || conn?.database || '默认')}</button></label><span class="spacer"></span><span class="muted">${esc(this.registry.shortcut('run'))}</span>${this.mode === 'shell' ? '<button class="btn" data-action="begin">开始事务</button><button class="btn" data-action="commit">提交</button><button class="btn" data-action="rollback">回滚</button>' : ''}`
    const transactionActive = !!session?.transactionActive
    const capabilities = state.runtime.dialects.find((driver) => driver.id === conn?.driver)?.capabilities || {}
    for (const [action, capability] of Object.entries({ explain: 'explain', begin: 'transaction', commit: 'transaction', rollback: 'transaction' })) {
      const button = toolbar.querySelector(`[data-action=${action}]`)
      if (button && (!connected || capabilities[capability]?.state !== 'available' || (capability === 'transaction' && (conn?.readOnly || session?.origin === 'quick' || (action === 'begin' ? transactionActive : !transactionActive))))) { button.disabled = true; button.title = capabilities[capability]?.reason || '连接后由驱动报告此能力' }
    }
    toolbar.onclick = async (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return
      if (action === 'database') return this.chooseDatabase()
      if (action === 'connect') { await this.ctx.connect(); this.update(); return }
      if (action === 'explain') return this.ctx.execute({ explain: true })
      if (['begin', 'commit', 'rollback'].includes(action)) {
        try { const result = await DbHost.transaction({ sessionKey: this.ctx.sessionKey(), operation: action }); session.transactionActive = result.active; this.renderQueryBar(); this.ctx.message({ begin: '事务已开始', commit: '事务已提交', rollback: '事务已回滚' }[action], 'success') } catch (error) { this.ctx.message(error.message, 'error') }; return
      }
      void this.registry.run(action)
    }
  }
  async chooseDatabase() {
    const modal = createDialog({ title: '切换数据库', content: '<p class="muted">正在读取数据库…</p>' })
    try {
      const databases = await DbHost.schema.databases({ sessionKey: this.ctx.sessionKey() })
      modal.body.innerHTML = `<div class="wb-command-list">${databases.map((db) => `<button data-db="${esc(db.name || db.label)}">${esc(db.name || db.label)}</button>`).join('') || '<p>当前驱动未返回数据库列表。</p>'}</div>`
      modal.body.querySelectorAll('[data-db]').forEach((button) => button.onclick = async () => { try { await this.ctx.switchDatabase(button.dataset.db); modal.close(); this.update() } catch (error) { this.ctx.message(error.message, 'error') } })
    } catch (error) { modal.body.textContent = error.message }
  }
  openTemplates() {
    const connection = this.ctx.connection(); if (!connection) return this.ctx.message('请先选择数据库连接', 'warn')
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
    this.pageRoot.innerHTML = `<div class="wb-settings"><div class="wb-page-title"><div><p class="wb-eyebrow">PLUGIN PREFERENCES</p><h1>数据库设置</h1><p class="muted">仅影响数据库插件。主题、字体和全局动画继续跟随 eNest。</p></div><button class="btn" data-back>返回查询</button></div><div class="wb-settings-grid"><section><h2>编辑器与查询</h2><label>工作台最大返回行数<input type="number" min="200" max="10000" step="200" data-pref="maxRows" value="${state.ui.maxRows || 1000}"></label><label>编辑器字号<input type="number" min="11" max="24" data-pref="editorFontSize" value="${state.ui.editorFontSize || 13}"></label><label><input type="checkbox" data-pref="autoAliasAfterTable" ${state.ui.autoAliasAfterTable ? 'checked' : ''}> 表名补全附加别名</label><label><input type="checkbox" data-pref="learnUsage" ${state.ui.learnUsage !== false ? 'checked' : ''}> 优先显示常用补全</label><label><input type="checkbox" data-pref="resourceAutoRefresh" ${state.ui.resourceAutoRefresh ? 'checked' : ''}> 资源中心可见时每 5 秒刷新</label><p class="muted">Quick 固定最多 200 行，只读查询。服务器不支持的指标会显示原因。</p></section><section><h2>布局与数据</h2><label>结果区域位置<select data-pref="resultDock"><option value="bottom" ${state.ui.resultDock !== 'right' ? 'selected' : ''}>编辑器下方</option><option value="right" ${state.ui.resultDock === 'right' ? 'selected' : ''}>编辑器右侧</option></select></label><button class="btn" data-reset-layout>恢复默认布局</button><button class="btn" data-clear-history>清空本插件查询历史</button><p class="muted">查询包含的文本会保存在本机。不要在查询或连接附加参数中保存明文密码。</p></section></div><section class="wb-shortcuts"><div class="wb-section-heading"><h2>快捷键</h2><button class="btn" data-reset-keys>恢复默认快捷键</button></div><p class="muted">点击快捷键字段后直接按组合键。Mod 在 macOS 为 Command，在 Windows/Linux 为 Ctrl。</p>${this.registry.list().map((command) => `<label><span>${esc(command.label)}</span><input readonly aria-label="${esc(command.label)}快捷键" data-key="${command.id}" value="${esc(this.registry.shortcut(command.id))}"></label>`).join('')}<p class="wb-form-error" role="status"></p></section></div>`
    this.pageRoot.querySelector('[data-back]').onclick = () => this.navigate('query')
    this.pageRoot.querySelectorAll('[data-pref]').forEach((input) => input.onchange = () => {
      const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) || Number(input.min))) : input.value
      setUiPref(input.dataset.pref, value); this.ctx.editor().fontSize = state.ui.editorFontSize || 13; this.root.dataset.resultDock = state.ui.resultDock || 'bottom'; this.ctx.editor().instance?.updateOptions({ fontSize: state.ui.editorFontSize || 13 })
    })
    this.pageRoot.querySelectorAll('[data-key]').forEach((input) => input.onkeydown = (event) => {
      if (event.key === 'Tab') return; event.preventDefault(); event.stopPropagation()
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return
      if (event.key === 'Escape') { input.blur(); return }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key !== 'Backspace' && !/^F\d{1,2}$/.test(event.key)) { this.pageRoot.querySelector('.wb-form-error').textContent = '请使用组合键或功能键，避免占用查询输入与导航键。'; return }
      try { this.registry.setBinding(input.dataset.key, event.key === 'Backspace' ? '' : normalizeShortcut(event)); input.value = this.registry.shortcut(input.dataset.key); setUiPref('shortcuts', { ...this.registry.bindings }); this.pageRoot.querySelector('.wb-form-error').textContent = '' } catch (error) { this.pageRoot.querySelector('.wb-form-error').textContent = error.message }
    })
    this.pageRoot.querySelector('[data-reset-keys]').onclick = () => { this.registry.bindings = {}; setUiPref('shortcuts', {}); this.renderSettings() }
    this.pageRoot.querySelector('[data-reset-layout]').onclick = () => { for (const [key, value] of Object.entries({ leftWidth: 240, rightWidth: 280, bottomHeight: 300, resultDock: 'bottom', sidebarCollapsed: false })) setUiPref(key, value); this.root.dataset.resultDock = 'bottom'; this.ctx.resetLayout(); this.ctx.message('默认布局已恢复', 'success') }
    this.pageRoot.querySelector('[data-clear-history]').onclick = async () => { try { await storageSet(StorageKeys.queryHistory, []); state.queryHistory = []; this.ctx.message('查询历史已清空', 'success') } catch (error) { this.ctx.message(error.message, 'error') } }
  }
  scheduleRefresh() {
    clearTimeout(this.refreshTimer)
    if (this.page === 'resources' && !document.hidden && state.ui.resourceAutoRefresh) this.refreshTimer = setTimeout(async () => { await this.renderResources(); this.scheduleRefresh() }, 5000)
  }
  async renderResources() {
    const ticket = this.resourceTicket = (this.resourceTicket || 0) + 1
    this.pageRoot.innerHTML = `<div class="wb-page-title"><div><p class="wb-eyebrow">OBSERVABILITY</p><h1>资源中心</h1><p class="muted">${esc(this.ctx.connection()?.name || '请先连接数据库')} · 客户端与服务器指标分别标注来源</p></div><button class="btn" data-refresh>刷新</button></div><nav class="wb-subtabs">${Object.entries(inspectTabs).map(([id, label]) => `<button data-kind="${id}" class="${this.resourceKind === id ? 'active' : ''}">${label}</button>`).join('')}</nav><div data-inspection aria-live="polite"><div class="wb-empty">读取中…</div></div>`
    this.pageRoot.querySelector('[data-refresh]').onclick = () => void this.renderResources()
    this.pageRoot.querySelectorAll('[data-kind]').forEach((button) => button.onclick = () => { this.resourceKind = button.dataset.kind; void this.renderResources() })
    try {
      const result = await DbHost.inspect({ sessionKey: this.ctx.sessionKey(), kind: this.resourceKind })
      if (this.page !== 'resources' || ticket !== this.resourceTicket) return
      this.lastInspection = result
      const target = this.pageRoot.querySelector('[data-inspection]')
      target.innerHTML = result.state === 'available' ? `<div class="wb-inspection-meta"><span>${result.source === 'enest-client' ? '本插件创建的连接' : '数据库服务器'}</span><span>采样 ${new Date(result.sampledAt).toLocaleTimeString()}</span><button class="btn" data-export-inspection>导出 JSON</button></div>${tableHtml(result.columns, result.rows)}${result.note ? `<p class="muted">${esc(result.note)}</p>` : ''}` : `<div class="wb-empty"><strong>${result.state === 'permission-denied' ? '权限不足' : '当前指标不可用'}</strong><p>${esc(result.reason || '当前驱动未提供此能力')}</p></div>`
      target.querySelector('[data-export-inspection]')?.addEventListener('click', () => void saveTextFile(`database-${this.resourceKind}.json`, JSON.stringify(result, null, 2)))
    } catch (error) { if (this.page === 'resources' && ticket === this.resourceTicket) this.pageRoot.querySelector('[data-inspection]').innerHTML = `<div class="wb-empty"><strong>无法读取资源</strong><p>${esc(error.message)}</p></div>` }
  }
  async renderStructure() {
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
    const req = { sessionKey: this.ctx.sessionKey(), database: this.ctx.session()?.database || this.ctx.connection()?.database, schema: this.ctx.session()?.schema, table }
    try {
      const detail = await DbHost.schema.describe(req); if (!target.isConnected || ticket !== this.definitionTicket) return
      if (this.ctx.connection()?.driver === 'redis') {
        const metadata = detail.metadata || {}, ttl = metadata.ttlState === 'persistent' ? '永不过期' : metadata.ttlState === 'expired' ? '键已不存在' : metadata.ttlSeconds !== undefined ? `${metadata.ttlSeconds} 秒（本次采样）` : '未返回'
        target.innerHTML = `<div class="wb-section-heading"><h2>${esc(table)}</h2><button class="btn" data-browse>读取值</button><button class="btn" data-key-refresh>刷新</button></div>${tableHtml([{ name: '属性' }, { name: '值' }], [['类型', metadata.type || '未返回'], ['TTL', ttl]])}<p class="muted">读取时按键类型选择命令。列表、集合和流使用有界范围；大型值可通过原生查询继续读取。</p>`
        target.querySelector('[data-browse]').onclick = () => this.ctx.browse({ name: table, database: req.database }); target.querySelector('[data-key-refresh]').onclick = () => void this.showDefinition(table); return
      }
      target.innerHTML = `<div class="wb-section-heading"><h2>${esc(table)}</h2><button class="btn" data-browse>打开数据</button><button class="btn" data-design>表设计</button><button class="btn" data-ddl>在编辑器打开 DDL</button></div><h3>字段</h3>${tableHtml([{ name: '名称' }, { name: '类型' }, { name: '可空' }, { name: '默认值' }, { name: '主键' }], (detail.columns || []).map((col) => [col.name, col.dataType || col.type, col.nullable === undefined ? '未知' : col.nullable ? '是' : '否', col.defaultValue ?? col.default, col.primaryKey || col.pk ? 'PK' : '']))}<h3>索引</h3>${tableHtml([{ name: '名称' }, { name: '列' }, { name: '唯一' }], (detail.indexes || []).map((index) => [index.name, index.columns, index.unique ? '是' : '否']), '当前对象没有返回索引信息')}<h3>关系图</h3><div class="wb-er"><article><strong>${esc(table)}</strong>${(detail.columns || []).map((col) => `<div>${col.primaryKey || col.pk ? 'PK · ' : ''}${esc(col.name)}<small>${esc(col.dataType || col.type)}</small></div>`).join('')}</article>${(detail.foreignKeys || []).map((fk) => `<div class="wb-er-edge"><span>${esc((fk.columns || []).join(', '))} → ${esc((fk.referencedColumns || []).join(', '))}</span><span class="wb-er-line"></span></div><article><strong>${esc(fk.referencedTable || fk.targetTable || '引用表')}</strong><p>${esc(fk.name || '外键关系')}</p></article>`).join('')}</div>${!detail.foreignKeys?.length ? '<p class="muted">没有返回外键关系；不会按字段名称推测关系。</p>' : ''}`
      if (detail.comment) { const note = document.createElement('p'); note.className = 'muted'; note.textContent = detail.comment; target.prepend(note) }
      if (detail.metadata?.tags) { const tags = document.createElement('section'); tags.innerHTML = `<h3>TDengine 标签</h3>${tableHtml([{ name: '标签' }, { name: '类型' }], detail.metadata.tags.map((tag) => [tag.name, tag.dataType]), '此对象没有标签')}`; target.prepend(tags) }
      target.querySelector('[data-browse]').onclick = () => this.ctx.browse({ name: table, database: req.database, schema: req.schema })
      const design = target.querySelector('[data-design]'); design.disabled = state.runtime.dialects.find((driver) => driver.id === this.ctx.connection()?.driver)?.capabilities?.tableDesign?.state !== 'available'; design.onclick = () => this.createTableDesigner(table, detail)
      target.querySelector('[data-ddl]').disabled = state.runtime.dialects.find((driver) => driver.id === this.ctx.connection()?.driver)?.capabilities?.ddl?.state !== 'available'
      target.querySelector('[data-ddl]').onclick = async () => { try { const result = await DbHost.schema.ddl(req); await this.ctx.newQuery(); this.ctx.editor().setValue(typeof result === 'string' ? result : result.ddl || ''); this.navigate('query') } catch (error) { this.ctx.message(error.message, 'error') } }
    } catch (error) { target.textContent = error.message }
  }
  createTableDesigner(table, detail) {
    if (this.mode === 'quick') return this.openShellAnd('structure', () => this.createTableDesigner(table, detail))
    return openTableDesigner({ sessionKey: this.ctx.sessionKey(), table: { database: this.ctx.session()?.database || this.ctx.connection()?.database, schema: this.ctx.session()?.schema, table }, detail, readOnly: this.ctx.connection()?.readOnly || this.ctx.session()?.origin === 'quick', onApplied: () => table ? this.showDefinition(table) : this.renderStructure() })
  }
  openComparison() {
    const sessions = state.connections.filter((conn) => state.runtime.sessionKeys.has(conn.id))
    const options = sessions.map((conn) => `<option value="${esc(conn.id)}">${esc(conn.name)}</option>`).join('')
    const sql = this.ctx.editor().getValue()
    const modal = createDialog({ title: '数据与结构比较 · 只读', className: 'wide wb-compare-dialog', content: `<div class="wb-compare-controls"><label>比较内容<select data-kind><option value="data">数据</option><option value="structure">结构</option></select></label><label>对齐键列<input data-keys placeholder="id 或 id,region"></label><label>每侧行数上限<input data-limit type="number" value="1000" min="1" max="10000"></label><button class="btn" data-swap>交换左右</button><button class="btn primary" data-compare ${!sessions.length ? 'disabled' : ''}>开始比较</button></div><p class="muted">${sessions.length ? '数据输入只读查询；结构输入表名。两侧分别读取，结果不是同一时刻的事务快照。' : '请先连接至少一个数据源，再进行比较。'}</p><details class="wb-compare-advanced"><summary>列映射与比较规则</summary><p class="muted">留空时按同名列比较；填写后仅比较映射的列。对齐键使用左侧列名。严格模式区分类型，文本模式按文本，数字模式按数值，JSON 模式按结构比较。</p><label>默认规则<select data-default-rule><option value="strict">严格类型</option><option value="text">文本</option><option value="numeric">数值</option><option value="json">JSON 结构</option></select></label><div data-mappings></div><button class="btn" data-add-mapping>添加列映射</button></details><div class="wb-compare-inputs">${['left', 'right'].map((side) => `<section><label>${side === 'left' ? '左侧来源' : '右侧来源'}<select data-side="${side}">${options}</select></label><textarea data-query="${side}" rows="4" spellcheck="false" aria-label="${side === 'left' ? '左' : '右'}侧查询或表名">${esc(sql)}</textarea></section>`).join('')}</div><div class="wb-compare-summary" role="status">尚未比较</div><div class="wb-compare-actions" hidden><label><input type="checkbox" data-diff-only> 仅看差异</label><button class="btn" data-prev>上一个差异</button><button class="btn" data-next>下一个差异</button><span class="spacer"></span><button class="btn" data-export>导出比较结果</button></div><div class="wb-compare-results"></div>` })
    const maximize = document.createElement('button'); maximize.className = 'btn'; maximize.textContent = '最大化'; maximize.setAttribute('aria-label', '最大化比较窗口'); modal.dialog.querySelector('[data-dialog-close]').before(maximize)
    maximize.onclick = () => { const full = modal.dialog.classList.toggle('is-maximized'); maximize.textContent = full ? '恢复' : '最大化'; maximize.setAttribute('aria-label', full ? '恢复比较窗口' : '最大化比较窗口') }
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
      try {
        const readSide = (side) => ({ sessionKey: state.runtime.sessionKeys.get(modal.body.querySelector(`[data-side=${side}]`).value), sql: modal.body.querySelector(`[data-query=${side}]`).value.trim() })
        const left = readSide('left'), right = readSide('right')
        if (!left.sql || !right.sql) throw new Error('请填写左右两侧的查询或表名')
        if (kind === 'data') {
          const keyColumns = modal.body.querySelector('[data-keys]').value.split(',').map((key) => key.trim()).filter(Boolean)
          if (!keyColumns.length) throw new Error('请选择可唯一标识数据行的对齐键列')
          if (mappings.some((mapping) => !mapping.left || !mapping.right)) throw new Error('请填写每行映射的左右列名')
          result = await DbHost.compare({ left, right, keyColumns, defaultRule: modal.body.querySelector('[data-default-rule]').value, columnMappings: mappings.map((mapping) => ({ left: mapping.left, right: mapping.right, ...(mapping.rule ? { rule: mapping.rule } : {}) })), maxRows: Math.min(10000, Math.max(1, Number(modal.body.querySelector('[data-limit]').value) || 1000)) })
        } else {
          const [l, r] = await Promise.all([DbHost.schema.describe({ sessionKey: left.sessionKey, table: left.sql }), DbHost.schema.describe({ sessionKey: right.sessionKey, table: right.sql })]); result = { left: l, right: r, rows: structureDiff(l, r), comparedAt: Date.now(), partial: false, snapshot: 'independent-query-snapshots' }
        }
        summary.textContent = `${result.coverage ? `左侧 ${result.coverage.leftRows} 行 / 右侧 ${result.coverage.rightRows} 行 · ` : ''}${result.rows.length} 个对齐键 · ${result.rows.filter((row) => row.status !== 'equal').length} 项差异${result.partial ? ' · 仅比较已读取的部分数据，不能据此判断全部相同' : ''}${result.rows.some((row) => row.status === 'ambiguous') ? ' · 存在重复键，请更换键列' : ''}`
        modal.body.querySelector('.wb-compare-actions').hidden = false; render()
      } catch (error) { summary.textContent = error.message } finally { button.disabled = false }
    }
    modal.body.querySelector('[data-diff-only]').onchange = render
    const jump = (direction) => { const rows = [...modal.body.querySelectorAll('[data-pane=left] tr[data-status]')].filter((row) => row.dataset.status !== 'equal'); if (!rows.length) return; differenceIndex = (differenceIndex + direction + rows.length) % rows.length; rows[differenceIndex].scrollIntoView({ block: 'center' }); rows.forEach((row, index) => row.classList.toggle('diff-current', index === differenceIndex)) }
    modal.body.querySelector('[data-prev]').onclick = () => jump(-1); modal.body.querySelector('[data-next]').onclick = () => jump(1)
    modal.body.querySelector('[data-export]').onclick = () => void saveTextFile(`database-${kind}-comparison.json`, JSON.stringify({ kind, ...result }, null, 2))
  }
}
