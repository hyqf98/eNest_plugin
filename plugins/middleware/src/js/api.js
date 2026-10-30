/**
 * api.js — window.enest 适配层（插件 backend + vault/storage/session/UI 通道）
 * 本文件是唯一允许触碰 window.enest 的模块；页面代码只经 ctx.api 调用。
 * 错误约定：
 *  - backend.call 缺失       → HOST_LAG（toast「壳子版本过低…」后 throw）
 *  - 错误消息含 permission denied → PERM（toast「权限不足…」后 throw）
 *  - 其余失败原样 reject Error；err.original 保留宿主原文
 */

const MSG = {
  hostLag: '请使用 eNest 0.0.1 或更新版本并更新中间件插件，启用插件 Node 后端',
  perm: '权限不足：请在插件设置→权限管理授权本机 Node 后端与所需 mw.* 能力'
}

/** kinds.list 失败时的静态兜底描述符（capabilities 为空对象 = gate 视为可用，页面再按数据降级） */
const FALLBACK_KINDS = [
  { kind: 'kafka', label: 'Kafka', transport: 'native', defaultPort: 9092, messageQueryModes: ['offset', 'time', 'key'], capabilities: {} },
  { kind: 'rabbitmq', label: 'RabbitMQ', transport: 'http', defaultPort: 15672, messageQueryModes: ['time', 'key'], capabilities: {} },
  { kind: 'mqtt', label: 'MQTT', transport: 'native', defaultPort: 1883, messageQueryModes: [], capabilities: {} },
  { kind: 'rocketmq', label: 'RocketMQ', transport: 'http', defaultPort: 8080, messageQueryModes: ['time', 'key', 'id'], capabilities: {} }
]

function host() {
  return globalThis.enest || globalThis.window?.enest || null
}

function wrapError(e, fallback = '宿主调用失败') {
  if (e instanceof Error) return e
  return new Error(String(e?.message ?? e ?? fallback))
}

/** mw 通道错误转译：权限/HOST_LAG 转 toast + 中文 Error，其余保留原文 */
function translateMwError(e) {
  const raw = String(e?.message ?? e ?? '')
  let err
  if (/permission denied/i.test(raw)) {
    err = new Error(MSG.perm)
    err.code = 'PERM'
    void toast(MSG.perm, 'error')
  } else if (/unknown method/i.test(raw)) {
    err = new Error(MSG.hostLag)
    err.code = 'HOST_LAG'
    void toast(MSG.hostLag, 'warn')
  } else {
    err = wrapError(e)
  }
  err.original = raw
  return err
}

/* —— 插件私有 workbench 统一入口 —— */

export async function mw(action, input = {}, options = {}) {
  const runtime = host()?.backend
  if (!runtime || typeof runtime.call !== 'function') {
    const err = new Error(MSG.hostLag)
    err.code = 'HOST_LAG'
    void toast(MSG.hostLag, 'warn')
    throw err
  }
  try {
    const timeoutMs = options.timeoutMs ?? (action === 'test' || action === 'session.close' ? 15000 : 30000)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 86400000) throw new Error('后端超时必须为 250ms 至 24h')
    return await runtime.call('workbench', [{ action, input }], { timeoutMs })
  } catch (e) {
    throw translateMwError(e)
  }
}

/* —— 键约定 —— */

export const sessionKeyOf = (connId) => `mw:${connId}`
export const sessionInfoKey = (connId) => `mw:session:${connId}`

/* —— 连接对象 → MwConnectionConfig（绝不含明文密码） —— */

function clean(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
}

export function toMwConfig(conn, overrides = {}) {
  const config = clean({
    kind: conn.kind,
    name: conn.name,
    env: conn.env,
    readOnly: !!conn.readOnly,
    note: conn.note,
    secretRef: conn.secretRef
  })
  if (conn.kind === 'kafka') {
    config.bootstrapServers = conn.bootstrapServers
    config.saslMechanism = conn.saslMechanism || 'none'
    config.tls = conn.tls !== false
  } else if (conn.kind === 'rabbitmq') {
    config.managementUrl = conn.managementUrl
    config.vhost = conn.vhost
    config.username = conn.username
  } else if (conn.kind === 'mqtt') {
    config.brokerUrl = conn.brokerUrl
    config.clientId = conn.clientId
    config.username = conn.username
    if (conn.emqx && typeof conn.emqx === 'object') {
      config.emqx = clean({
        enabled: !!conn.emqx.enabled,
        version: conn.emqx.version || 'auto',
        apiUrl: conn.emqx.apiUrl,
        apiKey: conn.emqx.apiKey,
        apiSecretRef: conn.emqx.apiSecretRef
      })
    }
  } else if (conn.kind === 'rocketmq') {
    config.dashboardUrl = conn.dashboardUrl
    config.username = conn.username
  }
  if (conn.options && typeof conn.options === 'object') config.options = conn.options
  return { ...config, ...overrides }
}

/* —— 高层封装 —— */

let kindsPromise = null

/** kinds.list → 描述符数组；宿主失败时回落静态描述符（mw 层已 toast 过一次） */
export async function kinds() {
  if (!kindsPromise) {
    kindsPromise = mw('kinds.list', {})
      .then((list) => (Array.isArray(list) ? list : list?.kinds || FALLBACK_KINDS))
      .catch((e) => {
        if (e?.code === 'PERM') throw e
        return FALLBACK_KINDS
      })
  }
  return kindsPromise
}

export async function testConnection(config) {
  return mw('test', { config })
}

/** session.open；成功后把会话信息（capabilities/messageQueryModes）写入会话级缓存供 ctx 组装 */
export async function openConnection(conn, options = {}) {
  const sessionKey = options.sessionKey || sessionKeyOf(conn.id)
  const res = await mw('session.open', { sessionKey, config: toMwConfig(conn, { readOnly: options.readOnly ?? !!conn.readOnly }) })
  const info = res && typeof res === 'object' ? res : {}
  try {
    await session.set(sessionInfoKey(conn.id), {
      sessionKey: info.sessionKey || sessionKey,
      capabilities: info.capabilities || null,
      messageQueryModes: info.messageQueryModes || null,
      connectedAt: Date.now()
    })
  } catch { /* 会话缓存失败不阻断连接 */ }
  return info
}

export async function closeConnection(sessionKey) {
  const key = typeof sessionKey === 'string' ? sessionKey : sessionKey?.sessionKey
  return mw('session.close', { sessionKey: key })
}

export async function listSessions() {
  const list = await mw('session.list', {})
  return Array.isArray(list) ? list : list?.sessions || []
}

/** 丢弃某连接的会话信息缓存（关 Tab / 删连接时） */
export async function forgetConnection(connId) {
  try {
    await rawSessionCall('remove', sessionInfoKey(connId))
  } catch { /* ignore */ }
}

/* —— vault（密码只进 vault，连接对象只存 secretRef） —— */

export const vault = {
  /** 成功返回 secretRef 字符串 */
  async set(key, secret) {
    const v = host()?.vault
    if (!v || typeof v.set !== 'function') throw new Error('宿主未提供凭据库（vault）')
    try {
      const r = await v.set(key, String(secret ?? ''))
      const ref = r?.secretRef ?? (typeof r === 'string' ? r : null)
      if (!ref) throw new Error('凭据库未返回引用')
      return ref
    } catch (e) {
      throw wrapError(e)
    }
  },
  async has(key) {
    try {
      return (await host()?.vault?.has?.(key)) === true
    } catch {
      return false
    }
  },
  async remove(key) {
    const v = host()?.vault
    if (!v || typeof v.remove !== 'function') throw new Error('宿主未提供凭据库（vault）')
    try {
      await v.remove(key)
      return true
    } catch (e) {
      throw wrapError(e)
    }
  }
}

/* —— 持久化 KV —— */

export const storage = {
  async get(key, fallback = null) {
    try {
      const v = await host()?.storage?.get?.(key)
      return v === undefined || v === null ? fallback : v
    } catch {
      return fallback
    }
  },
  async set(key, value) {
    const s = host()?.storage
    if (!s || typeof s.set !== 'function') throw new Error('宿主存储不可用')
    try {
      const ok = await s.set(key, value)
      if (ok === false) throw new Error('宿主拒绝写入')
      return true
    } catch (e) {
      throw new Error(`保存失败：${e?.message || e}`)
    }
  },
  async remove(key) {
    try {
      return (await host()?.storage?.remove?.(key)) !== false
    } catch {
      return false
    }
  }
}

/* —— 会话级 KV（关 Tab 即清；tail 状态 / 轮询开关 / 会话能力缓存） —— */

async function rawSessionCall(op, key, value) {
  const s = host()?.storage?.session
  return s?.[op]?.(key, value)
}

export const session = {
  async get(key) {
    try {
      return (await rawSessionCall('get', key)) ?? null
    } catch {
      return null
    }
  },
  async set(key, value) {
    try {
      return (await rawSessionCall('set', key, value)) !== false
    } catch {
      return false
    }
  },
  async remove(key) {
    try {
      return (await rawSessionCall('remove', key)) !== false
    } catch {
      return false
    }
  }
}

/* —— 轻提示 / 通知 / 剪贴板 —— */

function localToast(message, type = 'info') {
  const root = document.getElementById('local-toast')
  if (!root) return
  const item = document.createElement('div')
  item.className = 'toast-item ' + (type === 'success' ? 'ok' : type === 'error' || type === 'warn' ? 'err' : '')
  item.textContent = String(message ?? '').slice(0, 200)
  root.appendChild(item)
  setTimeout(() => item.remove(), 3200)
}

/** 'info'|'success'|'warn'|'error'；宿主 toast 不可用时回落本地 #local-toast */
export async function toast(message, type = 'info') {
  try {
    await host()?.ui?.toast?.({ message: String(message ?? ''), type })
  } catch {
    localToast(message, type)
  }
}

export async function notify(title, body) {
  try {
    return (await host()?.notify?.({ title, body })) === true
  } catch {
    return false
  }
}

export async function copy(text) {
  try {
    await host().clipboard.writeText(String(text ?? ''))
    return true
  } catch (error) {
    localToast(`复制失败：${error?.message || '剪贴板不可用'}`, 'error')
    return false
  }
}

/* —— 事件订阅 —— */

function subscribe(event, cb) {
  const h = host()
  if (!h || typeof h.on !== 'function' || typeof cb !== 'function') return () => {}
  const listener = message => { if (message?.event === event) cb(message.data) }
  let unsubscribe
  try {
    unsubscribe = h.on('backend.event', listener)
  } catch {
    return () => {}
  }
  return () => {
    try {
      if (typeof unsubscribe === 'function') unsubscribe()
      else h.off?.('backend.event', listener)
    } catch { /* ignore */ }
  }
}

/** tail/监听数据流：payload { sessionKey, tailId, message } */
export const onMwData = (cb) => subscribe('mw.data', cb)
export const onMwError = (cb) => subscribe('mw.error', cb)

/* —— 模式 / 生命周期 / 窗口 —— */

export async function mode() {
  try {
    return (await host()?.getLaunchMode?.()) === 'quick' ? 'quick' : 'shell'
  } catch {
    return 'shell'
  }
}

export function onModeChange(cb) {
  const h = host()
  if (typeof h?.onModeChange !== 'function') return () => {}
  try {
    return h.onModeChange(cb) || (() => {})
  } catch {
    return () => {}
  }
}

export async function openInShell() {
  try {
    return (await host()?.ui?.openInShell?.()) === true
  } catch {
    return false
  }
}

export async function setTitle(text) {
  try {
    await (host()?.ui?.setTitle?.(text) ?? host()?.setTitle?.(text))
    return true
  } catch {
    return false
  }
}

export function onEnter(cb) {
  const h = host()
  if (typeof h?.onEnter !== 'function') return () => {}
  try {
    return h.onEnter(cb) || (() => {})
  } catch {
    return () => {}
  }
}

export function onBeforeClose(cb) {
  const h = host()
  if (typeof h?.onBeforeClose !== 'function') return () => {}
  try {
    return h.onBeforeClose(cb) || (() => {})
  } catch {
    return () => {}
  }
}

export function onDestroy(cb) {
  const h = host()
  if (typeof h?.onDestroy !== 'function') return () => {}
  try {
    return h.onDestroy(cb) || (() => {})
  } catch {
    return () => {}
  }
}

/* —— 主题：theme.getTokens + onThemeChange → 写 :root（themeAware 注入后的双保险） —— */

export async function applyTheme() {
  const apply = (tokens, modeValue) => {
    if (tokens && typeof tokens === 'object') {
      const root = document.documentElement
      for (const [k, v] of Object.entries(tokens)) {
        if (k.startsWith('--') && typeof v === 'string' && v) root.style.setProperty(k, v)
      }
    }
    if (modeValue === 'light' || modeValue === 'dark') {
      document.documentElement.dataset.theme = modeValue
      document.documentElement.dataset.scheme = modeValue
    }
  }
  try {
    const h = host()
    const res = await (h?.theme?.getTokens?.() ?? h?.ui?.getThemeTokens?.())
    if (res) apply(res.tokens || res, res.mode)
  } catch { /* 兜底 token 已在 main.css :root */ }
  try {
    host()?.ui?.onThemeChange?.((ev) => apply(ev?.tokens, ev?.mode))
  } catch { /* ignore */ }
}

/* —— 组装默认导出（页面 ctx.api 即此对象） —— */

const api = {
  mw,
  kinds,
  testConnection,
  openConnection,
  closeConnection,
  listSessions,
  forgetConnection,
  vault,
  storage,
  session,
  toast,
  notify,
  copy,
  onMwData,
  onMwError,
  mode,
  onModeChange,
  openInShell,
  setTitle,
  onEnter,
  onBeforeClose,
  onDestroy,
  applyTheme,
  toMwConfig,
  sessionKeyOf,
  sessionInfoKey
}

export default api
