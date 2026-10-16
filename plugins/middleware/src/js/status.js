/**
 * status.js — 底部状态栏
 * 显示：当前连接名 / kind 色点 / 延迟（overview 拉取缓存）/ 只读标识
 * 导出 refreshStatus(conn?) 与 setLatency(ms)；tabs.js 每次切页后调用 refreshStatus。
 */
import { KIND_META, fmt } from './components.js'
import store from './store.js'

let currentMode = 'shell'

const bar = () => document.getElementById('status-bar')

/** overview 延迟缓存：connId -> ms（页面拉 overview 后调 setLatency 回写） */
const latencyByConn = new Map()

export function setMode(mode) {
  currentMode = mode === 'quick' ? 'quick' : 'shell'
}

/**
 * 刷新状态栏。
 * @param conn 可选；缺省取 store.activeTab 对应连接。传 null 表示「无连接」首页态。
 */
export function refreshStatus(conn) {
  const root = bar()
  if (!root) return
  const active = conn === null ? null : conn ?? store.getConnection(store.activeTab)
  root.innerHTML = ''
  if (!active) {
    root.appendChild(renderIdle())
    return
  }
  const meta = KIND_META[active.kind]
  const latency = latencyByConn.get(active.id)
  const quick = currentMode === 'quick'

  const dot = document.createElement('span')
  dot.className = 'dot'
  dot.style.background = meta?.color ?? 'var(--text-3)'

  const name = document.createElement('span')
  name.textContent = `${active.name || active.id} · ${meta?.label ?? active.kind}`

  root.append(dot, name)

  if (Number.isFinite(latency)) {
    const lat = document.createElement('span')
    lat.className = 'lat'
    lat.textContent = fmt.ms(latency)
    root.appendChild(lat)
  }

  const readonly = document.createElement('span')
  readonly.textContent = `只读：${active.readOnly || quick ? '开' : '关'}`
  root.appendChild(readonly)
}

function renderIdle() {
  const wrap = document.createElement('span')
  const dot = document.createElement('span')
  dot.className = 'dot warn'
  const text = document.createElement('span')
  text.textContent = currentMode === 'quick' ? '未连接' : `未连接 · 共 ${store.connections.length} 个已保存连接`
  wrap.append(dot, text)
  return wrap
}

/** 页面拉取 overview 后回写延迟并刷新（仅当该连接是当前激活 Tab 时重绘） */
export function setLatency(ms, connId = store.activeTab) {
  if (!Number.isFinite(Number(ms))) return
  latencyByConn.set(connId, Number(ms))
  if (connId === store.activeTab) refreshStatus()
}

/** 连接删除后清缓存 */
export function forgetStatus(connId) {
  latencyByConn.delete(connId)
}
