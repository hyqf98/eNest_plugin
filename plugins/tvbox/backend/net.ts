/**
 * tvbox 网络层：统一出网请求（并发闸/超时/体积上限）+ 源隔离 cookie + 系统代理。
 * 所有站点请求（配置 JSON/采集 API/spider 出网/媒体代理）都走这里。
 */
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici'
import { isMapLike } from './shared'

export interface RawResponse { status: number; headers: Record<string, string>; body: string; bytes: Uint8Array }

export const HTTP_TIMEOUT_MS = 20_000
export const MAX_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_MEDIA_BYTES = 24 * 1024 * 1024   // 单段 ts/图片上限
export const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const MAX_CONCURRENT = 12
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/* ---------------- 系统代理（undici ProxyAgent 全局 dispatcher） ----------------
 * 部分 CDN（如 lzv34.com）走代理反而失败：网络级错误（超时/连接重置/TLS）时
 * 用 undici Agent 直连重试一次，由 rawFetch 统一处理。 */
let proxyReady = false
let directAgent: unknown = null
export function setupProxy(log = console.log): void {
  if (proxyReady) return
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
  if (!proxy) return
  try {
    setGlobalDispatcher(new ProxyAgent(proxy))
    proxyReady = true
    log('[tvbox] network proxy enabled:', proxy)
  } catch (error) {
    console.warn('[tvbox] proxy setup failed:', error instanceof Error ? error.message : String(error))
  }
}
function directDispatcher(): unknown {
  if (!directAgent) directAgent = new Agent({ connect: { timeout: 15_000 } })
  return directAgent
}
const NETWORK_ERROR = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EPROTO|UND_ERR|aborted|timeout/i

/* ---------------- 并发闸 ---------------- */
let activeRequests = 0
const requestQueue: Array<() => void> = []
async function acquireSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT) { activeRequests++; return }
  await new Promise<void>(resolve => requestQueue.push(resolve))
  activeRequests++
}
function releaseSlot(): void {
  activeRequests--
  const next = requestQueue.shift()
  if (next) next()
}

export function normalizeUrl(input: unknown): string {
  const url = typeof input === 'string' ? input.trim() : ''
  if (!url) throw new Error('URL 不能为空')
  if (!/^https?:\/\//i.test(url)) throw new Error(`仅支持 http(s) 地址：${url.slice(0, 80)}`)
  return url
}

/* ---------------- 源 cookie 存储（内存 + 由 index.ts 持久化） ---------------- */
type CookieList = Array<{ name: string; value: string; domain: string }>
type CookieJar = Record<string, Record<string, CookieList>>   // ownerKey -> origin -> cookies
export const cookieJars = new Map<string, Record<string, CookieList>>()
export function exportCookieJar(): Record<string, Record<string, CookieList>> {
  const flat: Record<string, Record<string, CookieList>> = {}
  for (const [k, jar] of cookieJars) flat[k] = jar
  return flat
}
export function importCookieJar(flat: Record<string, Record<string, CookieList>>): void {
  for (const [k, jar] of Object.entries(flat ?? {})) cookieJars.set(k, jar)
}

function cookieOrigin(url: string): string {
  try { return new URL(url).origin } catch { return '' }
}
export function cookieHeaderFor(ownerKey: string, url: string): string {
  const list = cookieJars.get(ownerKey)?.[cookieOrigin(url)]
  if (!list?.length) return ''
  return list.map(c => `${c.name}=${c.value}`).join('; ')
}
let persistHook: (() => void) | null = null
export function onCookiePersist(hook: () => void): void { persistHook = hook }
function storeCookiesFromResponse(ownerKey: string, url: string, headers: Headers): void {
  const raw = headers.getSetCookie?.() ?? []
  if (!raw.length) return
  const origin = cookieOrigin(url)
  if (!origin) return
  let jar = cookieJars.get(ownerKey)
  if (!jar) { jar = {}; cookieJars.set(ownerKey, jar) }
  const list = jar[origin] ?? []
  for (const line of raw) {
    const [pair] = line.split(';')
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const name = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    const existing = list.findIndex(c => c.name === name)
    if (existing >= 0) list[existing].value = value
    else list.push({ name, value, domain: origin })
  }
  jar[origin] = list
  persistHook?.()
}

/** 请求体归一：字符串直传、Map/数组走 urlencoded、对象走 JSON */
function coerceBody(data: unknown, h: Headers): BodyInit {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return data as BodyInit
  if (Array.isArray(data)) {
    if (!h.has('content-type')) h.set('content-type', 'application/x-www-form-urlencoded')
    return data.map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).join('&')
  }
  if (isMapLike(data)) {
    if (!h.has('content-type')) h.set('content-type', 'application/x-www-form-urlencoded')
    const parts: string[] = []
    for (const [k, v] of data.entries()) parts.push(`${encodeURIComponent(String(k))}=${encodeURIComponent(String(v))}`)
    return parts.join('&')
  }
  if (typeof data === 'object' && data !== null) {
    if (!h.has('content-type')) h.set('content-type', 'application/json')
    return JSON.stringify(data)
  }
  return String(data)
}

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  data?: unknown
  maxBytes?: number
  timeoutMs?: number
  /** cookie 归属键（站点 key / spider key）；缺省不带 cookie */
  ownerKey?: string
}

/** 整包读取的文本/字节请求（配置/采集 API/图片）。媒体流转发见 mediaProxy 的 fetchStream。
 * 全局代理失败（网络级错误）时自动直连重试一次（部分 CDN 走代理必挂）。 */
export async function rawFetch(url: string, options: FetchOptions = {}): Promise<RawResponse> {
  const target = normalizeUrl(url)
  const { method = 'GET', headers, data, maxBytes = MAX_TEXT_BYTES, timeoutMs = HTTP_TIMEOUT_MS, ownerKey } = options
  try {
    return await doFetch(target, method, headers, data, maxBytes, timeoutMs, ownerKey, undefined)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (!proxyReady || !NETWORK_ERROR.test(msg)) throw error
    return doFetch(target, method, headers, data, maxBytes, timeoutMs, ownerKey, directDispatcher())
  }
}

async function doFetch(target: string, method: string, headers: Record<string, string> | undefined, data: unknown, maxBytes: number, timeoutMs: number, ownerKey: string | undefined, dispatcher: unknown): Promise<RawResponse> {
  await acquireSlot()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const h = new Headers()
    for (const [k, v] of Object.entries(headers ?? {})) h.set(k, v)
    if (!h.has('user-agent')) h.set('user-agent', UA)
    if (ownerKey) {
      const cookie = cookieHeaderFor(ownerKey, target)
      if (cookie && !h.has('cookie')) h.set('cookie', cookie)
    }
    const init: RequestInit = { method: method.toUpperCase(), signal: controller.signal, redirect: 'follow', headers: h }
    if (dispatcher) (init as RequestInit & { dispatcher?: unknown }).dispatcher = dispatcher
    if (data !== undefined && data !== null && method !== 'GET' && method !== 'HEAD') {
      init.body = coerceBody(data, h)
    }
    const res = await fetch(target, init).catch(error => {
      const cause = (error as any)?.cause
      const detail = cause?.code || cause?.message || (error as Error)?.message || String(error)
      throw new Error(`请求失败 ${detail}：${target.slice(0, 120)}`)
    })
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new Error(`响应过大（${(buf.byteLength / 1048576).toFixed(1)}MB 超过 ${(maxBytes / 1048576).toFixed(0)}MB 上限）`)
    const responseHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => { responseHeaders[k.toLowerCase()] = v })
    if (ownerKey) storeCookiesFromResponse(ownerKey, target, res.headers)
    const body = new TextDecoder('utf-8').decode(buf)
    return { status: res.status, headers: responseHeaders, body, bytes: buf }
  } finally {
    clearTimeout(timer)
    releaseSlot()
  }
}

/** 请求并解析 JSON（采集 API/配置）。响应非 JSON 或业务 code!=1 时抛错。 */
export async function fetchJson<T = any>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await rawFetch(url, { ...options, headers: { accept: 'application/json,text/plain,*/*', ...(options.headers ?? {}) } })
  if (res.status >= 400) throw new Error(`HTTP ${res.status}：${url.slice(0, 120)}`)
  try {
    return JSON.parse(res.body) as T
  } catch {
    throw new Error(`响应不是合法 JSON：${url.slice(0, 120)}`)
  }
}
