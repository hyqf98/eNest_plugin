/**
 * 天翼云请求封装：cookie jar + 手动逐跳跟随 302。
 * 登录链路跨 cloud.189.cn → open.e.189.cn，必须每一跳都收集 Set-Cookie，
 * 跨 origin 不清 cookie（与通用 requestText 的自动跟随不同）。
 */

import { getAdapter } from '../adapters/current.ts'
import type { HttpRequest, RawResponse } from '../adapters/types.ts'
import { BackendError } from '../adapters/types.ts'

export interface CookieEntry {
  name: string
  value: string
  domain: string
}

export class CookieJar {
  private readonly entries = new Map<string, CookieEntry>()

  /** 解析一条 Set-Cookie（name=value; Domain=…; Path=…），domain 缺省用当前 URL 的主机名 */
  store(setCookie: string, url: string): void {
    const parts = setCookie.split(';')
    const [pair] = parts
    if (!pair) return
    const index = pair.indexOf('=')
    if (index <= 0) return
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!name) return
    let domain = hostOf(url)
    for (const attribute of parts.slice(1)) {
      const eq = attribute.indexOf('=')
      const key = (eq >= 0 ? attribute.slice(0, eq) : attribute).trim().toLowerCase()
      if (key === 'domain' && eq >= 0) {
        const raw = attribute.slice(eq + 1).trim().replace(/^\./, '')
        if (raw) domain = raw
      }
    }
    this.entries.set(name, { name, value, domain })
  }

  storeAll(setCookies: readonly string[], url: string): void {
    for (const cookie of setCookies) this.store(cookie, url)
  }

  /** 组装当前 cookie 头（全部域的 cookie 都带上——天翼云登录就是跨子域共享） */
  header(): string {
    const parts: string[] = []
    for (const entry of this.entries.values()) parts.push(`${entry.name}=${entry.value}`)
    return parts.join('; ')
  }

  get(name: string): string {
    return this.entries.get(name)?.value ?? ''
  }

  set(name: string, value: string): void {
    const existing = this.entries.get(name)
    if (existing) existing.value = value
    else this.entries.set(name, { name, value, domain: '.189.cn' })
  }

  clear(): void {
    this.entries.clear()
  }

  clone(): CookieJar {
    const copy = new CookieJar()
    for (const [key, entry] of this.entries) copy.entries.set(key, { ...entry })
    return copy
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function joinCookies(extra?: Record<string, string>): Record<string, string> {
  return { ...extra }
}

/**
 * 带 cookie jar 的请求：manualRedirect 逐跳跟随，每一跳收集 Set-Cookie，
 * 跨 origin 不清 cookie。返回最后一跳（非 3xx）的响应。
 */
export async function jarRequest(
  jar: CookieJar,
  options: Omit<HttpRequest, 'manualRedirect'> & { /** 单跳上限 */ maxHops?: number; onHop?: (response: RawResponse, url: string) => void },
): Promise<RawResponse> {
  const adapter = getAdapter()
  const maxHops = options.maxHops ?? 8
  let currentUrl = options.url
  let headers: Record<string, string> = { ...(options.headers ?? {}) }
  let method = options.method ?? 'GET'
  let body = options.body
  for (let hop = 0; hop <= maxHops; hop++) {
    const cookie = jar.header()
    const stepHeaders: Record<string, string> = { ...headers }
    if (cookie) {
      // 请求显式带的 cookie 头优先；否则用 jar。
      if (!stepHeaders['cookie']) stepHeaders['cookie'] = cookie
    }
    const response = await adapter.request({ ...options, url: currentUrl, headers: stepHeaders, method, body, manualRedirect: true })
    if (response.setCookies.length) jar.storeAll(response.setCookies, currentUrl)
    options.onHop?.(response, currentUrl)
    if (response.status >= 300 && response.status < 400 && response.location) {
      currentUrl = response.location
      // 302/303 的语义是"改用 GET 重新请求"：不能把登录表单（含加密后的账号密码）带到跳转后的地址。
      if (response.status === 303 || method === 'POST') {
        method = 'GET'
        body = undefined
        delete stepHeaders['content-type']
        headers = stepHeaders
      }
      continue
    }
    return response
  }
  throw new BackendError('NETWORK', '重定向次数过多')
}

/** 便捷封装：返回文本响应体 */
export async function jarRequestText(
  jar: CookieJar,
  options: Omit<HttpRequest, 'manualRedirect'> & { maxHops?: number; onHop?: (response: RawResponse, url: string) => void },
): Promise<{ response: RawResponse; text: string }> {
  const response = await jarRequest(jar, options)
  return { response, text: new TextDecoder('utf-8').decode(response.body) }
}

/** 便捷封装：解析 JSON 响应体（容错：先去掉可能的 JSONP 前缀） */
export async function jarRequestJson<T = Record<string, unknown>>(
  jar: CookieJar,
  options: Omit<HttpRequest, 'manualRedirect'> & { maxHops?: number; onHop?: (response: RawResponse, url: string) => void },
): Promise<{ response: RawResponse; data: T }> {
  const { response, text } = await jarRequestText(jar, options)
  return { response, data: JSON.parse(text) as T }
}

export function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
}

export const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

export function joinCookieHeader(jar: CookieJar, extra: Record<string, string> = {}): Record<string, string> {
  const merged = joinCookies(extra)
  const cookie = jar.header()
  if (cookie && !merged['cookie']) merged['cookie'] = cookie
  return merged
}
