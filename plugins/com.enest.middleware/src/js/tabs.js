/**
 * tabs.js — 连接 Tab 条 + 子导航 + 页面路由
 * - .conn-tab：kind-dot + label + env chip + ✕；＋ 按钮开新建抽屉
 * - subnav：按当前连接 kind 过滤 PAGES（kinds 为 null 或含 kind）
 * - ctx 组装：{ api, store, conn, sessionKey, caps, queryModes, mode, switchPage, refreshStatus }
 * - 页面切换先调旧页 destroy()；同一连接重复 Tab 不重复开
 */
import { PAGES } from './pages/index.js'
import { KIND_META, kindDot, envChip } from './components.js'
import api from './api.js'
import store from './store.js'
import { refreshStatus } from './status.js'

let appMode = 'shell' // workbench.js 启动时 setMode
let currentPageId = null
let currentPageInstance = null
const pageModuleCache = new Map() // pageId -> module
const sessionCaps = new Map() // connId -> { caps, queryModes }（session.open 回填 + api.session 恢复）

const dom = () => ({
  connTabs: document.getElementById('conn-tabs'),
  subnav: document.getElementById('subnav'),
  pageHost: document.getElementById('page-host')
})

export function setMode(mode) {
  appMode = mode === 'quick' ? 'quick' : 'shell'
}

/** openConnection 成功后由 workbench.js 回填会话能力 */
export function setSessionCaps(connId, caps, queryModes) {
  sessionCaps.set(connId, { caps: caps || {}, queryModes: queryModes || null })
}

export function forgetSessionCaps(connId) {
  sessionCaps.delete(connId)
}

/** 某连接 Tab 关闭时若持有会话则关连接（异步，失败不打断 UI） */
async function tryCloseSession(connId) {
  const key = api.sessionKeyOf(connId)
  try {
    await api.closeConnection(key)
  } catch { /* 会话可能本就不存在 */ }
  forgetSessionCaps(connId)
  await api.forgetConnection(connId).catch(() => {})
}

/* ———————————————— Tab 条 ———————————————— */

function renderConnTabs() {
  const { connTabs } = dom()
  if (!connTabs) return
  connTabs.innerHTML = ''
  for (const connId of store.tabs) {
    const conn = store.getConnection(connId)
    if (!conn) continue
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'conn-tab' + (store.activeTab === connId ? ' on' : '')
    tab.dataset.kind = conn.kind
    tab.title = `${conn.name || conn.id} · ${KIND_META[conn.kind]?.label ?? conn.kind}`
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = conn.name || conn.id
    tab.appendChild(el_html(kindDot(conn.kind)))
    tab.appendChild(label)
    tab.insertAdjacentHTML('beforeend', envChip(conn.env))
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '✕'
    x.title = '关闭 Tab'
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      closeConnTab(connId)
    })
    tab.appendChild(x)
    tab.addEventListener('click', () => {
      if (store.setActiveTab(connId)) renderAll()
    })
    connTabs.appendChild(tab)
  }
  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'conn-tab plus'
  plus.title = '连接一个新实例'
  plus.textContent = '＋'
  plus.addEventListener('click', () => {
    import('./connections.js').then(({ openConnectionDrawer }) => openConnectionDrawer())
  })
  connTabs.appendChild(plus)
}

function el_html(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstChild
}

export function closeConnTab(connId) {
  store.closeTab(connId)
  void tryCloseSession(connId)
  renderAll()
}

/** 打开（或激活）某连接 Tab；重复 Tab 不重复开；激活后懒连接宿主会话并回填能力 */
export async function openConnTab(connId) {
  if (!store.openTab(connId)) return
  renderAll()
  await ensureSession(connId)
}

/** 懒连接：打开宿主会话（未开时），能力就位后重绘一次 subnav */
export async function ensureSession(connId) {
  const conn = store.getConnection(connId ?? store.activeTab)
  if (!conn) return
  if (sessionCaps.has(conn.id)) return // 已有会话能力（open 过）
  try {
    const info = await api.openConnection(conn)
    if (info && (info.capabilities || info.messageQueryModes)) {
      setSessionCaps(conn.id, info.capabilities, info.messageQueryModes)
      if (store.activeTab === conn.id) renderAll()
    }
  } catch (e) {
    if (e?.code !== 'HOST_LAG') void api.toast(e?.message || '连接失败', 'error')
  }
}

/* ———————————————— 子导航 + 页面路由 ———————————————— */

function visiblePages(kind) {
  return PAGES.filter((p) => !p.kinds || p.kinds.includes(kind))
}

function currentPageIdFor(conn) {
  const restored = store.ui.lastPage?.[conn.id]
  const visible = visiblePages(conn.kind)
  const fallback = appMode === 'quick' ? 'overview' : (visible[0]?.id ?? 'overview')
  if (restored && visible.some((p) => p.id === restored)) return restored
  return fallback
}

async function loadPageModule(pageId) {
  if (pageModuleCache.has(pageId)) return pageModuleCache.get(pageId)
  const reg = PAGES.find((p) => p.id === pageId)
  if (!reg) return null
  try {
    const mod = await reg.page()
    const resolved = mod?.default ?? mod
    pageModuleCache.set(pageId, resolved)
    return resolved
  } catch (e) {
    void api.toast(`页面加载失败：${e?.message || e}`, 'error')
    return null
  }
}

async function showPage(conn, pageId) {
  const { subnav, pageHost } = dom()
  if (!subnav || !pageHost) return

  // 先销毁旧页（停轮询/断监听）
  destroyCurrentPage()
  currentPageId = pageId

  // 子导航
  const visible = visiblePages(conn.kind)
  const caps = await getCaps(conn)
  subnav.innerHTML = ''
  for (const p of visible) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = p.title
    if (p.id === pageId) btn.classList.add('on')
    btn.addEventListener('click', () => showPage(conn, p.id))
    subnav.appendChild(btn)
  }
  const right = document.createElement('div')
  right.className = 'subnav-right'
  right.textContent = `${KIND_META[conn.kind]?.label ?? conn.kind} · 子导航按连接类型显隐`
  subnav.appendChild(right)

  // 页面容器
  pageHost.innerHTML = ''
  const pageDiv = document.createElement('div')
  pageDiv.className = 'page on'
  pageHost.appendChild(pageDiv)

  const mod = await loadPageModule(pageId)
  if (!mod || currentPageId !== pageId || store.activeTab !== conn.id) return
  const ctx = buildCtx(conn, caps)
  try {
    currentPageInstance = mod
    await mod.render(pageDiv, ctx)
  } catch (e) {
    void api.toast(`页面渲染失败：${e?.message || e}`, 'error')
  }
  refreshStatus()
}

function destroyCurrentPage() {
  if (currentPageInstance && typeof currentPageInstance.destroy === 'function') {
    try {
      currentPageInstance.destroy()
    } catch { /* 页面销毁异常不阻断切换 */ }
  }
  currentPageInstance = null
  currentPageId = null
}

/** caps：session.open 回填优先；未 open 用 kinds.list 静态描述符 */
async function getCaps(conn) {
  const cached = sessionCaps.get(conn.id)
  if (cached) return cached
  try {
    const info = await api.session.get(api.sessionInfoKey(conn.id))
    if (info?.capabilities) {
      return { caps: info.capabilities, queryModes: info.messageQueryModes || null }
    }
  } catch { /* ignore */ }
  try {
    const descriptors = await api.kinds()
    const d = descriptors.find((x) => x.kind === conn.kind)
    return { caps: d?.capabilities || {}, queryModes: d?.messageQueryModes || null }
  } catch {
    return { caps: {}, queryModes: null }
  }
}

function buildCtx(conn, { caps, queryModes }) {
  return {
    api,
    store,
    conn,
    sessionKey: api.sessionKeyOf(conn.id),
    caps: caps || {},
    queryModes: queryModes || null,
    mode: appMode,
    switchPage: (pageId) => {
      if (store.getConnection(conn.id)) void showPage(conn, pageId)
    },
    refreshStatus: () => refreshStatus()
  }
}

/* ———————————————— 总渲染 ———————————————— */

/** 全量重绘：Tab 条 + 当前内容区（连接页 / 首页）+ 状态栏 */
export function renderAll() {
  renderConnTabs()
  const conn = store.getConnection(store.activeTab)
  if (!conn) {
    // 所有 Tab 关闭 → 连接首页
    destroyCurrentPage()
    const { subnav, pageHost } = dom()
    if (subnav) subnav.innerHTML = ''
    if (pageHost) {
      pageHost.innerHTML = ''
      const pageDiv = document.createElement('div')
      pageDiv.className = 'page on'
      pageDiv.style.display = 'flex'
      pageDiv.style.flexDirection = 'column'
      pageHost.appendChild(pageDiv)
      import('./connections.js').then(({ renderHome }) => {
        if (!store.getConnection(store.activeTab)) {
          currentPageInstance = { id: 'home', destroy() {} }
          currentPageId = 'home'
          renderHome(pageDiv, { api, store, conn: null, sessionKey: '', caps: {}, queryModes: null, mode: appMode, switchPage: () => {}, refreshStatus: () => refreshStatus() })
        }
      }).catch(() => {})
    }
    refreshStatus(null)
    return
  }
  const pageId = currentPageId && visiblePages(conn.kind).some((p) => p.id === currentPageId)
    ? currentPageId
    : currentPageIdFor(conn)
  if (store.ui.lastPage[conn.id] !== pageId) {
    store.ui.lastPage[conn.id] = pageId
    store.setUi('lastPage', store.ui.lastPage) // 防抖持久化上次页面
  }
  void showPage(conn, pageId)
  refreshStatus()
}

/** 外部（workbench.js / tree 右键）触达：激活并跳到指定页 */
export function activateWithPage(connId, pageId) {
  if (!store.openTab(connId)) return
  const conn = store.getConnection(connId)
  renderConnTabs()
  if (conn && pageId) {
    void showPage(conn, pageId)
  } else {
    renderAll()
  }
}
