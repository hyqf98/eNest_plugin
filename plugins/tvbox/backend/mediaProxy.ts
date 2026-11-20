/**
 * tvbox 媒体代理：后端 127.0.0.1 回环 HTTP 服务，前端 hls.js 经它拉流。
 * 为什么必须代理：视频 CDN 普遍有防盗链（Referer/UA）与 CORS 限制，页面
 * CSP 也不允许媒体直连外网；代理层统一注入 play 返回的 header。
 *
 * 路由（均 GET）：
 *  - /m?u=<b64url>&h=<b64headers JSON>  媒体入口：m3u8 文本改写子地址为代理地址；其他流式转发
 *  - /i?u=<b64url>&h=...                图片（海报兜底通道）
 * endpoint.allow {kind:'subFrame'} 放行整个回环 origin（pluginSessionPolicy），
 * shutdown/失败即 revoke；URL 不签名（端口随机 + 生命周期 = 进程生命周期）。
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { cookieHeaderFor, setupProxy } from './net'

export interface MediaProxyHandle {
  origin: string
  close(): Promise<void>
}

type HostRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>

interface ProxyContext {
  hostRequest: HostRequest
  /** 拉流器：返回 fetch Response，由调用方 pipe/读文本 */
  fetchStream: (url: string, headers: Record<string, string>, range?: string) => Promise<Response>
  log: (...args: unknown[]) => void
}

const B64 = {
  encode: (s: string) => Buffer.from(s, 'utf-8').toString('base64url'),
  decode: (s: string) => Buffer.from(String(s ?? ''), 'base64url').toString('utf-8'),
}

let server: Server | null = null
let originCache = ''
let endpointToken = ''
let ctxRef: ProxyContext | null = null

/** m3u8 文本改写：把子 playlist/segment 地址换成代理地址（保真原站 header 注入） */
function rewriteM3u8(text: string, baseUrl: string, headers: Record<string, string>, ownerKey: string): string {
  const headerB64 = B64.encode(JSON.stringify(headers))
  const proxify = (rawUrl: string): string => {
    const abs = /^https?:\/\//i.test(rawUrl) ? rawUrl : new URL(rawUrl, baseUrl).toString()
    return `/m?u=${B64.encode(abs)}&h=${headerB64}&o=${encodeURIComponent(ownerKey)}`
  }
  return text
    .split('\n')
    .map(line => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) {
        // URI="..." 属性（key map / byterange 等）也要改写
        return t.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(String(uri))}"`)
      }
      return proxify(t)
    })
    .join('\n')
}

async function dispatch(req: { url?: string; headers: Record<string, string | string[] | undefined> }, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://tvbox.local')
  try {
    if (url.pathname === '/m' || url.pathname === '/i') {
      const target = B64.decode(url.searchParams.get('u') ?? '')
      if (!/^https?:\/\//i.test(target)) { res.writeHead(400); res.end('bad target'); return }
      const headerJson = B64.decode(url.searchParams.get('h') ?? '')
      const ownerKey = url.searchParams.get('o') ?? ''
      let headers: Record<string, string> = {}
      try { headers = headerJson ? JSON.parse(headerJson) : {} } catch { /* 空头 */ }
      if (ownerKey) {
        const cookie = cookieHeaderFor(ownerKey, target)
        if (cookie && !Object.keys(headers).some(k => k.toLowerCase() === 'cookie')) headers['cookie'] = cookie
      }
      if (url.pathname === '/i') {
        // 图片：整包读回（海报兜底通道；正常海报走 image.load base64）
        const buf = await ctxRef!.fetchStream(target, headers)
        const bytes = new Uint8Array(await buf.arrayBuffer())
        res.writeHead(buf.status >= 400 ? buf.status : 200, {
          'content-type': buf.headers.get('content-type') ?? 'image/jpeg',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=86400',
        })
        res.end(bytes)
        return
      }
      // 媒体：先探测 content-type 再决定改写或转发
      const rangeHeader = req.headers.range
      const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader
      const probe = await ctxRef!.fetchStream(target, headers, range)
      const ctype = (probe.headers.get('content-type') ?? '').toLowerCase()
      const looksManifest = /\.m3u8(\?|$)/i.test(target) || ctype.includes('mpegurl') || ctype.includes('m3u')
      if (looksManifest && probe.ok) {
        const text = await probe.text()
        const rewritten = rewriteM3u8(text, target, headers, ownerKey)
        res.writeHead(200, {
          'content-type': 'application/vnd.apple.mpegurl',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        })
        res.end(rewritten)
        return
      }
      await pipeResponse(probe, res)
      return
    }
    res.writeHead(404); res.end('not found')
  } catch (error) {
    ctxRef?.log('[tvbox] proxy error:', error instanceof Error ? error.message : String(error))
    if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' })
    res.end('proxy error')
  }
}

async function pipeResponse(upstream: Response, res: ServerResponse): Promise<void> {
  if (!upstream.ok && upstream.status !== 206) {
    res.writeHead(upstream.status, { 'access-control-allow-origin': '*' })
    res.end(`upstream ${upstream.status}`)
    return
  }
  const outHeaders: Record<string, string> = { 'access-control-allow-origin': '*' }
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(key)
    if (v) outHeaders[key] = v
  }
  res.writeHead(upstream.status, outHeaders)
  if (!upstream.body) { res.end(); return }
  const reader = upstream.body.getReader()
  res.on('close', () => { void reader.cancel().catch(() => {}) })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const canContinue = res.write(value as Buffer)
      if (!canContinue) await new Promise<void>(resolve => res.once('drain', resolve))
    }
    res.end()
  } catch {
    res.destroy()
  }
}

/** 启动回环服务并注册宿主端点；返回代理 origin（http://127.0.0.1:<port>） */
export async function startMediaProxy(context: HostRequest, fetchStream: ProxyContext['fetchStream'], log: ProxyContext['log'] = console.log): Promise<MediaProxyHandle> {
  if (server && originCache) return { origin: originCache, close: async () => { await stopMediaProxy() } }
  setupProxy(log)
  ctxRef = { hostRequest: context, fetchStream, log }
  const s = createServer((req, res) => { void dispatch(req, res) })
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { s.removeListener('error', reject); resolve() })
  })
  const port = (s.address() as AddressInfo).port
  originCache = `http://127.0.0.1:${port}`
  server = s
  // 宿主端点注册（dsh 同款）：subFrame 放行该回环 origin 的资源请求
  endpointToken = `tvbox-media-${Date.now().toString(36)}`
  try {
    await context('endpoint.allow', { token: endpointToken, url: originCache, kind: 'subFrame', pid: process.pid })
    log('[tvbox] media proxy on', originCache)
  } catch (error) {
    await stopMediaProxy().catch(() => {})
    throw new Error(`回环端点注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { origin: originCache, close: async () => { await stopMediaProxy() } }
}

export async function stopMediaProxy(): Promise<void> {
  if (endpointToken && ctxRef) {
    try { await ctxRef.hostRequest('endpoint.revoke', { token: endpointToken }) } catch { /* best effort */ }
    endpointToken = ''
  }
  const s = server
  server = null
  originCache = ''
  if (!s) return
  await new Promise<void>(resolve => s.close(() => resolve()))
}

/** 给播放地址生成代理 URL（前端直接喂给 hls.js/video） */
export function proxyMediaUrl(origin: string, target: string, headers: Record<string, string> | undefined, ownerKey: string): string {
  const h = B64.encode(JSON.stringify(headers ?? {}))
  return `${origin}/m?u=${B64.encode(target)}&h=${h}&o=${encodeURIComponent(ownerKey)}`
}
export function proxyImageUrl(origin: string, target: string, ownerKey: string): string {
  return `${origin}/i?u=${B64.encode(target)}&h=${B64.encode('{}')}&o=${encodeURIComponent(ownerKey)}`
}
