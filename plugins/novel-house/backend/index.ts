/**
 * novel-house 后端 —— utilityProcess 入口。
 * 职责：Legado（阅读3.0）格式书源的加载与执行（规则引擎 + node:vm JS 沙箱）、
 * 源管理（安装/删除/启停/更新/批量导入）、跨源业务调用（搜索/发现/详情/目录/正文）、
 * 封面代理（取图转 base64 回前端，绕过页面 CSP img-src 限制）、整本离线缓存。
 *
 * 规则引擎（AnalyzeRule 兼容子集）：
 *  - 默认模式 class.xxx.0@tag.a.1@text / id.xxx@… 链式元素定位
 *  - @css: 前缀（+ 纯 CSS 选择器自动判定）、// 与 @XPath: 前缀（常用子集）、
 *    @json: 与 $. JSONPath 子集、`:` 开头整体正则（配合 $1/$2 捕获组）
 *  - ##正则[##替换] 净化、|| 备选、<js>…</js> 与 @js: 脚本（受限沙箱）
 *  - URL 规则：path,{"method":"POST","body":"k={{key}}","charset":"gbk","headers":{…}}，
 *    {{key}}/{{page}} 占位符
 *
 * 存储模型（全部走 host.request storage.get/set，宿主统一插件 KV）：
 *  - `sources.index`  已装源索引 [{key,name,version,enabled,url,installedAt,updatedAt}]
 *  - `source.<key>`   源 JSON 本体（UTF-8 文本）
 *  - `cookies.jar`    源站点 cookie（按源 key 隔离）
 *
 * 安全约定：
 *  - @js/<js> 规则片段在 node:vm 隔离上下文执行，无 require/process/fs/import；
 *  - 所有出网请求由后端真实 fetch 代发（超时/体积/并发上限）；
 *  - 慢调用一律 withTimeout 墙钟限时，避免源规则卡死后端请求。
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import tls from 'node:tls'
import { ProxyAgent, setGlobalDispatcher } from 'undici'

/* 笔趣阁系站点证书常年过期/自签（Legado 默认 trustAll）——对源站放宽校验。
 * 仅影响本插件后端的 fetch，不改变系统或宿主其他连接。 */
;(tls as unknown as { setDefaultRejectUnauthorized?: (v: boolean) => void }).setDefaultRejectUnauthorized?.(false)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

type Request = {
  type?: string
  id?: number
  pluginId?: string
  generation?: number
  method?: string
  args?: unknown[]
}
interface ParentPort {
  on(event: 'message', listener: (message: { data: Request & { ok?: boolean; data?: unknown; error?: string } }) => void): void
  postMessage(message: unknown): void
}
const maybePort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!maybePort) throw new Error('This entry requires the eNest utility process')
const port: ParentPort = maybePort

let owner: string | undefined
/** 插件包根（init 时由 BackendContext 注入）；内置书源位于 runtime/sources/ */
let packagePath = ''
/** 宿主授权数据目录（init 时注入）；磁盘缓存放 {appDataPath}/novel-house/cache/ */
let appDataPath = ''

/* ---------------- 代理（与壳配置一致） ---------------- */
let proxyDispatcher: ProxyAgent | null = null
function currentEnvProxy(): string {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || ''
}
function applyProxy(mode: string, manualUrl: string): { mode: string; url: string; effective: string } {
  const url = mode === 'manual' ? manualUrl.trim() : ''
  const effective = mode === 'direct' ? '' : mode === 'manual' ? url : currentEnvProxy()
  try {
    if (effective) {
      proxyDispatcher = new ProxyAgent(effective)
      setGlobalDispatcher(proxyDispatcher)
      console.log('[novel-house] proxy enabled:', effective)
    } else {
      proxyDispatcher = null
      setGlobalDispatcher(undefined as never)
      console.log('[novel-house] proxy disabled (direct)')
    }
  } catch (error) {
    console.warn('[novel-house] proxy apply failed:', error instanceof Error ? error.message : String(error))
  }
  return { mode, url, effective }
}
async function loadProxyConfig(): Promise<{ mode: string; url: string }> {
  const v = await storageGet('proxy.config').catch(() => null)
  return v && typeof v === 'object' ? { mode: String((v as any).mode || 'shell'), url: String((v as any).url || '') } : { mode: 'shell', url: '' }
}
{
  const envProxy = currentEnvProxy()
  if (envProxy) applyProxy('shell', '')
  else applyProxy('direct', '')
}

/* ---------------- 进程级兜底（源 js 片段里的异步异常不杀进程） ---------------- */
process.on('unhandledRejection', reason => {
  console.warn('[novel-house] unhandled rejection from source rule:', reason instanceof Error ? reason.message : String(reason))
})
process.on('uncaughtException', error => {
  console.error('[novel-house] uncaught exception from source rule:', error instanceof Error ? error.stack : String(error))
})

/* ---------------- 宿主控制通道（storage） ---------------- */
interface PendingHost { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const HOST_TIMEOUT_MS = 30_000
let hostSequence = 0
const hostControls = new Map<number, PendingHost>()

function assertReady(): void {
  if (!owner) throw new Error('后端尚未就绪，请稍后重试')
}
function hostRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  assertReady()
  if (hostControls.size >= 64) return Promise.reject(new Error('后端控制请求过多，请稍后重试'))
  const id = ++hostSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { hostControls.delete(id); reject(new Error('宿主控制请求超时')) }, HOST_TIMEOUT_MS)
    timer.unref()
    hostControls.set(id, { resolve, reject, timer })
    try {
      port.postMessage({ type: 'host.request', id, method, params })
    } catch (error) {
      hostControls.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
const storageGet = (key: string): Promise<unknown> => hostRequest('storage.get', { key })
async function storageSet(key: string, value: unknown): Promise<void> {
  await hostRequest('storage.set', { key, value })
}
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
    promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))) })
  })
}
async function retryTransient<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      const msg = e instanceof Error ? e.message : String(e)
      const transient = /(status code:?\s*5\d\d)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|timeout|520|521|522|523|524/i.test(msg)
      if (!transient || i === attempts - 1) throw e
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)))
    }
  }
  throw lastError
}

/* ---------------- 网络层 ---------------- */
const HTTP_TIMEOUT_MS = 20_000
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_CONCURRENT = 10
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

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

function normalizeUrl(input: unknown): string {
  const url = typeof input === 'string' ? input.trim() : ''
  if (!url) throw new Error('URL 不能为空')
  if (!/^https?:\/\//i.test(url)) throw new Error(`仅支持 http(s) 地址：${url.slice(0, 80)}`)
  return url
}
function resolveAgainst(baseUrl: string | undefined, url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  if (baseUrl) {
    try { return new URL(url, baseUrl).toString() } catch { /* fallthrough */ }
  }
  return url
}

/* ---------------- GBK 编码表（POST body / key 转码） ---------------- */
let gbkCharToCode: Map<string, number> | null = null
function gbkTable(): Map<string, number> {
  if (gbkCharToCode) return gbkCharToCode
  const table = new Map<string, number>()
  const decoder = new TextDecoder('gbk')
  const probe = new Uint8Array(2)
  for (let b1 = 0x81; b1 <= 0xfe; b1++) {
    for (let b2 = 0x40; b2 <= 0xfe; b2++) {
      if (b2 === 0x7f) continue
      probe[0] = b1; probe[1] = b2
      const ch = decoder.decode(probe)
      if (ch && ch !== '\ufffd' && ch.codePointAt(0)! > 0x7f && !table.has(ch)) table.set(ch, (b1 << 8) | b2)
    }
  }
  gbkCharToCode = table
  return table
}
function gbkEncode(text: string): Uint8Array {
  const out: number[] = []
  const table = gbkTable()
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) { out.push(code); continue }
    const gb = table.get(ch)
    if (gb === undefined) out.push(0x3f)
    else out.push(gb >> 8, gb & 0xff)
  }
  return Uint8Array.from(out)
}
function decodeWith(bytes: Uint8Array, encoding: string): string {
  try { return new TextDecoder(encoding).decode(bytes) } catch { return new TextDecoder('utf-8').decode(bytes) }
}
/** 从 HTML 头部嗅探声明编码（charset=xxx meta / xml 声明） */
function sniffCharset(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const m = /charset=["']?([\w-]+)/i.exec(head)
  if (!m) return 'utf-8'
  const enc = m[1].toLowerCase()
  if (enc === 'gb2312' || enc === 'gbk2k' || enc === 'gb18030') return 'gbk'
  return enc
}

/* ---------------- cookie 存储（按源 key 隔离） ---------------- */
type CookieList = Array<{ name: string; value: string; domain: string }>
type CookieJar = Record<string, Record<string, CookieList>>
const cookieJars = new Map<string, Record<string, CookieList>>()
let cookieJarLoaded = false

function cookieOrigin(url: string): string {
  try { return new URL(url).origin } catch { return '' }
}
async function loadCookieJar(): Promise<void> {
  if (cookieJarLoaded) return
  cookieJarLoaded = true
  const stored = await storageGet('cookies.jar')
  if (stored && typeof stored === 'object') {
    for (const [sourceKey, jar] of Object.entries(stored as Record<string, Record<string, CookieList>>)) {
      cookieJars.set(sourceKey, jar)
    }
  }
}
async function persistCookieJar(): Promise<void> {
  const flat: Record<string, Record<string, CookieList>> = {}
  for (const [sourceKey, jar] of cookieJars) flat[sourceKey] = jar
  await storageSet('cookies.jar', flat)
}
function cookieHeaderFor(sourceKey: string, url: string): string {
  const list = cookieJars.get(sourceKey)?.[cookieOrigin(url)]
  if (!list?.length) return ''
  return list.map(c => `${c.name}=${c.value}`).join('; ')
}
function storeCookiesFromResponse(sourceKey: string, url: string, headers: Headers): void {
  const raw = headers.getSetCookie?.() ?? []
  if (!raw.length) return
  const origin = cookieOrigin(url)
  if (!origin) return
  let jar = cookieJars.get(sourceKey)
  if (!jar) { jar = {}; cookieJars.set(sourceKey, jar) }
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
  void persistCookieJar().catch(() => { /* best effort */ })
}

interface RawResponse { status: number; headers: Record<string, string>; body: string; bytes: Uint8Array; charset: string }
interface FetchOptions {
  method?: string
  body?: string
  charset?: string          // 请求体编码（gbk 时 body 按 gbk 字节发）
  responseCharset?: string  // 强制响应解码编码
  headers?: Record<string, string>
}

async function rawFetch(url: string, opts: FetchOptions, maxBytes: number, sourceKey?: string): Promise<RawResponse> {
  const target = normalizeUrl(url)
  await acquireSlot()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const h = new Headers()
    for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v)
    if (!h.has('user-agent')) h.set('user-agent', UA)
    if (sourceKey) {
      const cookie = cookieHeaderFor(sourceKey, target)
      if (cookie && !h.has('cookie')) h.set('cookie', cookie)
    }
    const method = (opts.method ?? 'GET').toUpperCase()
    const init: RequestInit = { method, signal: controller.signal, redirect: 'follow', headers: h }
    if (opts.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = (opts.charset ?? '').toLowerCase() === 'gbk' ? gbkEncode(opts.body) as unknown as BodyInit : opts.body
      if (!h.has('content-type')) h.set('content-type', 'application/x-www-form-urlencoded')
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
    if (sourceKey) storeCookiesFromResponse(sourceKey, target, res.headers)
    const charset = opts.responseCharset?.toLowerCase() === 'gbk' ? 'gbk' : sniffCharset(buf)
    const body = decodeWith(buf, charset)
    return { status: res.status, headers: responseHeaders, body, bytes: buf, charset }
  } finally {
    clearTimeout(timer)
    releaseSlot()
  }
}

/* ---------------- HTML 解析器（与 comic-house 同源的轻量实现） ---------------- */
interface SimNode { type: 'element' | 'text' | 'comment'; name?: string; attrs?: Record<string, string>; children?: SimNode[]; text?: string }
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function parseHtml(html: string): SimNode {
  const root: SimNode = { type: 'element', name: 'root', attrs: {}, children: [] }
  const stack: SimNode[] = [root]
  let i = 0
  const pushNode = (node: SimNode) => { const top = stack[stack.length - 1]; (top.children ??= []).push(node) }
  while (i < html.length) {
    if (html[i] !== '<') {
      const start = i
      while (i < html.length && html[i] !== '<') i++
      const t = html.slice(start, i)
      if (t) pushNode({ type: 'text', text: t })
      continue
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      const stop = end < 0 ? html.length : end + 3
      pushNode({ type: 'comment', text: html.slice(i, stop) })
      i = stop
      continue
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i)
      i = end < 0 ? html.length : end + 1
      continue
    }
    if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i)
      const name = html.slice(i + 2, end < 0 ? html.length : end).trim().toLowerCase()
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) { stack.length = s; break }
      }
      i = end < 0 ? html.length : end + 1
      continue
    }
    const end = findTagEnd(html, i)
    const rawTag = html.slice(i + 1, end)
    i = end + 1
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag)
    if (!m) continue
    const name = m[1].toLowerCase()
    const attrs = parseAttrs(rawTag.slice(m[1].length))
    const selfClosing = rawTag.endsWith('/') || VOID_TAGS.has(name)
    const node: SimNode = { type: 'element', name, attrs, children: [] }
    pushNode(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}
function findTagEnd(html: string, start: number): number {
  let quote = ''
  for (let j = start + 1; j < html.length; j++) {
    const c = html[j]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') return j
  }
  return html.length
}
function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.:-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '')
  }
  return attrs
}
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ as string } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)) } catch { return _ as string } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
}
function descendants(node: SimNode): SimNode[] {
  const out: SimNode[] = []
  const walk = (n: SimNode) => { for (const c of n.children ?? []) { if (c.type === 'element') { out.push(c); walk(c) } } }
  walk(node)
  return out
}
function nodeText(node: SimNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'comment') return ''
  return (node.children ?? []).map(nodeText).join('')
}
function nodeOwnText(node: SimNode): string {
  // textNodes 语义：直属文本节点
  return (node.children ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}
function serializeNode(node: SimNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'comment') return ''
  const inner = (node.children ?? []).map(serializeNode).join('')
  if (VOID_TAGS.has(node.name ?? '')) return ''
  return `<${node.name}>${inner}</${node.name}>`
}
function selectMatches(root: SimNode, selector: string): SimNode[] {
  const groups = selector.split(',').map(s => s.trim()).filter(Boolean)
  const out: SimNode[] = []
  const seen = new Set<SimNode>()
  for (const group of groups) {
    const parts = group.split(/\s*>\s*/).length > 1
      ? group.split(/\s*>\s*/).flatMap(seg => seg.split(/\s+/)).filter(Boolean)
      : group.split(/\s+/).filter(Boolean)
    const useChild = />\s/.test(group) || group.includes('>')
    out.push(...walkSelect(root, parts, 0, seen, useChild))
  }
  return out
}
function walkSelect(node: SimNode, parts: string[], index: number, seen: Set<SimNode>, direct: boolean): SimNode[] {
  if (index >= parts.length) {
    if (node.type === 'element' && node.name !== 'root' && !seen.has(node)) { seen.add(node); return [node] }
    return []
  }
  const results: SimNode[] = []
  const candidates = node.type === 'element' && node.name !== 'root' ? [node, ...descendants(node)] : descendants(node)
  for (const cand of candidates) {
    if (matchesSimple(cand, parts[index])) {
      if (index + 1 <= parts.length - 1 && direct) {
        // 直接子代约束：只走 children
        const kids = (cand.children ?? []).filter(c => c.type === 'element' && matchesSimple(c, parts[index + 1]))
        for (const k of kids) results.push(...walkSelect(k, parts, index + 2, seen, direct))
        continue
      }
      results.push(...walkSelect(cand, parts, index + 1, seen, direct))
    }
  }
  return results
}
function matchesSimple(node: SimNode, part: string): boolean {
  if (node.type !== 'element') return false
  const segs: string[] = []
  const re = /([a-zA-Z][a-zA-Z0-9-]*|\.[a-zA-Z_][\w-]*|#[a-zA-Z_][\w-]*|\[[^\]]+\])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(part))) segs.push(m[1])
  if (!segs.length) return false
  for (const seg of segs) {
    if (seg.startsWith('.')) {
      if (!(node.attrs?.class ?? '').split(/\s+/).includes(seg.slice(1))) return false
    } else if (seg.startsWith('#')) {
      if (node.attrs?.id !== seg.slice(1)) return false
    } else if (seg.startsWith('[')) {
      const am = /^([a-zA-Z_:][\w:.]*)(?:([\^\$*~|]?=)("([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(seg.slice(1, -1))
      if (!am) return false
      const value = node.attrs?.[am[1].toLowerCase()]
      if (value === undefined) return false
      if (am[2]) {
        const expect = am[4] ?? am[5] ?? am[6] ?? ''
        switch (am[2]) {
          case '=': if (value !== expect) return false; break
          case '^=': if (!value.startsWith(expect)) return false; break
          case '$=': if (!value.endsWith(expect)) return false; break
          case '*=': if (!value.includes(expect)) return false; break
          case '~=': if (!value.split(/\s+/).includes(expect)) return false; break
          case '|=': if (value !== expect && !value.startsWith(expect + '-')) return false; break
        }
      }
    } else {
      if (node.name !== seg.toLowerCase()) return false
    }
  }
  return true
}

/* ---------------- 跨上下文值归一 ---------------- */
function plain(value: unknown, depth = 0): any {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return null
    if (typeof value === 'bigint') return String(value)
    return value
  }
  if (depth > 8) return null
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return { __bytes: Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map(v => plain(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = plain(v, depth + 1)
  return out
}

/* ================================================================
 *  Legado 规则引擎（AnalyzeRule 兼容子集）
 * ================================================================ */
interface RuleContext {
  /** HTML 根节点或 JSON 数据（择一） */
  html?: SimNode
  data?: unknown
  /** 原始响应文本（正则模式 / js 用） */
  raw: string
  baseUrl: string
  sourceKey: string
  /** js 沙箱共享存储（java.put/get） */
  shared: Map<string, unknown>
  vars: Record<string, unknown>
}

/** 入口：解析规则串，返回字符串或元素数组 */
function evalRule(ctx: RuleContext, ruleInput: unknown): { elements: SimNode[]; text: string } {
  let rule = typeof ruleInput === 'string' ? ruleInput.trim() : String(ruleInput ?? '').trim()
  if (!rule) return { elements: [], text: '' }
  // || 备选：依次尝试（首个有结果的生效）
  if (rule.includes('||')) {
    for (const alt of rule.split('||')) {
      const r = evalSingle(ctx, alt.trim())
      if (r.text || r.elements.length) return r
    }
    return { elements: [], text: '' }
  }
  return evalSingle(ctx, rule)
}

function splitPurify(rule: string): { rule: string; purify?: [string, string?] } {
  // ##正则[##替换]：仅顶层（js 块里的 ## 不管）
  const jsGuard = rule.startsWith('@js:') || rule.startsWith('<js>')
  if (jsGuard) return { rule }
  const idx = rule.indexOf('##')
  if (idx >= 0) {
    const rest = rule.slice(idx + 2)
    const second = rest.indexOf('##')
    return {
      rule: rule.slice(0, idx).trim(),
      purify: second >= 0 ? [rest.slice(0, second), rest.slice(second + 2)] : [rest, undefined],
    }
  }
  return { rule }
}
function applyPurify(text: string, purify?: [string, string?]): string {
  if (!purify) return text
  const [pattern, replacement] = purify
  try {
    const re = new RegExp(pattern, 'g')
    return replacement === undefined ? text.replace(re, '') : text.replace(re, replacement)
  } catch {
    return text
  }
}

function evalSingle(ctx: RuleContext, ruleInput: string): { elements: SimNode[]; text: string } {
  const { rule, purify } = splitPurify(ruleInput)
  let result: { elements: SimNode[]; text: string }
  if (!rule) {
    // 仅 ##净化：作用于 raw
    result = { elements: [], text: ctx.raw }
  } else if (rule.startsWith('@js:') || rule.startsWith('<js>')) {
    const js = rule.startsWith('@js:') ? rule.slice(4) : rule.replace(/^<js>/, '').replace(/<\/js>$/, '')
    const out = runRuleJs(ctx, js)
    result = { elements: [], text: out === null || out === undefined ? '' : String(out) }
  } else if (rule.startsWith('@css:')) {
    result = cssQuery(ctx, rule.slice(5))
  } else if (rule.startsWith('@XPath:') || rule.startsWith('@xpath:')) {
    result = xpathQuery(ctx, rule.slice(7))
  } else if (rule.startsWith('//')) {
    result = xpathQuery(ctx, rule)
  } else if (rule.startsWith('@json:')) {
    result = { elements: [], text: jsonPath(ctx, rule.slice(6)) }
  } else if (rule.startsWith('$.') || rule.startsWith('$[')) {
    result = { elements: [], text: jsonPath(ctx, rule) }
  } else if (rule.startsWith(':')) {
    // 整体正则（chapterList 常用：":"sS":(\d),…"），匹配全部 → 逐组占位由 $1 处理，这里返回原文交由上层
    result = { elements: [], text: ctx.raw }
  } else if (/^(class|tag|id|children)\./i.test(rule) || /^@(class|tag|id|children)\./i.test(rule)) {
    result = defaultChainQuery(ctx, rule.replace(/^@/, ''))
  } else if (/^[a-z]+[.#[]/i.test(rule) || /^[.#]/.test(rule)) {
    // 纯 CSS 选择器形态
    result = cssQuery(ctx, rule)
  } else if (ctx.data !== undefined) {
    // JSON 上下文的默认按 JSONPath 处理
    result = { elements: [], text: jsonPath(ctx, rule) }
  } else {
    result = cssQuery(ctx, rule)
  }
  return { elements: result.elements, text: applyPurify(result.text, purify) }
}

/** CSS 选择器查询（支持结尾 @text/@html/@attr/@all 提取） */
function cssQuery(ctx: RuleContext, selector: string): { elements: SimNode[]; text: string } {
  const el = ctx.html
  if (!el) return { elements: [], text: '' }
  // 尾部提取器：@text / @html / @textNodes / @all / @属性名
  let extract: string | null = null
  const at = selector.lastIndexOf('@')
  let sel = selector
  if (at > 0) {
    const tail = selector.slice(at + 1).trim()
    if (/^(text|textNodes|html|ownText|all|[a-zA-Z-]+)$/.test(tail)) {
      extract = tail
      sel = selector.slice(0, at).trim()
    }
  }
  const matches = selectMatches(el, sel)
  if (!matches.length) return { elements: [], text: '' }
  if (!extract) return { elements: matches, text: '' }
  return { elements: matches, text: matches.map(n => extractText(n, extract!)).join('\n').trim() }
}

/** 默认链式规则：class.foo.0@tag.a.1@href（Legado 默认语法） */
function defaultChainQuery(ctx: RuleContext, chain: string): { elements: SimNode[]; text: string } {
  const el = ctx.html
  if (!el) return { elements: [], text: '' }
  const parts = chain.split('@').map(s => s.trim()).filter(Boolean)
  let current: SimNode[] = []
  const rootScope: SimNode[] = el.name === 'root' ? descendants(el) : [el, ...descendants(el)]
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const isLast = i === parts.length - 1
    // 尾段提取器
    if (isLast && /^(text|textNodes|html|ownText|all)$/.test(part)) {
      return { elements: current, text: current.map(n => extractText(n, part)).join('\n').trim() }
    }
    if (isLast && !/^(class|tag|id|children)\./i.test(part) && !/^\[/.test(part)) {
      // 尾段是属性名（href/src/data-bid…）
      return { elements: current, text: current.map(n => n.attrs?.[part.toLowerCase()] ?? '').filter(Boolean).join('\n').trim() }
    }
    const scope = current.length ? descendantsOfSet(current) : rootScope
    const m = /^(class|tag|id|children)\.([^.]+)(?:\.(-?\d+))?$/.exec(part)
    if (m) {
      const [, kind, name, index] = m
      let matched: SimNode[]
      if (kind === 'class') matched = scope.filter(n => (n.attrs?.class ?? '').split(/\s+/).includes(name))
      else if (kind === 'tag') matched = scope.filter(n => n.name === name.toLowerCase())
      else if (kind === 'id') matched = scope.filter(n => n.attrs?.id === name)
      else matched = scope // children. 全量
      if (index !== undefined) {
        const idx = Number(index)
        matched = idx < 0 ? (matched[idx + matched.length] !== undefined ? [matched[idx + matched.length]] : []) : (matched[idx] !== undefined ? [matched[idx]] : [])
      }
      current = matched
    } else {
      // [n] / [start:end] 切片（tag.a[-1:0] 之类）
      const sm = /^\[(-?\d*)(?::(-?\d*))?\]$/.exec(part)
      if (sm && current.length) {
        const a = sm[1] === '' || sm[1] === undefined ? 0 : Number(sm[1])
        const b = sm[2] === '' || sm[2] === undefined ? undefined : Number(sm[2])
        if (b !== undefined && (a < 0 || b < 0)) {
          // 负数区间：逆向切片（[-1:0] = 从末尾往前取全部）
          current = current.slice().reverse()
        } else {
          current = current.slice(a, b)
        }
      } else {
        // 未知段：按 CSS 选择器尝试
        current = scope.filter(n => matchesSimple(n, part))
      }
    }
  }
  return { elements: current, text: '' }
}
/** Legado 默认链 tag./class. 段是后代搜索（jsoup select 语义），不是仅直接子代 */
function descendantsOfSet(nodes: SimNode[]): SimNode[] {
  const out: SimNode[] = []
  const seen = new Set<SimNode>()
  for (const n of nodes) {
    for (const d of descendants(n)) {
      if (!seen.has(d)) { seen.add(d); out.push(d) }
    }
  }
  return out
}
function extractText(node: SimNode, kind: string): string {
  switch (kind) {
    case 'text': return decodeEntities(nodeText(node)).trim()
    case 'textNodes': case 'ownText': return decodeEntities(nodeOwnText(node)).trim()
    case 'html': return serializeNode(node)
    case 'all': return serializeNode(node)
    default: return decodeEntities(nodeText(node)).trim()
  }
}

/** XPath 常用子集：//tag[@attr='v' or @attr='w']/@attr、//tag/text()、//tag/@attr */
function xpathQuery(ctx: RuleContext, xpath: string): { elements: SimNode[]; text: string } {
  const root = ctx.html
  if (!root) return { elements: [], text: '' }
  const m = /^(?:\/\/|\*@XPath:)?([a-zA-Z][\w-]*)(\[[^\]]+\])?(?:\/(@?\w+(?:\(\))?))?$/.exec(xpath.replace(/^\*@?XPath:/i, '').trim())
  if (!m) return { elements: [], text: '' }
  const [, tagName, predicate, extractor] = m
  let nodes = descendants(root).filter(n => n.name === tagName.toLowerCase())
  if (predicate) {
    // [@attr='v' or @attr='w'] / [@attr]
    const ors = predicate.slice(1, -1).split(/\s+or\s+/i)
    nodes = nodes.filter(n => ors.some(cond => {
      const cm = /^\s*@([\w-]+)(?:\s*=\s*(['"])(.*?)\2)?\s*$/.exec(cond)
      if (!cm) return false
      const v = n.attrs?.[cm[1].toLowerCase()]
      return cm[3] === undefined ? v !== undefined : v === cm[3]
    }))
  }
  if (!extractor || extractor === 'text()' || extractor === 'text') {
    return { elements: nodes, text: nodes.map(n => decodeEntities(nodeText(n)).trim()).filter(Boolean).join('\n') }
  }
  if (extractor.startsWith('@')) {
    const attr = extractor.slice(1).toLowerCase()
    return { elements: nodes, text: nodes.map(n => n.attrs?.[attr] ?? '').filter(Boolean).join('\n') }
  }
  if (extractor === 'html()') {
    return { elements: nodes, text: nodes.map(serializeNode).join('') }
  }
  return { elements: nodes, text: '' }
}

/** JSONPath 子集：$.a.b[0].c / $..key */
function jsonPath(ctx: RuleContext, path: string): string {
  if (ctx.data === undefined) {
    try { ctx.data = JSON.parse(ctx.raw) } catch { return '' }
  }
  const expr = path.replace(/^\$\.?/, '')
  const deep = expr.startsWith('.')
  const segs = (deep ? expr.replace(/^\./, '') : expr).split(/[.[]/).map(s => s.replace(/\]$/, '')).filter(s => s !== '')
  let current: unknown[] = [ctx.data]
  for (const seg of segs) {
    const next: unknown[] = []
    for (const item of current) {
      if (item === null || item === undefined) continue
      if (/^\d+$/.test(seg)) {
        const arr = Array.isArray(item) ? item : undefined
        if (arr && arr[Number(seg)] !== undefined) next.push(arr[Number(seg)])
      } else if (typeof item === 'object') {
        const v = (item as Record<string, unknown>)[seg]
        if (v !== undefined) next.push(v)
        if (deep && typeof v === 'object') {
          for (const d of deepFind(v, seg)) next.push(d)
        }
      }
    }
    current = next
  }
  if (!current.length) return ''
  const first = current[0]
  return typeof first === 'object' ? JSON.stringify(first) : String(first)
}
function deepFind(value: unknown, key: string): unknown[] {
  const out: unknown[] = []
  if (Array.isArray(value)) {
    for (const v of value) out.push(...deepFind(v, key))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key) out.push(v)
      if (v && typeof v === 'object') out.push(...deepFind(v, key))
    }
  }
  return out
}

/* ---------------- 规则 JS 沙箱（@js: / <js>） ---------------- */
function runRuleJs(ctx: RuleContext, code: string): unknown {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sandboxConsole = {
    log: (...a: unknown[]) => console.log(`[novel:${ctx.sourceKey}]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[novel:${ctx.sourceKey}]`, ...a),
    error: (...a: unknown[]) => console.error(`[novel:${ctx.sourceKey}]`, ...a),
  }
  const host = (() => { try { return new URL(ctx.baseUrl).host } catch { return '' } })()
  const sandbox: Record<string, unknown> = {
    result: ctx.raw,
    baseUrl: ctx.baseUrl,
    book: ctx.vars.book ?? {},
    source: { bookSourceUrl: ctx.vars.bookSourceUrl ?? '', getKey: () => ctx.sourceKey },
    key: ctx.vars.key ?? '',
    page: ctx.vars.page ?? 1,
    title: ctx.vars.title ?? '',
    host,
    java: {
      put: (k: unknown, v: unknown) => { ctx.shared.set(String(k), v) },
      get: (k: unknown) => ctx.shared.get(String(k)),
      toast: () => { /* noop */ },
      longToast: () => { /* noop */ },
      log: (t: unknown, c?: unknown) => sandboxConsole.log(String(t), c === undefined ? '' : String(c)),
      getStrResponse: undefined,
      ajax: undefined, // 由下方重新定义为受限 fetch（同步语义无法支持，返回占位）
      startBrowserAwait: () => { throw new Error('内置浏览器不可用（novel-house 无头模式）') },
    },
    cookie: {
      getCookie: (url: unknown) => cookieHeaderFor(ctx.sourceKey, String(url ?? '')),
      setCookie: () => { /* noop */ },
      removeCookie: () => { /* noop */ },
    },
    String: {
      // Legado 常用 java String 扩展的 JS 侧简版
      format: (fmt: unknown, ...args: unknown[]) => String(fmt).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')),
    },
    console: sandboxConsole,
    setTimeout: (cb: () => void, ms?: unknown) => {
      const t = setTimeout(() => { try { cb() } catch (e) { sandboxConsole.error(e) } }, Number(ms ?? 0))
      timers.add(t)
      t.unref?.()
      return t
    },
    clearTimeout: (t: unknown) => { clearTimeout(t as ReturnType<typeof setTimeout>); timers.delete(t as ReturnType<typeof setTimeout>) },
    parseInt: Number.parseInt,
    parseFloat: Number.parseFloat,
    JSON,
    Math,
    RegExp,
    Date,
    encodeURI,
    encodeURIComponent,
    decodeURI,
    decodeURIComponent,
  }
  // result 需按规则形态提供：JSON 上下文给对象
  if (ctx.data !== undefined) sandbox.result = ctx.data
  try {
    const context = vm.createContext(sandbox)
    const script = new vm.Script(`(function(){ ${code}\n })()`, { filename: `rule:${ctx.sourceKey}.js` })
    const out = script.runInContext(context, { timeout: 5_000 })
    return plain(out)
  } catch (error) {
    throw new Error(`源脚本规则执行失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    for (const t of timers) clearTimeout(t)
  }
}

/* ---------------- URL 规则 ---------------- */
interface UrlRule { url: string; method: string; body?: string; charset?: string; headers?: Record<string, string> }

function parseUrlRule(rule: string, baseUrl: string): UrlRule {
  let url = rule.trim()
  let method = 'GET'
  let body: string | undefined
  let charset: string | undefined
  let headers: Record<string, string> | undefined
  // ,{options} 后缀（单引号 JSON 常见）：从第一个 ,{ 起尝试解析到串尾
  const brace = url.indexOf(',{')
  if (brace > 0) {
    const tail = url.slice(brace + 1).trim()
    if (tail.startsWith('{') && tail.endsWith('}')) {
      try {
        const opts = JSON.parse(tail.replace(/'/g, '"'))
        url = url.slice(0, brace).trim()
        if (typeof opts.method === 'string') method = opts.method.toUpperCase()
        if (typeof opts.body === 'string') body = opts.body
        else if (opts.body !== null && typeof opts.body === 'object') body = new URLSearchParams(opts.body as Record<string, string>).toString()
        if (typeof opts.charset === 'string') charset = opts.charset
        if (opts.headers && typeof opts.headers === 'object') {
          headers = {}
          for (const [k, v] of Object.entries(opts.headers as Record<string, unknown>)) headers[k] = String(v)
        }
      } catch { /* 无 options 尾巴则当普通 URL */ }
    }
  }
  if (/^https?:\/\//i.test(url)) return { url, method, body, charset, headers }
  return { url: resolveAgainst(baseUrl, url), method, body, charset, headers }
}

/** 展开占位符：{{key}}（编码）/ {{page}} / {{book.xxx}} */
function expandUrl(ctx: RuleContext, urlRule: UrlRule, key: string, page: number): UrlRule {
  const expand = (text: string): string => text
    .replace(/\{\{\s*key\s*\}\}/g, () => urlRule.charset === 'gbk' ? key : encodeURIComponent(key))
    .replace(/\{\{\s*page\s*\}\}/g, () => String(page))
    .replace(/\{\{\s*book\.(\w+)\s*\}\}/g, (_, f) => String((ctx.vars.book as Record<string, unknown>)?.[f] ?? ''))
  return {
    url: expand(urlRule.url),
    method: urlRule.method,
    body: urlRule.body ? expand(urlRule.body) : undefined,
    charset: urlRule.charset,
    headers: urlRule.headers,
  }
}

/* ---------------- 书源模型 ---------------- */
interface BookSourceMeta { key: string; name: string; version: string; enabled: boolean; url?: string; group?: string; installedAt: number; updatedAt: number; comment?: string }
interface SourceInstance {
  key: string
  name: string
  group: string
  json: Record<string, unknown>
  header: Record<string, string>
  searchUrl: string
  exploreUrl: string
  ruleSearch: Record<string, unknown>
  ruleBookInfo: Record<string, unknown>
  ruleToc: Record<string, unknown>
  ruleContent: Record<string, unknown>
  shared: Map<string, unknown>
}

let sourcesIndex: BookSourceMeta[] | null = null
const instances = new Map<string, SourceInstance>()

async function loadSourcesIndex(): Promise<BookSourceMeta[]> {
  if (sourcesIndex) return sourcesIndex
  const stored = await storageGet('sources.index')
  sourcesIndex = Array.isArray(stored) ? stored as BookSourceMeta[] : []
  return sourcesIndex
}
async function saveSourcesIndex(): Promise<void> {
  await storageSet('sources.index', sourcesIndex ?? [])
}
async function loadSourceJson(key: string): Promise<Record<string, unknown> | null> {
  const value = await storageGet(`source.${key}`)
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return null }
  }
  return null
}

function normalizeSource(json: Record<string, unknown>): SourceInstance {
  const headersFromJson = json.header
  let header: Record<string, string> = {}
  if (typeof headersFromJson === 'string') {
    try { header = JSON.parse(headersFromJson.replace(/'/g, '"')) } catch { /* ignore */ }
  } else if (headersFromJson && typeof headersFromJson === 'object') {
    for (const [k, v] of Object.entries(headersFromJson as Record<string, unknown>)) header[k] = String(v)
  }
  return {
    key: String(json.bookSourceUrl ?? ''),
    name: String(json.bookSourceName ?? json.bookSourceUrl ?? ''),
    group: String(json.bookSourceGroup ?? ''),
    json,
    header,
    searchUrl: String(json.searchUrl ?? ''),
    exploreUrl: String(json.exploreUrl ?? ''),
    ruleSearch: (json.ruleSearch ?? {}) as Record<string, unknown>,
    ruleBookInfo: (json.ruleBookInfo ?? {}) as Record<string, unknown>,
    ruleToc: (json.ruleToc ?? {}) as Record<string, unknown>,
    ruleContent: (json.ruleContent ?? {}) as Record<string, unknown>,
    shared: new Map<string, unknown>(),
  }
}

async function getSource(key: string): Promise<SourceInstance> {
  const meta = (await loadSourcesIndex()).find(s => s.key === key)
  if (!meta) throw new Error(`未安装书源：${key}`)
  if (!meta.enabled) throw new Error(`书源已停用：${meta.name}`)
  const cached = instances.get(key)
  if (cached) return cached
  const json = await loadSourceJson(key)
  if (!json) throw new Error(`书源数据丢失：${key}`)
  const src = normalizeSource(json)
  instances.set(key, src)
  return src
}

/* ---------------- 页面获取 → RuleContext ---------------- */
async function fetchContext(src: SourceInstance, urlRule: UrlRule): Promise<RuleContext & { res: RawResponse }> {
  const headers = { ...src.header, ...urlRule.headers }
  const res = await retryTransient(() => rawFetch(urlRule.url, { method: urlRule.method, body: urlRule.body, charset: urlRule.charset, headers }, MAX_TEXT_BYTES, src.key))
  if (res.status >= 400) throw new Error(`HTTP ${res.status}：${urlRule.url.slice(0, 100)}`)
  const trimmed = res.body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  const looksJson = /^\s*[[{]/.test(res.body)
  const ctx: RuleContext & { res: RawResponse } = {
    html: looksJson ? undefined : parseHtml(trimmed),
    data: looksJson ? safeJson(res.body) : undefined,
    raw: res.body,
    baseUrl: urlRule.url,
    sourceKey: src.key,
    shared: src.shared,
    vars: {},
    res,
  }
  return ctx
}
function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** 相对元素上下文：evalRule 需要 element 相对查询 —— 默认链与 CSS 都以 ctx.html 为根。
 *  这里构造一个仅含该元素子树的迷你 ctx。 */
function elementContext(parent: RuleContext, node: SimNode): RuleContext {
  return { ...parent, html: node, raw: serializeNode(node) }
}

/* ---------------- 结果归一 ---------------- */
interface BookCard { sourceKey: string; id: string; title: string; author: string; cover: string; intro: string; kind: string; lastChapter: string }
function asString(v: unknown): string { return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v) }
function normalizeBook(v: unknown, sourceKey: string): BookCard | null {
  if (!v || typeof v !== 'object') return null
  const o = plain(v)
  const title = asString(o?.name ?? o?.title ?? o?.bookName)
  const id = asString(o?.bookUrl ?? o?.id)
  if (!title && !id) return null
  return {
    sourceKey,
    id,
    title,
    author: asString(o?.author ?? ''),
    cover: asString(o?.coverUrl ?? o?.cover ?? ''),
    intro: asString(o?.intro ?? ''),
    kind: asString(o?.kind ?? ''),
    lastChapter: asString(o?.lastChapter ?? ''),
  }
}

/** 从 bookList 元素逐项提取字段 */
function extractBookFields(src: SourceInstance, ctx: RuleContext, items: SimNode[], rawItems: unknown[]): BookCard[] {
  const rules = src.ruleSearch
  const out: BookCard[] = []
  const list: Array<{ node?: SimNode; data?: unknown }> = items.length
    ? items.map(node => ({ node }))
    : rawItems.map(data => ({ data }))
  for (const item of list.slice(0, 60)) {
    const ictx: RuleContext = item.node
      ? elementContext(ctx, item.node)
      : { ...ctx, data: item.data, raw: typeof item.data === 'string' ? item.data : JSON.stringify(item.data) }
    const grab = (field: string): string => {
      const rule = rules[field]
      if (rule === undefined || rule === null || String(rule).trim() === '') return ''
      const r = evalRule(ictx, rule)
      return (r.text || '').trim()
    }
    const book: Record<string, unknown> = {}
    const name = grab('name')
    const bookUrl = grab('bookUrl')
    if (!name && !bookUrl) continue
    book.name = name
    book.bookUrl = resolveAgainst(ctx.baseUrl, bookUrl || ctx.baseUrl)
    book.author = grab('author')
    book.coverUrl = grab('coverUrl') ? resolveAgainst(ctx.baseUrl, grab('coverUrl')) : ''
    book.intro = grab('intro')
    book.kind = grab('kind')
    book.lastChapter = grab('lastChapter')
    const card = normalizeBook(book, src.key)
    if (card) out.push(card)
  }
  return out
}

/* ---------------- 业务管线 ---------------- */
async function runSearch(src: SourceInstance, keyword: string, page: number): Promise<{ books: BookCard[]; maxPage: number }> {
  if (!src.searchUrl.trim()) throw new Error(`源「${src.name}」不提供搜索（可切换其他源或用分类浏览）`)
  const kw = keyword.trim()
  if (!kw) return { books: [], maxPage: 0 }
  const base = parseUrlRule(src.searchUrl, src.key)
  const ctx0: RuleContext = { raw: '', baseUrl: src.key, sourceKey: src.key, shared: src.shared, vars: { key: kw, page } }
  const expanded = expandUrl(ctx0, base, kw, page)
  const ctx = await fetchContext(src, expanded)
  const listRule = src.ruleSearch.bookList
  if (listRule === undefined || String(listRule).trim() === '') throw new Error(`源「${src.name}」缺少搜索列表规则`)
  const r = evalRule(ctx, listRule)
  let books: BookCard[]
  if (r.elements.length) {
    books = extractBookFields(src, ctx, r.elements, [])
  } else if (ctx.data !== undefined) {
    // JSON 源：bookList 返回 JSONPath 字符串 → 逐项再提取
    const dataCtx: RuleContext = { ...ctx, data: ctx.data }
    const sub = jsonPathAll(ctx.data, r.text)
    books = extractBookFields(src, dataCtx, [], sub)
  } else {
    // 正则 chapterList 型（`:` 开头）：整体匹配 → 捕获组交给字段规则（$1…）
    const pairs = regexChapterPairs(ctx.raw, String(listRule))
    books = pairs.map(p => normalizeBook({ name: p[1], bookUrl: resolveAgainst(ctx.baseUrl, p[0] || '') }, src.key)).filter(Boolean) as BookCard[]
  }
  // 简单翻页启发：结果满一页且规则里带 {{page}} 视为还有下一页
  const maxPage = books.length >= 10 && /\{\{\s*page\s*\}\}/.test(src.searchUrl) ? page + 1 : page
  return { books, maxPage }
}

function jsonPathAll(data: unknown, path: string): unknown[] {
  // 把单值 jsonPath 扩展为列表（取数组字段）
  const expr = path.replace(/^\$\.?/, '')
  const segs = expr.split(/[.[]/).map(s => s.replace(/\]$/, '')).filter(s => s !== '')
  let current: unknown[] = [data]
  for (const seg of segs) {
    const next: unknown[] = []
    for (const item of current) {
      if (item === null || item === undefined) continue
      if (/^\d+$/.test(seg) && Array.isArray(item)) {
        if (item[Number(seg)] !== undefined) next.push(item[Number(seg)])
      } else if (typeof item === 'object' && !Array.isArray(item)) {
        const v = (item as Record<string, unknown>)[seg]
        if (Array.isArray(v)) next.push(...v)
        else if (v !== undefined) next.push(v)
      } else if (seg === '*' && Array.isArray(item)) {
        next.push(...item)
      }
    }
    current = next
  }
  return current
}

/** 正则 chapterList：返回捕获组配对（url/name 各一组时按顺序两两取） */
function regexChapterPairs(raw: string, ruleStr: string): Array<[string, string]> {
  const rule = ruleStr.replace(/^:/, '')
  const re = new RegExp(rule, 'g')
  const out: Array<[string, string]> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    if (m.length >= 3) out.push([m[1], m[2]])
    else if (m.length === 2) out.push(['', m[1]])
    if (out.length > 4000) break
  }
  return out
}

/** 发现页标题清单（exploreUrl JSON 数组或 :: 分隔） */
function exploreTitles(src: SourceInstance): Array<{ title: string; url: string }> {
  const text = src.exploreUrl.trim()
  if (!text) return []
  try {
    const arr = JSON.parse(text)
    if (Array.isArray(arr)) {
      return arr
        .filter((e: any) => e && typeof e === 'object' && e.title && e.url)
        .map((e: any) => ({ title: String(e.title), url: String(e.url) }))
    }
  } catch { /* fallthrough */ }
  return text.split(/\n+/).map(line => {
    const idx = line.indexOf('::')
    if (idx < 0) return null
    const title = line.slice(0, idx).trim()
    const url = line.slice(idx + 2).trim()
    return title && url ? { title, url } : null
  }).filter((x): x is { title: string; url: string } => x !== null)
}

async function runExplore(src: SourceInstance, title: string, page: number): Promise<{ books: BookCard[]; maxPage: number }> {
  const entries = exploreTitles(src)
  const entry = entries.find(e => e.title === title) ?? entries[0]
  if (!entry) return { books: [], maxPage: 0 }
  const base = parseUrlRule(entry.url, src.key)
  const ctx0: RuleContext = { raw: '', baseUrl: src.key, sourceKey: src.key, shared: src.shared, vars: { page } }
  const expanded = expandUrl(ctx0, base, '', page)
  const ctx = await fetchContext(src, expanded)
  // 分类页与搜索页布局常不同（如搜索是表格、分类是 ul 列表）：ruleExplore 优先，
  // 未声明时回退 ruleSearch —— 与 Legado 的 ruleExplore 可选语义一致。
  const exploreRules = (src.json.ruleExplore ?? null) as Record<string, unknown> | null
  const rules = exploreRules && Object.keys(exploreRules).length ? exploreRules : src.ruleSearch
  const listRule = rules.bookList
  if (listRule === undefined || String(listRule).trim() === '') return { books: [], maxPage: 0 }
  const r = evalRule(ctx, listRule)
  const books = r.elements.length
    ? extractBookFields({ ...src, ruleSearch: rules }, ctx, r.elements, [])
    : ctx.data !== undefined ? extractBookFields({ ...src, ruleSearch: rules }, ctx, [], jsonPathAll(ctx.data, r.text)) : []
  const maxPage = books.length >= 10 && /\{\{\s*page\s*\}\}/.test(entry.url) ? page + 1 : page
  return { books, maxPage }
}

interface BookInfo { title: string; author: string; cover: string; intro: string; kind: string; lastChapter: string; tocUrl: string }
async function runBookInfo(src: SourceInstance, bookUrl: string): Promise<BookInfo> {
  const urlRule: UrlRule = { url: resolveAgainst(src.key, bookUrl), method: 'GET' }
  const ctx = await fetchContext(src, urlRule)
  const rules = src.ruleBookInfo
  const grab = (field: string): string => {
    const rule = rules[field]
    if (rule === undefined || String(rule).trim() === '') return ''
    return evalRule(ctx, rule).text.trim()
  }
  const info: BookInfo = {
    title: grab('name') || grab('title'),
    author: grab('author'),
    cover: grab('coverUrl') || grab('cover') ? resolveAgainst(ctx.baseUrl, grab('coverUrl') || grab('cover')) : '',
    intro: grab('intro'),
    kind: grab('kind'),
    lastChapter: grab('lastChapter'),
    tocUrl: '',
  }
  const tocRaw = grab('tocUrl')
  info.tocUrl = !tocRaw || tocRaw === '/' ? ctx.baseUrl : resolveAgainst(ctx.baseUrl, tocRaw)
  // tocUrl 常见 <js> 场景外的基本形态已覆盖；无详情规则时退回搜索卡片信息（上层兜底）
  return info
}

interface ChapterItem { id: string; title: string }
async function runToc(src: SourceInstance, tocUrl: string, maxPages = 30): Promise<ChapterItem[]> {
  let url: string = resolveAgainst(src.key, tocUrl)
  const chapters: ChapterItem[] = []
  const seenUrls = new Set<string>()
  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    if (seenUrls.has(url)) break
    seenUrls.add(url)
    const urlRule: UrlRule = { url, method: 'GET' }
    const ctx = await fetchContext(src, urlRule)
    const rules = src.ruleToc
    const listRuleStr = String(rules.chapterList ?? '').trim()
    if (!listRuleStr) throw new Error(`源「${src.name}」缺少目录规则`)
    if (listRuleStr.startsWith(':')) {
      // 正则目录：规则里的 $n 引用捕获组
      const pairs = regexChapterPairs(ctx.raw, listRuleStr)
      const urlGroup = asString(rules.chapterUrl).trim()
      const nameGroup = asString(rules.chapterName).trim()
      const um = /^\$(\d)$/.exec(urlGroup)
      const nm = /^\$(\d)$/.exec(nameGroup)
      const re = new RegExp(listRuleStr.slice(1), 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(ctx.raw))) {
        const cu = um ? m[Number(um[1])] ?? '' : m[1] ?? ''
        const cn = nm ? m[Number(nm[1])] ?? '' : m[2] ?? ''
        if (cn) chapters.push({ id: resolveAgainst(ctx.baseUrl, cu), title: cn })
        if (chapters.length > 6000) break
      }
      break
    }
    const r = evalRule(ctx, listRuleStr)
    const items = r.elements
    const nameRule = rules.chapterName
    const urlRuleField = rules.chapterUrl
    const grabIn = (ictx: RuleContext, rule: unknown): string => {
      if (rule === undefined || rule === null || String(rule).trim() === '') return ''
      return evalRule(ictx, rule).text.trim()
    }
    let added = 0
    for (const node of items) {
      const ictx = elementContext(ctx, node)
      const name = grabIn(ictx, nameRule) || decodeEntities(nodeText(node)).trim()
      let chUrl = grabIn(ictx, urlRuleField)
      if (!chUrl) chUrl = node.attrs?.href ?? ''
      // chapterUrl 常带 @js: 拼 id —— 已由 runRuleJs 支持
      if (!name && !chUrl) continue
      chapters.push({ id: resolveAgainst(ctx.baseUrl, chUrl), title: name || chUrl })
      added++
      if (chapters.length > 6000) break
    }
    // 多页目录：nextTocUrl
    const nextRule = rules.nextTocUrl
    let nextUrl = ''
    if (nextRule !== undefined && String(nextRule).trim() !== '') {
      nextUrl = evalRule(ctx, nextRule).text.trim()
    }
    if (!nextUrl || !added) break
    url = resolveAgainst(ctx.baseUrl, nextUrl)
  }
  // 笔趣阁系常见「最新 9 章倒序块 + 正文全量」重复：按 URL 去重，保留最后一次出现（正文顺序）
  if (chapters.length) {
    const byId = new Map<string, ChapterItem & { _i: number }>()
    chapters.forEach((ch, i) => byId.set(ch.id, { ...ch, _i: i }))
    if (byId.size !== chapters.length) {
      const deduped = [...byId.values()].sort((a, b) => a._i - b._i).map(({ id, title }) => ({ id, title }))
      chapters.length = 0
      chapters.push(...deduped)
    }
  }
  // 目录通常按时间倒序插入最新几章 + 正文正序；检测整体倒序则翻转
  const reversed = /^第?[0-9零一二三四五六七八九十百千万]+[章节卷话回]/.test(chapters[0]?.title ?? '') && /^第?[0-9零一二三四五六七八九十百千万]+[章节卷话回]/.test(chapters[chapters.length - 1]?.title ?? '')
  const num = (t: string): number => {
    const m = /第?([0-9零一二三四五六七八九十百千万]+)[章节卷话回]/.exec(t)
    if (!m) return -1
    const s = m[1]
    if (/^\d+$/.test(s)) return Number(s)
    let v = 0
    const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    if (s === '十') return 10
    for (const seg of s.split('十')) {
      const d = seg.split('').reduce((acc, ch) => acc * 10 + (digits[ch] ?? 0), 0)
      v = v * 10 + (seg === '' ? 1 : d)
    }
    return v
  }
  if (reversed && chapters.length > 2) {
    const a = num(chapters[0].title), b = num(chapters[chapters.length - 1].title)
    if (a > b) chapters.reverse()
  }
  return chapters
}

/** 正文：content 规则 → 分段；nextContentUrl 翻页；replaceRegex 净化 */
async function runContent(src: SourceInstance, chapterUrl: string, chapterTitle: string, maxPages = 10): Promise<{ title: string; paragraphs: string[] }> {
  let url = resolveAgainst(src.key, chapterUrl)
  const segments: string[] = []
  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    const urlRule: UrlRule = { url, method: 'GET' }
    const ctx = await fetchContext(src, urlRule)
    const rules = src.ruleContent
    const contentRule = rules.content
    let html = ''
    if (contentRule !== undefined && String(contentRule).trim() !== '') {
      const r = evalRule(ctx, contentRule)
      html = r.text
      // css 规则返回 elements 无提取器时取 html
      if (!html && r.elements.length) html = r.elements.map(serializeNode).join('')
    } else {
      html = ctx.raw
    }
    segments.push(html)
    const nextRule = rules.nextContentUrl
    let next = ''
    if (nextRule !== undefined && String(nextRule).trim() !== '') next = evalRule(ctx, nextRule).text.trim()
    if (!next) break
    const resolved = resolveAgainst(ctx.baseUrl, next)
    if (resolved === url) break
    url = resolved
  }
  let text = segments.join('\n')
  // 源级净化（replaceRegex：##pattern[##replacement]，支持 {{book.durChapterTitle}} 占位）
  const replaceRegex = asString(src.ruleContent.replaceRegex).trim()
  if (replaceRegex) {
    const expandedRule = replaceRegex.replace(/\{\{\s*book\.durChapterTitle\s*\}\}/g, chapterTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const { rule, purify } = splitPurify(expandedRule)
    if (purify) text = applyPurify(text, purify)
    else if (rule) {
      try { text = text.replace(new RegExp(rule, 'g'), '') } catch { /* ignore */ }
    }
  }
  const paragraphs = toParagraphs(text)
  if (!paragraphs.length) throw new Error('本章没有解析到正文内容')
  return { title: chapterTitle, paragraphs }
}

/** HTML/纯文本 → 段落数组 */
function toParagraphs(text: string): string[] {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split(/\n+/)
    .map(s => s.replace(/[\u00a0\u3000]+/g, ' ').trim())
    .filter(s => s.length > 0 && !/^(请记住本书首发域名|最新网址|笔趣阁|www\..*?\.com|手机版|章节错误.*|加入书签.*|报错.*|天才一秒记住.*)$/i.test(s))
}

/* ---------------- 磁盘缓存层（整本离线） ----------------
 * 目录：{appDataPath}/novel-house/cache/
 *   texts/<sourceKey>/<sha256(bookId)>.json  单章正文 {title, paragraphs, at}
 *   meta/<sourceKey>/<bookId>.json           {book, chapters:{chId:{title,at}}, at}
 * 索引走 KV：cache.index（LRU 淘汰） */
const CACHE_LIMITS = { maxTotalBytes: 1024 * 1024 * 1024, maxPerBookBytes: 256 * 1024 * 1024 }

function cacheRoot(): string {
  if (!appDataPath) throw new Error('缓存目录不可用（缺少宿主数据目录）')
  return join(appDataPath, 'novel-house', 'cache')
}
const cacheTextDir = (sourceKey: string) => join(cacheRoot(), 'texts', safeDirName(sourceKey))
const cacheMetaDir = (sourceKey: string) => join(cacheRoot(), 'meta', safeDirName(sourceKey))
const cacheTextFile = (sourceKey: string, bookId: string, chId: string) => join(cacheTextDir(sourceKey), `${createHash('sha256').update(bookId + '|' + chId).digest('hex')}.json`)
const cacheMetaFile = (sourceKey: string, bookId: string) => join(cacheMetaDir(sourceKey), `${encodeURIComponent(bookId).replace(/[%.]/g, '_')}.json`)
function safeDirName(key: string): string {
  try { return new URL(key).host.replace(/[^\w.-]/g, '_') } catch { return createHash('sha256').update(key).digest('hex').slice(0, 16) }
}

interface CacheChapterMeta { title: string; at: number }
interface CacheMeta { book: { id: string; title: string; cover?: string }; info?: unknown; chapters: Record<string, CacheChapterMeta>; at: number; bytes?: number }
interface CacheIndexEntry { sourceKey: string; bookId: string; title: string; bytes: number; chapters: number; at: number }

async function readCacheMeta(sourceKey: string, bookId: string): Promise<CacheMeta | null> {
  try { return JSON.parse(await readFile(cacheMetaFile(sourceKey, bookId), 'utf-8')) as CacheMeta } catch { return null }
}
async function writeCacheMeta(sourceKey: string, bookId: string, meta: CacheMeta): Promise<void> {
  await mkdir(cacheMetaDir(sourceKey), { recursive: true })
  await writeFile(cacheMetaFile(sourceKey, bookId), JSON.stringify(meta))
}
async function loadCacheIndex(): Promise<CacheIndexEntry[]> {
  const v = await storageGet('cache.index')
  return Array.isArray(v) ? v as CacheIndexEntry[] : []
}
async function saveCacheIndex(list: CacheIndexEntry[]): Promise<void> {
  await storageSet('cache.index', list)
}
async function evictCacheIfNeeded(): Promise<void> {
  let list = await loadCacheIndex()
  let total = list.reduce((s, e) => s + (e.bytes || 0), 0)
  const victims = list.filter(e => total - (e.bytes || 0) >= CACHE_LIMITS.maxTotalBytes * 0.9).sort((a, b) => a.at - b.at)
  for (const v of victims) {
    await rm(cacheTextDir(v.sourceKey), { recursive: true, force: true }).catch(() => {})
    await rm(cacheMetaFile(v.sourceKey, v.bookId), { force: true }).catch(() => {})
    total -= v.bytes || 0
    list = list.filter(e => !(e.sourceKey === v.sourceKey && e.bookId === v.bookId))
  }
  if (victims.length) await saveCacheIndex(list)
}
function emitCacheProgress(sourceKey: string, bookId: string, payload: Record<string, unknown>): void {
  port.postMessage({ event: 'cache.progress', data: { sourceKey, bookId, ...payload } })
}

async function writeCacheText(sourceKey: string, bookId: string, chId: string, title: string, paragraphs: string[]): Promise<number> {
  const file = cacheTextFile(sourceKey, bookId, chId)
  await mkdir(cacheTextDir(sourceKey), { recursive: true })
  const payload = JSON.stringify({ title, paragraphs })
  await writeFile(file, payload)
  return Buffer.byteLength(payload)
}
function sniffImageMime(b: Buffer): string {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length > 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (b.length > 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (b.length > 12 && b.subarray(4, 8).toString('ascii') === 'ftyp') return 'image/avif'
  return 'image/jpeg'
}
/** 字节内容是否为图片（404 页会回 HTML，不能只看状态码） */
function sniffIsImage(b: Uint8Array): boolean {
  return sniffImageMime(Buffer.from(b)) !== undefined && (
    (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) ||
    (b.length > 4 && b.subarray(0, 4).toString('hex') === '89504e47') ||
    (b.length > 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a'))
  )
}

/* ---------------- 源安装 ---------------- */
const BUILTIN_REPOS = [
  { id: 'xiu2-yuedu', name: 'Xiu2 精选书源', url: 'https://raw.githubusercontent.com/Xiu2/yuedu/master/shuyuan' },
  { id: 'shidahuilueshe-yuedu', name: '狮子大佬聚合书源', url: 'https://shuyuan.miaogongzi.net/shuyuan' },
]
/** 内置源目录：生产包 runtime/sources/，dev 源码树回退 sources/ */
function builtinSourcesDir(): string | null {
  if (!packagePath) return null
  const packaged = join(packagePath, 'runtime', 'sources')
  if (existsSync(packaged)) return packaged
  return join(packagePath, 'sources')
}
function validateBookSourceJson(json: Record<string, unknown>): void {
  const url = String(json.bookSourceUrl ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('书源缺少合法的 bookSourceUrl')
  if (!String(json.bookSourceName ?? '').trim()) throw new Error('书源缺少 bookSourceName')
}
async function installSourceJson(json: Record<string, unknown>, url: string, updateKey?: string): Promise<BookSourceMeta> {
  validateBookSourceJson(json)
  const key = String(json.bookSourceUrl)
  if (updateKey && key !== updateKey) throw new Error(`更新后源 key 已变化（${key} ≠ ${updateKey}），请删除后重新安装`)
  const index = await loadSourcesIndex()
  const existing = index.find(s => s.key === key)
  if (existing && !updateKey) return existing   // 批量导入时已装视为成功
  const meta: BookSourceMeta = existing
    ? { ...existing, name: String(json.bookSourceName), url: url || existing.url, group: String(json.bookSourceGroup ?? ''), updatedAt: Date.now() }
    : { key, name: String(json.bookSourceName), version: '1.0.0', enabled: json.enabled === false ? false : true, url: url || undefined, group: String(json.bookSourceGroup ?? ''), installedAt: Date.now(), updatedAt: Date.now() }
  if (!existing) index.push(meta)
  await storageSet(`source.${key}`, JSON.stringify(json))
  await saveSourcesIndex()
  instances.delete(key)
  return meta
}
/** 解析导入文本：单个对象 / JSON 数组（批量） */
async function installFromText(text: string, nameHint: string, url: string): Promise<{ installed: number; names: string[] }> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('内容为空')
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch {
    throw new Error('不是合法的 Legado 书源 JSON（对象或数组）')
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const metas: BookSourceMeta[] = []
  let failed = 0
  for (const item of list) {
    if (!item || typeof item !== 'object') { failed++; continue }
    try {
      metas.push(await installSourceJson(item as Record<string, unknown>, url))
    } catch { failed++ }
  }
  if (!metas.length) throw new Error('没有可安装的书源（格式校验未通过）')
  return { installed: metas.length, names: metas.slice(0, 5).map(m => m.name), failed }
}
async function installBuiltinFiles(dir: string, files: string[]): Promise<BookSourceMeta[]> {
  const installed: BookSourceMeta[] = []
  for (const f of files) {
    try {
      const text = await readFile(join(dir, f), 'utf-8')
      const r = await installFromText(text, '', '')
      if (r.installed) installed.push(...(await loadSourcesIndex()).filter(s => r.names.includes(s.name)))
    } catch (e) {
      console.warn(`[novel-house] builtin source ${f} skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return installed
}

/* ---------------- backend.call 方法表 ---------------- */
const methods: Record<string, (args: unknown[]) => Promise<unknown>> = {
  /* ----- 源管理 ----- */
  'sources.list': async () => {
    let index = await loadSourcesIndex()
    // 首启自动安装全部内置书源（内置源均经人工验证，无成人内容）
    if (!index.length) {
      const dir = builtinSourcesDir()
      if (dir) {
        const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.json'))
        if (files.length) {
          console.log(`[novel-house] first launch: installing ${files.length} builtin source(s)`)
          try { await installBuiltinFiles(dir, files) } catch (e) {
            console.warn('[novel-house] builtin auto-install failed:', e instanceof Error ? e.message : String(e))
          }
          index = await loadSourcesIndex()
        }
      }
    }
    return index.map(s => ({ ...s }))
  },
  'sources.repos': async () => BUILTIN_REPOS,
  'sources.builtinList': async () => {
    const dir = builtinSourcesDir()
    if (!dir) return []
    const list = await readdir(dir).catch(() => [] as string[])
    return list.filter(f => f.endsWith('.json')).sort().map(f => {
      const key = f.slice(0, -5)
      let name = key
      let group = ''
      try {
        const json = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
        name = String(json.bookSourceName ?? key)
        group = String(json.bookSourceGroup ?? '')
      } catch { /* 命名回退 */ }
      return { key, name, group }
    })
  },
  'sources.installBuiltinOne': async ([key]) => {
    const dir = builtinSourcesDir()
    if (!dir) throw new Error('内置书源目录不可用，请重新安装插件包')
    const k = String(key)
    const text = await readFile(join(dir, `${k}.json`), 'utf-8').catch(() => null)
    if (!text) throw new Error(`没有这个内置书源：${k}`)
    const r = await installFromText(text, '', '')
    return r
  },
  'sources.installBuiltin': async () => {
    const dir = builtinSourcesDir()
    if (!dir) throw new Error('内置书源目录不可用，请重新安装插件包')
    const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.json')).sort()
    return installBuiltinFiles(dir, files)
  },
  /** URL 导入：支持单个书源 JSON、书源 JSON 数组、仓库 index */
  'sources.installFromUrl': async ([url]) => {
    const target = normalizeUrl(url)
    const res = await rawFetch(target, { headers: { accept: 'application/json,text/plain,*/*' } }, 24 * 1024 * 1024)
    if (res.status >= 400) throw new Error(`下载失败 HTTP ${res.status}`)
    return installFromText(res.body, '', target)
  },
  'sources.installFromText': async ([text]) => installFromText(String(text ?? ''), '', ''),
  'sources.setEnabled': async ([key, enabled]) => {
    const index = await loadSourcesIndex()
    const meta = index.find(s => s.key === String(key))
    if (!meta) throw new Error(`未安装书源：${String(key)}`)
    meta.enabled = Boolean(enabled)
    await saveSourcesIndex()
    if (!meta.enabled) instances.delete(String(key))
    return { ok: true }
  },
  'sources.remove': async ([key]) => {
    const k = String(key)
    const index = await loadSourcesIndex()
    if (!index.some(s => s.key === k)) throw new Error(`未安装书源：${k}`)
    sourcesIndex = index.filter(s => s.key !== k)
    await saveSourcesIndex()
    instances.delete(k)
    await storageSet(`source.${k}`, null)
    return { ok: true }
  },
  'sources.update': async ([key]) => {
    const k = String(key)
    const meta = (await loadSourcesIndex()).find(s => s.key === k)
    if (!meta) throw new Error(`未安装书源：${k}`)
    if (!meta.url) throw new Error(`源「${meta.name}」没有更新地址，请重新导入`)
    const res = await rawFetch(meta.url, { headers: { accept: 'application/json,text/plain,*/*' } }, 24 * 1024 * 1024)
    if (res.status >= 400) throw new Error(`更新失败 HTTP ${res.status}`)
    return installFromText(res.body, meta.name, meta.url)
  },
  /** 仓库索引：JSON 数组书源 → 逐项给 name/version/url（url=仓库地址，安装走整仓导入） */
  'sources.repoIndex': async ([repoUrl]) => {
    const target = normalizeUrl(repoUrl)
    const res = await rawFetch(target, { headers: { accept: 'application/json,text/plain,*/*' } }, 24 * 1024 * 1024)
    if (res.status >= 400) throw new Error(`拉取仓库失败 HTTP ${res.status}`)
    let list: unknown
    try { list = JSON.parse(res.body) } catch { throw new Error('仓库内容不是合法 JSON') }
    const entries = Array.isArray(list) ? list : null
    if (!entries) throw new Error('仓库格式不支持（需要书源 JSON 数组）')
    return (entries as Array<Record<string, unknown>>).map(e => ({
      name: String(e.bookSourceName ?? ''),
      version: String(e.bookSourceVersion ?? e.customOrder ?? ''),
      description: String(e.bookSourceGroup ?? e.bookSourceComment ?? '').slice(0, 120),
      url: target,            // 整仓地址（安装=批量导入后按 key 去重）
      originUrl: String(e.bookSourceUrl ?? ''),
    })).filter(e => e.name)
  },
  /* ----- 聚合（跨全部启用源） ----- */
  /** 聚合搜索：并行查所有启用源，每源完成即用 backend.event 推送（流式，搜一个出一个） */
  'search.aggregate': async ([keyword, page]) => {
    const kw = String(keyword ?? '').trim()
    if (!kw) return { started: 0 }
    const enabled = (await loadSourcesIndex()).filter(s => s.enabled)
    const pageNo = Number(page) || 1
    const eventName = `search.stream.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    void (async () => {
      let done = 0
      await Promise.all(enabled.map(async meta => {
        try {
          const result = await runSearch(await getSource(meta.key), kw, pageNo) as { books: BookCard[]; maxPage: number }
          port.postMessage({
            event: 'search.aggregate',
            data: { streamId: eventName, sourceKey: meta.key, sourceName: meta.name, books: result.books ?? [], maxPage: result.maxPage ?? 0, done: ++done, total: enabled.length },
          })
        } catch (e) {
          port.postMessage({
            event: 'search.aggregate',
            data: { streamId: eventName, sourceKey: meta.key, sourceName: meta.name, books: [], error: e instanceof Error ? e.message : String(e), done: ++done, total: enabled.length },
          })
        }
      }))
      port.postMessage({ event: 'search.aggregate', data: { streamId: eventName, finished: true, total: enabled.length } })
    })()
    return { streamId: eventName, total: enabled.length }
  },
  /** 聚合首页：每个源一个热门分区（并行，失败源跳过） */
  'home.aggregate': async () => {
    const enabled = (await loadSourcesIndex()).filter(s => s.enabled)
    const results = await Promise.allSettled(enabled.map(async meta => {
      const hot = await methods['home.hot']([meta.key]) as { sections: Array<{ title: string; books: BookCard[] }> }
      return { sourceKey: meta.key, sourceName: meta.name, sections: hot?.sections ?? [] }
    }))
    return results
      .map((r, i) => r.status === 'fulfilled'
        ? r.value
        : { sourceKey: enabled[i].key, sourceName: enabled[i].name, sections: [], error: String((r as PromiseRejectedResult).reason).slice(0, 80) })
      .filter(x => x.sections.length > 0 || x.error)
  },
  /** 聚合分类：每个源取其第一个分类的前若干本（并行，失败源跳过） */
  'explore.aggregate': async ([page]) => {
    const enabled = (await loadSourcesIndex()).filter(s => s.enabled)
    const pageNo = Number(page) || 1
    const results = await Promise.allSettled(enabled.map(async meta => {
      const src = await getSource(meta.key)
      const titles = exploreTitles(src)
      if (!titles.length) return { sourceKey: meta.key, sourceName: meta.name, option: '', books: [] as BookCard[] }
      const r = await runExplore(src, titles[0].title, pageNo)
      return { sourceKey: meta.key, sourceName: meta.name, option: titles[0].title, books: r.books ?? [] }
    }))
    return results
      .map((r, i) => r.status === 'fulfilled' ? r.value
        : { sourceKey: enabled[i].key, sourceName: enabled[i].name, option: '', books: [] as BookCard[], error: String((r as PromiseRejectedResult).reason).slice(0, 80) })
  },
  /** 聚合筛选维度：各源支持的分类选项（用于筛选栏） */
  'filters.aggregate': async () => {
    const enabled = (await loadSourcesIndex()).filter(s => s.enabled)
    return Promise.all(enabled.map(async meta => {
      const src = await getSource(meta.key).catch(() => null)
      if (!src) return { sourceKey: meta.key, sourceName: meta.name, categories: [] as Array<{ label: string; param: string }>, rankings: [] as string[] }
      // 书源的 exploreUrl 条目即分类清单
      const categories = exploreTitles(src).map(t => ({ label: t.title, param: t.title }))
      return { sourceKey: meta.key, sourceName: meta.name, categories: categories.slice(0, 30), rankings: [] }
    }))
  },
  /** 按筛选维度取内容（书源分类） */
  'filters.load': async ([key, kind, value, page]) => {
    const src = await getSource(String(key))
    return runExplore(src, String(value), Number(page) || 1)
  },
  /* ----- 发现 / 排行 / 搜索 ----- */
  'home.hot': async ([key]) => {
    const src = await getSource(String(key))
    const entries = exploreTitles(src)
    const sections: Array<{ title: string; books: BookCard[] }> = []
    for (const entry of entries.slice(0, 2)) {
      try {
        const r = await runExplore(src, entry.title, 1)
        if (r.books.length) sections.push({ title: entry.title, books: r.books })
      } catch { /* 单区失败跳过 */ }
    }
    if (!sections.length) {
      // 无 explore 的源退回搜索页热词不可行；尝试详情页无 —— 返回空让前端引导
    }
    return { sourceName: src.name, sections }
  },
  'explore.titles': async ([key]) => {
    const src = await getSource(String(key))
    return exploreTitles(src).map(e => ({ title: e.title }))
  },
  'explore.load': async ([key, title, page]) => {
    const src = await getSource(String(key))
    return runExplore(src, String(title ?? ''), Number(page) || 1)
  },
  'ranking.options': async ([key]) => {
    const src = await getSource(String(key))
    return exploreTitles(src).map(e => e.title)
  },
  'ranking.load': async ([key, option, page]) => {
    const src = await getSource(String(key))
    return runExplore(src, String(option ?? ''), Number(page) || 1)
  },
  'search.load': async ([key, keyword, page]) => {
    const src = await getSource(String(key))
    return runSearch(src, String(keyword ?? ''), Number(page) || 1)
  },
  /* ----- 详情 / 目录 / 正文 ----- */
  'book.info': async ([key, bookUrl]) => {
    const src = await getSource(String(key))
    const info = await runBookInfo(src, String(bookUrl))
    if (!info.title) {
      // 详情页规则缺失时尽力从页面 title 提取
      try {
        const res = await rawFetch(resolveAgainst(src.key, String(bookUrl)), { headers: src.header }, MAX_TEXT_BYTES, src.key)
        const m = /<title>([^<]+)<\/title>/i.exec(res.body)
        if (m) info.title = decodeEntities(m[1]).split(/[_|·]/)[0].trim() || info.title
      } catch { /* ignore */ }
    }
    return { ...info, sourceKey: src.key, id: resolveAgainst(src.key, String(bookUrl)) }
  },
  'book.toc': async ([key, bookUrl, tocUrl]) => {
    const src = await getSource(String(key))
    const chapters = await runToc(src, String(tocUrl || bookUrl || ''))
    if (!chapters.length) throw new Error('没有解析到目录章节')
    // 目录退化检测：站方把章节 href 改空（防抓）时只会剩下 1-2 条真链接，
    // 静默展示 1 章会让用户以为全书只有一章——明确告知换源。
    const distinct = new Set(chapters.map(c => c.id)).size
    if (distinct < 3) {
      throw new Error(`源「${src.name}」目录只解析出 ${distinct} 章，该站可能已限制抓取，请换一个源`)
    }
    return { chapters }
  },
  'book.content': async ([key, bookUrl, chId, chTitle]) => {
    const src = await getSource(String(key))
    // 缓存优先
    if (appDataPath) {
      const cached = await readCacheText(src.key, String(bookUrl), String(chId))
      if (cached) return { ...cached, cached: true }
    }
    const result = await runContent(src, String(chId), String(chTitle ?? ''))
    return { ...result, cached: false }
  },
  /* ----- 封面代理 ----- */
  /** 封面三级回退：传入 URL → 笔趣阁固定路径（bookId `a_b` → /files/article/image/{a}/{b}/{b}s.jpg）→ 详情页 og:image */
  'cover.load': async ([key, url, bookUrl]) => {
    const src = await getSource(String(key))
    const candidates: string[] = []
    if (String(url ?? '').trim()) candidates.push(resolveAgainst(src.key, String(url)))
    // 笔趣阁系固定封面路径（b5200/b520 同模板）
    const m = /\/(\d+)_(\d+)\/?$/.exec(String(bookUrl ?? ''))
    if (m) candidates.push(resolveAgainst(src.key, `/files/article/image/${m[1]}/${m[2]}/${m[2]}s.jpg`))
    const fetchImage = async (target: string) => {
      const res = await rawFetch(target, { headers: { ...src.header, referer: src.key } }, MAX_IMAGE_BYTES, src.key)
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`)
      const mime = (res.headers['content-type'] ?? '').split(';')[0].trim()
      if (!/image/.test(mime) && !sniffIsImage(res.bytes)) throw new Error('非图片内容')
      return { mime: /image/.test(mime) ? mime : sniffImageMime(Buffer.from(res.bytes)), base64: Buffer.from(res.bytes).toString('base64') }
    }
    for (const target of candidates) {
      try { return await retryTransient(() => fetchImage(target)) } catch { /* 试下一个候选 */ }
    }
    // 最后回退：详情页 og:image
    if (String(bookUrl ?? '').trim()) {
      try {
        const info = await runBookInfo(src, String(bookUrl))
        if (info.cover) return await retryTransient(() => fetchImage(info.cover))
      } catch { /* 无封面 */ }
    }
    throw new Error('封面加载失败')
  },
  /* ----- 缓存 ----- */
  'cache.chapter': async ([key, bookUrl, chId, chTitle]) => {
    const src = await getSource(String(key))
    return cacheChapterInternal(src, String(bookUrl), String(chId), String(chTitle ?? ''))
  },
  'cache.book': async ([key, bookUrl, title, author, cover, tocUrl]) => {
    const src = await getSource(String(key))
    const bId = String(bookUrl)
    const chapters = await runToc(src, String(tocUrl || bId))
    if (!chapters.length) throw new Error('该书没有可缓存的章节')
    emitCacheProgress(src.key, bId, { phase: 'start', totalChapters: chapters.length, doneChapters: 0 })
    let done = 0, failed = 0
    for (const ch of chapters) {
      try {
        await cacheChapterInternal(src, bId, ch.id, ch.title, () => ({ title, author, cover }))
        done++
      } catch { failed++ }
      emitCacheProgress(src.key, bId, { phase: 'chapter', totalChapters: chapters.length, doneChapters: done, failedChapters: failed, chId: ch.id, chTitle: ch.title })
    }
    const meta = await readCacheMeta(src.key, bId)
    await refreshCacheIndexEntry(src.key, bId, meta, title)
    emitCacheProgress(src.key, bId, { phase: 'done', totalChapters: chapters.length, doneChapters: done, failedChapters: failed })
    return { chapters: chapters.length, done, failed }
  },
  'cache.status': async ([key, bookUrl]) => {
    const meta = await readCacheMeta(String(key), String(bookUrl))
    if (!meta) return { cached: false, chapters: [] as string[] }
    return { cached: true, chapters: Object.keys(meta.chapters), title: meta.book?.title, bytes: meta.bytes ?? 0 }
  },
  'cache.list': async () => (await loadCacheIndex()).sort((a, b) => b.at - a.at),
  'cache.remove': async ([key, bookUrl]) => {
    const k = String(key), b = String(bookUrl ?? '')
    if (b) {
      await rm(cacheTextDir(k), { recursive: true, force: true }).catch(() => {})
      await rm(cacheMetaFile(k, b), { force: true }).catch(() => {})
      await saveCacheIndex((await loadCacheIndex()).filter(e => !(e.sourceKey === k && e.bookId === b)))
    } else {
      await rm(cacheRoot(), { recursive: true, force: true }).catch(() => {})
      await saveCacheIndex([])
    }
    return { ok: true }
  },
  /* ----- 代理 ----- */
  'net.getProxy': async () => {
    const cfg = await loadProxyConfig()
    return { ...cfg, effective: proxyDispatcher ? currentEnvProxy() || '(manual)' : '' }
  },
  'net.setProxy': async ([mode, url]) => {
    const m = String(mode) === 'manual' ? 'manual' : String(mode) === 'direct' ? 'direct' : 'shell'
    const u = String(url ?? '')
    if (m === 'manual' && !/^https?:\/\//i.test(u)) throw new Error('代理地址需以 http:// 或 https:// 开头')
    const result = applyProxy(m, u)
    await storageSet('proxy.config', { mode: m, url: u })
    return result
  },
  'history.clear': async () => {
    await storageSet('history', [])
    return { ok: true }
  },
  /* ----- 调试（仅 dev 冒烟；发布包不可达：无 UI 入口） ----- */
  'debug.rule': async ([key, url, rule]) => {
    const src = await getSource(String(key))
    const res = await rawFetch(resolveAgainst(src.key, String(url)), { headers: src.header }, MAX_TEXT_BYTES, src.key)
    const trimmed = res.body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    const ctx: RuleContext = {
      html: parseHtml(trimmed), raw: res.body, baseUrl: resolveAgainst(src.key, String(url)),
      sourceKey: src.key, shared: src.shared, vars: {},
    }
    const r = evalRule(ctx, String(rule))
    return { elements: r.elements.length, text: r.text.slice(0, 300), firstAttrs: r.elements[0]?.attrs ?? null, firstText: r.elements[0] ? decodeEntities(nodeText(r.elements[0])).slice(0, 60) : '' }
  },
}

async function readCacheText(sourceKey: string, bookId: string, chId: string): Promise<{ title: string; paragraphs: string[] } | null> {
  try {
    const raw = await readFile(cacheTextFile(sourceKey, bookId, chId), 'utf-8')
    return JSON.parse(raw) as { title: string; paragraphs: string[] }
  } catch { return null }
}

async function cacheChapterInternal(src: SourceInstance, bookId: string, chId: string, chTitle: string, metaLoader?: () => { title?: string; author?: string; cover?: string }): Promise<{ paragraphs: number }> {
  const result = await runContent(src, chId, chTitle)
  const bytes = await writeCacheText(src.key, bookId, chId, chTitle, result.paragraphs)
  const meta = (await readCacheMeta(src.key, bookId)) ?? {
    book: { id: bookId, title: bookId }, chapters: {}, at: Date.now(),
  }
  if (metaLoader) {
    const d = metaLoader()
    if (d?.title) meta.book.title = d.title
    if (d?.cover) meta.book.cover = d.cover
  }
  meta.chapters[chId] = { title: chTitle, at: Date.now() }
  meta.at = Date.now()
  meta.bytes = (meta.bytes ?? 0) + bytes
  if ((meta.bytes ?? 0) > CACHE_LIMITS.maxPerBookBytes) throw new Error('单书缓存超出上限')
  await writeCacheMeta(src.key, bookId, meta)
  await refreshCacheIndexEntry(src.key, bookId, meta)
  await evictCacheIfNeeded()
  return { paragraphs: result.paragraphs.length }
}
async function refreshCacheIndexEntry(sourceKey: string, bookId: string, meta: CacheMeta | null, titleHint?: string): Promise<void> {
  const list = await loadCacheIndex()
  const rest = list.filter(e => !(e.sourceKey === sourceKey && e.bookId === bookId))
  if (meta && Object.keys(meta.chapters).length) {
    rest.push({
      sourceKey, bookId,
      title: meta.book?.title ?? titleHint ?? bookId,
      bytes: meta.bytes ?? 0,
      chapters: Object.keys(meta.chapters).length,
      at: meta.at,
    })
  }
  await saveCacheIndex(rest)
}

/* ---------------- 进程协议 ---------------- */
port.on('message', ({ data: request }) => {
  if (request.type === 'init') {
    if (!owner && typeof request.pluginId === 'string') owner = request.pluginId
    const ctx = (request as { context?: { protocolVersion?: number; packagePath?: string; appDataPath?: string } }).context
    if (ctx && ctx.protocolVersion !== 1) throw new Error(`Unsupported backend protocol version: ${ctx.protocolVersion}`)
    if (ctx?.packagePath) packagePath = ctx.packagePath
    if (ctx?.appDataPath) appDataPath = ctx.appDataPath
    void loadCookieJar().catch(() => { /* best effort */ })
    void loadProxyConfig().then(cfg => {
      if (cfg.mode !== 'shell') applyProxy(cfg.mode, cfg.url)
    }).catch(() => { /* best effort */ })
    return
  }
  if (request.type === 'shutdown') {
    port.postMessage({ type: 'shutdown.complete', ok: true })
    process.exit(0)
  }
  if (request.type === 'host.response') {
    const pending = hostControls.get(request.id!)
    if (pending) {
      hostControls.delete(request.id!)
      clearTimeout(pending.timer)
      if (request.ok) pending.resolve(request.data)
      else pending.reject(new Error(String(request.error ?? '宿主控制请求失败')))
    }
    return
  }
  if (!Number.isSafeInteger(request.id)) return
  void (async () => {
    if (!owner || request.pluginId !== owner) throw new Error('Invalid backend owner')
    const handler = methods[request.method!]
    if (!handler) throw new Error(`Unknown backend method: ${request.method}`)
    return handler(request.args ?? [])
  })().then(
    data => port.postMessage({ id: request.id, ok: true, data }),
    error => port.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  )
})
