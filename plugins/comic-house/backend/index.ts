/**
 * comic-house 后端 —— utilityProcess 入口。
 * 职责：Venera/VeneraNext 格式漫画源的加载与执行（node:vm 沙箱）、
 * 源管理（安装/删除/启停/更新）、跨源业务调用（搜索/排行/详情/章节）、
 * 图片代理（取图转 base64 回前端，绕过页面 CSP img-src 限制）。
 *
 * 存储模型（全部走 host.request storage.get/set，宿主统一插件 KV）：
 *  - `sources.index`   已装源索引 [{key,name,version,enabled,url,installedAt,updatedAt}]
 *  - `source.<key>`    源脚本本体（UTF-8 文本）
 *  - `sourceData.<key>.<dataKey>`  源脚本 this.loadData/saveData 私有数据
 *  - `cookies.jar`     源站点 cookie（按源 key 隔离）
 *
 * 沙箱全局按 Venera-Next doc/api 实现：Network/Convert/HtmlDocument/Cookie/
 * Comic/ComicDetails/Comment + APP/randomInt/createUuid/console/log/setTimeout。
 * 与 Venera 原版差异做容错（subTitle 别名、loadNext 兼容、同步 getCookies）。
 *
 * 安全约定：
 *  - 源脚本在 node:vm 隔离上下文执行，无 require/process/fs/import；
 *  - 所有出网请求由后端真实 fetch 代发（超时/体积/并发上限）；
 *  - 慢调用一律 withTimeout 墙钟限时，避免源脚本卡死后端请求。
 */
import { createHash, createHmac, createCipheriv, createDecipheriv, privateDecrypt, randomInt as nodeRandomInt, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { Agent, ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'

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
/** 插件包根（init 时由 BackendContext 注入）；内置源脚本位于 runtime/sources/ */
let packagePath = ''
/** 宿主授权数据目录（init 时注入）；磁盘缓存放 {appDataPath}/comic-house/cache/ */
let appDataPath = ''

/* ---------------- 代理 ----------------
 * 默认跟随壳代理（宿主注入的 HTTP(S)_PROXY 环境快照，Node fetch 不读 env，
 * 用 undici ProxyAgent 作为全局 dispatcher）；用户可在设置里手动指定代理地址。
 * 配置持久化在 KV proxy.config = { mode: 'shell' | 'manual' | 'direct', url: '' } */
let proxyDispatcher: ProxyAgent | null = null
function currentEnvProxy(): string {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || ''
}
/** 环境无代理时读系统代理（macOS scutil / Windows 注册表）；失败返回空 */
function systemProxy(): string {
  try {
    if (process.platform === 'darwin') {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 })
      const enabled = /HTTPSEnable\s*:\s*1/.test(out) || /HTTPEnable\s*:\s*1/.test(out)
      if (!enabled) return ''
      const host = /HTTPSProxy\s*:\s*(\S+)/.exec(out)?.[1] ?? /HTTPProxy\s*:\s*(\S+)/.exec(out)?.[1]
      const port = /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1] ?? /HTTPPort\s*:\s*(\d+)/.exec(out)?.[1]
      return host && port ? `http://${host}:${port}` : ''
    }
    if (process.platform === 'win32') {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', timeout: 1500 })
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(out)
      const server = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out)?.[1]
      if (!enabled || !server) return ''
      return server.includes('://') ? server : `http://${server}`
    }
  } catch { /* 读取失败按直连 */ }
  return ''
}
/** 实际可用代理：环境变量优先，其次系统代理 */
function effectiveProxy(): string {
  return currentEnvProxy() || systemProxy()
}
function applyProxy(mode: string, manualUrl: string): { mode: string; url: string; effective: string } {
  const url = mode === 'manual' ? manualUrl.trim() : ''
  const effective = mode === 'direct' ? '' : mode === 'manual' ? url : effectiveProxy()
  try {
    if (effective) {
      // ProxyAgent 对带尾斜杠的地址兼容性差，统一规范化
      const normalized = effective.replace(/\/+$/, '')
      proxyDispatcher = new ProxyAgent(normalized)
      setGlobalDispatcher(proxyDispatcher)
      console.log('[comic-house] proxy enabled:', normalized)
    } else {
      proxyDispatcher = null
      // 直连必须换回普通 Agent；传 undefined 会让全局 dispatcher 非法，后续 fetch 全部异常
      setGlobalDispatcher(new Agent())
      console.log('[comic-house] proxy disabled (direct)')
    }
  } catch (error) {
    console.warn('[comic-house] proxy apply failed:', error instanceof Error ? error.message : String(error))
  }
  return { mode, url, effective }
}
async function loadProxyConfig(): Promise<{ mode: string; url: string }> {
  const v = await storageGet('proxy.config').catch(() => null)
  return v && typeof v === 'object' ? { mode: String((v as any).mode || 'shell'), url: String((v as any).url || '') } : { mode: 'shell', url: '' }
}
// 启动默认：跟随壳代理（异步恢复用户自定义配置）
{
  const p = effectiveProxy()
  if (p) applyProxy('shell', '')
  else applyProxy('direct', '')
}

/* ---------------- 进程级兜底 ----------------
 * 源脚本是第三方代码，init() 里 fire-and-forget 的网络调用失败会变成
 * unhandledRejection；Node 默认行为是杀进程，会连累整个后端。
 * 源引发的未处理异常只记日志，不让宿主重启插件。 */
process.on('unhandledRejection', reason => {
  console.warn('[comic-house] unhandled rejection from source script:', reason instanceof Error ? reason.message : String(reason))
})
process.on('uncaughtException', error => {
  console.error('[comic-house] uncaught exception from source script:', error instanceof Error ? error.stack : String(error))
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
  // 宿主 serializeJson 只接受纯 JSON（拒绝 undefined/NaN/类实例/循环）；
  // 统一在此净化，避免各调用点遗漏导致 "storage requires finite JSON data"。
  const safe = toPlainJson(value)
  if (safe === undefined) return
  await hostRequest('storage.set', { key, value: safe })
}
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
    promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))) })
  })
}

/** 瞬时错误自动重试：源站风控码（210 等）/5xx/网络抖动，指数退避重试 2 次 */
async function retryTransient<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      const msg = e instanceof Error ? e.message : String(e)
      const transient = /(status code:?\s*(210|5\d\d))|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|timeout|520|521|522|523|524/i.test(msg)
      if (!transient || i === attempts - 1) throw e
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)))
    }
  }
  throw lastError
}

/* ---------------- 网络层 ---------------- */
const HTTP_TIMEOUT_MS = 20_000
const MAX_TEXT_BYTES = 8 * 1024 * 1024      // 文本响应上限（列表/详情页足够）
// 原图上限不妥协画质：允许到 32 MiB，超过宿主单条 8 MiB 回复预算时自动分块返回。
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
/** 单条回复 base64 分块大小：留足 JSON 包装余量（宿主上限 8 MiB） */
const IMAGE_CHUNK_BASE64 = 5 * 1024 * 1024
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
  if (typeof input !== 'string' || !input.trim()) throw new Error('URL 不能为空')
  const url = input.trim()
  if (!/^https?:\/\//i.test(url)) throw new Error(`仅支持 http(s) 地址：${input.slice(0, 80)}`)
  return url
}

interface RawResponse { status: number; headers: Record<string, string>; body: string; bytes: Uint8Array }

/** 源脚本站点相对地址解析（源内常写 "/api/…"）；探测期 baseUrl 由调用方先注入 */
function resolveAgainst(baseUrl: string | undefined, url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  if (baseUrl) {
    try { return new URL(url, baseUrl).toString() } catch { /* fallthrough */ }
  }
  return url
}

/** 沙箱 Map/普通对象的鸭子判断（跨上下文不能用 instanceof） */
function isMapLike(v: unknown): v is Map<string, unknown> {
  return !!v && typeof v === 'object'
    && typeof (v as Map<string, unknown>).entries === 'function'
    && typeof (v as Map<string, unknown>).get === 'function'
    && typeof (v as Map<string, unknown>).size === 'number'
}
function headersToPlain(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object') return out
  if (isMapLike(input)) {
    for (const [k, v] of input.entries()) out[String(k)] = String(v)
    return out
  }
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return out
}

async function rawFetch(url: string, method: string, headers: Record<string, string> | undefined, data: unknown, maxBytes: number, cookieSourceKey?: string): Promise<RawResponse> {
  const target = normalizeUrl(url)
  await acquireSlot()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const h = new Headers()
    for (const [k, v] of Object.entries(headers ?? {})) h.set(k, v)
    if (!h.has('user-agent')) h.set('user-agent', UA)
    if (cookieSourceKey) {
      const cookie = cookieHeaderFor(cookieSourceKey, target)
      if (cookie && !h.has('cookie')) h.set('cookie', cookie)
    }
    const init: RequestInit = { method: method.toUpperCase(), signal: controller.signal, redirect: 'follow', headers: h }
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
    if (cookieSourceKey) storeCookiesFromResponse(cookieSourceKey, target, res.headers)
    const body = new TextDecoder('utf-8').decode(buf)
    return { status: res.status, headers: responseHeaders, body, bytes: buf }
  } finally {
    clearTimeout(timer)
    releaseSlot()
  }
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

/* ---------------- 源 cookie 存储（内存 + KV 持久化） ---------------- */
type CookieList = Array<{ name: string; value: string; domain: string }>
type CookieJar = Record<string, Record<string, CookieList>>   // sourceKey -> origin -> cookies
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

/* ---------------- Convert API（Venera 兼容） ---------------- */
function coerceBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (Array.isArray(input)) return Uint8Array.from(input as number[])
  if (typeof input === 'string') return new TextEncoder().encode(input)
  throw new Error('参数必须是 ArrayBuffer/字节数组')
}
function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
function normalizeHashName(name: string): string {
  const n = name.toLowerCase().replace(/-/g, '')
  return ['md5', 'sha1', 'sha256', 'sha512'].includes(n) ? n : 'md5'
}

/** GBK 反查表：懒构建（约 2.4 万码位，<50ms），此后 O(1) */
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

function makeConvertApi() {
  const digest = (algo: string) => (bytes: unknown): ArrayBuffer =>
    bytesToArrayBuffer(createHash(algo).update(coerceBytes(bytes)).digest())
  const keyIvDecipher = (mode: string, value: unknown, key: unknown, iv: unknown, isEncrypt: boolean): ArrayBuffer => {
    const k = coerceBytes(key)
    const algo = `aes-${k.byteLength * 8}-${mode}` as const
    const cipher = mode === 'ecb'
      ? (isEncrypt ? createCipheriv(algo, k, null) : createDecipheriv(algo, k, null))
      : (isEncrypt ? createCipheriv(algo, k, coerceBytes(iv)) : createDecipheriv(algo, k, coerceBytes(iv)))
    const data = Buffer.from(coerceBytes(value))
    return bytesToArrayBuffer(Buffer.concat([cipher.update(data), cipher.final()]))
  }
  return {
    encodeUtf8: (text: unknown): ArrayBuffer => bytesToArrayBuffer(new TextEncoder().encode(String(text ?? ''))),
    decodeUtf8: (bytes: unknown): string => decodeWith(coerceBytes(bytes), 'utf-8'),
    encodeGbk: (text: unknown): ArrayBuffer => bytesToArrayBuffer(gbkEncode(String(text ?? ''))),
    decodeGbk: (bytes: unknown): string => decodeWith(coerceBytes(bytes), 'gbk'),
    encodeBase64: (bytes: unknown): string => Buffer.from(coerceBytes(bytes)).toString('base64'),
    decodeBase64: (text: unknown): ArrayBuffer => bytesToArrayBuffer(Buffer.from(String(text ?? ''), 'base64')),
    hexEncode: (bytes: unknown): string => Buffer.from(coerceBytes(bytes)).toString('hex'),
    md5: digest('md5'),
    sha1: digest('sha1'),
    sha256: digest('sha256'),
    sha512: digest('sha512'),
    hmac: (key: unknown, value: unknown, hash: unknown): ArrayBuffer => {
      const algo = normalizeHashName(String(hash ?? 'md5'))
      return bytesToArrayBuffer(createHmac(algo, coerceBytes(key)).update(coerceBytes(value)).digest())
    },
    hmacString: (key: unknown, value: unknown, hash: unknown): string => {
      const algo = normalizeHashName(String(hash ?? 'md5'))
      return createHmac(algo, coerceBytes(key)).update(coerceBytes(value)).digest('hex')
    },
    decryptAesEcb: (v: unknown, k: unknown) => keyIvDecipher('ecb', v, k, undefined, false),
    decryptAesCbc: (v: unknown, k: unknown, iv: unknown) => keyIvDecipher('cbc', v, k, iv, false),
    decryptAesCfb: (v: unknown, k: unknown, iv: unknown, _bs?: unknown) => keyIvDecipher('cfb', v, k, iv, false),
    decryptAesOfb: (v: unknown, k: unknown, _bs?: unknown) => keyIvDecipher('ofb', v, k, undefined, false),
    encryptAesEcb: (v: unknown, k: unknown) => keyIvDecipher('ecb', v, k, undefined, true),
    encryptAesCbc: (v: unknown, k: unknown, iv: unknown) => keyIvDecipher('cbc', v, k, iv, true),
    encryptAesCfb: (v: unknown, k: unknown, iv: unknown, _bs?: unknown) => keyIvDecipher('cfb', v, k, iv, true),
    encryptAesOfb: (v: unknown, k: unknown, _bs?: unknown) => keyIvDecipher('ofb', v, k, undefined, true),
    decryptRsa: (v: unknown, k: unknown): ArrayBuffer => {
      const keyText = String(k ?? '')
      const pem = keyText.includes('-----BEGIN')
        ? keyText
        : `-----BEGIN PRIVATE KEY-----\n${keyText}\n-----END PRIVATE KEY-----`
      return bytesToArrayBuffer(privateDecrypt(pem, Buffer.from(coerceBytes(v))))
    },
  }
}

/* ---------------- HtmlDocument 兼容层（手写解析器 + 极简 CSS 选择器） ---------------- */
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
function selectMatches(root: SimNode, selector: string): SimNode[] {
  const groups = selector.split(',').map(s => s.trim()).filter(Boolean)
  const out: SimNode[] = []
  const seen = new Set<SimNode>()
  for (const group of groups) {
    const parts = group.split(/\s+/).filter(Boolean)
    out.push(...walkSelect(root, parts, 0, seen))
  }
  return out
}
function walkSelect(node: SimNode, parts: string[], index: number, seen: Set<SimNode>): SimNode[] {
  if (index >= parts.length) {
    if (node.type === 'element' && node.name !== 'root' && !seen.has(node)) { seen.add(node); return [node] }
    return []
  }
  const results: SimNode[] = []
  const candidates = node.type === 'element' && node.name !== 'root' ? [node, ...descendants(node)] : descendants(node)
  for (const cand of candidates) {
    if (matchesSimple(cand, parts[index])) results.push(...walkSelect(cand, parts, index + 1, seen))
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
function nodeText(node: SimNode): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.children ?? []).map(nodeText).join('')
}
function serializeNode(node: SimNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'comment') return `<!--${node.text ?? ''}-->`
  const attrs = Object.entries(node.attrs ?? {}).map(([k, v]) => v === '' ? k : `${k}="${v.replace(/"/g, '&quot;')}"`).join(' ')
  const inner = (node.children ?? []).map(serializeNode).join('')
  return attrs ? `<${node.name} ${attrs}>${inner}</${node.name}>` : `<${node.name}>${inner}</${node.name}>`
}

class HtmlElement {
  constructor(private node: SimNode) {}
  get text(): string { return nodeText(this.node).trim() }
  get innerHTML(): string { return (this.node.children ?? []).map(serializeNode).join('') }
  get outerHTML(): string { return serializeNode(this.node) }
  get attributes(): Record<string, string> { return { ...(this.node.attrs ?? {}) } }
  get classNames(): string[] { return (this.node.attrs?.class ?? '').split(/\s+/).filter(Boolean) }
  get id(): string { return this.node.attrs?.id ?? '' }
  get localName(): string { return this.node.name ?? '' }
  get children(): HtmlElement[] { return (this.node.children ?? []).filter(c => c.type === 'element').map(c => new HtmlElement(c)) }
  get nodes(): Array<{ type: string; text: string; toElement(): HtmlElement | null }> {
    return (this.node.children ?? []).map(c => ({
      type: c.type,
      text: c.type === 'text' ? (c.text ?? '') : nodeText(c),
      toElement: () => c.type === 'element' ? new HtmlElement(c) : null,
    }))
  }
  get parent(): HtmlElement | null { return null }
  get previousElementSibling(): HtmlElement | null { return null }
  get nextElementSibling(): HtmlElement | null { return null }
  querySelector(selector: string): HtmlElement | null {
    const found = selectMatches(this.node, selector)
    return found.length ? new HtmlElement(found[0]) : null
  }
  querySelectorAll(selector: string): HtmlElement[] { return selectMatches(this.node, selector).map(n => new HtmlElement(n)) }
  getAttribute(name: string): string | null { return this.node.attrs?.[name.toLowerCase()] ?? null }
  dispose(): void { /* 解析器无原生资源 */ }
}
class HtmlDocument {
  private root: SimNode
  constructor(html: string) { this.root = parseHtml(String(html ?? '')) }
  querySelector(selector: string): HtmlElement | null {
    const found = selectMatches(this.root, selector)
    return found.length ? new HtmlElement(found[0]) : null
  }
  querySelectorAll(selector: string): HtmlElement[] { return selectMatches(this.root, selector).map(n => new HtmlElement(n)) }
  getElementById(id: string): HtmlElement | null {
    const escaped = String(id).replace(/"/g, '\\"')
    const found = selectMatches(this.root, `[id="${escaped}"]`)
    return found.length ? new HtmlElement(found[0]) : null
  }
  dispose(): void { this.root = { type: 'element', name: 'root', attrs: {}, children: [] } }
}

/* ---------------- 跨上下文值归一（vm 对象 → 纯 JSON，支持 Map/Set） ---------------- */
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
  if (typeof (value as any).toElement === 'function') {
    // HtmlElement/HtmlNode：取文本
    return String((value as any).text ?? '')
  }
  if (isMapLike(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of value.entries()) out[String(k)] = plain(v, depth + 1)
    return out
  }
  if (typeof (value as any).size === 'number' && typeof (value as any).has === 'function' && typeof (value as any).add === 'function') {
    // Set-like
    return [...(value as Set<unknown>)].map(v => plain(v, depth + 1))
  }
  if (Array.isArray(value)) return value.map(v => plain(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = plain(v, depth + 1)
  return out
}

/* ---------------- 磁盘缓存层（整部漫画离线化） ----------------
 * 目录：{appDataPath}/comic-house/cache/
 *   images/<sourceKey>/<sha256(url)>.<ext>   图片字节
 *   meta/<sourceKey>/<comicId>.json          {comic, chapters:{epId:{images,at}}, info, at}
 * 索引走 KV：`cache.index` = [{sourceKey, comicId, title, bytes, chapters, at}]（LRU 淘汰依据）
 * 配额：单部漫画图片字节合计 + 总量上限（见 CACHE_LIMITS），超限时按最旧漫画整部淘汰。 */
const CACHE_LIMITS = { maxTotalBytes: 2 * 1024 * 1024 * 1024, maxPerComicBytes: 512 * 1024 * 1024 }

/** 总量上限跟设置页「缓存总量上限」滑块（KV settings.cacheLimitMB，MB）；未配置时用默认 2GB */
async function cacheTotalLimitBytes(): Promise<number> {
  const v = await storageGet('settings').catch(() => null)
  const mb = v && typeof v === 'object' && typeof (v as { cacheLimitMB?: unknown }).cacheLimitMB === 'number'
    ? (v as { cacheLimitMB: number }).cacheLimitMB : 0
  return mb > 0 ? mb * 1024 * 1024 : CACHE_LIMITS.maxTotalBytes
}

function cacheRoot(): string {
  if (!appDataPath) throw new Error('缓存目录不可用（缺少宿主数据目录）')
  return join(appDataPath, 'comic-house', 'cache')
}
const cacheImageDir = (sourceKey: string) => join(cacheRoot(), 'images', sourceKey)
const cacheMetaDir = (sourceKey: string) => join(cacheRoot(), 'meta', sourceKey)
const cacheImageFile = (sourceKey: string, url: string) => {
  const ext = /\.(png|webp|gif|avif|jpg|jpeg)(\?|$)/i.exec(url)?.[1]?.toLowerCase()
  return join(cacheImageDir(sourceKey), createHash('sha256').update(url).digest('hex') + (ext && ext !== 'jpeg' ? '.' + ext : '.jpg'))
}
const cacheMetaFile = (sourceKey: string, comicId: string) => join(cacheMetaDir(sourceKey), `${encodeURIComponent(comicId).replace(/[%.]/g, '_')}.json`)

interface CacheChapter { images: string[]; at: number }
interface CacheMeta { comic: { id: string; title: string; cover?: string }; info?: unknown; chapters: Record<string, CacheChapter>; at: number; bytes?: number }
interface CacheIndexEntry { sourceKey: string; comicId: string; title: string; bytes: number; chapters: number; at: number }

async function readCacheMeta(sourceKey: string, comicId: string): Promise<CacheMeta | null> {
  try { return JSON.parse(await readFile(cacheMetaFile(sourceKey, comicId), 'utf-8')) as CacheMeta } catch { return null }
}
async function writeCacheMeta(sourceKey: string, comicId: string, meta: CacheMeta): Promise<void> {
  await mkdir(cacheMetaDir(sourceKey), { recursive: true })
  await writeFile(cacheMetaFile(sourceKey, comicId), JSON.stringify(meta))
}
async function loadCacheIndex(): Promise<CacheIndexEntry[]> {
  const v = await storageGet('cache.index')
  return Array.isArray(v) ? v as CacheIndexEntry[] : []
}
async function saveCacheIndex(list: CacheIndexEntry[]): Promise<void> {
  await storageSet('cache.index', list)
}
/** LRU 淘汰：总量超限按最旧整部删除（图片目录 + meta + 索引行） */
async function evictCacheIfNeeded(): Promise<void> {
  let list = await loadCacheIndex()
  let total = list.reduce((s, e) => s + (e.bytes || 0), 0)
  const limitBytes = await cacheTotalLimitBytes()
  const victims = list.filter(e => total - (e.bytes || 0) >= limitBytes * 0.9).sort((a, b) => a.at - b.at)
  for (const v of victims) {
    await rm(cacheImageDir(v.sourceKey), { recursive: true, force: true }).catch(() => {})
    await rm(cacheMetaFile(v.sourceKey, v.comicId), { force: true }).catch(() => {})
    total -= v.bytes || 0
    list = list.filter(e => !(e.sourceKey === v.sourceKey && e.comicId === v.comicId))
  }
  if (victims.length) await saveCacheIndex(list)
}
/** 覆盖写图片到缓存；返回字节体积。目录按需创建。 */
async function writeCacheImage(sourceKey: string, url: string, mime: string, bytes: Uint8Array): Promise<void> {
  await mkdir(cacheImageDir(sourceKey), { recursive: true })
  const file = cacheImageFile(sourceKey, url)
  const existing = await stat(file).then(s => s.size, () => 0)
  if (existing === bytes.byteLength) return   // 已有同尺寸文件视为命中，避免重复写
  await writeFile(file, bytes)
}
function emitCacheProgress(sourceKey: string, comicId: string, payload: Record<string, unknown>): void {
  port.postMessage({ event: 'cache.progress', data: { sourceKey, comicId, ...payload } })
}

/** 缓存单张图片：命中缓存直接读盘，否则走源代理后写盘。返回 base64（在线/离线统一出口） */
async function imageViaCache(src: SourceInstance, comicId: string, epId: string, url: string, opts?: { write?: boolean }): Promise<{ mime: string; base64: string; cached: boolean }> {
  const file = cacheImageFile(src.key, url)
  if (appDataPath) {
    const hit = await readFile(file).then(b => ({ mime: sniffImageMime(b), base64: Buffer.from(b).toString('base64'), cached: true }), () => null)
    if (hit) return hit
  }
  const fetched = await methods['image.load']([src.key, url, comicId, epId])
  const bytes = Buffer.from((fetched as { base64: string }).base64, 'base64')
  if (opts?.write !== false && appDataPath) {
    await writeCacheImage(src.key, url, (fetched as { mime: string }).mime, bytes).catch(() => { /* 磁盘满不阻塞阅读 */ })
  }
  return { mime: (fetched as { mime: string }).mime, base64: (fetched as { base64: string }).base64, cached: false }
}
/** 从魔数探图片 MIME（缓存文件名扩展可能不准） */
function sniffImageMime(b: Buffer): string {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length > 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (b.length > 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (b.length > 12 && b.subarray(4, 8).toString('ascii') === 'ftyp') return 'image/avif'
  return 'image/jpeg'
}

/* ---------------- 源实例管理 ---------------- */
interface SourceInstance {
  key: string
  name: string
  version: string
  baseUrl?: string
  instance: any
  imageConfigCache: Map<string, unknown>
  dataCache?: Map<string, unknown>
}
interface SourceMeta { key: string; name: string; version: string; enabled: boolean; url?: string; installedAt: number; updatedAt: number; adult?: boolean }

let sourcesIndex: SourceMeta[] | null = null
const instances = new Map<string, SourceInstance>()

async function loadSourcesIndex(): Promise<SourceMeta[]> {
  if (sourcesIndex) return sourcesIndex
  const stored = await storageGet('sources.index')
  sourcesIndex = Array.isArray(stored) ? stored as SourceMeta[] : []
  return sourcesIndex
}
async function saveSourcesIndex(): Promise<void> {
  await storageSet('sources.index', sourcesIndex ?? [])
}
async function loadSourceScript(key: string): Promise<string | null> {
  const value = await storageGet(`source.${key}`)
  return typeof value === 'string' ? value : null
}
/** 从源脚本猜站点根（相对路径解析用）：取脚本中首个完整 http(s) 地址 */
function guessBaseUrl(script: string): string | undefined {
  const m = /https?:\/\/[a-z0-9.-]+[a-z](?::\d+)?(?:\/[^\s"'`\\]*)?/i.exec(script)
  return m ? m[0] : undefined
}
/** 提取源入口类名（V8 上下文里 class 声明不在 globalThis 上，必须静态提取再实例化） */
function extractClassName(script: string): string | null {
  const re = /class\s+([A-Za-z_$][\w$]*)\s+extends\s+ComicSource/g
  let m: RegExpExecArray | null
  let last: string | null = null
  while ((m = re.exec(script))) last = m[1]
  return last
}

async function instantiateSource(probeKey: string, script: string): Promise<SourceInstance> {
  const className = extractClassName(script)
  if (!className) throw new Error('不是有效的 Venera/VeneraNext 数据源（缺少 ComicSource 子类声明）')

  // key 引用体：发现真实 key 后更新，data 读写前缀即时生效
  const keyRef = { value: probeKey }
  const dataCache = new Map<string, unknown>()
  const pendingSaves = new Map<string, unknown>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const dataKeyOf = (dataKey: unknown) => `sourceData.${keyRef.value}.${String(dataKey)}`
  class ComicSourceBase {
    name = ''
    key = ''
    version = '1.0.0'
    minAppVersion = ''
    url = ''
    static sources: Record<string, unknown> = {}
    /** Venera 语义是同步返回；这里同步回缓存值并异步刷新，首次调用可能为 undefined */
    loadData(dataKey: unknown): unknown {
      const k = String(dataKey)
      void storageGet(dataKeyOf(k)).then(v => {
        if (v !== null && v !== undefined) dataCache.set(k, v)
      }).catch(() => { /* ignore */ })
      return dataCache.has(k) ? dataCache.get(k) : undefined
    }
    loadSetting(settingKey: unknown): unknown {
      const settings = (this as any).settings
      const entry = settings?.[String(settingKey)]
      if (entry === undefined || entry === null) return undefined
      // 源脚本会把运行时值直接覆写成标量（如 copy_manga 的 base_url），此时直接返回该值
      if (typeof entry !== 'object') return entry
      return entry.default
    }
    saveData(dataKey: unknown, value: unknown): unknown {
      const k = String(dataKey)
      dataCache.set(k, value)
      // 设备指纹等键必须立即落盘：源脚本常在 saveData 后立刻发请求，
      // 若延迟批量写入，重载插件后指纹会丢失并被重新生成 → 源站风控 210。
      if (k.startsWith('_') || k === 'token') {
        const safe = toPlainJson(value)
        if (safe !== undefined) void storageSet(dataKeyOf(k), safe).catch(() => { /* best effort */ })
        return undefined
      }
      pendingSaves.set(k, value)
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          const entries = [...pendingSaves.entries()]
          pendingSaves.clear()
          for (const [k2, v] of entries) {
            const safe = toPlainJson(v)
            if (safe !== undefined) void storageSet(dataKeyOf(k2), safe).catch(() => { /* best effort */ })
          }
        }, 200)
        flushTimer.unref()
      }
      return undefined
    }
    deleteData(dataKey: unknown): void {
      const k = String(dataKey)
      dataCache.delete(k)
      pendingSaves.delete(k)
      void storageSet(dataKeyOf(k), '').catch(() => { /* best effort */ })
    }
    get isLogged(): boolean { return false }
    translate(text: unknown): unknown { return text }
  }

  const state: { baseUrl?: string } = {}
  async function sendSourceRequest(method: string, url: unknown, headers: unknown, data: unknown, asBytes: boolean) {
    const target = resolveAgainst(state.baseUrl, String(url ?? ''))
    const res = await rawFetch(target, method, headersToPlain(headers), data, MAX_TEXT_BYTES, keyRef.value)
    return { status: res.status, headers: res.headers, body: asBytes ? bytesToArrayBuffer(res.bytes) : res.body }
  }

  const Network = {
    get: (url: unknown, headers?: unknown) => sendSourceRequest('GET', url, headers, undefined, false),
    delete: (url: unknown, headers?: unknown) => sendSourceRequest('DELETE', url, headers, undefined, false),
    post: (url: unknown, headers?: unknown, data?: unknown) => sendSourceRequest('POST', url, headers, data, false),
    put: (url: unknown, headers?: unknown, data?: unknown) => sendSourceRequest('PUT', url, headers, data, false),
    patch: (url: unknown, headers?: unknown, data?: unknown) => sendSourceRequest('PATCH', url, headers, data, false),
    sendRequest: (method: unknown, url: unknown, headers?: unknown, data?: unknown) => sendSourceRequest(String(method ?? 'GET').toUpperCase(), url, headers, data, false),
    fetchBytes: (method: unknown, url: unknown, headers?: unknown, data?: unknown) => sendSourceRequest(String(method ?? 'GET').toUpperCase(), url, headers, data, true),
    setCookies: async (url: unknown, cookies: unknown) => {
      const origin = cookieOrigin(normalizeUrl(url))
      const list = (Array.isArray(cookies) ? cookies : []).map((c: any) => ({
        name: String(c?.name ?? ''), value: String(c?.value ?? ''), domain: String(c?.domain ?? origin),
      })).filter(c => c.name)
      let jar = cookieJars.get(keyRef.value)
      if (!jar) { jar = {}; cookieJars.set(keyRef.value, jar) }
      jar[origin] = list
      await persistCookieJar()
    },
    getCookies: (url: unknown) => (cookieJars.get(keyRef.value)?.[cookieOrigin(String(url ?? ''))] ?? []).map(c => ({ ...c })),
    deleteCookies: async (url: unknown) => {
      const jar = cookieJars.get(keyRef.value)
      if (jar) { delete jar[cookieOrigin(normalizeUrl(url))]; await persistCookieJar() }
    },
  }

  const sandboxConsole = {
    log: (...a: unknown[]) => console.log(`[comic:${keyRef.value}]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[comic:${keyRef.value}]`, ...a),
    error: (...a: unknown[]) => console.error(`[comic:${keyRef.value}]`, ...a),
  }
  const logFn = (level: unknown, title: unknown, content?: unknown) => {
    const line = `[comic:${keyRef.value}] ${String(title ?? '')} ${content === undefined ? '' : String(content)}`
    if (level === 'error') console.error(line)
    else if (level === 'warning') console.warn(line)
    else console.log(line)
  }

  /** Venera-Next fetch 包装：text()/json()/arrayBuffer()，无流式/AbortSignal */
  const sandboxFetch = async (input: unknown, init?: any) => {
    const url = typeof input === 'string' ? input : String((input as any)?.url ?? '')
    const method = String(init?.method ?? (typeof input === 'object' && input ? (input as any).method : 'GET') ?? 'GET').toUpperCase()
    const headers = { ...(init?.headers ?? {}), ...((input as any)?.headers ?? {}) }
    const body = init?.body
    const res = await sendSourceRequest(method, url, headers, body, false)
    const consume = (kind: 'text' | 'json' | 'arrayBuffer') => async () => {
      if (kind === 'json') return JSON.parse(res.body)
      if (kind === 'arrayBuffer') return bytesToArrayBuffer(textToBytesForJson(res.body))
      return res.body
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: String(res.headers['x-status-text'] ?? ''),
      headers: res.headers,
      url,
      text: consume('text'),
      json: consume('json'),
      arrayBuffer: consume('arrayBuffer'),
    }
  }
  function textToBytesForJson(text: string): Uint8Array { return new TextEncoder().encode(text) }

  const classAlias = (Base: new (init: Record<string, unknown>) => object) =>
    class extends Base {
      constructor(init: Record<string, unknown> = {}) {
        super(init)
        // subtitle/subTitle 双向别名（Venera 原版只有 subtitle，文档两写法都有）
        if ('subTitle' in init && !('subtitle' in init)) (this as any).subtitle = (init as any).subTitle
        if ('subtitle' in init && !('subTitle' in init)) (this as any).subTitle = (init as any).subtitle
      }
    }

  const sandbox: Record<string, unknown> = {
    ComicSource: ComicSourceBase,
    Network,
    fetch: sandboxFetch,
    Convert: makeConvertApi(),
    HtmlDocument,
    Cookie: class Cookie { constructor(init: { name: string; value: string; domain?: string }) { Object.assign(this, { name: init?.name, value: init?.value, domain: init?.domain }) } },
    Comic: classAlias(class { constructor(init: Record<string, unknown>) { Object.assign(this, init) } }),
    ComicDetails: classAlias(class { constructor(init: Record<string, unknown>) { Object.assign(this, init) } }),
    Comment: class { constructor(init: Record<string, unknown>) { Object.assign(this, init) } },
    APP: { version: '1.18.3', locale: 'zh_CN', platform: process.platform },
    randomInt: (min: unknown, max: unknown) => nodeRandomInt(Number(min), Number(max)),
    randomDouble: (min: unknown, max: unknown) => Number(min) + Math.random() * (Number(max) - Number(min)),
    createUuid: () => randomUUID(),
    console: sandboxConsole,
    log: logFn,
    setTimeout: (cb: () => void, ms?: unknown) => {
      const t = setTimeout(() => { try { cb() } catch (e) { sandboxConsole.error(e) } }, Number(ms ?? 0))
      timers.add(t)
      t.unref?.()
      return t
    },
    clearTimeout: (t: unknown) => { clearTimeout(t as ReturnType<typeof setTimeout>); timers.delete(t as ReturnType<typeof setTimeout>) },
    setInterval: (cb: () => void, ms?: unknown) => {
      const t = setInterval(() => { try { cb() } catch (e) { sandboxConsole.error(e) } }, Math.max(50, Number(ms ?? 1000)))
      timers.add(t)
      const handle = { cancel: () => { clearInterval(t); timers.delete(t) } }
      return handle
    },
    compute: () => Promise.reject(new Error('compute 暂不支持')),
    setClipboard: () => Promise.resolve(false),
    getClipboard: () => Promise.resolve(''),
    sendMessage: () => Promise.reject(new Error('sendMessage 暂不支持')),
  }

  const context = vm.createContext(sandbox)
  // 末尾追加实例化语句：class 声明在 V8 里是全局词法绑定，globalThis 扫不到
  const bootstrap = `${script}\n;globalThis.__comicHouseInstance = new ${className}();`
  const compiled = new vm.Script(bootstrap, { filename: `source:${probeKey}.js` })
  compiled.runInContext(context, { timeout: 30_000 })
  const instance = (sandbox as any).__comicHouseInstance
  delete (sandbox as any).__comicHouseInstance
  if (!instance || typeof instance !== 'object') throw new Error('源脚本实例化失败')

  const key = String(instance.key ?? '').trim()
  if (!key) throw new Error('数据源未声明 key')
  keyRef.value = key
  const baseUrl = guessBaseUrl(script)
  state.baseUrl = baseUrl

  const src: SourceInstance = {
    key,
    name: String(instance.name ?? key),
    version: String(instance.version ?? '1.0.0'),
    baseUrl,
    instance,
    imageConfigCache: new Map(),
    dataCache,
  }
  // 预加载该源全部私有数据到内存缓存：Venera 的 loadData 是同步语义，
  // 源脚本用 loadData 缓存设备指纹（_device/_pseudoid/_deviceinfo）等，
  // 若首次读取返回 undefined 会重新生成 → 指纹每次变化 → 源站风控 210。
  await prefetchSourceData(src)
  if (typeof instance.init === 'function') {
    await withTimeout(Promise.resolve(instance.init()), 15_000, `源 ${key} init 超时`)
  }
  return src
}

async function getSource(key: string): Promise<SourceInstance> {
  const meta = (await loadSourcesIndex()).find(s => s.key === key)
  if (!meta) throw new Error(`未安装数据源：${key}`)
  if (!meta.enabled) throw new Error(`数据源已停用：${meta.name}`)
  const cached = instances.get(key)
  if (cached) return cached
  const script = await loadSourceScript(key)
  if (!script) throw new Error(`数据源脚本丢失：${key}`)
  const src = await instantiateSource(key, script)
  instances.set(key, src)
  return src
}

/* ---------------- 结果归一化 ---------------- */
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : [] }
interface ComicCard { sourceKey: string; id: string; title: string; subtitle: string; cover: string; tags: string[] }
function normalizeComic(v: unknown, sourceKey: string): ComicCard | null {
  if (!v || typeof v !== 'object') return null
  const o = plain(v)
  const title = typeof o?.title === 'string' ? o.title : ''
  const id = o?.id !== undefined && o?.id !== null ? String(o.id) : ''
  if (!title && !id) return null
  return {
    sourceKey,
    id,
    title,
    subtitle: typeof o?.subtitle === 'string' ? o.subtitle : '',
    cover: typeof o?.cover === 'string' ? o.cover : '',
    tags: Array.isArray(o?.tags) ? o.tags.map((t: unknown) => String(t)).slice(0, 8) : [],
  }
}
function normalizeComics(list: unknown, sourceKey: string): ComicCard[] {
  return asArray(list)
    .map(c => normalizeComic(c, sourceKey))
    .filter((c): c is ComicCard => c !== null)
}
function normalizePageResult(result: unknown, sourceKey: string, page: number) {
  const r = plain(result)
  const comics = normalizeComics(r?.comics, sourceKey)
  let maxPage = typeof r?.maxPage === 'number' ? r.maxPage : undefined
  if (maxPage === undefined || maxPage < 1) maxPage = comics.length ? page : 0
  return { comics, maxPage }
}
function normalizeDetails(v: unknown): unknown {
  const o = plain(v)
  if (!o || typeof o !== 'object') return null
  const chapters: Array<{ id: string; title: string; group?: string }> = []
  const pushChapter = (id: unknown, title: unknown, group?: string) => {
    const cid = id !== undefined && id !== null ? String(id) : ''
    if (!cid) return
    chapters.push({ id: cid, title: String(title ?? cid), group })
  }
  const isChapterList = (value: any): boolean => {
    // id→title 的 Map/对象：所有 value 都是字符串
    if (!value || typeof value !== 'object') return false
    const entries = isMapLike(value) ? [...value.entries()] : Object.entries(value)
    return entries.length > 0 && entries.every(([, t]) => typeof t === 'string')
  }
  const rawChapters = o.chapters
  if (Array.isArray(rawChapters)) {
    for (const c of rawChapters) {
      const cc = plain(c)
      if (cc && typeof cc === 'object') {
        const id = cc.id !== undefined ? String(cc.id) : String(cc.title ?? '')
        if (id) chapters.push({ id, title: String(cc.title ?? id) })
      }
    }
  } else if (rawChapters && typeof rawChapters === 'object') {
    const outerEntries = isMapLike(rawChapters) ? [...rawChapters.entries()] : Object.entries(rawChapters)
    if (isChapterList(rawChapters)) {
      // 扁平形态：id → 标题
      for (const [id, title] of outerEntries) pushChapter(id, title)
    } else {
      // 嵌套形态（Venera 1.3.0+ 多分组）：组名 → Map(章节id → 标题)
      for (const [group, list] of outerEntries) {
        const inner = plain(list)
        if (!inner || typeof inner !== 'object') continue
        const innerEntries = Array.isArray(inner)
          ? inner.map((c: any) => [c?.id ?? c?.uuid ?? c?.title, c?.title ?? c?.name] as [unknown, unknown])
          : isMapLike(list) ? [...(list as Map<unknown, unknown>).entries()] : Object.entries(inner)
        for (const [id, title] of innerEntries) pushChapter(id, title, String(group))
      }
    }
  }
  const tags: Array<{ namespace: string; tag: string }> = []
  if (o.tags && typeof o.tags === 'object' && !Array.isArray(o.tags)) {
    for (const [ns, list] of Object.entries(o.tags)) {
      if (Array.isArray(list)) for (const t of list) tags.push({ namespace: ns, tag: String(t) })
    }
  }
  return {
    title: String(o.title ?? ''),
    subtitle: String(o.subtitle ?? ''),
    cover: String(o.cover ?? ''),
    description: String(o.description ?? ''),
    chapters,
    tags,
    updateTime: typeof o.updateTime === 'string' ? o.updateTime : undefined,
    stars: typeof o.stars === 'number' ? o.stars : undefined,
  }
}

/* ---------------- 源仓库 ---------------- */
const BUILTIN_REPOS = [
  { id: 'venera-configs', name: '官方仓库源', url: 'https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/index.json' },
  { id: 'venera-next-sources', name: '社区仓库源', url: 'https://cdn.jsdelivr.net/gh/weihanlong267-spec/Venera-Next-sources@main/index.json' },
]
/** 内置源目录：后端私有 runtime/sources/ 附件（BackendContext.packagePath 注入包根） */
function builtinSourcesDir(): string | null {
  return packagePath ? join(packagePath, 'runtime', 'sources') : null
}
function resolveRepoEntryUrl(repoUrl: string, entry: unknown): string {
  if (typeof entry !== 'string' || !entry) return ''
  if (/^https?:\/\//i.test(entry)) return entry
  try { return new URL(entry, repoUrl).toString() } catch { return '' }
}

/** 成人向源 key 清单（静态声明，仅用于界面「成人」警告标记，不做任何内容判断） */
const ADULT_KEYS = new Set(['hcomic', 'hot_manga', 'jm', 'manwaba', 'nhentai', 'ehentai', 'hitomi', 'wnacg', 'jmanga', '18comic'])

/**
 * 净化源脚本数据为宿主可接受的纯 JSON：
 * 剔除 undefined/函数/Symbol、NaN/Infinity→null、Map/Set→普通结构、
 * 类实例→自有可枚举字段、断开循环引用。
 * 宿主 serializeJson 会拒绝上述任何一项（storage requires finite JSON data）。
 */
function toPlainJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value as number) ? value : null
  if (t === 'bigint') return String(value)
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined
  const obj = value as object
  if (seen.has(obj)) return null                    // 循环引用
  seen.add(obj)
  try {
    if (Array.isArray(value)) {
      return value.map(v => { const p = toPlainJson(v, seen); return p === undefined ? null : p })
    }
    if (isMapLike(value)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of (value as Map<unknown, unknown>).entries()) {
        const p = toPlainJson(v, seen)
        if (p !== undefined) out[String(k)] = p
      }
      return out
    }
    if (value instanceof Set) {
      return [...value].map(v => { const p = toPlainJson(v, seen); return p === undefined ? null : p })
    }
    if (value instanceof ArrayBuffer) return { __bytes: Buffer.from(value).toString('base64') }
    if (value instanceof Uint8Array) return { __bytes: Buffer.from(value).toString('base64') }
    if (value instanceof Date) return value.toISOString()
    // 类实例/普通对象：只保留自有可枚举字符串键
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = toPlainJson(v, seen)
      if (p !== undefined) out[k] = p
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

/** 预加载源私有数据到内存（让同步 loadData 首次即命中） */
async function prefetchSourceData(src: SourceInstance): Promise<void> {
  if (!src.dataCache) return
  try {
    const list = await hostRequest('storage.list', { prefix: src.dataPrefix })
    const entries = Array.isArray(list) ? list as Array<{ key: string; value?: unknown }> : []
    for (const e of entries) {
      if (typeof e?.key !== 'string') continue
      const short = e.key.slice(src.dataPrefix.length)
      if (e.value !== undefined && e.value !== null) src.dataCache.set(short, e.value)
    }
  } catch {
    // 宿主不支持带前缀枚举时，至少预取源脚本常用的指纹类键
    for (const k of ['_device', '_pseudoid', '_deviceinfo', 'token', 'setting']) {
      const v = await storageGet(src.dataPrefix + k).catch(() => null)
      if (v !== null && v !== undefined) src.dataCache.set(k, v)
    }
  }
}

/** 批量安装内置源文件（同 key 已装视为就绪） */
async function installBuiltinFiles(dir: string, files: string[]): Promise<SourceMeta[]> {
  const installed: SourceMeta[] = []
  for (const f of files) {
    const script = await readFile(join(dir, f), 'utf-8')
    try {
      installed.push(await installScript(script, '', ''))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const existing = (await loadSourcesIndex()).find(s => msg.includes(`「${s.name}」`))
      if (existing) installed.push(existing)
      else console.warn(`[comic-house] builtin source ${f} skipped: ${msg}`)
    }
  }
  return installed
}

/** 安装脚本：静态校验 → 沙箱实例化拿元数据 → key 冲突检查 → 存储 */
async function installScript(script: string, nameHint: string, url: string, updateKey?: string): Promise<SourceMeta> {
  const trimmed = script.trim()
  if (!/class\s+[A-Za-z_$][\w$]*\s+extends\s+ComicSource/.test(trimmed)) {
    throw new Error('不是有效的 Venera/VeneraNext 数据源（缺少 ComicSource 子类声明）')
  }
  const probe = await instantiateSource(updateKey ?? '__probe__', trimmed)
  const { key, name, version } = probe
  if (updateKey && key !== updateKey) throw new Error(`更新后源 key 已变化（${key} ≠ ${updateKey}），请删除后重新安装`)
  const index = await loadSourcesIndex()
  const existing = index.find(s => s.key === key)
  if (existing && !updateKey) throw new Error(`数据源「${name}」已安装（key: ${key}）`)
  const meta: SourceMeta = existing
    ? { ...existing, name: name || existing.name, version, url: url || existing.url, updatedAt: Date.now(), adult: ADULT_KEYS.has(key) }
    : { key, name: name || nameHint || key, version, url: url || undefined, enabled: true, installedAt: Date.now(), updatedAt: Date.now(), adult: ADULT_KEYS.has(key) }
  if (!existing) index.push(meta)
  await storageSet(`source.${key}`, script)
  await saveSourcesIndex()
  instances.set(key, probe)
  return meta
}

/* ---------------- backend.call 方法表 ---------------- */
const methods: Record<string, (args: unknown[]) => Promise<unknown>> = {
  /* ----- 源管理 ----- */
  'sources.list': async () => {
    let index = await loadSourcesIndex()
    // 首启自动安装：仅装通用源拷贝漫画（成人源由用户在仓库区自行选择安装）
    if (!index.length) {
      const dir = builtinSourcesDir()
      if (dir) {
        const auto = ['copy_manga']
        const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.js') && auto.includes(f.slice(0, -3)))
        if (files.length) {
          console.log(`[comic-house] first launch: installing ${files.length} default source(s)`)
          try { await installBuiltinFiles(dir, files) } catch (e) {
            console.warn('[comic-house] builtin auto-install failed:', e instanceof Error ? e.message : String(e))
          }
          index = await loadSourcesIndex()
        }
      }
    }
    return index.map(s => ({ ...s }))
  },
  'sources.repos': async () => BUILTIN_REPOS,
  /** 内置源清单：后端私有 runtime/sources/ 附件里预置的、经过稳定性验证的源 */
  'sources.builtinList': async () => {
    const dir = builtinSourcesDir()
    if (!dir) return []
    const list = await readdir(dir).catch(() => [] as string[])
    // 读取脚本声明的 name/version（静态正则提取，不做完整实例化）
    return list.filter(f => f.endsWith('.js')).sort().map(f => {
      const key = f.slice(0, -3)
      const script = readFileSync(join(dir, f), 'utf-8')
      const name = (/^\s*name\s*=\s*['"]([^'"]+)['"]/m.exec(script) || [])[1] ?? key
      const version = (/^\s*version\s*=\s*['"]([^'"]+)['"]/m.exec(script) || [])[1] ?? ''
      return { key, name, version, adult: ADULT_KEYS.has(key) }
    })
  },
  /** 安装单个内置源（仓库区「插件内置」由用户自选安装） */
  'sources.installBuiltinOne': async ([key]) => {
    const dir = builtinSourcesDir()
    if (!dir) throw new Error('内置源目录不可用，请重新安装插件包')
    const k = String(key)
    const script = await readFile(join(dir, `${k}.js`), 'utf-8').catch(() => null)
    if (!script) throw new Error(`没有这个内置源：${k}`)
    return installScript(script, '', '')
  },
  /** 一键安装全部内置源（已装的跳过）；返回本次确认可用的源元数据 */
  'sources.installBuiltin': async () => {
    const dir = builtinSourcesDir()
    if (!dir) throw new Error('内置源目录不可用，请重新安装插件包')
    const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.js')).sort()
    return installBuiltinFiles(dir, files)
  },
  'sources.installFromUrl': async ([url, nameHint]) => {
    const res = await rawFetch(normalizeUrl(url), 'GET', { accept: '*/*' }, undefined, 2 * 1024 * 1024)
    if (res.status >= 400) throw new Error(`下载源脚本失败 HTTP ${res.status}`)
    return installScript(res.body, String(nameHint ?? ''), normalizeUrl(url))
  },
  'sources.installFromText': async ([script, nameHint]) => {
    if (typeof script !== 'string' || !script.trim()) throw new Error('源脚本不能为空')
    return installScript(script, String(nameHint ?? ''), '')
  },
  'sources.setEnabled': async ([key, enabled]) => {
    const index = await loadSourcesIndex()
    const meta = index.find(s => s.key === String(key))
    if (!meta) throw new Error(`未安装数据源：${String(key)}`)
    meta.enabled = Boolean(enabled)
    await saveSourcesIndex()
    if (!meta.enabled) instances.delete(String(key))
    return { ok: true }
  },
  'sources.remove': async ([key]) => {
    const k = String(key)
    const index = await loadSourcesIndex()
    const meta = index.find(s => s.key === k)
    if (!meta) throw new Error(`未安装数据源：${k}`)
    sourcesIndex = index.filter(s => s.key !== k)
    await saveSourcesIndex()
    instances.delete(k)
    // 宿主后端通道只提供 storage.get/set（无 remove），且 serializeJson 拒绝 null；
    // 用空串占位表示已删除，loadSourceScript 会判定为空脚本。
    await storageSet(`source.${k}`, '')

    // ---- 连带清理该源的全部业务数据 ----
    const cleaned = { history: 0, favorites: 0, progress: 0, cache: 0, sourceData: 0 }
    // 1) 阅读历史（含进度合并条目）
    const history = await storageGet('history').catch(() => null)
    if (Array.isArray(history)) {
      const kept = (history as Array<Record<string, unknown>>).filter(h => h?.sourceKey !== k)
      cleaned.history = (history as unknown[]).length - kept.length
      if (cleaned.history) await storageSet('history', kept)
    }
    // 2) 收藏
    const favs = await storageGet('favorites').catch(() => null)
    if (Array.isArray(favs)) {
      const kept = (favs as Array<Record<string, unknown>>).filter(f => f?.sourceKey !== k)
      cleaned.favorites = (favs as unknown[]).length - kept.length
      if (cleaned.favorites) await storageSet('favorites', kept)
    }
    // 3) 阅读进度
    const progress = await storageGet('reading.progress').catch(() => null)
    if (progress && typeof progress === 'object') {
      const out: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(progress as Record<string, unknown>)) {
        if (!pk.startsWith(`${k}::`)) out[pk] = pv
        else cleaned.progress++
      }
      if (cleaned.progress) await storageSet('reading.progress', out)
    }
    // 4) 漫画缓存（目录 + 索引）
    await rm(cacheImageDir(k), { recursive: true, force: true }).catch(() => {})
    const cacheIndex = await loadCacheIndex()
    const cacheKept = cacheIndex.filter(e => e.sourceKey !== k)
    cleaned.cache = cacheIndex.length - cacheKept.length
    if (cleaned.cache) await saveCacheIndex(cacheKept)
    // 5) 源私有数据（loadData/saveData 的键，含设备指纹）
    for (const dataKey of ['_device', '_pseudoid', '_deviceinfo', 'token', 'setting']) {
      await storageSet(`sourceData.${k}.${dataKey}`, '').catch(() => {})
    }
    cleaned.sourceData = 1
    // 6) cookie
    const jars = cookieJars.get(k)
    if (jars) { cookieJars.delete(k); void persistCookieJar().catch(() => {}) }

    return { ok: true, name: meta.name, cleaned }
  },
  'sources.update': async ([key]) => {
    const k = String(key)
    const meta = (await loadSourcesIndex()).find(s => s.key === k)
    if (!meta) throw new Error(`未安装数据源：${k}`)
    if (!meta.url) throw new Error(`源「${meta.name}」没有更新地址，请重新安装`)
    const res = await rawFetch(meta.url, 'GET', { accept: '*/*' }, undefined, 2 * 1024 * 1024)
    if (res.status >= 400) throw new Error(`更新源脚本失败 HTTP ${res.status}`)
    return installScript(res.body, meta.name, meta.url, k)
  },
  'sources.repoIndex': async ([repoUrl]) => {
    const target = normalizeUrl(repoUrl)
    const res = await rawFetch(target, 'GET', { accept: 'application/json' }, undefined, 2 * 1024 * 1024)
    if (res.status >= 400) throw new Error(`拉取源仓库索引失败 HTTP ${res.status}`)
    let list: unknown
    try { list = JSON.parse(res.body) } catch { throw new Error('源仓库索引不是合法 JSON') }
    const entries = Array.isArray(list)
      ? list
      : list && typeof list === 'object' && Array.isArray((list as any).sources)
        ? (list as any).sources
        : null
    if (!entries) throw new Error('源仓库索引格式不支持（需要 JSON 数组）')
    return (entries as Array<Record<string, unknown>>)
      .map(e => {
        const name = String(e.name ?? e.title ?? '')
        const key = String(e.key ?? '')
        return {
          name,
          version: String(e.version ?? ''),
          description: String(e.description ?? ''),
          url: resolveRepoEntryUrl(target, e.url ?? e.fileName ?? e.filename),
          adult: ADULT_KEYS.has(key) || ADULT_KEYS.has(name.toLowerCase()),
        }
      })
      .filter(e => e.url)
  },
  /* ----- 聚合（跨全部启用源） ----- */
  /** 聚合搜索：并行查所有启用源，每源完成即用 backend.event 推送（流式，搜一个出一个） */
  'search.aggregate': async ([keyword, page]) => {
    const kw = String(keyword ?? '').trim()
    if (!kw) return { started: 0 }
    const enabled = (await loadSourcesIndex()).filter(s => s.enabled)
    const pageNo = Number(page) || 1
    const eventName = `search.stream.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    // 立即返回事件名，前端据此订阅
    void (async () => {
      let done = 0
      await Promise.all(enabled.map(async meta => {
        try {
          const result = await methods['search.load']([meta.key, kw, pageNo]) as { comics: ComicCard[]; maxPage: number }
          port.postMessage({
            event: 'search.aggregate',
            data: { streamId: eventName, sourceKey: meta.key, sourceName: meta.name, comics: result.comics ?? [], maxPage: result.maxPage ?? 0, done: ++done, total: enabled.length },
          })
        } catch (e) {
          port.postMessage({
            event: 'search.aggregate',
            data: { streamId: eventName, sourceKey: meta.key, sourceName: meta.name, comics: [], error: e instanceof Error ? e.message : String(e), done: ++done, total: enabled.length },
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
      const hot = await methods['home.hot']([meta.key]) as { sections: Array<{ title: string; comics: ComicCard[] }> }
      return { sourceKey: meta.key, sourceName: meta.name, adult: !!meta.adult, sections: hot?.sections ?? [] }
    }))
    return results
      .map((r, i) => r.status === 'fulfilled'
        ? r.value
        : { sourceKey: enabled[i].key, sourceName: enabled[i].name, adult: !!enabled[i].adult, sections: [], error: String((r as PromiseRejectedResult).reason).slice(0, 80) })
      .filter(x => x.sections.length > 0 || x.error)
  },
  /** 聚合排行：每个源取其首选项排行榜（并行，失败源跳过） */
  'ranking.aggregate': async ([page]) => {
    const enabled = (await loadSourcesIndex()).filter(s => s.enabled)
    const pageNo = Number(page) || 1
    const results = await Promise.allSettled(enabled.map(async meta => {
      const options = await methods['ranking.options']([meta.key]) as string[]
      if (!options?.length) return { sourceKey: meta.key, sourceName: meta.name, adult: !!meta.adult, option: '', comics: [] }
      const r = await methods['ranking.load']([meta.key, options[0], pageNo]) as { comics: ComicCard[]; maxPage: number }
      return { sourceKey: meta.key, sourceName: meta.name, adult: !!meta.adult, option: options[0], comics: r?.comics ?? [], maxPage: r?.maxPage ?? 0 }
    }))
    return results
      .map((r, i) => r.status === 'fulfilled' ? r.value
        : { sourceKey: enabled[i].key, sourceName: enabled[i].name, adult: !!enabled[i].adult, option: '', comics: [], error: String((r as PromiseRejectedResult).reason).slice(0, 80) })
  },
  /** 聚合筛选维度：各源支持的分类/榜单选项（用于筛选栏） */
  'filters.aggregate': async () => {
    const enabled = (await loadSourcesIndex()).filter(s => s.enabled)
    return Promise.all(enabled.map(async meta => {
      const src = await getSource(meta.key).catch(() => null)
      if (!src) return { sourceKey: meta.key, sourceName: meta.name, adult: !!meta.adult, categories: [], rankings: [] }
      // 分类：源脚本 category.parts 里的类目 + categoryComics.optionList
      const categories: Array<{ label: string; param: string }> = []
      const cat = (src.instance as any).category
      for (const part of asArray(cat?.parts)) {
        const p = part as any
        for (const c of asArray(p?.categories)) {
          const label = typeof c === 'string' ? c : String((c as any)?.label ?? '')
          const param = typeof c === 'string'
            ? (asArray(p?.categoryParams)[asArray(p?.categories).indexOf(c)] as string ?? c)
            : String((c as any)?.target?.attributes?.param ?? (c as any)?.param ?? label)
          if (label) categories.push({ label, param: String(param ?? label) })
        }
      }
      let rankings = asArray(((src.instance as any).categoryComics?.ranking?.options)).map(o => String(o))
      // 部分源（copy_manga）把排行放在 category 的「排行」类目 + optionList 里
      if (!rankings.length) rankings = categoryRankingOptions(src).slice(0, 6)
      return { sourceKey: meta.key, sourceName: meta.name, adult: !!meta.adult, categories: categories.slice(0, 30), rankings }
    }))
  },
  /** 按筛选维度取内容（category 或 ranking） */
  'filters.load': async ([key, kind, value, page]) => {
    const pageNo = Number(page) || 1
    if (kind === 'ranking') {
      return methods['ranking.load']([key, value, pageNo])
    }
    // category：走 categoryComics.load(category, param, options, page)
    const src = await getSource(String(key))
    const cc = (src.instance as any).categoryComics
    if (!cc?.load) throw new Error(`源「${src.name}」不支持分类浏览`)
    const options = categoryRankingDefaults(src)
    const result = await retryTransient(() => withTimeout(
      Promise.resolve(cc.load(String(value), String(value), options, pageNo)), 60_000, '分类加载超时'
    ))
    return normalizePageResult(result, src.key, pageNo)
  },
  /* ----- 探索 / 排行 / 搜索 / 详情 / 章节 / 图片 ----- */
  /** 发现页热门推荐：排行第一榜 + explore 首屏合并（任一失败降级另一个） */
  'home.hot': async ([key]) => {
    const src = await getSource(String(key))
    const sections: Array<{ title: string; comics: ComicCard[] }> = []
    // 1) 排行首选项
    try {
      const options = await methods['ranking.options']([key])
      if (Array.isArray(options) && options.length) {
        const rank = await methods['ranking.load']([key, options[0], 1]) as { comics: ComicCard[] }
        if (rank?.comics?.length) sections.push({ title: `🔥 ${options[0]}`, comics: rank.comics })
      }
    } catch { /* 无排行则跳过 */ }
    // 2) explore 首屏分区
    try {
      const titles = asArray(src.instance.explore).map((e: any) => ({ title: String(e?.title ?? ''), type: String(e?.type ?? 'multiPartPage') }))
      if (titles.length) {
        const ex = await methods['explore.load']([key, titles[0].title, 1]) as { kind: string; parts?: Array<{ title: string; comics: ComicCard[] }>; comics?: ComicCard[] }
        if (ex?.kind === 'list' && ex.comics?.length) sections.push({ title: titles[0].title, comics: ex.comics })
        else if (ex?.kind === 'parts') for (const p of ex.parts ?? []) if (p.comics?.length) sections.push({ title: p.title || titles[0].title, comics: p.comics })
      }
    } catch { /* explore 失败不阻塞排行展示 */ }
    return { sourceName: src.name, sections }
  },
  'explore.titles': async ([key]) => {
    const src = await getSource(String(key))
    return asArray(src.instance.explore).map((e: any) => ({
      title: String(e?.title ?? ''),
      type: String(e?.type ?? 'multiPartPage'),
    }))
  },
  'explore.load': async ([key, title, page]) => {
    const src = await getSource(String(key))
    const list = asArray(src.instance.explore)
    const target = list.find(e => e && typeof e === 'object' && String((e as any).title) === String(title)) ?? list[0]
    if (!target) return { kind: 'empty', parts: [] }
    const t = target as any
    const pageNo = Number(page) || 1
    if (String(t.type) === 'multiPageComicList') {
      const loadFn = typeof t.load === 'function' ? t.load : (p: number) => t.loadNext?.(p === 1 ? null : p)
      const result = await retryTransient(() => withTimeout(Promise.resolve(loadFn(pageNo)), 60_000, '探索页加载超时'))
      const r = plain(result)
      return {
        kind: 'list',
        title: String(t.title ?? ''),
        comics: normalizeComics(r?.comics, src.key),
        maxPage: typeof r?.maxPage === 'number' ? r.maxPage : undefined,
      }
    }
    if (String(t.type) === 'mixed') {
      const result = await retryTransient(() => withTimeout(Promise.resolve(t.load?.(pageNo - 1)), 60_000, '探索页加载超时'))
      const r = plain(result)
      return {
        kind: 'parts',
        parts: asArray(r?.data).map((p: any) => ({
          title: String(p?.title ?? ''),
          comics: normalizeComics(p?.comics, src.key),
        })),
      }
    }
    // multiPartPage（原版 singlePageMultiPart 容错）：标准返回 [{title, comics}]，
    // 部分源返回 {标题: comics[]} 对象形态，一并兼容
    const result = plain(await retryTransient(() => withTimeout(Promise.resolve(t.load?.(pageNo)), 60_000, '探索页加载超时')))
    let rawParts: unknown[] = Array.isArray(result) ? result : []
    if (!Array.isArray(result) && result && typeof result === 'object') {
      rawParts = Object.entries(result).map(([title, comics]) => ({ title, comics }))
    }
    return {
      kind: 'parts',
      parts: rawParts.map((p: any) => ({
        title: String(p?.title ?? ''),
        comics: normalizeComics(p?.comics, src.key),
      })),
    }
  },
  'ranking.options': async ([key]) => {
    const src = await getSource(String(key))
    const ranking = src.instance.categoryComics?.ranking
    if (ranking && Array.isArray(ranking.options) && ranking.options.length) {
      return ranking.options.map(o => String(o))
    }
    return categoryRankingOptions(src)
  },  'ranking.load': async ([key, option, page]) => {
    const src = await getSource(String(key))
    const ranking = src.instance.categoryComics?.ranking
    const pageNo = Number(page) || 1
    if (ranking && (typeof ranking.load === 'function' || typeof ranking.loadWithNext === 'function' || typeof ranking.loadNext === 'function')) {
      const loadFn = ranking.load ?? ranking.loadWithNext ?? ranking.loadNext
      const result = await retryTransient(() => withTimeout(Promise.resolve(loadFn(String(option ?? ''), pageNo)), 60_000, '排行加载超时'))
      return normalizePageResult(result, src.key, pageNo)
    }
    // 回退：categoryComics.load 的「排行」类目（copy_manga 等源的写法）
    const options = categoryRankingDefaults(src)
    const result = await retryTransient(() => withTimeout(
      Promise.resolve(src.instance.categoryComics?.load?.('排行', 'ranking', options, pageNo)),
      60_000,
      '排行加载超时'
    ))
    return normalizePageResult(result, src.key, pageNo)
  },
  'search.options': async ([key]) => {
    const src = await getSource(String(key))
    return plain(src.instance.search?.optionList ?? []) ?? []
  },
  'search.load': async ([key, keyword, page]) => {
    const src = await getSource(String(key))
    const search = src.instance.search
    if (!search || (typeof search.load !== 'function' && typeof search.loadNext !== 'function')) {
      throw new Error(`源「${src.name}」不支持搜索`)
    }
    const kw = String(keyword ?? '').trim()
    if (!kw) return { comics: [], maxPage: 0 }
    const pageNo = Number(page) || 1
    // options 是数组：按 optionList 每项的 default 值填充（Venera 语义）
    const options = asArray(src.instance.search?.optionList).map((o: any) => {
      if (o && typeof o === 'object' && 'default' in o) return o.default
      if (o && typeof o === 'object' && Array.isArray(o.options) && o.options.length) {
        const first = o.options[0]
        return first && typeof first === 'object' ? (first.value ?? first) : first
      }
      return undefined
    })
    let result: unknown
    if (typeof search.load === 'function') {
      result = await retryTransient(() => withTimeout(Promise.resolve(search.load(kw, options, pageNo)), 60_000, '搜索超时'))
    } else {
      result = await retryTransient(() => withTimeout(Promise.resolve(search.loadNext(kw, options, pageNo === 1 ? null : String(pageNo))), 60_000, '搜索超时'))
    }
    return normalizePageResult(result, src.key, pageNo)
  },
  'comic.info': async ([key, id]) => {
    const src = await getSource(String(key))
    if (typeof src.instance.comic?.loadInfo !== 'function') throw new Error(`源「${src.name}」不支持加载详情`)
    const details = await retryTransient(() => withTimeout(Promise.resolve(src.instance.comic.loadInfo(String(id))), 60_000, '详情加载超时'))
    return normalizeDetails(details)
  },
  'comic.chapter': async ([key, comicId, epId]) => {
    const src = await getSource(String(key))
    // 缓存优先：整章已离线时直接回图片列表（image.load 会命中磁盘）
    if (appDataPath) {
      const meta = await readCacheMeta(src.key, String(comicId))
      const cached = meta?.chapters?.[String(epId)]
      if (cached?.images?.length) return { images: cached.images, cached: true }
    }
    const comic = src.instance.comic
    if (typeof comic?.loadEp !== 'function') throw new Error(`源「${src.name}」不支持加载章节`)
    const result = await retryTransient(() => withTimeout(Promise.resolve(comic.loadEp(String(comicId), String(epId))), 90_000, '章节加载超时'))
    const r = plain(result)
    const images = asArray(r?.images ?? r).map(i => String(i)).filter(Boolean)
    if (!images.length) throw new Error('本章没有图片')
    return { images, cached: false }
  },
  'image.load': async ([key, url, comicId, epId]) => {
    const src = await getSource(String(key))
    const rawUrl = String(url ?? '')
    if (!rawUrl) {
      void hostRequest('log.write', { level: 'warn', source: 'comic-house', message: `image.load 收到空 URL（comic=${comicId} ep=${epId}）` }).catch(() => {})
      throw new Error('图片地址为空（源返回了空占位）')
    }
    let target = resolveAgainst(src.baseUrl, String(url))
    let headers: Record<string, string> | undefined
    const cfg = await imageRequestConfig(src, String(url), String(comicId ?? ''), String(epId ?? ''))
    if (cfg?.url) target = resolveAgainst(src.baseUrl, String(cfg.url))
    if (cfg?.headers && typeof cfg.headers === 'object') headers = headersToPlain(cfg.headers)
    const method = typeof cfg?.method === 'string' && cfg.method ? cfg.method : 'GET'
    let res: RawResponse
    try {
      res = await rawFetch(target, method, headers, cfg?.data, MAX_IMAGE_BYTES, src.key)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      void hostRequest('log.write', { level: 'warn', source: 'comic-house', message: `image.load 失败 ${msg} | url=${target.slice(0, 160)} | headers=${JSON.stringify(Object.keys(headers ?? {}))}` }).catch(() => {})
      throw e
    }
    if (res.status >= 400) {
      void hostRequest('log.write', { level: 'warn', source: 'comic-house', message: `image.load HTTP ${res.status} | url=${target.slice(0, 160)}` }).catch(() => {})
      throw new Error(`图片加载失败 HTTP ${res.status}`)
    }
    const mimeRaw = (res.headers['content-type'] ?? '').split(';')[0].trim() || 'image/jpeg'
    const mime = /image|octet-stream/.test(mimeRaw) ? mimeRaw : 'image/jpeg'
    const base64 = Buffer.from(res.bytes).toString('base64')
    // 大图分块：base64 超过单条预算时切片返回，前端按序拼接（画质不损失）
    if (base64.length > IMAGE_CHUNK_BASE64) {
      const chunks: string[] = []
      for (let i = 0; i < base64.length; i += IMAGE_CHUNK_BASE64) {
        chunks.push(base64.slice(i, i + IMAGE_CHUNK_BASE64))
      }
      return { mime, chunked: true, chunks }
    }
    return { mime, base64 }
  },
  /* ----- 缓存（整部漫画离线化） ----- */
  /** 缓存单章：图片逐张落盘 + meta 记账；进度经 cache.progress 事件推送 */
  'cache.chapter': async ([key, comicId, epId]) => {
    const src = await getSource(String(key))
    return cacheChapterInternal(src, String(comicId), String(epId))
  },
  /** 缓存整部：详情 + 全部章节顺序下载；单章失败跳过继续 */
  'cache.comic': async ([key, comicId]) => {
    const src = await getSource(String(key))
    const k = String(comicId)
    const info = await withTimeout(Promise.resolve(src.instance.comic?.loadInfo?.(k)), 60_000, '详情加载超时')
    const details = normalizeDetails(info) as { title?: string; cover?: string; chapters?: Array<{ id: string; title: string }> } | null
    const chapters = details?.chapters ?? []
    if (!chapters.length) throw new Error('该漫画没有可缓存的章节')
    emitCacheProgress(src.key, k, { phase: 'start', totalChapters: chapters.length, doneChapters: 0 })
    let done = 0, failed = 0
    for (const ch of chapters) {
      try {
        await cacheChapterInternal(src, k, ch.id, () => details)
        done++
      } catch { failed++ }
      emitCacheProgress(src.key, k, { phase: 'chapter', totalChapters: chapters.length, doneChapters: done, failedChapters: failed, epId: ch.id, epTitle: ch.title })
    }
    // 封面一并缓存
    if (details?.cover) await imageViaCache(src, k, '', details.cover).catch(() => { /* 封面失败不影响 */ })
    const finalMeta = await readCacheMeta(src.key, k)
    await refreshCacheIndexEntry(src.key, k, finalMeta)
    emitCacheProgress(src.key, k, { phase: 'done', totalChapters: chapters.length, doneChapters: done, failedChapters: failed })
    return { chapters: chapters.length, done, failed }
  },
  /** 查询某部漫画的缓存状态（哪些章节已缓存） */
  'cache.status': async ([key, comicId]) => {
    const meta = await readCacheMeta(String(key), String(comicId))
    if (!meta) return { cached: false, chapters: [] as string[] }
    return { cached: true, chapters: Object.keys(meta.chapters), title: meta.comic?.title, bytes: meta.bytes ?? 0 }
  },
  /** 已缓存列表（LRU 索引） */
  'cache.list': async () => (await loadCacheIndex()).sort((a, b) => b.at - a.at),
  /** 删除单部缓存；comicId 传空清空全部 */
  'cache.remove': async ([key, comicId]) => {
    const k = String(key), c = String(comicId ?? '')
    if (c) {
      await rm(cacheImageDir(k), { recursive: true, force: true }).catch(() => {})
      await rm(cacheMetaFile(k, c), { force: true }).catch(() => {})
      await saveCacheIndex((await loadCacheIndex()).filter(e => !(e.sourceKey === k && e.comicId === c)))
    } else {
      await rm(cacheRoot(), { recursive: true, force: true }).catch(() => {})
      await saveCacheIndex([])
    }
    return { ok: true }
  },
  /* ----- 代理 ----- */
  'net.getProxy': async () => {
    const cfg = await loadProxyConfig()
    return { ...cfg, effective: proxyDispatcher ? (cfg.mode === 'manual' ? cfg.url : effectiveProxy()) : '' }
  },
  'net.setProxy': async ([mode, url]) => {
    const m = String(mode) === 'manual' ? 'manual' : String(mode) === 'direct' ? 'direct' : 'shell'
    const u = String(url ?? '')
    if (m === 'manual' && !/^https?:\/\//i.test(u)) throw new Error('代理地址需以 http:// 或 https:// 开头')
    const result = applyProxy(m, u)
    await storageSet('proxy.config', { mode: m, url: u })
    return result
  },
  /* ----- 辅助 ----- */
  'history.clear': async () => {
    await storageSet('history', [])
    return { ok: true }
  },
}

/** onImageLoad 配置（带每图缓存） */
async function imageRequestConfig(src: SourceInstance, imageKey: string, comicId: string, epId: string): Promise<any> {
  const cacheKey = `${comicId}|${epId}|${imageKey}`
  if (src.imageConfigCache.has(cacheKey)) return src.imageConfigCache.get(cacheKey)
  const onImageLoad = src.instance.comic?.onImageLoad
  if (typeof onImageLoad !== 'function') return null
  try {
    const cfg = await withTimeout(Promise.resolve(onImageLoad(imageKey, comicId, epId)), 15_000, '图片请求配置超时')
    const p = plain(cfg)
    src.imageConfigCache.set(cacheKey, p)
    return p
  } catch {
    return null
  }
}

/** 缓存单章到磁盘：取章节图片列表 → 逐张经 imageViaCache 落盘 → meta 记账 + 索引刷新 */
async function cacheChapterInternal(src: SourceInstance, comicId: string, epId: string, detailsLoader?: () => unknown): Promise<{ images: number }> {
  const chapterResult = await withTimeout(Promise.resolve(src.instance.comic?.loadEp?.(comicId, epId)), 90_000, '章节加载超时')
  const r = plain(chapterResult)
  const images = asArray(r?.images ?? r).map(i => String(i)).filter(Boolean)
  if (!images.length) throw new Error('本章没有图片')
  let bytes = 0
  for (let i = 0; i < images.length; i++) {
    const { base64 } = await imageViaCache(src, comicId, epId, images[i])
    bytes += Math.round(base64.length * 3 / 4)
    emitCacheProgress(src.key, comicId, { phase: 'image', epId, totalImages: images.length, doneImages: i + 1 })
  }
  const meta = (await readCacheMeta(src.key, comicId)) ?? {
    comic: { id: comicId, title: comicId }, chapters: {}, at: Date.now(),
  }
  if (detailsLoader) {
    const d = normalizeDetails(detailsLoader()) as { title?: string; cover?: string } | null
    if (d?.title) meta.comic.title = d.title
    if (d?.cover) meta.comic.cover = d.cover
  }
  meta.chapters[epId] = { images, at: Date.now() }
  meta.at = Date.now()
  meta.bytes = (meta.bytes ?? 0) + bytes
  if ((meta.bytes ?? 0) > CACHE_LIMITS.maxPerComicBytes) throw new Error('单部漫画缓存超出上限')
  await writeCacheMeta(src.key, comicId, meta)
  await refreshCacheIndexEntry(src.key, comicId, meta)
  await evictCacheIfNeeded()
  return { images: images.length }
}
/** 同步某部漫画的缓存索引行（bytes/章数/标题） */
async function refreshCacheIndexEntry(sourceKey: string, comicId: string, meta: CacheMeta | null): Promise<void> {
  const list = await loadCacheIndex()
  const rest = list.filter(e => !(e.sourceKey === sourceKey && e.comicId === comicId))
  if (meta && Object.keys(meta.chapters).length) {
    rest.push({
      sourceKey, comicId,
      title: meta.comic?.title ?? comicId,
      bytes: meta.bytes ?? 0,
      chapters: Object.keys(meta.chapters).length,
      at: meta.at,
    })
  }
  await saveCacheIndex(rest)
}

/** categoryComics optionList 中排行类目（showWhen 含「排行」）的选项标签 */
function categoryRankingOptions(src: SourceInstance): string[] {
  const list = asArray(src.instance.categoryComics?.optionList)
  const opts: string[] = []
  for (const o of list) {
    const item = o as any
    if (!item || typeof item !== 'object') continue
    const showWhen = Array.isArray(item.showWhen) ? item.showWhen.map(String) : null
    // 排行类目通常 showWhen: ["排行"]；其余类目跳过
    if (showWhen && !showWhen.includes('排行')) continue
    for (const raw of asArray(item.options)) {
      // 选项格式 "value-label"（* 前缀标记默认）
      const label = String(raw).replace(/^\*/, '').split('-').slice(1).join('-') || String(raw).replace(/^\*/, '')
      opts.push(label)
    }
  }
  return opts
}
/** 排行类目每组的默认值（* 前缀；无 * 取第一项的 value 段） */
function categoryRankingDefaults(src: SourceInstance): string[] {
  const list = asArray(src.instance.categoryComics?.optionList)
  const values: string[] = []
  for (const o of list) {
    const item = o as any
    if (!item || typeof item !== 'object') continue
    const showWhen = Array.isArray(item.showWhen) ? item.showWhen.map(String) : null
    if (showWhen && !showWhen.includes('排行')) continue
    const options = asArray(item.options)
    if (!options.length) continue
    const starred = options.find(x => String(x).startsWith('*'))
    const chosen = starred ?? options[0]
    values.push(String(chosen).replace(/^\*/, '').split('-')[0])
  }
  return values
}

/* ---------------- 进程协议 ---------------- */
port.on('message', ({ data: request }) => {
  if (request.type === 'init') {
    if (!owner && typeof request.pluginId === 'string') owner = request.pluginId
    const ctx = (request as { context?: { protocolVersion?: number; packagePath?: string; appDataPath?: string } }).context
    // 协议版本校验（backend.md：不能在缺少上下文时静默改用旧实现）
    if (ctx && ctx.protocolVersion !== 1) throw new Error(`Unsupported backend protocol version: ${ctx.protocolVersion}`)
    if (ctx?.packagePath) packagePath = ctx.packagePath
    if (ctx?.appDataPath) appDataPath = ctx.appDataPath
    void loadCookieJar().catch(() => { /* best effort */ })
    // 恢复用户代理配置（默认跟随壳）
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
