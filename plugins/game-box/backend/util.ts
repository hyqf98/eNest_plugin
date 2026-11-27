/** 通用小工具：参数校验、错误文本、格式化、节流。 */

import { fail } from './adapters/types.ts'

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback
}

export function textOrNumber(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

export function requireString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value) fail('INVALID_ARGUMENT', `${name} 不能为空`)
  if (value.length > max) fail('INVALID_ARGUMENT', `${name} 过长`)
  return value
}

export function optionalString(value: unknown, name: string, max = 4096): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail('INVALID_ARGUMENT', `${name} 必须是字符串`)
  if (value.length > max) fail('INVALID_ARGUMENT', `${name} 过长`)
  return value
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail('INVALID_ARGUMENT', `${name} 必须是布尔值`)
  return value
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function optionalNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function newId(prefix: string): string {
  const random = [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${Date.now().toString(36)}${random}`
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const timer = setTimeout(done, Math.max(0, ms))
    function done(): void {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }
    function cancel(): void {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

export function abortError(): Error {
  return Object.assign(new Error('已取消'), { name: 'AbortError' })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** "145.55 GB" / "102.04 KB" / "154.33 G" / 纯字节数 → 字节；无法识别返回 0 */
export function parseSize(value: unknown): number {
  const raw = textOrNumber(value).trim()
  if (!raw) return 0
  const match = /^([\d.]+)\s*(GB|MB|KB|G|M|K|B)$/i.exec(raw)
  if (match) {
    const number = Number(match[1])
    const unit = match[2].toUpperCase()
    const factor = unit === 'GB' || unit === 'G' ? 1073741824 : unit === 'MB' || unit === 'M' ? 1048576 : unit === 'KB' || unit === 'K' ? 1024 : 1
    return Number.isFinite(number) ? number * factor : 0
  }
  const number = Number(raw)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

export function formatSize(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`
  if (value >= 1048576) return `${(value / 1048576).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`
  return `${Math.round(value)} B`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`
  return `${secs} 秒`
}

/** 去掉 HTML 标签并压缩空白 */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}

/**
 * 配置要求的一行：键是站点原文（操作系统 / 处理器 / 显卡 / DirectX版本…各站不统一，不做枚举）。
 * 站点把最低 / 推荐配置放在一段 JSON 文本里（键值对）；解析不出就返回空数组，页面改用纯文本显示。
 */
export function parseConfigFields(raw: string): Array<{ label: string; value: string }> {
  const source = raw.trim()
  if (!source.startsWith('{')) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return []
  }
  const record = asRecord(parsed)
  if (!record) return []
  const fields: Array<{ label: string; value: string }> = []
  for (const [label, cell] of Object.entries(record)) {
    // 值可能是字符串，也可能是站点塞进来的数字 / 嵌套对象；非字符串一律转成可读文本
    const value = typeof cell === 'string' ? cell : JSON.stringify(cell) ?? ''
    const clean = stripHtml(value).replace(/&quot;/g, '"').trim()
    if (label.trim() && clean) fields.push({ label: label.trim(), value: clean })
  }
  return fields
}

/** 把事件推送限制在约 interval 一次；可选立即冲刷 */
export function createThrottle<T>(fn: (value: T) => void, intervalMs: number): {
  push(value: T): void
  flush(): void
  cancel(): void
} {
  let last: T | undefined
  let hasLast = false
  let timer: NodeJS.Timeout | undefined
  const run = (): void => {
    timer = undefined
    if (!hasLast) return
    hasLast = false
    fn(last as T)
  }
  return {
    push(value: T): void {
      last = value
      hasLast = true
      if (timer) return
      timer = setTimeout(run, intervalMs)
    },
    flush(): void {
      if (timer) clearTimeout(timer)
      run()
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = undefined
      hasLast = false
    },
  }
}

/** 串行锁：同一把钥匙下的异步任务依次执行；一个任务失败不影响后面排队中的任务 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    // 链上只保留"已吞掉错误"的尾 Promise，失败的 task 不会卡死后续排队者。
    const tail = result.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    return result
  }
}

/** 简单并发闸 */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError()
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => { signal?.removeEventListener('abort', cancel); resolve() }
        const cancel = (): void => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(abortError())
        }
        this.waiters.push(waiter)
        signal?.addEventListener('abort', cancel, { once: true })
      })
      if (signal?.aborted) throw abortError()
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}
