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
  path: string
}

/**
 * cookie jar：按 (domain, path, name) 三元组保存，按请求地址过滤后组装。
 *
 * 不能按名字去重：天翼在 cloud.189.cn 与 open.e.189.cn 会下发**同名但值不同**的 cookie，
 * 服务端靠 domain 区分。按名字存会让后写的 SSO cookie 顶掉真正的会话 cookie，
 * 表现为「刚登录成功就显示已过期」。
 */
export class CookieJar {
  private readonly entries = new Map<string, CookieEntry>()

  private static key(domain: string, path: string, name: string): string {
    return `${domain}\u0000${path}\u0000${name}`
  }

  /** 直接存入一条已知域名的 cookie */
  storeEntry(entry: CookieEntry): void {
    const domain = entry.domain.replace(/^\./, '').toLowerCase()
    if (!entry.name) return
    this.entries.set(CookieJar.key(domain, entry.path || '/', entry.name), { ...entry, domain, path: entry.path || '/' })
  }

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
    let path = '/'
    let expired = false
    for (const attribute of parts.slice(1)) {
      const eq = attribute.indexOf('=')
      const key = (eq >= 0 ? attribute.slice(0, eq) : attribute).trim().toLowerCase()
      const raw = eq >= 0 ? attribute.slice(eq + 1).trim() : ''
      if (key === 'domain' && raw) {
        const cleaned = raw.replace(/^\./, '')
        if (cleaned) domain = cleaned
      } else if (key === 'path' && raw) {
        path = raw.startsWith('/') ? raw : '/'
      } else if (key === 'max-age' && raw) {
        const seconds = Number(raw)
        if (Number.isFinite(seconds) && seconds <= 0) expired = true
      } else if (key === 'expires' && raw) {
        const at = Date.parse(raw)
        if (Number.isFinite(at) && at <= Date.now()) expired = true
      }
    }
    if (expired) {
      // 删除指令（Max-Age=0 / 过去的 Expires）：不存空值。
      // 天翼未登录时会对 getUserBriefInfo 下发 `COOKIE_LOGIN_USER=; Max-Age=0`，
      // 把空值当 cookie 存下会盖掉凭据里的真会话，之后所有请求都变成未登录。
      this.remove(name, domain)
      return
    }
    this.storeEntry({ name, value, domain, path })
  }

  storeAll(setCookies: readonly string[], url: string): void {
    for (const cookie of setCookies) this.store(cookie, url)
  }

  private remove(name: string, domain: string): void {
    const prefix = `${domain}\u0000`
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix) && key.endsWith(`\u0000${name}`)) this.entries.delete(key)
    }
  }

  /** 组装 cookie 头（全部域的 cookie 都带上——天翼云登录就是跨子域共享） */
  header(): string {
    return this.all().map(entry => `${entry.name}=${entry.value}`).join('; ')
  }

  /**
   * 组装请求头。天翼的登录链路跨 cloud.189.cn → open.e.189.cn，cookie 必须能带过去
   * （服务端在跳转时靠它续上流程），所以这里不做严格的作用域过滤。
   *
   * 但同名 cookie 要按**最匹配的域名**取值，不能谁后写谁赢：
   * 天翼在 cloud 与 open.e 下会下发同名不同值的 cookie，服务端靠 domain 区分。
   * 发往 cloud 的请求拿到 open.e 那条 SSO cookie，就会把真正的会话 cookie 顶掉，
   * 表现为「刚登录就显示已过期」。
   */
  headerFor(url: string): string {
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      return this.header()
    }
    /** 域名匹配得分：完全一致最高，其次后缀匹配，越具体越高；不匹配为 -1 */
    const score = (domain: string): number => {
      const value = domain.toLowerCase()
      if (!value) return 0
      if (host === value) return value.length + 1000
      if (host.endsWith(`.${value}`)) return value.length
      return -1
    }
    const best = new Map<string, { entry: CookieEntry; score: number }>()
    const unmatched: CookieEntry[] = []
    for (const entry of this.entries.values()) {
      const value = score(entry.domain)
      if (value < 0) {
        // 不属于这个主机，但同族站点间仍要带上（见上面的跨子域说明）
        if (!unmatched.some(item => item.name === entry.name)) unmatched.push(entry)
        continue
      }
      const current = best.get(entry.name)
      if (!current || value > current.score) best.set(entry.name, { entry, score: value })
    }
    const parts: string[] = []
    for (const { entry } of best.values()) parts.push(`${entry.name}=${entry.value}`)
    for (const entry of unmatched) if (!best.has(entry.name)) parts.push(`${entry.name}=${entry.value}`)
    return parts.join('; ')
  }

  all(): CookieEntry[] {
    return [...this.entries.values()]
  }

  get(name: string): string {
    for (const entry of this.entries.values()) if (entry.name === name) return entry.value
    return ''
  }

  set(name: string, value: string): void {
    this.storeEntry({ name, value, domain: '189.cn', path: '/' })
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

/**
 * 把会话凭据里的 cookie 灌进 jar。
 *
 * 优先用逐条带 domain/path 的 `cookies` 形态（正确形态）；只有旧的拍平 `cookie` 字符串时
 * 才退回按 cloud.189.cn 逐条写入，这种凭据无法区分同名 cookie，属于历史数据。
 */
export function seedJarFromCredential(jar: CookieJar, credential: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(credential) } catch { return }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  if (!record) return
  const list = Array.isArray(record.cookies) ? record.cookies : []
  let seeded = 0
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const cookie = item as Record<string, unknown>
    const name = typeof cookie.name === 'string' ? cookie.name : ''
    const value = typeof cookie.value === 'string' ? cookie.value : ''
    if (!name) continue
    jar.storeEntry({
      name,
      value,
      domain: typeof cookie.domain === 'string' && cookie.domain ? cookie.domain : 'cloud.189.cn',
      path: typeof cookie.path === 'string' && cookie.path ? cookie.path : '/',
    })
    seeded++
  }
  if (seeded) return
  if (typeof record.cookie === 'string') {
    for (const pair of record.cookie.split('; ')) {
      if (pair.includes('=')) jar.store(`${pair}; Path=/`, 'https://cloud.189.cn/')
    }
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
    // 按这一跳的地址组装 cookie：域名/路径匹配，同名 cookie 靠各自的域区分。
    const cookie = jar.headerFor(currentUrl)
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
