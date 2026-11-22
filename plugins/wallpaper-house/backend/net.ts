import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EnvHttpProxyAgent, request, type Dispatcher } from 'undici'

const USER_AGENT = 'wallpaper-house/0.0.1 (eNest)'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

export class RateLimitError extends Error {
  readonly retryAfterMs: number

  constructor(message: string, retryAfterMs = 1_000) {
    super(message)
    this.name = 'RateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

let dispatcherRef: Dispatcher | undefined

export function getProxyDispatcher(): Dispatcher {
  if (dispatcherRef) return dispatcherRef
  const hasProxy = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .some(key => Boolean(process.env[key]))
  dispatcherRef = hasProxy ? new EnvHttpProxyAgent() : undefined
  return dispatcherRef as Dispatcher
}

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
  userAgent?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  url: string
}

export async function httpRequest(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers = normalizeHeaders(options.headers)
  if (!headers['user-agent']) headers['user-agent'] = options.userAgent || USER_AGENT
  if (!headers.accept) headers.accept = '*/*'
  let currentUrl = url
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await request(currentUrl, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      dispatcher: getProxyDispatcher(),
      signal: combineSignal(options.signal, timeoutMs),
    })
    if (REDIRECT_STATUS.has(response.statusCode)) {
      const location = headerValue(response.headers, 'location')
      if (!location) throw new Error('重定向响应缺少 Location')
      const nextUrl = new URL(location, currentUrl)
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') throw new Error('重定向协议不受支持')
      if (nextUrl.origin !== new URL(currentUrl).origin) {
        delete headers.authorization
        delete headers['x-api-key']
        delete headers['client-id']
        delete headers.cookie
      }
      await response.body.dump()
      currentUrl = nextUrl.toString()
      continue
    }
    if (response.statusCode === 429) {
      await response.body.dump()
      const retryAfter = headerValue(response.headers, 'retry-after')
      const seconds = Number(retryAfter)
      throw new RateLimitError('请求过于频繁，请稍后再试', Number.isFinite(seconds) ? Math.max(500, seconds * 1000) : 5_000)
    }
    const body = await readBody(response.body, maxBytes)
    return { status: response.statusCode, headers: response.headers, body, url: currentUrl }
  }
  throw new Error('重定向次数过多')
}

export async function fetchJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await httpRequest(url, { ...options, headers: { ...options.headers, accept: 'application/json' } })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}: ${response.body.toString('utf8').slice(0, 300)}`)
  }
  try {
    return JSON.parse(response.body.toString('utf8')) as T
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function fetchText(url: string, options: HttpOptions = {}): Promise<string> {
  const response = await httpRequest(url, options)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}: ${response.body.toString('utf8').slice(0, 300)}`)
  }
  return response.body.toString('utf8')
}

export async function fetchBuffer(url: string, options: HttpOptions = {}): Promise<{ buffer: Buffer; contentType: string; status: number }> {
  const response = await httpRequest(url, options)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}: ${response.body.toString('utf8').slice(0, 300)}`)
  }
  return { buffer: response.body, contentType: headerValue(response.headers, 'content-type') || '', status: response.status }
}

export interface DownloadToFileOptions extends HttpOptions {
  targetPath: string
  onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void
  maxBytes?: number
}

export interface DownloadToFileResult {
  bytes: number
  sha256: string
  contentType: string
  url: string
}

export async function downloadToFile(url: string, options: DownloadToFileOptions): Promise<DownloadToFileResult> {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 120_000
  const headers = normalizeHeaders(options.headers)
  if (!headers['user-agent']) headers['user-agent'] = options.userAgent || USER_AGENT
  let currentUrl = url
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await request(currentUrl, {
      method: options.method ?? 'GET',
      headers,
      dispatcher: getProxyDispatcher(),
      signal: combineSignal(options.signal, timeoutMs),
    })
    if (REDIRECT_STATUS.has(response.statusCode)) {
      const location = headerValue(response.headers, 'location')
      if (!location) throw new Error('重定向响应缺少 Location')
      const nextUrl = new URL(location, currentUrl)
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') throw new Error('重定向协议不受支持')
      if (nextUrl.origin !== new URL(currentUrl).origin) {
        delete headers.authorization
        delete headers['x-api-key']
        delete headers['client-id']
        delete headers.cookie
      }
      await response.body.dump()
      currentUrl = nextUrl.toString()
      continue
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = await readBody(response.body, 64 * 1024)
      throw new Error(`HTTP ${response.statusCode}: ${detail.toString('utf8').slice(0, 300)}`)
    }
    const total = Number(headerValue(response.headers, 'content-length')) || undefined
    if (total && total > maxBytes) throw new Error(`文件过大：${total} 字节`)
    const target = options.targetPath
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.${Date.now()}.part`
    const hash = createHash('sha256')
    let received = 0
    const stream = createWriteStream(temp, { flags: 'w' })
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        received += buffer.length
        if (received > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节上限`)
        hash.update(buffer)
        if (!stream.write(buffer)) await new Promise<void>(resolve => stream.once('drain', resolve))
        options.onProgress?.(received, total)
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => error ? reject(error) : resolve())
      })
      await rm(target, { force: true })
      await rename(temp, target)
      return {
        bytes: received,
        sha256: hash.digest('hex'),
        contentType: headerValue(response.headers, 'content-type') || '',
        url: currentUrl,
      }
    } catch (error) {
      stream.destroy()
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
  throw new Error('重定向次数过多')
}

export function dataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime || 'application/octet-stream'};base64,${buffer.toString('base64')}`
}

export function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key) || typeof value !== 'string' || value.length > 2048) continue
    result[key.toLowerCase()] = value
  }
  return result
}

export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

async function readBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error(`响应超过 ${maxBytes} 字节上限`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export class RateLimiter {
  private readonly limit: number
  private readonly intervalMs: number
  private timestamps: number[] = []

  constructor(limit: number, intervalMs: number) {
    this.limit = Math.max(1, limit)
    this.intervalMs = Math.max(1, intervalMs)
  }

  async wait(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      const now = Date.now()
      this.timestamps = this.timestamps.filter(time => now - time < this.intervalMs)
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now)
        return
      }
      const waitMs = this.intervalMs - (now - (this.timestamps[0] ?? now)) + 10
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new DOMException('已取消', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
}

export class TtlCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>()
  private readonly maxEntries: number

  constructor(maxEntries = 200, private readonly ttlMs = 24 * 60 * 60 * 1000) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  get(key: string): T | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.values.delete(key)
      return undefined
    }
    this.values.delete(key)
    this.values.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    this.values.delete(key)
    this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value
      if (typeof oldest !== 'string') break
      this.values.delete(oldest)
    }
  }

  clear(): void {
    this.values.clear()
  }
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(250, timeoutMs))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
