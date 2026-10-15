/**
 * tree.js — 左侧连接树
 * 按 KIND_META 顺序分组（kafka/rabbitmq/mqtt/rocketmq）；连接项 = 名称 + env chip + 只读🔒 + EMQX 适配◐
 * 点击 = 打开/激活 Tab；右键菜单 = 打开/编辑/复制配置/切换只读/删除（confirmDanger 两段式）
 * 底部 ⊕ 新建连接；#resizer-tree 拖宽持久化 store.ui.treeWidth
 */
import { KIND_META, kindDot, envChip, showContextMenu, confirmDanger, escapeHtml } from './components.js'
import api from './api.js'
import store from './store.js'
import { renderAll, activateWithPage, closeConnTab, forgetSessionCaps, openSettings } from './tabs.js'
import { forgetStatus } from './status.js'

const KIND_ORDER = ['kafka', 'rabbitmq', 'mqtt', 'rocketmq']

let resizeBound = false
let searchText = ''
let navigationMode = 'shell'
let drawerOpen = false

export function renderTree() {
  const root = document.getElementById('tree')
  if (!root) return
  const focused = document.activeElement?.id === 'connection-search'
  const selection = focused ? document.activeElement.selectionStart : null
  root.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'tree-head'
  const headLabel = document.createElement('span')
  headLabel.textContent = '连接'
  const headAdd = document.createElement('button')
  headAdd.type = 'button'
  headAdd.title = '新建连接'
  headAdd.textContent = '＋'
  headAdd.addEventListener('click', () => {
    import('./connections.js').then(({ openConnectionDrawer }) => openConnectionDrawer())
  })
  head.append(headLabel, headAdd)
  root.appendChild(head)
  const search = document.createElement('input')
  search.id = 'connection-search'
  search.type = 'search'
  search.className = 'connection-search'
  search.placeholder = '搜索连接、环境或类型'
  search.setAttribute('aria-label', '搜索连接')
  search.value = searchText
  search.addEventListener('input', () => { searchText = search.value; renderTree() })
  root.append(search)

  const scroll = document.createElement('div')
  scroll.className = 'tree-scroll'

  const groups = new Map(KIND_ORDER.map((k) => [k, []]))
  for (const conn of store.connections) {
    if (!groups.has(conn.kind)) groups.set(conn.kind, [])
    groups.get(conn.kind).push(conn)
  }

  for (const kind of KIND_ORDER) {
    const conns = (groups.get(kind) || []).filter(conn => `${conn.name} ${conn.env || ''} ${conn.note || ''} ${kind}`.toLowerCase().includes(searchText.trim().toLowerCase()))
    if (!conns.length) continue
    const collapsed = store.ui.collapsedGroups?.includes(kind)
    const group = document.createElement('div')
    group.className = 'tree-group'

    const label = document.createElement('button')
    label.type = 'button'
    label.setAttribute('aria-expanded', String(!collapsed))
    label.className = 'g-label'
    label.style.cursor = 'pointer'
    label.title = collapsed ? '展开分组' : '折叠分组'
    label.innerHTML = `${kindDot(kind)}<span>${escapeHtml(KIND_META[kind]?.label ?? kind)}</span><span class="cnt">${conns.length}</span>`
    label.addEventListener('click', () => {
      const list = store.ui.collapsedGroups ?? []
      store.setUi('collapsedGroups', list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind])
      renderTree()
    })
    group.appendChild(label)

    if (!collapsed) {
      for (const conn of conns) {
        group.appendChild(renderTreeItem(conn))
      }
    }
    scroll.appendChild(group)
  }

  if (!store.connections.length) {
    const empty = document.createElement('div')
    empty.className = 'tree-group'
    empty.innerHTML = '<div class="g-label" style="padding-left:8px">尚无连接，点击 ＋ 创建</div>'
    scroll.appendChild(empty)
  }
  if (store.connections.length && !scroll.childElementCount) scroll.textContent = '没有匹配的连接'
  root.appendChild(scroll)

  const foot = document.createElement('div')
  foot.className = 'tree-foot'
  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'new-btn'
  newBtn.textContent = '＋ 新建连接'
  newBtn.addEventListener('click', () => {
    import('./connections.js').then(({ openConnectionDrawer }) => openConnectionDrawer())
  })
  foot.appendChild(newBtn)
  const settings = document.createElement('button')
  settings.className = 'new-btn'; settings.textContent = '⚙ 设置'; settings.dataset.openSettings = ''
  settings.onclick = () => { closeNavigation(); openSettings() }
  foot.append(settings)
  root.appendChild(foot)

  bindTreeResize()
  if (focused) { search.focus(); search.setSelectionRange(selection, selection) }
}

function renderTreeItem(conn) {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'tree-item' + (store.activeTab === conn.id ? ' on' : '')
  item.dataset.connection = conn.id
  item.setAttribute('aria-current', store.activeTab === conn.id ? 'true' : 'false')
  item.title = conn.note ? `${conn.name || conn.id} · ${conn.note}` : (conn.name || conn.id)

  const name = document.createElement('span')
  name.className = 'tname'
  name.textContent = conn.name || conn.id
  item.appendChild(elHtml(kindDot(conn.kind)))
  item.appendChild(name)
  item.insertAdjacentHTML('beforeend', envChip(conn.env))

  if (conn.readOnly) {
    const lock = document.createElement('span')
    lock.className = 'lock'
    lock.textContent = '🔒'
    lock.title = '只读'
    item.appendChild(lock)
  }
  // MQTT 未启用 EMQX 适配 → 能力受限标记
  if (conn.kind === 'mqtt' && !(conn.emqx && conn.emqx.enabled)) {
    const half = document.createElement('span')
    half.className = 'lock'
    half.textContent = '◐'
    half.title = 'EMQX 适配未启用，管理能力受限'
    item.appendChild(half)
  }

  item.addEventListener('click', () => {
    activateWithPage(conn.id)
    if (isCompact()) closeNavigation()
  })
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showConnectionMenu(conn, e.clientX, e.clientY)
  })
  return item
}

function elHtml(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstChild
}

export function showConnectionMenu(conn, x, y) {
  showContextMenu(x, y, [
    { label: '打开', icon: '↗', onClick: () => activateWithPage(conn.id) },
    { label: '编辑…', icon: '✎', onClick: () => import('./connections.js').then(({ openConnectionDrawer }) => openConnectionDrawer(conn)) },
    { label: '复制配置', icon: '⧉', onClick: () => duplicateConnection(conn) },
    { label: conn.readOnly ? '取消只读' : '切换只读', icon: '🔒', onClick: () => toggleReadOnly(conn) },
    'hr',
    { label: '删除…', icon: '🗑', danger: true, onClick: () => removeConnectionFlow(conn) }
  ])
}

async function duplicateConnection(conn) {
  try {
    const copy = {
      ...structuredClone(conn),
      id: store.uid('mwc'),
      name: `${conn.name || '连接'}-副本`,
      createdAt: undefined,
      updatedAt: undefined
    }
    copy.secretRef = undefined // 凭据不复制，需重新输入密码
    delete copy.secretRef
    store.upsertConnection(copy)
    renderTree()
    renderAll()
    void api.toast('已复制连接配置（凭据需重新填写）', 'success')
  } catch (e) {
    void api.toast(e?.message || '复制失败', 'error')
  }
}

async function toggleReadOnly(conn) {
  const fresh = store.getConnection(conn.id)
  if (!fresh) return
  try {
    forgetSessionCaps(conn.id)
    store.upsertConnection({ ...fresh, readOnly: !fresh.readOnly })
    renderTree()
    renderAll()
    void api.toast(fresh.readOnly ? '已取消只读' : '已设为只读', 'success')
  } catch (e) {
    void api.toast(e?.message || '操作失败', 'error')
  }
}

async function removeConnectionFlow(conn) {
  const name = conn.name || conn.id
  const ok = await confirmDanger({
    title: '删除连接',
    message: `将删除连接「${name}」的配置与已存凭据（vault），不会影响中间件实例数据。`,
    requireText: name,
    confirmLabel: '删除连接'
  })
  if (!ok) return
  // 关会话（若开着）
  try {
    await api.closeConnection(api.sessionKeyOf(conn.id))
  } catch { /* 会话可能不存在 */ }
  // 删凭据
  if (conn.secretRef) {
    try {
      await api.vault.remove(conn.secretRef)
    } catch { /* host lag 不阻断本地删除 */ }
  }
  if (conn.kind === 'mqtt' && conn.emqx?.apiSecretRef && conn.emqx.apiSecretRef !== conn.secretRef) {
    try {
      await api.vault.remove(conn.emqx.apiSecretRef)
    } catch { /* ignore */ }
  }
  if (store.tabs.includes(conn.id)) closeConnTab(conn.id)
  await api.forgetConnection(conn.id).catch(() => {})
  forgetStatus(conn.id)
  store.removeConnection(conn.id)
  renderTree()
  renderAll()
  void api.toast(`已删除连接「${name}」`, 'success')
}

/** Pointer capture keeps the splitter under the pointer; Escape restores its start width. */
function bindTreeResize() {
  if (resizeBound) return
  const handle = document.getElementById('resizer-tree')
  const tree = document.getElementById('tree')
  if (!handle || !tree) return
  resizeBound = true
  let drag = null
  const apply = width => {
    const value = Math.min(360, Math.max(220, Math.round(width)))
    tree.style.width = `${value}px`
    handle.setAttribute('aria-valuenow', String(value))
    return value
  }
  handle.setAttribute('aria-valuemin', '220')
  handle.setAttribute('aria-valuemax', '360')
  handle.addEventListener('pointerdown', event => {
    if (isCompact() || event.button !== 0) return
    drag = { x: event.clientX, width: tree.getBoundingClientRect().width, id: event.pointerId }
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('active')
    event.preventDefault()
  })
  handle.addEventListener('pointermove', event => { if (drag) apply(drag.width + event.clientX - drag.x) })
  const end = cancelled => {
    if (!drag) return
    const current = drag
    drag = null
    if (cancelled) apply(current.width)
    else store.setUi('treeWidth', tree.getBoundingClientRect().width)
    handle.classList.remove('active')
    if (handle.hasPointerCapture(current.id)) handle.releasePointerCapture(current.id)
  }
  handle.addEventListener('pointerup', () => end(false))
  handle.addEventListener('pointercancel', () => end(true))
  handle.addEventListener('lostpointercapture', () => end(true))
  document.addEventListener('keydown', event => { if (drag && event.key === 'Escape') { event.preventDefault(); end(true) } })
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const width = event.key === 'Home' ? 220 : event.key === 'End' ? 360 : tree.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 10 : -10)
    store.setUi('treeWidth', apply(width))
  })
}
function isCompact() { return navigationMode === 'quick' || window.innerWidth < 720 }
function updateNavigation() {
  const compact = isCompact()
  const hidden = compact ? !drawerOpen : !!store.ui.navigationCollapsed
  document.getElementById('app').classList.toggle('navigation-compact', compact)
  document.getElementById('app').classList.toggle('navigation-hidden', hidden)
  document.getElementById('app').classList.toggle('navigation-open', compact && !hidden)
  const tree = document.getElementById('tree')
  tree.inert = hidden
  tree.setAttribute('aria-hidden', String(hidden))
  document.getElementById('nav-toggle').setAttribute('aria-expanded', String(!hidden))
  document.getElementById('nav-scrim').hidden = !compact || hidden
}
export function closeNavigation() {
  if (!drawerOpen) return false
  drawerOpen = false
  updateNavigation()
  document.getElementById('nav-toggle').focus()
  return true
}
export function initializeNavigation(mode) {
  navigationMode = mode
  document.getElementById('nav-toggle').addEventListener('click', () => {
    if (isCompact()) drawerOpen = !drawerOpen
    else store.setUi('navigationCollapsed', !store.ui.navigationCollapsed)
    updateNavigation()
    if (drawerOpen) document.getElementById('connection-search')?.focus()
  })
  document.getElementById('nav-scrim').addEventListener('click', closeNavigation)
  document.addEventListener('mw-navigation-changed', () => { renderTree(); updateNavigation() })
  window.addEventListener('resize', updateNavigation)
  document.getElementById('open-shell').addEventListener('click', () => api.openInShell())
  updateNavigation()
}
export function applyTreeWidth(mode) {
  navigationMode = mode
  const tree = document.getElementById('tree')
  if (!tree) return
  tree.style.width = `${Math.max(220, Math.min(360, Number(store.ui.treeWidth) || 240))}px`
  document.getElementById('open-shell').hidden = mode !== 'quick'
  updateNavigation()
}
