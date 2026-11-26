/**
 * panel.mjs — AI 助手悬浮框控制器（命令式壳，dbai- 前缀）
 * 悬浮球：右下 40px（避开状态栏 12px），DSH 蓝配色 + sparkle icon，运行中呼吸灯；
 *   点击展开/收起，拖动 >6px 阈值区分点击；位置记入 prefs。
 * 面板：默认右侧全高、左侧两角 16px 圆角；整个头部为拖动抓手（grip），
 *   拖动 position:fixed 跟随 + 视口 8px clamp；双击 grip 复位默认位置。
 * 头部：标题行内编辑 / 最近会话下拉 / 模型 chip（下拉+配置…）/ 连接 chip / 收起‹。
 * 消息区（dbai-body）：React 渲染层 PanelBody（A2UI surfaces + markdown + 工具轮次），
 *   经 mountPanelBody 挂载；A2UI 线报真源是 host.ledger（a2ui/session.mjs）。
 * agent ui 契约改为 live 状态推送：beginTurn/pushText/endStream/beginTurnEntries/
 *   syncTurnEntry/finishTurn/applyA2ui/confirm/notice/openInEditor/done。
 * 响应式：宽 min(400px, calc(100vw-24px))；<480px 窄窗全宽贴顶；ResizeObserver 守护。
 * Pointer Events + setPointerCapture，流式打字不因拖动中断（拖动只改 transform/left/top）。
 */

import { state, setUiPref, getConnection } from '../store.js'
import { createAgent, setBoundConnection, getBoundConnection } from './agent.mjs'
import { summarizeArgs } from './confirm.mjs'
import { mountPanelBody } from './a2ui/PanelBody.jsx'
import { askText } from './a2ui/PromptDialog.jsx'
import { createA2uiHost } from './a2ui/session.mjs'
import { refreshCharts, watchThemeChanges, resizeChart } from './a2ui/charts.mjs'
import { registerAiPanel } from './registry.mjs'
import {
  loadSessions, sessionIndex, getSession, createSession, deleteSession,
  renameSession, persistSession, relativeTime, summaryOf, flushSessions
} from './sessions.mjs'
import { listProviders, defaultProvider, normalizeBaseUrl } from './models.mjs'

const FAB_SIZE = 40
const EDGE = 8
const DRAG_THRESHOLD = 6
const DEFAULT_FAB = { right: 40, bottom: 12 + 4 }
const DEFAULT_PANEL = { right: 12, top: 76 }

let panelInstance = null

export function getAiPanel() {
  return panelInstance
}

export async function initAiPanel() {
  if (panelInstance) return panelInstance
  await loadSessions()
  panelInstance = createAiPanel()
  panelInstance.mount()
  registerAiPanel(panelInstance)
  return panelInstance
}

/* ── 通用拖动（Pointer Events）── */

/**
 * 绑定拖动：handle 为抓手，target 为移动元素。
 * onMove({ x, y, dx, dy }) 由调用方落位（写 left/top）；moved 回调返回是否超过点击阈值。
 */
function bindDrag(handle, { onMove, onDragStart, onDragEnd, onClick, onDoubleClick }) {
  let active = false
  let startX = 0
  let startY = 0
  let moved = false
  let lastClickAt = 0

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    if (event.target.closest('button, input, select, textarea, a, [contenteditable]')) return
    active = true
    moved = false
    startX = event.clientX
    startY = event.clientY
    handle.setPointerCapture(event.pointerId)
    onDragStart?.()
  })
  handle.addEventListener('pointermove', (event) => {
    if (!active) return
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true
    if (moved) onMove({ dx, dy, x: event.clientX, y: event.clientY })
  })
  const end = (event) => {
    if (!active) return
    active = false
    try { handle.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
    onDragEnd?.(moved)
    if (!moved) {
      const now = Date.now()
      if (now - lastClickAt < 350) onDoubleClick?.()
      else onClick?.()
      lastClickAt = now
    }
  }
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

/** 数值 clamp */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/* ── 面板主体 ── */

function createAiPanel() {
  const root = document.body
  const narrow = () => window.innerWidth < 480

  let session = null
  let agent = null

  /* A2UI host（线报真源）+ React 视图 + live 状态 */
  const host = createA2uiHost({
    onAction: (action) => {
      // 运行中：序列化为工具上下文回喂（agent 循环消费）；空闲：作为新输入续跑
      if (agent?.isRunning()) {
        agent.pushAction?.(action)
      } else if (session) {
        const label = action?.userMessage || `用户点击了「${action?.name}」`
        void agent.run(session, `[界面交互] ${label}（${safeJson(action?.context || {})}）`)
      }
    }
  })
  const live = { phase: 'idle', text: '', turnEntries: null, surfaces: [], revision: 0 }
  let bodyView = null

  function bump() { live.revision += 1 }

  function safeJson(value) {
    try { return JSON.stringify(value) } catch { return '{}' }
  }

  function syncBody() {
    bodyView?.update({
      host, session,
      live: { ...live, surfaces: [...live.surfaces], turnEntries: live.turnEntries ? [...live.turnEntries] : null },
      connection: connSnapshot(),
      revision: live.revision,
      messagesRevision: live.revision + (session?.messages?.length || 0)
    })
  }

  function connSnapshot() {
    const conn = getBoundConnection()
    return conn ? { ...conn } : null
  }

  /* 悬浮球 */
  const fab = el('button', 'dbai-fab')
  fab.type = 'button'
  fab.title = 'AI 助手'
  fab.setAttribute('aria-label', 'AI 助手')
  fab.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM18.5 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3z" fill="currentColor"/></svg>`

  /* 面板 */
  const panel = el('aside', 'dbai-panel')
  panel.setAttribute('role', 'complementary')
  panel.setAttribute('aria-label', 'AI 数据库助手')

  const header = el('header', 'dbai-header')
  const grip = el('div', 'dbai-grip')
  grip.title = '拖动移动 · 双击复位'
  const headRow = el('div', 'dbai-head-row')

  const titleBtn = el('button', 'dbai-title')
  titleBtn.type = 'button'
  titleBtn.title = '点击重命名会话'

  const sessionsBtn = el('button', 'dbai-sessions-btn')
  sessionsBtn.type = 'button'
  sessionsBtn.title = '最近会话'

  const modelBtn = el('button', 'dbai-model-chip')
  modelBtn.type = 'button'
  modelBtn.title = '模型'

  const connBtn = el('button', 'dbai-conn-chip')
  connBtn.type = 'button'
  connBtn.title = '当前绑定连接（随工作台活动连接切换）'

  const collapseBtn = el('button', 'dbai-collapse')
  collapseBtn.type = 'button'
  collapseBtn.title = '收起'
  collapseBtn.textContent = '‹'

  headRow.append(titleBtn, sessionsBtn, modelBtn, connBtn, collapseBtn)
  grip.append(headRow)
  header.append(grip)

  const body = el('div', 'dbai-body')

  const composer = el('div', 'dbai-composer')
  const input = el('textarea', 'dbai-input')
  input.rows = 1
  input.placeholder = '问点什么，例如：这个库有哪些表？'
  input.setAttribute('aria-label', 'AI 助手输入')
  const stopBtn = el('button', 'dbai-stop')
  stopBtn.type = 'button'
  stopBtn.textContent = '停止'
  stopBtn.title = '停止生成'
  stopBtn.hidden = true
  const sendBtn = el('button', 'dbai-send')
  sendBtn.type = 'button'
  sendBtn.textContent = '发送'
  composer.append(input, stopBtn, sendBtn)

  panel.append(header, body, composer)

  /* 下拉浮层（最近会话 / 模型） */
  let dropdown = null
  function closeDropdown() {
    dropdown?.remove()
    dropdown = null
  }
  function openDropdown(anchor, contentEl) {
    closeDropdown()
    dropdown = el('div', 'dbai-dropdown')
    dropdown.append(contentEl)
    document.body.append(dropdown)
    const rect = anchor.getBoundingClientRect()
    const width = Math.max(240, rect.width)
    dropdown.style.width = `${width}px`
    const left = clamp(rect.left, EDGE, window.innerWidth - width - EDGE)
    const top = rect.bottom + 6 + dropdown.offsetHeight <= window.innerHeight - EDGE ? rect.bottom + 6 : rect.top - dropdown.offsetHeight - 6
    dropdown.style.left = `${left}px`
    dropdown.style.top = `${clamp(top, EDGE, window.innerHeight - dropdown.offsetHeight - EDGE)}px`
    setTimeout(() => {
      const onDoc = (event) => {
        if (!dropdown?.contains(event.target) && event.target !== anchor && !anchor.contains(event.target)) {
          closeDropdown()
          document.removeEventListener('pointerdown', onDoc, true)
        }
      }
      document.addEventListener('pointerdown', onDoc, true)
    }, 0)
  }

  /* ── 渲染头部 ── */

  function renderHeader() {
    titleBtn.textContent = session?.title || '新会话'
    // 模型 chip
    void listProviders().then((providers) => {
      const provider = defaultProvider(providers)
      modelBtn.textContent = provider ? `${provider.name}/${provider.model}` : '配置模型'
      modelBtn.classList.toggle('empty', !provider)
    })
    // 连接 chip：跟随工作台当前活动连接
    syncConnection()
  }

  let unboundConnection = null
  function syncConnection() {
    const conn = getBoundConnection()
    if (conn) connBtn.textContent = conn.name || conn.driver
    else connBtn.textContent = '未绑定连接'
    connBtn.classList.toggle('empty', !conn)
  }
  /** main.js 每 2s / 连接切换时调用：把工作台活动连接绑定为 AI 上下文 */
  function bindWorkbenchConnection() {
    const active = state.sessions.find((item) => item.id === state.activeSessionId) || null
    const conn = active ? getConnection(active.connectionId) : getConnection(state.selectedConnectionId)
    const nextId = conn?.id || null
    if (nextId !== unboundConnection) {
      unboundConnection = nextId
      setBoundConnection(nextId)
      syncConnection()
      syncBody() // 空态引导随连接变化
    }
  }

  /* ── 会话列表 ── */

  function renderSessionsDropdown() {
    const box = el('div', 'dbai-sessions-list')
    void (async () => {
      const index = sessionIndex()
      const items = await Promise.all(index.slice(0, 12).map(async (item) => ({ item, data: await getSession(item.id) })))
      box.innerHTML = ''
      if (!items.length) box.append(el('p', 'dbai-dropdown-empty', '还没有会话'))
      for (const { item, data } of items) {
        const row = el('button', 'dbai-session-item' + (session?.id === item.id ? ' active' : ''))
        row.type = 'button'
        row.innerHTML = `<strong>${esc(item.title)}</strong><small>${esc(relativeTime(item.updatedAt))}${data ? ` · ${esc(summaryOf(data))}` : ''}</small>`
        row.onclick = () => { closeDropdown(); void switchSession(item.id) }
        const del = el('span', 'dbai-session-del')
        del.textContent = '×'
        del.title = '删除会话'
        del.onclick = async (event) => {
          event.stopPropagation()
          await deleteSession(item.id)
          if (session?.id === item.id) void switchSession(null)
          else renderSessionsDropdown()
        }
        row.append(del)
        box.append(row)
      }
      const create = el('button', 'dbai-session-new')
      create.type = 'button'
      create.textContent = '＋ 新建会话'
      create.onclick = () => { closeDropdown(); void switchSession(null) }
      box.append(create)
    })()
    return box
  }

  /* ── 模型下拉 ── */

  function renderModelDropdown() {
    const box = el('div', 'dbai-model-list')
    void listProviders().then((providers) => {
      box.innerHTML = ''
      if (!providers.length) box.append(el('p', 'dbai-dropdown-empty', '尚未配置供应商'))
      for (const provider of providers) {
        const row = el('button', 'dbai-model-item' + (provider.isDefault ? ' active' : ''))
        row.type = 'button'
        row.innerHTML = `<strong>${esc(provider.name)}</strong><small>${esc(provider.model)} · ${esc(normalizeBaseUrl(provider.baseUrl).replace(/^https?:\/\//, ''))}</small>`
        box.append(row)
      }
      const config = el('button', 'dbai-model-config')
      config.type = 'button'
      config.textContent = '配置…'
      config.onclick = () => {
        closeDropdown()
        document.dispatchEvent(new CustomEvent('database-open-settings', { detail: { section: 'ai' } }))
      }
      box.append(config)
    })
    return box
  }

  /* ── 消息区（React 渲染层）── */

  /** 收集会话全部 A2UI 线报（按消息顺序），供 host.replay 恢复界面 */
  function collectSessionA2ui(data) {
    const out = []
    for (const message of data?.messages || []) {
      if (Array.isArray(message.a2ui)) out.push(...message.a2ui)
    }
    return out
  }

  async function switchSession(id) {
    if (agent?.isRunning()) return
    if (!id) session = await createSession()
    else {
      session = await getSession(id)
      if (!session) session = await createSession()
    }
    host.replay(collectSessionA2ui(session))
    live.phase = 'idle'
    live.text = ''
    live.turnEntries = null
    live.surfaces = []
    bump()
    syncBody()
    renderHeader()
    persistSession(session.id)
  }

  /* ── agent ui 契约（live 状态推送）── */

  function openInEditor(sql) {
    document.dispatchEvent(new CustomEvent('database-ai-open-sql', { detail: { sql: String(sql || '') } }))
    collapse()
  }

  const agentUi = {
    beginTurn() {
      live.phase = 'streaming'
      live.text = ''
      live.turnEntries = null
      live.surfaces = []
      bump()
      syncBody()
    },
    pushText(delta) {
      live.text += delta
      syncBody()
    },
    endStream() {
      live.phase = 'idle'
      bump()
      syncBody()
    },
    beginTurnEntries(entries) {
      live.turnEntries = entries
      bump()
      syncBody()
    },
    syncTurnEntry() {
      bump()
      syncBody()
    },
    finishTurn() {
      live.turnEntries = null
      live.surfaces = []
      bump()
      syncBody()
    },
    /** A2UI 线报落地（agent 解析产出 / 确认卡结算）；返回本轮新建 surfaceId 列表 */
    applyA2ui(messages) {
      if (!Array.isArray(messages) || !messages.length) return []
      const before = new Set(host.processor.getSurfaces().keys())
      host.apply(messages)
      const created = [...host.processor.getSurfaces().keys()].filter((sid) => !before.has(sid))
      live.surfaces.push(...created)
      bump()
      syncBody()
      return created
    },
    /** agent 侧 A2UI 请求处理器（绑定本 host 的渲染器能力；每 run 新建保持会话级状态） */
    a2uiProcessor() {
      try { return host.createRequestState() } catch { return null }
    },
    /** 工具结果注入本轮全部 live surfaces 的 dataModel /toolResults/<i> */
    injectToolResult(toolIndex, structured) {
      const targets = [...new Set(live.surfaces)]
      for (const surfaceId of targets) host.injectToolResult(surfaceId, toolIndex, structured)
    },
    /** 取走累积线报（持久化进 message.a2ui 后清账） */
    takeA2ui() {
      const out = host.ledger.splice(0, host.ledger.length)
      return out
    },
    confirm({ callId, name, args, onOpenInEditor: openSql }) {
      const card = host.createConfirmSurface({ callId, name, args, onOpenInEditor: openSql || openInEditor })
      live.surfaces.push(card.surfaceId)
      bump()
      syncBody()
      return card.promise
    },
    notice: (message) => {
      live.notice = String(message || '')
      bump()
      syncBody()
      setTimeout(() => { live.notice = ''; syncBody() }, 6000)
    },
    openInEditor,
    done: () => {
      setRunning(false)
      renderHeader()
    }
  }

  function setRunning(running) {
    fab.classList.toggle('running', running)
    sendBtn.hidden = running
    stopBtn.hidden = !running
  }

  async function submit(text) {
    const value = String(text ?? input.value).trim()
    if (!value || agent?.isRunning()) return
    input.value = ''
    autoSize()
    if (!session) session = await createSession()
    live.notice = ''
    bump()
    syncBody()
    setRunning(true)
    void agent.run(session, value)
  }

  function autoSize() {
    input.style.height = 'auto'
    input.style.height = `${clamp(input.scrollHeight, 32, 140)}px`
  }

  /* ── 展开 / 收起 ── */

  let collapsed = true
  function applyCollapsed() {
    collapsed = state.ui.aiPanelCollapsed !== false
    fab.hidden = false
    panel.hidden = collapsed
    if (!collapsed) {
      applyPanelLayout()
      void refreshCharts()
      input.focus()
    }
  }
  function expand() {
    collapsed = false
    panel.hidden = false
    setUiPref('aiPanelCollapsed', false)
    applyPanelLayout()
    void refreshCharts()
    input.focus()
  }
  function collapse() {
    collapsed = true
    panel.hidden = true
    setUiPref('aiPanelCollapsed', true)
  }

  /* ── 布局（悬浮球 / 面板位置 + 响应式）── */

  function applyFabLayout() {
    const pos = state.ui.aiFabPos || DEFAULT_FAB
    const x = clamp(pos.x ?? (window.innerWidth - pos.right - FAB_SIZE), EDGE, window.innerWidth - FAB_SIZE - EDGE)
    const y = clamp(pos.y ?? (window.innerHeight - pos.bottom - FAB_SIZE), EDGE, window.innerHeight - FAB_SIZE - EDGE)
    fab.style.left = `${Math.round(x)}px`
    fab.style.top = `${Math.round(y)}px`
    fab.style.right = 'auto'
    fab.style.bottom = 'auto'
  }

  function applyPanelLayout() {
    panel.classList.toggle('narrow', narrow())
    if (narrow()) {
      // 窄窗全宽贴顶（位置记忆不适用）
      panel.style.left = '0px'
      panel.style.top = '0px'
      panel.style.width = '100vw'
      panel.style.height = '100vh'
      return
    }
    const pos = state.ui.aiPanelPos || DEFAULT_PANEL
    const width = Math.min(400, window.innerWidth - 24)
    panel.style.width = `${width}px`
    panel.style.height = `calc(100vh - ${pos.top}px - ${EDGE}px)`
    if (pos.x !== undefined) {
      panel.style.left = `${clamp(pos.x, EDGE, window.innerWidth - width - EDGE)}px`
      panel.style.top = `${clamp(pos.y ?? pos.top, EDGE, Math.max(EDGE, window.innerHeight - 200))}px`
    } else {
      panel.style.left = `${clamp(window.innerWidth - pos.right - width, EDGE, window.innerWidth - width - EDGE)}px`
      panel.style.top = `${pos.top}px`
    }
  }

  /* ── 拖动绑定 ── */

  function bindFabDrag() {
    bindDrag(fab, {
      onDragStart() { fab.classList.add('dragging') },
      onMove({ dx, dy }) {
        const base = fab.getBoundingClientRect()
        fab.style.left = `${clamp(base.left + dx, EDGE, window.innerWidth - FAB_SIZE - EDGE)}px`
        fab.style.top = `${clamp(base.top + dy, EDGE, window.innerHeight - FAB_SIZE - EDGE)}px`
      },
      onDragEnd(moved) {
        fab.classList.remove('dragging')
        if (moved) {
          const rect = fab.getBoundingClientRect()
          setUiPref('aiFabPos', { x: rect.left, y: rect.top })
        }
      },
      onClick() { collapsed ? expand() : collapse() }
    })
  }

  function bindPanelDrag() {
    bindDrag(grip, {
      onDragStart() {
        panel.classList.add('dragging')
        const rect = panel.getBoundingClientRect()
        if (narrow()) return
        panel.style.left = `${rect.left}px`
        panel.style.top = `${rect.top}px`
        panel.style.right = 'auto'
      },
      onMove({ dx, dy }) {
        if (narrow()) return
        const rect = panel.getBoundingClientRect()
        const width = rect.width
        panel.style.left = `${clamp(rect.left + dx, EDGE, window.innerWidth - width - EDGE)}px`
        panel.style.top = `${clamp(rect.top + dy, EDGE, window.innerHeight - 120)}px`
      },
      onDragEnd(moved) {
        panel.classList.remove('dragging')
        if (moved && !narrow()) {
          const rect = panel.getBoundingClientRect()
          setUiPref('aiPanelPos', { x: rect.left, y: rect.top })
        }
      },
      onDoubleClick() { resetPositions() }
    })
  }

  /** 双击 grip / 设置页按钮：复位球与面板默认位置 */
  function resetPositions() {
    state.ui.aiFabPos = undefined
    state.ui.aiPanelPos = undefined
    setUiPref('aiFabPos', undefined)
    setUiPref('aiPanelPos', undefined)
    applyFabLayout()
    applyPanelLayout()
  }

  /* ── 事件 ── */

  function bindEvents() {
    collapseBtn.onclick = collapse
    sessionsBtn.onclick = () => dropdown ? closeDropdown() : openDropdown(sessionsBtn, renderSessionsDropdown())
    modelBtn.onclick = () => dropdown ? closeDropdown() : openDropdown(modelBtn, renderModelDropdown())
    connBtn.onclick = () => {
      bindWorkbenchConnection()
      syncConnection()
    }
    titleBtn.onclick = async () => {
      if (!session) return
      // renameSession 原地改缓存里的 session 并返回它；空标题保留原名
      const next = await askText({ title: '重命名会话', defaultValue: session.title })
      if (next === null) return
      session = (await renameSession(session.id, next)) || session
      renderHeader()
    }
    sendBtn.onclick = () => void submit()
    stopBtn.onclick = () => agent?.stop()
    input.addEventListener('input', autoSize)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        void submit()
      }
    })
    fab.addEventListener('pointerdown', () => { applyFabLayout() }, { once: true })
  }

  /* ── ResizeObserver + 主题监听 ── */

  function bindObservers() {
    // 根元素 resize：布局重算去抖；图表 resize 只处理尺寸真实变化的容器
    // （裸循环在 echarts init/resize 自写布局时会形成 ResizeObserver 风暴，headless 下卡死主线程）
    let layoutTimer = null
    const resizeObserver = new ResizeObserver(() => {
      if (layoutTimer) return
      layoutTimer = setTimeout(() => {
        layoutTimer = null
        applyFabLayout()
        applyPanelLayout()
        // echarts resize 由组件内 ResizeObserver 负责（去抖），根观察者只管布局
      }, 120)
    })
    resizeObserver.observe(document.documentElement)
    let themeTimer = null
watchThemeChanges(() => {
  if (panel.hidden) return
  // 去抖合并：主题初始化期 data-paper 可能连续变化，立即重画会与 echarts/mermaid
  // 渲染的样式写入形成观察者正反馈风暴（headless 下直接卡死主线程）
  if (themeTimer) return
  themeTimer = setTimeout(() => { themeTimer = null; void refreshCharts(panel); bump(); syncBody() }, 180)
})
    window.addEventListener('pagehide', () => { void flushSessions().catch(() => {}) })
    // 工作台连接切换随动：低频轮询（页面隐藏时暂停，仅面板可见或球在屏时工作）
    setInterval(() => {
      if (document.hidden) return
      bindWorkbenchConnection()
    }, 2000)
  }

  return {
    fab,
    panel,
    mount() {
      root.append(fab, panel)
      bodyView = mountPanelBody(body, () => ({
        host, session,
        live: { ...live, surfaces: [...live.surfaces], turnEntries: live.turnEntries ? [...live.turnEntries] : null },
        connection: connSnapshot(),
        onSuggest: (text) => void submit(text),
        onOpenInEditor: openInEditor
      }))
      agent = createAgent(agentUi)
      applyFabLayout()
      bindFabDrag()
      bindPanelDrag()
      bindEvents()
      bindObservers()
      applyCollapsed()
      // 预览注入（浏览器直开测试）：shim 标记的会话直接切入，验证历史线报回放
      void switchSession(window.__DBAI_PREVIEW_SESSION__ || null)
      renderHeader()
    },
    expand,
    collapse,
    resetPositions,
    bindWorkbenchConnection,
    getSession: () => session,
    isCollapsed: () => collapsed
  }
}
