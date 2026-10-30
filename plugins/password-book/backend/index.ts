/**
 * password-book backend entry: vault secret resolution (secret.resolve),
 * password strength estimation and secure random generation over the
 * Electron utility message port. No renderer or host runtime imports.
 *
 * 协议：宿主先发 {type:'init'} 建立 host.request 通道；revealSecret 依赖
 * secret.resolve，未就绪前抛「后端尚未就绪」。strength/generatePassword
 * 为纯计算，init 之前即可服务。
 */
import { parentPort, type BackendMessagePort } from './parentPort'
import { generatePassword, passwordStrength } from './crypto'

const port = parentPort
if (!port) throw new Error('password-book backend requires an Electron utility parent')
const channel: BackendMessagePort = port

const PLUGIN_ID = 'com.github.eNest.password-book'
const MAX_SECRET_BYTES = 64 * 1024
const HOST_TIMEOUT_MS = 25_000
const REF_PATTERN = /^sv:com\.github\.eNest\.password-book:[A-Za-z0-9_-]+$/

type Unknown = Record<string, unknown>

interface PendingHost {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

let initialized = false
let closed = false
let hostSequence = 0
const hostControls = new Map<number, PendingHost>()

function assertReady(): void {
  if (closed) throw new Error('后端已关闭')
  if (!initialized) throw new Error('后端尚未就绪，请稍后重试')
}

function post(message: unknown): void {
  if (Buffer.byteLength(JSON.stringify(message) ?? '') > 8 * 1024 * 1024) throw new Error('后端结果超过 8 MiB 限制')
  channel.postMessage(message)
}

/** host.request：secret.resolve 等宿主控制能力，带超时与在途表 */
function hostRequest(method: string, params: Unknown): Promise<unknown> {
  assertReady()
  if (hostControls.size >= 32) return Promise.reject(new Error('后端控制请求过多，请稍后重试'))
  const id = ++hostSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { hostControls.delete(id); reject(new Error('宿主确认超时')) }, HOST_TIMEOUT_MS)
    timer.unref()
    hostControls.set(id, { resolve, reject, timer })
    try {
      post({ type: 'host.request', id, method, params })
    } catch (error) {
      hostControls.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function objectArg(value: unknown, name: string): Unknown {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 参数无效`)
  return value as Unknown
}

function stringArg(value: unknown, name: string, options: { max?: number; min?: number; required?: boolean } = {}): string {
  const { max = 256, min = 0, required = false } = options
  if (value === undefined || value === null) {
    if (required) throw new Error(`${name} 不能为空`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`)
  if (required && !value.trim()) throw new Error(`${name} 不能为空`)
  if (value.length > max) throw new Error(`${name} 超过最大长度 ${max}`)
  if (min && value.length < min) throw new Error(`${name} 至少需要 ${min} 个字符`)
  return value
}

const methods: Record<string, (...args: never[]) => unknown> = {
  /** 解密保险库引用：仅本插件 ref 有效；明文经 backend.call 定向返回 UI/MCP，不落日志 */
  revealSecret: (...args: never[]) => {
    const input = objectArg(args[0], '参数')
    const ref = stringArg(input.ref, 'ref', { max: 512, required: true })
    if (!REF_PATTERN.test(ref)) throw new Error('密码引用格式无效')
    return hostRequest('secret.resolve', { ref }).then(resolved => {
      assertReady()
      if (resolved === null || resolved === undefined) throw new Error('密码不存在或已被删除')
      if (typeof resolved !== 'string' || !resolved) throw new Error('密码解密失败，请检查系统密钥库')
      if (Buffer.byteLength(resolved, 'utf8') > MAX_SECRET_BYTES) throw new Error('密码内容超出限制')
      return { secret: resolved }
    })
  },
  strength: (...args: never[]) => {
    const password = stringArg(args[0], 'password', { max: 256, required: true })
    return passwordStrength(password)
  },
  generatePassword: (...args: never[]) => {
    const input = objectArg(args[0], '参数')
    const length = input.length === undefined ? 20 : input.length
    if (typeof length !== 'number' || !Number.isInteger(length)) throw new Error('length 必须是整数')
    for (const key of ['symbols', 'digits', 'uppercase', 'ambiguous'] as const) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
    }
    return { password: generatePassword({ length, symbols: input.symbols as boolean | undefined, digits: input.digits as boolean | undefined, uppercase: input.uppercase as boolean | undefined, ambiguous: input.ambiguous as boolean | undefined }) }
  }
}

function shutdown(): void {
  if (closed) return
  closed = true
  for (const control of hostControls.values()) {
    clearTimeout(control.timer)
    control.reject(new Error('后端正在关闭'))
  }
  hostControls.clear()
  post({ type: 'shutdown.complete', ok: true })
  process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

channel.on('message', ({ data: raw }) => {
  const data = raw as { type?: unknown; id?: unknown; pluginId?: unknown; generation?: unknown; method?: unknown; args?: unknown; ok?: unknown; error?: unknown; data?: unknown } | undefined
  if (!data || typeof data !== 'object') return

  // host.request 应答：匹配在途控制表
  if (data.type === 'host.response') {
    const id = Number(data.id)
    const control = hostControls.get(id)
    if (!control) return
    hostControls.delete(id)
    clearTimeout(control.timer)
    if (data.ok === true) control.resolve(data.data)
    else control.reject(new Error(typeof data.error === 'string' && data.error ? data.error : '宿主控制请求失败'))
    return
  }

  if (data.type === 'shutdown') { shutdown(); return }

  if (data.type === 'init') {
    if (initialized || closed) return
    if (data.pluginId !== PLUGIN_ID || !Number.isSafeInteger(data.generation) || Number(data.generation) < 1) return
    const context = data as Unknown & { context?: unknown }
    if (!context || typeof context.context !== 'object' || context.context === null || (context.context as Unknown).protocolVersion !== 1) return
    initialized = true
    return
  }

  // 业务请求
  const { id, pluginId, method, args = [] } = data as { id?: unknown; pluginId?: unknown; method?: unknown; args?: unknown }
  if (!Number.isInteger(id) || pluginId !== PLUGIN_ID || typeof method !== 'string' || !Object.hasOwn(methods, method) || !Array.isArray(args)) return
  void (async () => methods[method]!(...args as never[]))().then(
    result => {
      if (closed) return
      const bytes = Buffer.byteLength(JSON.stringify(result) ?? '')
      if (bytes > 8 * 1024 * 1024) throw new Error('结果超过 8 MiB 限制')
      post({ id, ok: true, data: result })
    },
    error => {
      if (closed) return
      // 错误消息只保留可读文本，不携带堆栈或明文
      post({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  )
})
