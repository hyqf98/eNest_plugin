/**
 * tvbox type 3 Spider 运行时（worker_threads + node:vm 沙箱）。
 *
 * 目标形态：drpy2 adapter（api 指向 drpy2.js，ext 是站点规则），生态主流。
 *
 * drpy2 是宿主注入式同步架构：req()/基础 pdfh/pdfa/pd()/joinUrl() 由宿主提供，
 * 规则解析全同步。Node 的 fetch 是异步的，直接在主线程 vm 里给同步 req 会阻塞
 * 整个后端（媒体代理、其它站点请求全卡死）。
 *
 * 方案：每个 spider 站点跑在专属 worker 线程（node:worker_threads）：
 *  - worker 内 vm 沙箱装载依赖库（cheerio/crypto-js/jsencrypt/muban/gbk/uri，
 *    ESM 壳已剥、UMD 原样）+ drpy2（剥 import/export 壳，default export →
 *    globalThis.__DRPY）+ 基础 pdfh/pdfa/pd/joinUrl（tvbox 自实现注入）；
 *  - 同步网络桥：worker 建 4MB 结果区 SAB 并首先 postMessage 回传；请求时
 *    state=1+notify，主线程收到 call 消息 → net.ts 异步代发 → postMessage 结果
 *    → worker 写结果区 state=2/3+notify 唤醒。单飞（同一时刻仅一个同步请求）。
 *  - 主线程永不被阻塞；spider 卡死只影响自身（invoke 外层 wall-clock 超时）。
 */
import { Worker } from 'node:worker_threads'
import { headersToPlain, HtmlDocument, HtmlElement, withTimeout } from './shared'
import { rawFetch } from './net'
import type { PlayFlag, SiteMeta, VodItem } from './types'

export interface SpiderDeps {
  configBaseUrl?: string
  globalSpider?: string
  /** drpy 依赖库读取器（runtime/presets/drpy/<name>） */
  readRuntimeFile?: (name: string) => Promise<string>
  /** 脚本下载器（带缓存） */
  fetchText?: (url: string) => Promise<string>
  log: (...args: unknown[]) => void
}

export interface SpiderInstance {
  invoke(method: string, ...args: unknown[]): Promise<unknown>
  dispose(): void
}

/* ---------------- worker 源码（eval 内联，不额外分发文件） ---------------- */

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')

// ---- 同步桥：SAB [0]=状态(0空闲 1请求中 2结果 3错误) [1]=结果字节长度；8 偏移起 4MB 结果区 ----
const SAB_BYTES = 8 + 4 * 1024 * 1024
const sab = new SharedArrayBuffer(SAB_BYTES)
const i32 = new Int32Array(sab, 0, 2)
const resultArea = new Uint8Array(sab, 8)
let bridgeBusy = false

function syncRequest(payload) {
  if (bridgeBusy) throw new Error('并发的同步请求不被支持')
  bridgeBusy = true
  try {
    Atomics.store(i32, 0, 1)
    Atomics.notify(i32, 0)
    parentPort.postMessage({ type: 'call', text: JSON.stringify(payload) })
    while (Atomics.load(i32, 0) === 1) Atomics.wait(i32, 0, 1)
    const state = Atomics.load(i32, 0)
    const len = Atomics.load(i32, 1)
    if (len > resultArea.length) throw new Error('同步响应超出 4MB 桥上限')
    const text = Buffer.from(resultArea.buffer, 8, len).toString('utf-8')
    if (state === 3) throw new Error(text || '同步请求失败')
    return JSON.parse(text)
  } finally {
    bridgeBusy = false
    Atomics.store(i32, 0, 0)
  }
}

parentPort.postMessage({ type: 'sab', sab })

// ---- 基础 DOM 解析三件套与 joinUrl（drpy2 引用但宿主注入；用 tvbox HtmlDocument 实现） ----
const BR = String.fromCharCode(10)
function domOf(html) { return new HtmlDocumentClass(String(html ?? '')) }
function basicPdfh(html, parse) {
  parse = String(parse || '').trim()
  if (!parse) return ''
  if (typeof html !== 'string') { try { html = String(html && html.toString ? html.toString() : html) } catch (e) { html = '' } }
  // drpy 复合选择器："选择器&&属性" / "选择器&&Text" / 单选择器
  let selector = parse, attr = ''
  const dd = parse.indexOf('&&')
  if (dd >= 0) { selector = parse.slice(0, dd).trim(); attr = parse.slice(dd + 2).trim() }
  else { const sp = parse.lastIndexOf(' '); if (sp > 0 && /^(@|Text|Html|text|html)/.test(parse.slice(sp + 1))) { selector = parse.slice(0, sp).trim(); attr = parse.slice(sp + 1).trim() } }
  if (!selector) return ''
  if (selector.startsWith('body&&')) selector = selector.slice(6)
  const doc = domOf(html)
  let el = null
  // eq(0) 这类 jQuery 索引简化：取第一个
  const eqm = /:eq\((\d+)\)/.exec(selector)
  if (eqm) selector = selector.replace(/:eq\(\d+\)/, '')
  const found = doc.querySelectorAll(selector)
  if (!found.length) return ''
  el = found[eqm ? Math.min(Number(eqm[1]), found.length - 1) : 0]
  if (!attr || attr === 'Text' || attr === 'text' || attr === 'ownText') return el.text
  if (attr === 'Html' || attr === 'html' || attr === 'innerHTML') return el.innerHTML
  if (attr.startsWith('@')) return el.getAttribute(attr.slice(1)) || ''
  return el.getAttribute(attr) || el.text
}
function basicPdfa(html, parse) {
  parse = String(parse || '').trim()
  if (!parse) return []
  if (typeof html !== 'string') { try { html = String(html) } catch (e) { html = '' } }
  let selector = parse
  const dd = parse.indexOf('&&')
  if (dd >= 0) selector = parse.slice(0, dd).trim()
  if (selector.startsWith('body&&')) selector = selector.slice(6)
  return domOf(html).querySelectorAll(selector).map(el => el.outerHTML)
}
function basicPd(html, parse, baseUrl) {
  const value = basicPdfh(html, parse)
  if (!value) return ''
  if (/^(https?:|magnet:|ftp:|thunder:|ws:)/i.test(value)) return value
  if (baseUrl) { try { return new URL(value, baseUrl).toString() } catch (e) { return value } }
  return value
}
function joinUrl(fromPath, nowPath) {
  fromPath = fromPath || ''; nowPath = nowPath || ''
  if (!nowPath) return fromPath
  if (/^https?:\/\//i.test(nowPath)) return nowPath
  if (!fromPath) return nowPath
  try { return new URL(nowPath, fromPath).toString() } catch (e) { return nowPath }
}
function rstrip(ch) { return String(this).replace(new RegExp(ch + '+$'), '') }

// ---- 沙箱 ----
const { site, libs, drpySource, domClasses } = workerData

// HtmlDocument/HtmlElement 类源码注入（主线程 shared.ts 的类定义字符串化后 eval）
const HtmlDocumentClass = (() => { try { return eval(domClasses.HtmlDocument) } catch (e) { return class {} } })()
const HtmlElementClass = (() => { try { return eval(domClasses.HtmlElement) } catch (e) { return class {} } })()

function makeTimers() {
  const timers = new Set()
  const guard = (fn) => (...args) => { try { fn(...args) } catch (e) { parentPort.postMessage({ type: 'log', args: ['timer: ' + ((e && e.message) || e)] }) } }
  return {
    setTimeout: (fn, ms, ...a) => { const id = setTimeout(guard(fn), Math.max(0, Number(ms) || 0), ...a); timers.add(id); if (id.unref) id.unref(); return id },
    clearTimeout: (id) => { clearTimeout(id); timers.delete(id) },
    setInterval: (fn, ms, ...a) => { const id = setInterval(guard(fn), Math.max(50, Number(ms) || 50), ...a); timers.add(id); return id },
    clearInterval: (id) => { clearInterval(id); timers.delete(id) },
    dispose: () => { for (const id of timers) { clearTimeout(id); clearInterval(id) } timers.clear() },
  }
}
const timers = makeTimers()
const sendLog = (args) => parentPort.postMessage({ type: 'log', args: args.map(a => { try { return (typeof a === 'object' && a !== null) ? JSON.stringify(a).slice(0, 400) : String(a).slice(0, 400) } catch (e) { return String(a) } }) })
const sandboxConsole = { log: sendLog, warn: sendLog, error: sendLog, info: sendLog, debug: () => {} }

function sandboxReq(url, obj) {
  const o = (obj && typeof obj === 'object') ? obj : {}
  return syncRequest({ kind: 'fetch', url: String(url), method: String(o.method || 'GET'), headers: o.headers || {}, body: o.body !== undefined ? String(o.body) : undefined, toBase64: !!o.toBase64 })
}

const sandbox = {
  console: sandboxConsole,
  setTimeout: timers.setTimeout,
  clearTimeout: timers.clearTimeout,
  setInterval: timers.setInterval,
  clearInterval: timers.clearInterval,
  req: sandboxReq,
  pdfh: basicPdfh,
  pdfa: basicPdfa,
  pd: basicPd,
  joinUrl: joinUrl,
  HtmlDocument: HtmlDocumentClass,
  HtmlElement: HtmlElementClass,
  APP: { version: '1.0.0', locale: 'zh_CN', platform: process.platform },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)

for (const [name, libText] of Object.entries(libs)) {
  try { vm.runInContext(libText, context, { timeout: 30000 }) }
  catch (e) { parentPort.postMessage({ type: 'log', args: ['[lib ' + name + '] ' + ((e && e.message) || e)] }) }
}
let drpyOk = true
if (drpySource) {
  try { vm.runInContext(drpySource, context, { timeout: 60000 }) }
  catch (e) { drpyOk = false; parentPort.postMessage({ type: 'log', args: ['[drpy2] ' + ((e && e.stack) || e)] }) }
}
parentPort.postMessage({ type: 'ready', drpyOk })

// ---- 消息处理 ----
parentPort.on('message', (m) => {
  if (m.type === 'result') {
    const bytes = Buffer.from(m.text || '', 'utf-8')
    if (bytes.length > resultArea.length) {
      Atomics.store(i32, 1, 0)
      Atomics.store(i32, 0, 3)
      Atomics.notify(i32, 0)
      return
    }
    resultArea.set(bytes)
    Atomics.store(i32, 1, bytes.length)
    Atomics.store(i32, 0, m.error ? 3 : 2)
    Atomics.notify(i32, 0)
    return
  }
  if (m.type === 'invoke') {
    const id = m.id
    ;(async () => {
      const DRPY = sandbox.__DRPY
      const fn = DRPY ? DRPY[m.method] : null
      if (typeof fn !== 'function') throw new Error('DRPY 缺少方法 ' + m.method)
      return await fn(m.arg0, m.arg1, m.arg2, m.arg3)
    })().then(
      (r) => parentPort.postMessage({ type: 'invoke.result', id, ok: true, result: JSON.parse(JSON.stringify(r === undefined ? null : r, (k, v) => {
        if (typeof v === 'function') return String(v)
        if (typeof v === 'bigint') return v.toString()
        if (v && v.constructor && (v.constructor.name === 'HtmlElement' || v.constructor.name === 'HtmlDocument')) return String(v.text || '')
        if (v && v.constructor && v.constructor.name === 'Map') return Object.fromEntries(v)
        if (v && v.constructor && v.constructor.name === 'Set') return Array.from(v)
        if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64') }
        return v
      })) }),
      (e) => parentPort.postMessage({ type: 'invoke.result', id, ok: false, error: String((e && e.message) || e).slice(0, 500) }),
    )
  }
})
`

/* ---------------- 主线程侧 ---------------- */

interface PendingInvoke { resolve(value: unknown): void; reject(error: Error): void }

/** 剥 ESM 壳：头部 import 行去掉、export default → 全局赋值、export {...} 去掉 */
export function stripEsm(text: string): string {
  return text
    .replace(/^import\s+[^;\n]*;?\s*$/gm, '')
    .replace(/^export\s+default\s+\{/, 'globalThis.__DRPY = {')
    .replace(/^export\s+\{[\s\S]*?\}\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
}

export async function instantiateSpider(site: SiteMeta, deps: SpiderDeps): Promise<SpiderInstance> {
  const { readRuntimeFile, fetchText, configBaseUrl, log } = deps
  const apiRef = site.api.trim()
  if (apiRef.startsWith('csp_') || /\.jar/i.test(apiRef)) throw new Error('该站点使用 Java 爬虫（jar），桌面端不支持')
  if (/\.py($|\?)/i.test(apiRef)) throw new Error('该站点使用 Python 爬虫，桌面端不支持')
  if (!/\.js($|\?)/i.test(apiRef) && !apiRef.startsWith('node:')) {
    throw new Error(`无法识别的 spider api：${apiRef.slice(0, 60)}`)
  }

  const resolveRef = (ref: string): string => {
    if (/^https?:\/\//i.test(ref)) return ref
    if (configBaseUrl) {
      try { return new URL(ref.replace(/^\.\//, ''), configBaseUrl).toString() } catch { /* fallthrough */ }
    }
    return ref
  }

  // drpy2 运行时：本地 presets 优先，否则下载
  const runtimeUrl = apiRef.startsWith('node:') ? apiRef.slice(5) : resolveRef(apiRef)
  let drpySource: string
  if (/drpy/i.test(runtimeUrl) && readRuntimeFile) {
    drpySource = stripEsm(await readRuntimeFile('drpy2.js'))
  } else {
    if (!fetchText) throw new Error('缺少脚本下载能力')
    drpySource = stripEsm(await fetchText(runtimeUrl))
  }

  // 依赖库（cheerio/crypto-js/jsencrypt/uri UMD 原样；muban/gbk ESM 剥壳提全局）
  const libs: Record<string, string> = {}
  if (readRuntimeFile) {
    const wrappers: Record<string, (t: string) => string> = {
      'muban.js': t => stripEsm(t) + ';globalThis.模板 = (typeof muban !== \'undefined\') ? muban : globalThis.muban;',
      'gbk.js': t => stripEsm(t) + ';globalThis.gbkTool = (typeof gbkTool !== \'undefined\') ? gbkTool : globalThis.gbkTool;',
    }
    for (const name of ['cheerio.min.js', 'crypto-js.js', 'jsencrypt.js', 'muban.js', 'gbk.js', 'uri.min.js']) {
      const text = await readRuntimeFile(name).catch(() => '')
      if (text) libs[name] = wrappers[name] ? wrappers[name](text) : text
    }
  }
  if (!libs['cheerio.min.js']) throw new Error('drpy 运行时依赖缺失（cheerio），请重新构建插件包')

  // worker 里需要的 HtmlDocument 类源码：从 shared 的类序列化不可行，直接注入构造入口
  // （shared.ts 的 HtmlDocument 是主线程类；worker 源码里引用 HtmlDocumentClass —— 由
  //  workerData 传入工厂函数字符串。见下方 workerData.libs 注入。）

  // ext：规则脚本文本（drpy2 init 里 eval）；对象字符串直传
  let extArg = site.ext ?? ''
  if (site.ext && !site.ext.trimStart().startsWith('{') && fetchText) {
    try { extArg = await fetchText(resolveRef(site.ext)) } catch { /* 让 drpy2 init 自行下载 */ }
  }

  // HtmlDocument/HtmlElement 类注入：shared.ts 的类定义 toString 后在 worker 内 eval
  // （类体没有闭包引用，序列化安全）
  const domClasses = {
    HtmlDocument: HtmlDocument.toString(),
    HtmlElement: HtmlElement.toString(),
  }

  // worker 启动与握手
  const invokes = new Map<number, PendingInvoke>()
  let invokeSeq = 0
  let disposed = false
  let workerSab: Int32Array | null = null
  let readyResolve: (() => void) | undefined
  let readyReject: ((e: Error) => void) | undefined
  const readyPromise = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { site: { key: site.key, name: site.name }, libs, drpySource, domClasses },
  })
  worker.unref()

  const failAll = (msg: string) => { for (const p of invokes.values()) p.reject(new Error(msg)); invokes.clear() }
  worker.on('message', (m: any) => {
    if (m.type === 'sab') { workerSab = new Int32Array(m.sab, 0, 2); return }
    if (m.type === 'ready') {
      if (!workerSab) { readyReject?.(new Error('spider 桥未就绪')); return }
      if (!m.drpyOk) { readyReject?.(new Error('drpy2 运行时装载失败（见日志）')); return }
      readyResolve?.()
      return
    }
    if (m.type === 'log') { log(`[spider:${site.key}]`, ...(m.args ?? [])); return }
    if (m.type === 'call') {
      void (async () => {
        try {
          const payload = JSON.parse(m.text)
          const result = await handleBridgeCall(payload, site)
          worker.postMessage({ type: 'result', text: JSON.stringify({ result }) })
        } catch (e) {
          worker.postMessage({ type: 'result', text: String(e instanceof Error ? e.message : e).slice(0, 200), error: true })
        }
      })()
      return
    }
    if (m.type === 'invoke.result') {
      const pending = invokes.get(m.id)
      if (!pending) return
      invokes.delete(m.id)
      if (m.ok) pending.resolve(m.result)
      else pending.reject(new Error(String(m.error)))
    }
  })
  worker.on('error', (e) => { readyReject?.(new Error(`spider 线程崩溃：${e.message}`)); failAll('spider 线程已崩溃') })
  worker.on('exit', () => failAll('spider 线程已退出'))

  await withTimeout(readyPromise, 60_000, 'spider 启动超时')

  const instance: SpiderInstance = {
    invoke(method, ...args) {
      if (disposed) return Promise.reject(new Error('spider 已释放'))
      const id = ++invokeSeq
      return new Promise((resolve, reject) => {
        invokes.set(id, { resolve, reject })
        worker.postMessage({ type: 'invoke', id, method, arg0: args[0], arg1: args[1], arg2: args[2], arg3: args[3] })
      })
    },
    dispose() {
      disposed = true
      failAll('spider 已释放')
      void worker.terminate().catch(() => {})
    },
  }

  await withTimeout(instance.invoke('init', extArg), 60_000, 'spider init 超时')
  return instance
}

/** worker 同步桥的网络代发（drpy req 语义：{content, headers, status}） */
async function handleBridgeCall(payload: { kind?: string; url?: string; method?: string; headers?: Record<string, string>; body?: string; toBase64?: boolean }, site: SiteMeta): Promise<unknown> {
  if (payload.kind !== 'fetch' || !payload.url) throw new Error(`未知桥调用 ${payload.kind}`)
  const headers = headersToPlain(payload.headers)
  const res = await rawFetch(payload.url, {
    method: payload.method ?? 'GET',
    headers: { ...site.header, ...headers },
    data: payload.body,
    ownerKey: site.key,
    timeoutMs: (site.timeout ?? 20) * 1000,
  })
  return {
    content: payload.toBase64 ? Buffer.from(res.bytes).toString('base64') : res.body,
    headers: res.headers,
    status: res.status,
  }
}

/* ---------------- 归一化（index.ts 用） ---------------- */

export function normalizeVods(list: unknown, siteKey: string): VodItem[] {
  return (Array.isArray(list) ? list : []).map((v: any) => ({
    vod_id: String(v?.vod_id ?? v?.id ?? ''),
    vod_name: String(v?.vod_name ?? v?.name ?? ''),
    vod_pic: v?.vod_pic ? String(v.vod_pic) : undefined,
    vod_remarks: v?.vod_remarks ? String(v.vod_remarks) : undefined,
    type_name: v?.type_name ? String(v.type_name) : undefined,
    vod_year: v?.vod_year ? String(v.vod_year) : undefined,
    siteKey,
  })).filter(v => v.vod_id && v.vod_name)
}

export function splitFlags(playFrom: unknown, playUrl: unknown): PlayFlag[] {
  const fromList = String(playFrom ?? '').split('$$$').map(s => s.trim()).filter(Boolean)
  const urlParts = String(playUrl ?? '').split('$$$')
  return fromList.map((flag, i) => ({
    flag,
    episodes: String(urlParts[i] ?? '').split('#').filter(Boolean).map(seg => {
      const idx = seg.indexOf('$')
      if (idx <= 0) return { name: '', url: seg.trim() }
      return { name: seg.slice(0, idx).trim(), url: seg.slice(idx + 1).trim() }
    }).filter(e => e.url),
  })).filter(f => f.episodes.length)
}
