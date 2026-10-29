/**
 * store.js — 内存状态 + 800ms 防抖持久化（enest.storage KV）
 * 键：mw.connections / mw.ui（openTabs/activeTab 随 mw.ui 一并落盘，恢复上次布局）
 * 会话级数据（tail 状态、轮询开关、会话能力缓存）走 api.session，不在此落盘。
 * LIMITS：连接 ≤50、每连接历史 ≤100（内存 Map，供 B/C 页面回显最近操作）。
 */
import api from './api.js'
import { taskId, restoreTasks } from './workspace.js'
import { readProductivity, validateProductivity } from './preferences.js'

export const LIMITS = { connections: 50, historyPerConn: 100 }

const KEYS = {
  connections: 'mw.connections',
  ui: 'mw.ui'
}

const KINDS = ['kafka', 'rabbitmq', 'mqtt', 'rocketmq']

export function uid(prefix = 'mw') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/* —— 内存 state —— */

const state = {
  /** [{ id, kind, name, env, readOnly, note, secretRef?, bootstrapServers?, managementUrl?, brokerUrl?, dashboardUrl?, vhost?, username?, saslMechanism?, tls?, emqx?{...}, options? }] */
  connections: [],
  /** 已打开 Tab 的连接 id 列表（顺序即 Tab 顺序） */
  tabs: [],
  tasks: [],
  activeTask: null,
  /** 当前激活 Tab 的连接 id | null */
  activeTab: null,
  ui: {
    treeWidth: 240,
    paper: 'auto', // auto | paper | cream | dark | board（纸感手绘主题）
    collapsedGroups: [],
    lastPage: {} // { connId: pageId }
  },
  /** 每连接操作历史（内存态）：connId -> [{ ts, ...entry }] */
  histories: new Map()
}

/* —— 防抖持久化 —— */

const timers = new Map()
const dirty = new Set()
let saveErrorShown = false
let uiWrites = Promise.resolve()

// Serialize settings and layout writes. A pending layout save must not overwrite
// newly saved preferences, and a failed explicit save must leave live settings intact.
function writeUi(productivity) {
  const write = uiWrites.catch(() => {}).then(async () => {
    const value = { ...snapshotUi(), ...(productivity ? { productivity } : {}) }
    await api.storage.set(KEYS.ui, structuredClone(value))
    if (productivity) state.ui.productivity = productivity
  })
  uiWrites = write
  return write
}

function schedule(key, value, delay = 800) {
  dirty.add(key)
  clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      const write = key === KEYS.ui ? writeUi() : api.storage.set(key, value)
      write.catch((e) => {
        if (!saveErrorShown) {
          saveErrorShown = true // 持久化失败只提示一次，避免后台保存刷屏
          void api.toast(e?.message || '本地数据保存失败', 'error')
        }
      })
    }, delay)
  )
}

/** Tab 布局随 mw.ui 落盘，下次启动恢复 */
function snapshotUi() {
  state.ui.workspace = { version: 1, tabs: state.tasks.map(({ connectionId, pageId }) => ({ connectionId, pageId })), activeTask: state.activeTask }
  state.ui.openTabs = [...state.tabs]
  state.ui.activeTab = state.activeTab
  return state.ui
}

function persistConnections() {
  schedule(KEYS.connections, state.connections)
}

function persistUi(delay = 800) {
  schedule(KEYS.ui, snapshotUi(), delay)
}

/** 修改 state 后调用；fn 可选（先执行 patch(state) 再排队全部落盘） */
function patch(fn) {
  if (typeof fn === 'function') fn(state)
  persistConnections()
  persistUi()
}

function save() {
  persistConnections()
  persistUi()
}

/** 立即落盘未决变更（onBeforeClose / pagehide 调用） */
async function flush() {
  const writes = []
  for (const key of [KEYS.connections, KEYS.ui]) {
    if (!dirty.has(key)) continue
    clearTimeout(timers.get(key))
    timers.delete(key)
    const value = key === KEYS.connections ? state.connections : snapshotUi()
    dirty.delete(key)
    writes.push((key === KEYS.ui ? writeUi() : api.storage.set(key, value)).catch(() => {}))
  }
  await Promise.all(writes)
}

/* —— 连接集合操作 —— */

function getConnection(id) {
  return state.connections.find((c) => c.id === id) || null
}

/** 新建或更新连接（对象替换进 state.connections）；连接上限守卫 */
function upsertConnection(conn) {
  const idx = state.connections.findIndex((c) => c.id === conn.id)
  if (idx < 0 && state.connections.length >= LIMITS.connections) {
    throw new Error(`连接数量已达上限 ${LIMITS.connections}`)
  }
  const next = idx >= 0
    ? { ...state.connections[idx], ...conn, updatedAt: Date.now() }
    : { ...conn, createdAt: Date.now(), updatedAt: Date.now() }
  if (idx >= 0) state.connections[idx] = next
  else state.connections.push(next)
  persistConnections()
  return idx >= 0 ? state.connections[idx] : state.connections[state.connections.length - 1]
}

function removeConnection(id) {
  state.tasks = state.tasks.filter(task => task.connectionId !== id)
  if (!state.tasks.some(task => task.id === state.activeTask)) state.activeTask = state.tasks.at(-1)?.id ?? null
  state.connections = state.connections.filter((c) => c.id !== id)
  const idx = state.tabs.indexOf(id)
  if (idx >= 0) state.tabs.splice(idx, 1)
  if (state.activeTab === id) state.activeTab = state.tabs[Math.min(idx, state.tabs.length - 1)] ?? null
  state.histories.delete(id)
  delete state.ui.lastPage[id]
  save()
}

/* —— Tab 操作 —— */

/** 打开/激活某连接的 Tab；同一连接不重复开 */
function openTab(connId) {
  if (!getConnection(connId)) return false
  if (!state.tabs.includes(connId)) state.tabs.push(connId)
  state.activeTab = connId
  persistUi()
  return true
}

function closeTab(connId) {
  state.tasks = state.tasks.filter(task => task.connectionId !== connId)
  if (!state.tasks.some(task => task.id === state.activeTask)) state.activeTask = state.tasks.at(-1)?.id ?? null
  const idx = state.tabs.indexOf(connId)
  if (idx < 0) return
  state.tabs.splice(idx, 1)
  if (state.activeTab === connId) state.activeTab = state.tabs[Math.min(idx, state.tabs.length - 1)] ?? null
  persistUi()
}

function setActiveTab(connId) {
  if (!state.tabs.includes(connId)) return false
  state.activeTab = connId
  persistUi(0)
  return true
}

/** One task per full connection/page identity; drafts and result data remain in memory only. */
function openTask(connectionId, pageId = 'overview') {
  if (pageId === 'settings') connectionId = null
  else if (!getConnection(connectionId)) return null
  const id = taskId(connectionId, pageId)
  if (!state.tasks.some(task => task.id === id)) state.tasks.push({ id, connectionId, pageId })
  state.activeTask = id
  if (connectionId) { openTab(connectionId); state.ui.lastPage[connectionId] = pageId }
  else state.activeTab = null
  persistUi()
  return id
}
function closeTask(id) {
  const index = state.tasks.findIndex(task => task.id === id)
  if (index < 0) return
  state.tasks.splice(index, 1)
  if (state.activeTask === id) state.activeTask = state.tasks[Math.min(index, state.tasks.length - 1)]?.id ?? null
  state.activeTab = state.tasks.find(task => task.id === state.activeTask)?.connectionId ?? null
  state.tabs = [...new Set(state.tasks.map(task => task.connectionId).filter(Boolean))]
  persistUi()
}
function activateTask(id) {
  const task = state.tasks.find(task => task.id === id)
  if (!task) return false
  state.activeTask = id
  state.activeTab = task.connectionId
  persistUi(0)
  return true
}

/* —— ui 偏好 —— */

function setUi(key, value) {
  state.ui[key] = value
  persistUi(300)
}

async function saveProductivity(value) {
  const next = validateProductivity(value)
  clearTimeout(timers.get(KEYS.ui)); timers.delete(KEYS.ui)
  dirty.add(KEYS.ui)
  await writeUi(next)
  return next
}

/* —— 每连接历史（内存，≤100）—— */

function pushHistory(connId, entry) {
  const list = state.histories.get(connId) ?? []
  list.unshift({ ts: Date.now(), ...entry })
  if (list.length > LIMITS.historyPerConn) list.length = LIMITS.historyPerConn
  state.histories.set(connId, list)
  return list[0]
}

/* —— 启动加载 —— */

export async function load() {
  const [connections, ui] = await Promise.all([
    api.storage.get(KEYS.connections, []),
    api.storage.get(KEYS.ui, {})
  ])
  const savedUi = ui && typeof ui === 'object' && !Array.isArray(ui) ? ui : {}
  state.connections = (Array.isArray(connections) ? connections : [])
    .filter((c) => c && c.id && KINDS.includes(c.kind))
    .slice(0, LIMITS.connections)
  state.ui = {
    treeWidth: 240,
    paper: 'auto',
    collapsedGroups: [],
    lastPage: {},
    ...savedUi,
    productivity: readProductivity(savedUi.productivity),
    lastPage: { ...(savedUi.lastPage && typeof savedUi.lastPage === 'object' ? savedUi.lastPage : {}) }
  }
  // 恢复上次打开的 Tab 与激活项
  const savedTabs = Array.isArray(savedUi.openTabs)
    ? savedUi.openTabs.filter((id) => state.connections.some((c) => c.id === id))
    : []
  state.tabs = savedTabs
  state.activeTab = savedTabs.includes(savedUi.activeTab)
    ? savedUi.activeTab
    : (savedTabs[savedTabs.length - 1] ?? null)
  state.tasks = restoreTasks(savedUi, state.connections)
  state.activeTask = state.tasks.some(task => task.id === savedUi.workspace?.activeTask)
    ? savedUi.workspace.activeTask : state.tasks.find(task => task.connectionId === state.activeTab)?.id ?? state.tasks.at(-1)?.id ?? null
  state.activeTab = state.tasks.find(task => task.id === state.activeTask)?.connectionId ?? state.activeTab
  return state
}

/* —— store 单例：字段经 getter/setter 代理到 state，赋值自动排队持久化 —— */

const store = {
  LIMITS,
  KEYS,
  openTask, closeTask, activateTask,
  get tasks() { return state.tasks },
  get activeTask() { return state.activeTask },
  uid,
  save,
  flush,
  patch,
  setUi,
  saveProductivity,
  getConnection,
  upsertConnection,
  removeConnection,
  openTab,
  closeTab,
  setActiveTab,
  pushHistory,
  load,
  get connections() { return state.connections },
  set connections(v) {
    state.connections = (Array.isArray(v) ? v : []).slice(0, LIMITS.connections)
    persistConnections()
  },
  get tabs() { return state.tabs },
  set tabs(v) {
    state.tabs = Array.isArray(v) ? v : []
    if (!state.tabs.includes(state.activeTab)) state.activeTab = state.tabs[state.tabs.length - 1] ?? null
    persistUi()
  },
  get activeTab() { return state.activeTab },
  set activeTab(v) {
    state.activeTab = v
    persistUi(0)
  },
  get ui() { return state.ui },
  set ui(v) {
    state.ui = v && typeof v === 'object' ? v : {}
    persistUi()
  },
  get histories() { return state.histories }
}

export default store
