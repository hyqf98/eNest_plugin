/** Persistent connection navigator. Metadata transports never borrow a console transaction. */
import { DbHost, hostLag, toConnectionInput, toast } from './api.js'
import { state, getConnection, setUiPref, saveConnection } from './store.js'
import { openCtxMenu } from './ctxMenu.js'
import { objectPolicy, groupDatabaseObjects, listDatabaseObjects, serializeMetadata } from './databaseObjectDetails.js'

const DRIVER_LABEL = {
  mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite', duckdb: 'DuckDB', postgres: 'PostgreSQL',
  timescale: 'TimescaleDB', influxdb: 'InfluxDB', influxdb1: 'InfluxDB', influxdb3: 'InfluxDB',
  tdengine: 'TDengine', mongodb: 'MongoDB', redis: 'Redis', mssql: 'SQL Server', oracle: 'Oracle',
  clickhouse: 'ClickHouse', elasticsearch: 'Elasticsearch', opensearch: 'OpenSearch', neo4j: 'Neo4j'
}
const ENV_LABEL = { dev: '开发', staging: '预发', prod: '生产', production: '生产', test: '测试', default: '其它连接' }
const OBJECT_TYPES = new Set(['table', 'view', 'materialized_view', 'procedure', 'function', 'trigger', 'event', 'measurement', 'supertable', 'collection', 'key', 'other'])
const NODE_LABEL = { database: '数据库', schema: '模式', group: '', table: '表', view: '视图', materialized_view: '物化视图', procedure: '过程', function: '函数', trigger: '触发器', event: '事件', measurement: '时序数据', supertable: '超级表', collection: '集合', key: '键', column: '字段', other: '对象' }
const ICON = {
  connection: '<ellipse cx="10" cy="4.5" rx="6" ry="2.5"/><path d="M4 4.5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-10M4 9.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/>',
  table: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M8 8v9"/>',
  view: '<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2.5"/>',
  procedure: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="m7 7 4 3-4 3m6-6v6"/>',
  function: '<path d="M13 3c-3-1-5 1-5 4l-1 7c0 3-2 4-4 3M5 8h8m0 4 4 5m0-5-4 5"/>',
  trigger: '<path d="m11 2-7 9h5l-1 7 8-10h-5z"/>',
  event: '<circle cx="10" cy="10" r="7"/><path d="M10 5v5l3 2M5 2 2 5m13-3 3 3"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  key: '<circle cx="7" cy="7" r="4"/><path d="m10 10 7 7m-3-3 2-2m-4 0 2-2"/>',
  column: '<rect x="6" y="3" width="8" height="14" rx="1.5"/><path d="M6 8h8M6 12h8"/>',
  documents: '<path d="M6 3h6l4 4v10H6zM12 3v4h4M3 6v11a2 2 0 0 0 2 2M9 10h4M9 13h4"/>',
  console: '<path d="M3 5h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="m6 8.5 2 2-2 2M10 12.5h4"/>',
  history: '<path d="M3 7a7 7 0 1 1 0 6M3 3v4h4M10 6v4l3 2"/>',
  resources: '<path d="M3 16h14M5 12V8M10 12V3M15 12V6"/>',
  compare: '<rect x="2" y="4" width="6" height="12" rx="1.5"/><rect x="12" y="4" width="6" height="12" rx="1.5"/>',
  settings: '<path d="M3 5h14M3 10h14M3 15h14"/><circle cx="7" cy="5" r="2"/><circle cx="13" cy="10" r="2"/><circle cx="8" cy="15" r="2"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>',
  chevron: '<path d="m7 4 6 6-6 6"/>',
  edit: '<path d="m12 4 4 4M4 12l9-9 4 4-9 9-5 1z"/>',
  more: '<circle cx="4" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="16" cy="10" r=".8"/>'
}
export const svg = (name) => `<svg class="nav-icon" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ICON.table}</svg>`
const part = (value) => encodeURIComponent(String(value ?? ''))
const rootKey = (id) => `conn:${part(id)}`

export function driverMeta(driver) {
  const key = String(driver || '').toLowerCase()
  return { label: DRIVER_LABEL[key] || key || '数据库', cls: `d-${key.replace(/[^a-z0-9]/g, '')}` }
}
export function driverLabel(driver) { return driverMeta(driver).label }

export class SidePanel {
  constructor(root, handlers = {}) {
    this.root = root
    this.h = handlers
    this.tab = 'connections'
    this.collapsed = !!state.ui.sidebarCollapsed
    this.expanded = new Set()
    this.treeData = new Map()
    this.nodes = new Map()
    this.errors = new Map()
    this.requests = new Map()
    this.generations = new Map()
    this.metadataSessions = new Map()
    this.openingSessions = new Map()
    this.redisScans = new Map()
    this.connecting = new Set()
    this.initializedGroups = new Set()
    this.instanceId = Math.random().toString(36).slice(2, 10)
    this.disposed = false
    this._build()
    this._bind()
    this.render()
  }

  get surface() { return this.root.closest('[data-surface]')?.dataset.surface === 'quick' ? 'quick' : 'shell' }
  generation(id) { return this.generations.get(id) || 0 }

  _build() {
    this.root.innerHTML = `<div class="nav-shell">
      <nav class="nav-toolrail" aria-label="工作台工具">${[['console', '查询控制台'], ['history', '查询历史'], ['settings', '设置']].map(([id, label]) => `<button type="button" class="nav-toolrail-button" data-nav="${id}" aria-label="${label}">${svg(id)}</button>`).join('')}</nav>
      <div class="nav-browser">
      <div class="nav-heading"><span class="nav-title">连接</span><span class="nav-count" data-el="count"></span><span class="spacer"></span><button type="button" class="nav-icon-button" data-new aria-label="新建连接" title="新建连接">${svg('plus')}</button><button type="button" class="nav-icon-button" data-nav-more aria-label="连接面板操作" title="连接面板操作">${svg('more')}</button></div>
      <div class="nav-search-wrap">${svg('search')}<input class="nav-search" data-el="search" type="search" placeholder="搜索连接或对象" aria-label="搜索连接或已加载对象" autocomplete="off"></div>
      <div class="nav-connections" data-el="list" role="tree" aria-label="数据库连接与对象"></div>
      </div>
      <div class="nav-settings" data-el="settingsPanel" hidden>
        <div class="nav-heading"><span class="nav-title">设置</span></div>
        <div class="nav-settings-list">${[
          ['settings-appearance', '界面主题', '石墨控制室 · 冷调纸面'],
          ['settings-editor', '编辑器与查询', '行数上限 · 字号 · 自动刷新'],
          ['settings-layout', '布局与数据', '结果区位置 · 历史清理'],
          ['settings-shortcuts', '快捷键', '命令绑定 · 分组与搜索'],
          ['settings-completion', 'SQL 补全', '触发方式 · 元数据读取']
        ].map(([id, title, desc]) => `<button type="button" data-settings-jump="${id}"><strong>${title}</strong><span>${desc}</span></button>`).join('')}</div>
      </div>
    </div>`
    this.el = { list: this.root.querySelector('[data-el=list]'), search: this.root.querySelector('[data-el=search]'), count: this.root.querySelector('[data-el=count]'), settingsPanel: this.root.querySelector('[data-el=settingsPanel]') }
  }
  /** 设置页时连接面板换为设置目录（CSS 由 .app[data-page] 驱动，这里同步 aria） */
  setPage(page) {
    const settings = page === 'settings'
    this.el.settingsPanel.hidden = !settings
    this.root.querySelector('.nav-browser').hidden = settings
  }

  _bind() {
    this.railTip = document.createElement('div'); this.railTip.className = 'nav-rail-tooltip'; this.railTip.id = `nav-tip-${this.instanceId}`; this.railTip.setAttribute('role', 'tooltip'); this.railTip.hidden = true; document.body.append(this.railTip)
    const hideRailTip = () => { this.railTip.hidden = true; this.root.querySelectorAll('[aria-describedby]').forEach((button) => button.removeAttribute('aria-describedby')) }
    const showRailTip = (event) => {
      const button = event.target.closest('.nav-toolrail-button'); if (!button) return
      this.railTip.textContent = button.getAttribute('aria-label'); this.railTip.hidden = false; button.setAttribute('aria-describedby', this.railTip.id)
      const rect = button.getBoundingClientRect(); this.railTip.style.left = `${Math.min(rect.right + 9, window.innerWidth - this.railTip.offsetWidth - 6)}px`; this.railTip.style.top = `${Math.max(4, Math.min(rect.top + (rect.height - this.railTip.offsetHeight) / 2, window.innerHeight - this.railTip.offsetHeight - 4))}px`
    }
    const rail = this.root.querySelector('.nav-toolrail')
    rail.addEventListener('pointerover', showRailTip); rail.addEventListener('focusin', showRailTip)
    rail.addEventListener('pointerout', (event) => { if (!event.target.closest('.nav-toolrail-button')?.contains(event.relatedTarget)) hideRailTip() }); rail.addEventListener('focusout', hideRailTip); rail.addEventListener('click', hideRailTip)
    rail.addEventListener('keydown', (event) => { if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const buttons = [...rail.querySelectorAll('button')], current = buttons.indexOf(event.target); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus() })
    this.el.search.addEventListener('input', () => this.render())
    this.el.list.addEventListener('scroll', () => { if (!this.restoringScroll) setUiPref('treeScroll', this.el.list.scrollTop) }, { passive: true })
    this.root.addEventListener('click', (event) => { void this._onClick(event).catch((error) => toast(error.message || String(error), 'error')) })
    this.el.list.addEventListener('dblclick', (event) => {
      const button = event.target.closest('[data-object]')
      if (button) void this._openObject(button.dataset.nodeKey, 'data').catch((error) => toast(error.message || String(error), 'error'))
    })
    this.el.list.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('[data-node-key], [data-connection-id]')
      if (!row) return
      event.preventDefault()
      if (row.dataset.nodeKey) { const node = this.nodes.get(row.dataset.nodeKey); if (node) this.h.onTreeContext?.(node, getConnection(node.connectionId), event) }
      else this.h.onConnectionContext?.(row.dataset.connectionId, event)
    })
    this.el.list.addEventListener('keydown', (event) => this._onKeydown(event))
  }

  async _onClick(event) {
    const button = event.target.closest('button')
    if (!button || button.disabled) return
    const data = button.dataset
    if ('new' in data) return this.h.onSideAction?.('connections')
    if ('navMore' in data) return openCtxMenu(event, [['new', '新建连接'], ['export', '导出全部连接配置']], (action) => action === 'new' ? this.h.onSideAction?.('connections') : this.h.onExportConnections?.(state.connections))
    if (data.nav) return this.navigate(data.nav)
    if (data.settingsJump) { document.getElementById(data.settingsJump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
    if (data.expandConnection) return this.toggleNode(rootKey(data.expandConnection), getConnection(data.expandConnection))
    if (data.selectConnection) {
      this.selectedKey = rootKey(data.selectConnection)
      this.h.onSelectConnection?.(data.selectConnection)
      this.render()
      return
    }
    if (data.connect) return this._connect(data.connect)
    if (data.editConnection) return this.h.onConnectionAction?.(data.editConnection, 'edit')
    if (data.connectionMore) return this._connectionMenu(data.connectionMore, event)
    if (data.toggle) return this.toggleNode(data.toggle)
    if (data.loadNode) return this.loadNode(data.loadNode)
    if (data.scanMore) return this.loadNode(rootKey(data.scanMore), { more: true })
    if (data.openObject) return this._openObject(data.openObject, data.view || 'data')
    if (data.object !== undefined) {
      this._selectNode(data.nodeKey)
    }
  }

  async _connect(id) {
    if (this.connecting.has(id)) return
    this.connecting.add(id); this.render()
    try { await this.h.onConnectionAction?.(id, 'connect') } finally { this.connecting.delete(id); this.render() }
  }

  navigate(page) {
    this.h.onNavigate?.(page)
    if (this.collapsed) this.h.onExpandRequest?.()
  }

  setTab(tab) {
    this.tab = 'connections'
    this.h.onTabChange?.('connections')
    if (tab === 'sessions') this.navigate('documents')
    else if (tab === 'history') this.navigate('history')
    else this.render()
  }

  setCollapsed(value) {
    this.collapsed = !!value
    this.root.classList.toggle('is-collapsed', this.collapsed)
    this.root.classList.toggle('nav-collapsed', this.collapsed)
  }

  _connectionMenu(id, event) {
    const conn = getConnection(id)
    if (!conn) return
    const connected = state.runtime.sessionKeys.has(id) || [...this.metadataSessions.values()].some((entry) => entry.connectionId === id)
    openCtxMenu(event, [
      ['connect', '打开查询'], ...(connected ? [['disconnect', '断开连接']] : []), ['edit', '编辑连接'], ['test', '测试连接'], ['favorite', conn.favorite ? '取消收藏' : '收藏连接'],
      ['readonly', conn.readOnly ? '取消只读' : '设为只读'], ['refresh', '刷新对象'], ['dup', '复制连接'], ['export', '导出配置'], 'sep', ['del', '删除连接', { danger: true }]
    ], (action) => {
      if (action === 'favorite') void saveConnection({ ...conn, favorite: !conn.favorite }).then(() => this.render()).catch(() => {})
      else if (action === 'refresh') void this.refreshTree(conn)
      else void this.h.onConnectionAction?.(id, action)
    })
  }

  _syncPreferences() {
    if (this.savedExpanded !== state.ui.treeExpanded) {
      this.savedExpanded = state.ui.treeExpanded
      if (Array.isArray(this.savedExpanded)) this.expanded = new Set(this.savedExpanded.filter((key) => typeof key === 'string'))
    }
    if (!this.selectedKey && typeof state.ui.treeSelectedKey === 'string') this.selectedKey = state.ui.treeSelectedKey
    if (this.lastSurface && this.lastSurface !== this.surface) {
      this.treeData.clear(); this.nodes.clear(); this.errors.clear(); this.redisScans.clear(); this.requests.clear()
    }
    this.lastSurface = this.surface
  }

  _persistExpanded() {
    const value = [...this.expanded]
    this.savedExpanded = value
    setUiPref('treeExpanded', value)
  }

  render() {
    if (this.disposed) return
    this._syncPreferences()
    const focus = this.el.list.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null
    const scrollTop = this.el.list.scrollTop || (!this.restoredScroll ? Number(state.ui.treeScroll) || 0 : 0)
    const query = this.el.search.value.trim().toLocaleLowerCase()
    const groups = new Map()
    for (const conn of [...state.connections].sort((a, b) => Number(b.favorite) - Number(a.favorite) || (a.name || '').localeCompare(b.name || ''))) {
      const matches = `${conn.name} ${conn.host || ''} ${conn.database || ''} ${conn.driver} ${conn.fileLabel || ''}`.toLocaleLowerCase().includes(query)
      if (query && !matches && !this._subtreeMatches(rootKey(conn.id), query)) continue
      const group = conn.favorite ? 'favorite' : conn.env || 'default'
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push({ conn, matches })
    }
    this.el.count.textContent = String(state.connections.length)
    this.el.list.innerHTML = groups.size ? [...groups].map(([group, conns]) => `<section class="nav-group" role="group" aria-label="${esc(group === 'favorite' ? '收藏' : ENV_LABEL[group] || group)}"><div class="nav-group-label">${group === 'favorite' ? '收藏' : esc(ENV_LABEL[group] || group)}</div>${conns.map(({ conn, matches }) => this._renderConnection(conn, matches ? '' : query)).join('')}</section>`).join('') : `<div class="nav-empty"><strong>${query ? '没有匹配的连接或对象' : '添加第一个连接'}</strong><p>${query ? '搜索仅包含已加载的对象。' : '连接保留在这里，查询在右侧打开。'}</p>${query ? '' : '<button type="button" class="btn" data-new>新建连接</button>'}</div>`
    const items = [...this.el.list.querySelectorAll('[role=treeitem]')]
    const current = items.find((item) => item.dataset.focusKey === focus) || items.find((item) => item.getAttribute('aria-selected') === 'true') || items[0]
    for (const item of items) item.tabIndex = item === current ? 0 : -1
    if (focus) current?.focus({ preventScroll: true })
    this.restoringScroll = true
    this.el.list.scrollTop = scrollTop
    this.restoredScroll = true
    this.restoringScroll = false
    this.setCollapsed(this.collapsed)
  }

  _subtreeMatches(key, query) {
    return (this.treeData.get(key) || []).some((node) => `${node.label} ${node.detail}`.toLocaleLowerCase().includes(query) || this._subtreeMatches(node.key, query))
  }

  _renderConnection(conn, query) {
    const key = rootKey(conn.id), open = this.expanded.has(key), meta = driverMeta(conn.driver)
    const active = conn.id === state.selectedConnectionId
    const connected = state.runtime.sessionKeys.has(conn.id)
    const metadata = [...this.metadataSessions.values()].some((entry) => entry.connectionId === conn.id)
    const address = conn.host || conn.fileLabel || (['sqlite', 'duckdb'].includes(conn.driver) ? '本地文件' : conn.database || '未设置地址')
    const status = connected ? '已连接' : metadata ? '对象浏览已连接' : '未连接'
    return `<div class="nav-connection${active ? ' active' : ''}" data-connection="${esc(conn.id)}">
      <div class="nav-connection-row${active ? ' active' : ''}" data-connection-id="${esc(conn.id)}">
        <button type="button" class="nav-disclosure${open ? ' open' : ''}" data-expand-connection="${esc(conn.id)}" aria-label="${open ? '收起' : '展开'} ${esc(conn.name)}" aria-expanded="${open}">${svg('chevron')}</button>
        <button type="button" class="nav-connection-main" role="treeitem" data-select-connection="${esc(conn.id)}" data-focus-key="${esc(key)}" aria-level="1" aria-expanded="${open}" aria-selected="${active}" tabindex="-1" title="${esc(`${conn.name} · ${meta.label} · ${address} · ${status}`)}"><span class="nav-engine ${meta.cls}">${svg('connection')}</span><span class="nav-connection-copy"><span class="nav-connection-name">${esc(conn.name || conn.id)}${conn.readOnly ? '<span class="nav-readonly">只读</span>' : ''}</span><span class="nav-connection-detail">${esc(meta.label)} <span aria-hidden="true">·</span> ${esc(address)}</span></span><span class="nav-status-dot${connected ? ' online' : metadata ? ' browsing' : ''}" aria-label="${status}"></span></button>
        <span class="nav-connection-actions"><button type="button" class="nav-small-button" data-connect="${esc(conn.id)}" ${this.connecting.has(conn.id) ? 'disabled' : ''} title="打开 ${esc(conn.name)} 的查询">${this.connecting.has(conn.id) ? '连接中…' : connected ? '打开' : '连接'}</button><button type="button" class="nav-icon-button" data-edit-connection="${esc(conn.id)}" aria-label="编辑 ${esc(conn.name)}" title="编辑连接">${svg('edit')}</button><button type="button" class="nav-icon-button" data-connection-more="${esc(conn.id)}" aria-label="${esc(conn.name)} 的更多操作" title="更多操作">${svg('more')}</button></span>
      </div>${open ? `<div class="nav-connection-children" role="group">${this._renderChildren(key, conn, query, 1)}${this.redisScans.get(key)?.cursor !== '0' && this.redisScans.has(key) ? `<button type="button" class="nav-scan-more" data-scan-more="${esc(conn.id)}" ${this.requests.has(key) ? 'disabled' : ''}>继续扫描键</button>` : ''}</div>` : ''}
    </div>`
  }

  _renderChildren(key, conn, query, depth) {
    const parent = this.nodes.get(key)
    if (parent?.data.unsupportedReason) return `<div class="nav-tree-state" role="status">${esc(parent.data.unsupportedReason)}</div>`
    if (this.requests.has(key) && !this.treeData.has(key)) return '<div class="nav-tree-state loading" role="status">正在读取对象…</div>'
    if (this.errors.has(key)) return `<div class="nav-tree-state error" role="status"><span>${esc(this.errors.get(key))}</span><button type="button" class="nav-small-button" data-load-node="${esc(key)}">重试</button></div>`
    if (!this.treeData.has(key)) return `<div class="nav-tree-state"><button type="button" class="nav-small-button" data-load-node="${esc(key)}">读取对象</button><span>展开位置已恢复</span></div>`
    const nodes = this.treeData.get(key).filter((node) => !query || `${node.label} ${node.detail}`.toLocaleLowerCase().includes(query) || this._subtreeMatches(node.key, query))
    if (!nodes.length) return `<div class="nav-tree-state">${query ? '没有匹配的已加载对象' : '没有可见对象'}</div>`
    return nodes.map((node) => {
      const open = this.expanded.has(node.key), selected = this.selectedKey === node.key, object = OBJECT_TYPES.has(node.type)
      const policy = objectPolicy(node.type)
      const icon = ['database', 'schema', 'group'].includes(node.type) ? 'folder' : node.type === 'materialized_view' ? 'view' : ICON[node.type] ? node.type : 'table'
      return `<div class="nav-tree-row${selected ? ' active' : ''}" data-node-key="${esc(node.key)}" style="--nav-depth:${depth}">
        ${node.expandable ? `<button type="button" class="nav-disclosure${open ? ' open' : ''}" data-toggle="${esc(node.key)}" aria-label="${open ? '收起' : '展开'} ${esc(node.label)}" aria-expanded="${open}">${svg('chevron')}</button>` : '<span class="nav-disclosure-placeholder"></span>'}
        <button type="button" class="nav-object-main" role="treeitem" data-object="${esc(node.name)}" data-node-key="${esc(node.key)}" data-focus-key="${esc(node.key)}" data-parent-key="${esc(key)}" aria-level="${depth + 1}" ${node.expandable ? `aria-expanded="${open}"` : ''} aria-selected="${selected}" tabindex="-1" title="${esc(`${node.label}${node.detail ? ` · ${node.detail}` : ''}`)}">${svg(icon)}<span class="nav-object-label">${esc(node.label)}</span><span class="nav-object-type">${esc(NODE_LABEL[node.type] || node.detail)}</span></button>
        ${object ? `<span class="nav-object-actions">${policy.browse ? `<button type="button" class="nav-small-button" data-open-object="${esc(node.key)}" data-view="data" title="打开 ${esc(node.label)} 的数据">数据</button>` : ''}<button type="button" class="nav-small-button" data-open-object="${esc(node.key)}" data-view="structure" title="查看 ${esc(node.label)} 的${policy.special ? '定义' : '结构'}">${policy.special ? '定义' : '结构'}</button></span>` : ''}
      </div>${open && node.expandable ? `<div class="nav-tree-children" role="group">${this._renderChildren(node.key, conn, query, depth + 1)}</div>` : ''}`
    }).join('')
  }

  _onKeydown(event) {
    const item = event.target.closest('[role=treeitem]')
    if (!item || event.altKey || event.ctrlKey || event.metaKey) return
    const items = [...this.el.list.querySelectorAll('[role=treeitem]')], index = items.indexOf(item), key = item.dataset.focusKey
    let next
    if (event.key === 'ArrowDown') next = items[Math.min(index + 1, items.length - 1)]
    else if (event.key === 'ArrowUp') next = items[Math.max(0, index - 1)]
    else if (event.key === 'Home') next = items[0]
    else if (event.key === 'End') next = items.at(-1)
    else if (event.key === 'ArrowRight' && item.hasAttribute('aria-expanded')) {
      if (!this.expanded.has(key) || !this.treeData.has(key)) void this.toggleNode(key, undefined, true)
      else next = items[index + 1]
    } else if (event.key === 'ArrowLeft') {
      if (this.expanded.has(key)) void this.toggleNode(key, undefined, false)
      else next = items.find((candidate) => candidate.dataset.focusKey === item.dataset.parentKey)
    } else if (event.key === 'Enter') {
      if (item.dataset.selectConnection) void this._connect(item.dataset.selectConnection).catch((error) => toast(error.message || String(error), 'error'))
      else if (OBJECT_TYPES.has(this.nodes.get(key)?.type)) void this._openObject(key, 'data').catch((error) => toast(error.message || String(error), 'error'))
      else if (item.hasAttribute('aria-expanded')) void this.toggleNode(key)
    } else return
    event.preventDefault()
    if (next) { for (const candidate of items) candidate.tabIndex = candidate === next ? 0 : -1; next.focus(); next.scrollIntoView({ block: 'nearest' }) }
  }

  _selectNode(key) {
    this.selectedKey = key
    setUiPref('treeSelectedKey', key)
    for (const row of this.el.list.querySelectorAll('.nav-tree-row')) row.classList.toggle('active', row.dataset.nodeKey === key)
    for (const item of this.el.list.querySelectorAll('[role=treeitem]')) {
      if (item.dataset.nodeKey) item.setAttribute('aria-selected', String(item.dataset.nodeKey === key))
      item.tabIndex = item.dataset.focusKey === key ? 0 : -1
    }
  }

  async _openObject(key, view) {
    const node = this.nodes.get(key), conn = node && getConnection(node.connectionId)
    if (!node || !conn || !OBJECT_TYPES.has(node.type)) return
    if (!objectPolicy(node.type).browse) view = 'structure'
    this._selectNode(key)
    if (this.h.onOpenObject) await this.h.onOpenObject(node, conn, view)
    else if (view === 'data') await this.h.onOpenTable?.(node, conn)
  }

  _nodeFor(key) {
    if (this.nodes.has(key)) return this.nodes.get(key)
    const conn = state.connections.find((item) => rootKey(item.id) === key)
    return conn ? { key, connectionId: conn.id, type: 'root', database: conn.database, schema: conn.schema, name: '', label: conn.name, expandable: true } : null
  }

  async toggleNode(key, conn, force) {
    const open = force ?? !this.expanded.has(key)
    if (!open) { this.expanded.delete(key); this._persistExpanded(); this.render(); return }
    this.expanded.add(key); this._persistExpanded()
    if (conn) this.h.onSelectConnection?.(conn.id)
    this.render()
    if (this._nodeFor(key)?.data?.unsupportedReason) return
    if (!this.treeData.has(key) || this.errors.has(key)) await this.loadNode(key)
  }

  _scope(conn, node) {
    const database = node.database ?? conn.database, schema = node.schema ?? conn.schema
    return { database, schema, surface: this.surface, key: [conn.id, database || '', schema || '', this.surface].map(part).join('|') }
  }

  async _metadataSession(conn, node, generation, surface) {
    const scope = this._scope(conn, node)
    if (scope.surface !== surface) throw new Error('连接浏览上下文已改变')
    const existing = this.metadataSessions.get(scope.key)
    if (existing?.generation === generation) return existing.sessionKey
    const pending = this.openingSessions.get(scope.key)
    if (pending?.generation === generation) return pending.promise
    const sessionKey = `db-nav:${this.instanceId}:${scope.key}:g${generation}`
    const config = toConnectionInput(conn, { database: scope.database, readOnly: true, createIfMissing: false })
    config.options = { ...config.options, schema: scope.schema, readOnly: true, createIfMissing: false }
    const promise = (async () => {
      const result = await DbHost.open({ config, sessionKey })
      const key = result?.sessionKey || result?.key || sessionKey
      if (this.disposed || this.generation(conn.id) !== generation || this.surface !== surface) {
        await DbHost.close(key)
        throw new Error('连接浏览请求已过期')
      }
      this.metadataSessions.set(scope.key, { sessionKey: key, connectionId: conn.id, generation, surface })
      return key
    })()
    this.openingSessions.set(scope.key, { promise, generation, connectionId: conn.id })
    try { return await promise } finally { if (this.openingSessions.get(scope.key)?.promise === promise) this.openingSessions.delete(scope.key) }
  }

  async loadNode(key, { more = false } = {}) {
    if (this.disposed) return
    const node = this._nodeFor(key), conn = node && getConnection(node.connectionId)
    if (!conn) return
    if (this.requests.has(key)) return this.requests.get(key).promise
    const generation = this.generation(conn.id), surface = this.surface
    const valid = () => !this.disposed && this.generation(conn.id) === generation && this.surface === surface && !!getConnection(conn.id)
    const run = (async () => {
      try {
        const sessionKey = await this._metadataSession(conn, node, generation, surface)
        if (!valid()) return
        const result = await serializeMetadata(sessionKey, async () => {
          if (!valid()) return []
          let result
          if (node.type === 'group') {
            result = await listDatabaseObjects({ driver: conn.driver, sessionKey, database: node.database, type: node.data.groupType, surface })
          } else if (conn.driver === 'redis' && node.type === 'root' && DbHost.supportsWorkbench()) {
            const scan = await DbHost.workbench('redis.scan', { sessionKey, cursor: more ? this.redisScans.get(key)?.cursor || '0' : '0', match: '*', count: 200 })
            if (!valid()) return
            const keys = new Set(more ? this.redisScans.get(key)?.keys || [] : [])
            for (const item of scan.keys || []) keys.add(item)
            this.redisScans.set(key, { cursor: String(scan.cursor), keys })
            result = [...keys].map((name) => ({ name, type: 'key', expandable: false, database: node.database ?? conn.database }))
          } else {
            try {
              result = await DbHost.schema.tree({ sessionKey, connectionId: conn.id, database: node.database, schema: node.schema, node: { type: node.type, database: node.database, schema: node.schema, table: node.name, data: node.data } })
            } catch (error) {
              if (!valid()) return
              if (node.type === 'root') result = await DbHost.schema.tables({ sessionKey, connectionId: conn.id, database: node.database, schema: node.schema })
              else if (OBJECT_TYPES.has(node.type) && !objectPolicy(node.type).special && node.type !== 'key') {
                const columns = await DbHost.schema.columns({ sessionKey, connectionId: conn.id, database: node.database, schema: node.schema, table: node.name })
                result = (Array.isArray(columns) ? columns : columns?.columns || []).map((column) => ({ name: column.name, type: 'column', column, expandable: false }))
                if (valid()) this.h.onCatalogPatch?.(conn.id, node.name, Array.isArray(columns) ? columns : columns?.columns || [])
              } else throw error
            }
          }
          return result
        })
        if (!valid()) return
        this._storeNodes(key, normalizeTreeNodes(result, conn, node))
        this.errors.delete(key)
      } catch (error) {
        if (valid()) {
          const message = String(error.message || error)
          const disconnected = /session not found or closed|database session closed|runtime closed|service closed|reconnect/i.test(message)
          if (disconnected) for (const [scope, entry] of this.metadataSessions) { if (entry.connectionId === conn.id) this.metadataSessions.delete(scope) }
          this.errors.set(key, disconnected ? '浏览连接已断开，重试可重新连接' : hostLag(error) ? '当前宿主暂不能读取对象，请重试' : message)
        }
      } finally {
        if (this.requests.get(key)?.promise === run) this.requests.delete(key)
        if (valid()) this.render()
      }
    })()
    this.errors.delete(key)
    this.requests.set(key, { promise: run, connectionId: conn.id })
    this.render()
    return run
  }

  _storeNodes(key, nodes) {
    this.treeData.set(key, nodes)
    for (const node of nodes) {
      this.nodes.set(node.key, node)
      if (node.type === 'group' && !this.initializedGroups.has(node.key)) {
        this.initializedGroups.add(node.key)
        if (node.data.defaultExpanded) this.expanded.add(node.key)
      }
      if (node.children) this._storeNodes(node.key, node.children)
    }
  }

  async describeForResult(connection, { database, schema, table }, surface = this.surface) {
    if (!connection || !table || this.disposed) throw new Error('对象上下文已失效')
    const generation = this.generation(connection.id)
    const valid = () => !this.disposed && this.generation(connection.id) === generation && this.surface === surface && !!getConnection(connection.id)
    const sessionKey = await this._metadataSession(connection, { database, schema }, generation, surface)
    return serializeMetadata(sessionKey, async () => {
      if (!valid()) throw new Error('对象读取上下文已改变')
      const detail = await DbHost.schema.describe({ sessionKey, database, schema, table })
      if (!valid()) throw new Error('对象读取上下文已改变')
      return detail
    })
  }

  async loadTreeRoot(conn) { if (conn) return this.loadNode(rootKey(conn.id)) }
  async loadTreeChildren(conn, node) { if (node) return this.loadNode(node.key) }

  async refreshTree(conn) {
    if (!conn || this.disposed) return
    this.h.onMetadataInvalidate?.(conn.id, '手动刷新对象目录')
    await this.invalidateConnection(conn.id)
    this.expanded.add(rootKey(conn.id)); this._persistExpanded()
    await this.loadTreeRoot(conn)
  }

  async invalidateConnection(id) {
    this.generations.set(id, this.generation(id) + 1)
    const root = rootKey(id)
    for (const key of [...this.treeData.keys()]) if (key === root || key.startsWith(`${root}/`)) this.treeData.delete(key)
    for (const [key, node] of this.nodes) if (node.connectionId === id) this.nodes.delete(key)
    for (const key of [...this.errors.keys()]) if (key === root || key.startsWith(`${root}/`)) this.errors.delete(key)
    for (const [key, request] of this.requests) if (request.connectionId === id) this.requests.delete(key)
    this.redisScans.delete(root)
    const entries = [...this.metadataSessions.entries()].filter(([, entry]) => entry.connectionId === id)
    for (const [key] of entries) this.metadataSessions.delete(key)
    this.render()
    const closing = entries.map(([, entry]) => DbHost.close(entry.sessionKey))
    const opening = [...this.openingSessions.values()].filter((entry) => entry.connectionId === id).map((entry) => entry.promise.catch(() => {}))
    const results = await Promise.allSettled([...closing, ...opening])
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.railTip?.remove()
    const ids = new Set([...this.metadataSessions.values(), ...this.openingSessions.values()].map((entry) => entry.connectionId))
    await Promise.allSettled([...ids].map((id) => this.invalidateConnection(id)))
    this.treeData.clear(); this.nodes.clear(); this.requests.clear(); this.errors.clear()
  }
}

function normalizeTreeNodes(response, conn, parent) {
  let list = Array.isArray(response) ? response : response?.nodes || response?.children || response?.items || response?.tables || []
  if (!Array.isArray(list)) list = []
  if (['database', 'schema'].includes(parent.type)) list = groupDatabaseObjects(conn.driver, list, { database: parent.database, schema: parent.schema })
  return list.map((input) => {
    const type = String(input.type || input.kind || 'other').toLowerCase().replaceAll(' ', '_'), label = String(input.name || input.label || input.table || '')
    const database = input.database ?? (type === 'database' ? label : parent.database ?? conn.database)
    const schema = input.schema ?? (type === 'schema' ? label : parent.schema ?? conn.schema)
    const column = input.column || input
    const node = {
      key: `${parent.key}/${part(type)}:${part(label)}`, connectionId: conn.id, label, name: label, type, database, schema,
      detail: type === 'group' ? Array.isArray(input.children) ? `${input.children.length}` : '按需读取' : input.comment || input.detail || [column.dataType || (type === 'column' ? column.type : ''), column.primaryKey || column.pk ? 'PK' : ''].filter(Boolean).join(' · '),
      data: input, expandable: input.expandable !== false && !['column', 'error', 'key', 'notice', 'procedure', 'function', 'trigger', 'event'].includes(type)
    }
    if (Array.isArray(input.children)) node.children = normalizeTreeNodes(input.children, conn, node)
    return node
  })

}

export function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
