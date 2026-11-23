/**
 * 后端运行时骨架：与宿主 utilityProcess 的消息通道、控制请求、活动租约、关闭流程。
 * 蓝本：plugins/wallpaper-house/backend/runtime.ts
 */

export interface BackendContext {
  protocolVersion: number
  appDataPath: string
  packagePath: string
  appExecPath: string
  pageOrigin: string | null
}

export interface ParentPort {
  on(event: 'message', listener: (message: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

export interface RuntimeScope {
  pluginId: string
  generation: number
  wcId: number
  context: BackendContext
  isCurrent(): boolean
  readonly closing: boolean
}

interface HostResponseMessage {  type: 'host.response'
  id: number
  ok: boolean
  data?: unknown
  error?: string
}

interface InitMessage {
  type: 'init'
  pluginId?: unknown
  generation?: unknown
  wcId?: unknown
  context?: unknown
}

interface PendingHost {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let portRef: ParentPort | undefined
let owner: string | undefined
let generation = 0
let wcId = 0
let contextRef: BackendContext | undefined
let closing = false
let hostRequestId = 0
const pendingHost = new Map<number, PendingHost>()
const shutdownHandlers = new Set<() => void | Promise<void>>()
let shutdownPromise: Promise<void> | undefined

export function parentPort(): ParentPort {
  const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
  if (!port) throw new Error('This entry requires the eNest utility process')
  portRef = port
  return port
}

export function initializeRuntime(message: InitMessage): void {
  if (owner) {
    if (message.pluginId !== owner) throw new Error('backend init owner mismatch')
    return
  }
  if (typeof message.pluginId !== 'string' || !message.pluginId) throw new Error('backend init is missing pluginId')
  if (!Number.isSafeInteger(message.generation) || !Number.isSafeInteger(message.wcId)) throw new Error('backend init is missing generation')
  const context = message.context
  if (!context || typeof context !== 'object') throw new Error('backend init is missing context')
  const record = context as Record<string, unknown>
  if (record.protocolVersion !== 1) throw new Error('unsupported backend protocol version')
  for (const key of ['appDataPath', 'packagePath', 'appExecPath'] as const) {
    if (typeof record[key] !== 'string' || !record[key]) throw new Error(`backend context is missing ${key}`)
  }
  owner = message.pluginId
  generation = message.generation as number
  wcId = message.wcId as number
  contextRef = {
    protocolVersion: 1,
    appDataPath: record.appDataPath as string,
    packagePath: record.packagePath as string,
    appExecPath: record.appExecPath as string,
    pageOrigin: typeof record.pageOrigin === 'string' ? record.pageOrigin : null,
  }
}

export function currentScope(): RuntimeScope {
  if (!owner || !contextRef) throw new Error('backend is not initialized')
  const scopeOwner = owner
  const scopeGeneration = generation
  const scopeContext = contextRef
  return {
    pluginId: scopeOwner,
    generation: scopeGeneration,
    wcId,
    context: scopeContext,
    isCurrent: () => owner === scopeOwner && generation === scopeGeneration && !closing,
    get closing() { return closing },
  }
}

export function isClosing(): boolean {
  return closing
}

export function postMessage(message: unknown): void {
  const port = portRef ?? parentPort()
  port.postMessage(message)
}

/** 主动给页面推事件；关闭期间丢弃 */
export function postEvent(event: string, data: unknown): void {
  if (closing) return
  postMessage({ event, data })
}

export function onShutdown(handler: () => void | Promise<void>): () => void {
  shutdownHandlers.add(handler)
  return () => { shutdownHandlers.delete(handler) }
}

/**
 * 关闭期间仍然允许的宿主请求：保存状态与释放资源正是关闭时要做的事。
 * 其余请求（网络、句柄、确认框…）在关闭期间一律拒绝——任务收尾不该再去发起它们。
 */
const ALLOWED_WHILE_CLOSING = new Set(['storage.get', 'storage.set', 'activity.release', 'log.write'])

/** 这个宿主请求在关闭期间是否仍然允许 */
export function allowedWhileClosing(method: string): boolean {
  return ALLOWED_WHILE_CLOSING.has(method)
}

export function requestHost<T = unknown>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
  const port = portRef ?? parentPort()
  if (closing && !allowedWhileClosing(method)) return Promise.reject(new Error('backend is closing'))
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000) {
    return Promise.reject(new Error('invalid host request timeout'))
  }
  const id = ++hostRequestId
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(id)
      reject(new Error(`host request timed out: ${method}`))
    }, timeoutMs)
    pendingHost.set(id, { resolve: value => resolve(value as T), reject, timer })
    port.postMessage({ type: 'host.request', id, method, params })
  })
}

export function receiveHostResponse(message: HostResponseMessage): void {
  const pending = pendingHost.get(message.id)
  if (!pending) return
  pendingHost.delete(message.id)
  clearTimeout(pending.timer)
  if (message.ok) pending.resolve(message.data)
  else pending.reject(new Error(message.error || 'host request failed'))
}

/** 申请活动租约，阻止下载/安装期间实例被空闲回收；返回释放函数 */
export async function acquireActivity(reason: string): Promise<() => Promise<void>> {
  const token = `game-box:${randomToken()}`
  await requestHost('activity.acquire', { token, reason: reason.slice(0, 160) })
  return async () => {
    try {
      await requestHost('activity.release', { token }, 5_000)
    } catch {
      // 宿主关闭期间释放可能失败；租约随运行代次回收。
    }
  }
}

export async function trackProcess(pid: number): Promise<void> {
  await requestHost('process.track', { pid })
}

export async function untrackProcess(pid: number): Promise<void> {
  try {
    await requestHost('process.untrack', { pid }, 5_000)
  } catch {
    // 进程已退出或宿主正在关闭。
  }
}

export async function storageGet<T = unknown>(key: string): Promise<T | null> {
  const value = await requestHost<T>('storage.get', { key })
  return value === undefined ? null : value
}

export async function storageSet(key: string, value: unknown): Promise<void> {
  let safe: unknown
  try {
    safe = JSON.parse(JSON.stringify(value === undefined ? null : value))
  } catch {
    throw new Error('storage value is not JSON serializable')
  }
  await requestHost('storage.set', { key, value: safe })
}

export async function resolveSecret(ref: string): Promise<string | null> {
  return requestHost('secret.resolve', { ref })
}

/** 把页面拿到的目录句柄换成后端可写的绝对路径 */
export async function resolveFileHandle(handleId: string, access: 'read' | 'write' = 'write'): Promise<string> {
  return requestHost('files.resolve', { handleId, access })
}

export async function confirmWithUser(title: string, message: string, detail = ''): Promise<boolean> {
  return requestHost<boolean>('dialog.confirm', { title: title.slice(0, 160), message: message.slice(0, 512), detail: detail.slice(0, 1000) }, 120_000)
}

export async function resolveProxy(url: string): Promise<string> {
  const result = await requestHost<{ proxy: string }>('network.resolveProxy', { url })
  return result?.proxy ?? ''
}

export async function logMessage(level: 'info' | 'warn', source: string, message: string): Promise<void> {
  try {
    await requestHost('log.write', { level, source: source.slice(0, 64), message: message.slice(0, 16_384) }, 5_000)
  } catch {
    // 日志失败不得影响业务。
  }
}

export function beginShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  closing = true
  shutdownPromise = (async () => {
    const results = await Promise.allSettled([...shutdownHandlers].map(handler => Promise.resolve().then(handler)))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    for (const pending of pendingHost.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('backend shutdown'))
    }
    pendingHost.clear()
    postMessage({
      type: 'shutdown.complete',
      ok: !failure,
      ...(failure ? { error: String(failure.reason instanceof Error ? failure.reason.message : failure.reason).slice(0, 4096) } : {}),
    })
    setTimeout(() => process.exit(0), 50).unref()
  })()
  return shutdownPromise
}

export function installSignalHandlers(): void {
  process.once('SIGTERM', () => { void beginShutdown() })
  process.once('SIGINT', () => { void beginShutdown() })
}

export function handleRuntimeMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const message = raw as Record<string, unknown>
  if (message.type === 'init') {
    initializeRuntime(message as unknown as InitMessage)
    return
  }
  if (message.type === 'host.response') {
    receiveHostResponse(message as unknown as HostResponseMessage)
    return
  }
  if (message.type === 'shutdown') {
    void beginShutdown()
    return
  }
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
