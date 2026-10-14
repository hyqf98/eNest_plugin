/**
 * tree.js — 左侧连接树
 * 按 KIND_META 顺序分组（kafka/rabbitmq/mqtt/rocketmq）；连接项 = 名称 + env chip + 只读🔒 + EMQX 适配◐
 * 点击 = 打开/激活 Tab；右键菜单 = 打开/编辑/复制配置/切换只读/删除（confirmDanger 两段式）
 * 底部 ⊕ 新建连接；#resizer-tree 拖宽持久化 store.ui.treeWidth
 */
import { KIND_META, kindDot, envChip, showContextMenu, confirmDanger, escapeHtml } from './components.js'
import { bindDockResize } from '@enest/plugin-kit/workbench'
import api from './api.js'
import store from './store.js'
import { renderAll, activateWithPage, closeConnTab } from './tabs.js'
import { forgetStatus } from './status.js'

const KIND_ORDER = ['kafka', 'rabbitmq', 'mqtt', 'rocketmq']

let resizeBound = false

export function renderTree() {
  const root = document.getElementById('tree')
  if (!root) return
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

  const scroll = document.createElement('div')
  scroll.className = 'tree-scroll'

  const groups = new Map(KIND_ORDER.map((k) => [k, []]))
  for (const conn of store.connections) {
    if (!groups.has(conn.kind)) groups.set(conn.kind, [])
    groups.get(conn.kind).push(conn)
  }

  for (const kind of KIND_ORDER) {
    const conns = groups.get(kind) || []
    const collapsed = store.ui.collapsedGroups?.includes(kind)
    const group = document.createElement('div')
    group.className = 'tree-group'

    const label = document.createElement('div')
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
    empty.innerHTML = '<div class="g-label" style="padding-left:8px">暂无连接 · 左下角新建</div>'
    scroll.appendChild(empty)
  }
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
  root.appendChild(foot)

  bindTreeResize()
}

function renderTreeItem(conn) {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'tree-item' + (store.activeTab === conn.id ? ' on' : '')
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
    if (store.openTab(conn.id)) renderAll()
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

/** 树宽拖拽（#resizer-tree）持久化 store.ui.treeWidth；quick 模式固定窄树不拖 */
function bindTreeResize() {
  if (resizeBound) return
  const handle = document.getElementById('resizer-tree')
  const tree = document.getElementById('tree')
  if (!handle || !tree) return
  resizeBound = true
  bindDockResize(handle, tree, {
    min: 176,
    max: 420,
    onChange: (width) => store.setUi('treeWidth', Math.round(width))
  })
}

/** 启动时应用持久化宽度（quick 模式交给 CSS 覆盖，不写 inline width） */
export function applyTreeWidth(mode) {
  const tree = document.getElementById('tree')
  if (!tree) return
  if (mode === 'quick') {
    tree.style.width = ''
    return
  }
  const w = Number(store.ui.treeWidth)
  if (Number.isFinite(w) && w >= 176 && w <= 420) tree.style.width = `${w}px`
}
