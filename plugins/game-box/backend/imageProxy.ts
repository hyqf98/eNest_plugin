/**
 * media.load 实现。token 格式：
 * - cover:<seed>            带截断封面的 Steam CDN 端点（依次补 header.jpg / library_600x900.jpg /
 *                             movie_600x337.jpg / 空串，取第一个 200 且 content-type 是图片的）
 * - img:<url 的 base64url>  单图
 * - video:<url 的 base64url> 视频（回环代理）
 * 小图（≤ 4 MiB）返回 data URL；大图/视频起 127.0.0.1 回环 HTTP 服务并 endpoint.allow 注册。
 * 正文 HTML 不走这里：它随 library.detail 返回，由 sanitizeArticle 净化（白名单重建，不用正则）。
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getAdapter } from './adapters/current.ts'
import { BackendError } from './adapters/types.ts'
import type { MediaPayload } from './contracts.ts'
import { requestHost, onShutdown } from './runtime.ts'
import { sanitizeHtml } from './sanitize.ts'

const SMALL_IMAGE_LIMIT = 4 * 1024 * 1024
/** 图床与 CDN 大多对没有浏览器 UA 的请求返回 403 */
const IMAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function b64decode(token: string): string {
  return Buffer.from(token, 'base64url').toString('utf8')
}

export function imgTokenOf(url: string): string {
  return `img:${Buffer.from(url, 'utf8').toString('base64url')}`
}

function isImageMime(mime: string): boolean {
  return /^image\//i.test(mime)
}

function mimeFromBytes(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  // ISO 基础媒体文件：按 ftyp 盒子的品牌区分 AVIF 与 HEIF 图像
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (/^avi[fs]$/.test(brand)) return 'image/avif'
    if (/^hei[cf]$/.test(brand) || brand === 'mif1') return 'image/heic'
  }
  return fallback
}

/** 带可选 referer 的图片请求 */
async function fetchImage(url: string, referer?: string, accept?: string): Promise<{ status: number; mime: string; bytes: Uint8Array }> {
  const adapter = getAdapter()
  const headers: Record<string, string> = { accept: accept ?? 'image/avif,image/webp,image/*,*/*;q=0.8', 'user-agent': IMAGE_UA }
  if (referer) headers.referer = referer
  const response = await adapter.request({ url, headers, timeoutMs: 20_000, maxBytes: 24 * 1024 * 1024 })
  return { status: response.status, mime: response.headers['content-type'] ?? '', bytes: response.body }
}

/** 封面截断修复：依次补扩展名取第一个 200 且 content-type 是图片的 */
async function resolveCover(seed: string): Promise<{ url: string; bytes: Uint8Array; mime: string }> {
  const suffixes = ['header.jpg', 'library_600x900.jpg', 'movie_600x337.jpg', '']
  for (const suffix of suffixes) {
    const candidate = seed + suffix
    try {
      const result = await fetchImage(candidate)
      if (result.status === 200 && (isImageMime(result.mime) || mimeLooksImage(result.bytes))) {
        return { url: candidate, bytes: result.bytes, mime: isImageMime(result.mime) ? result.mime : mimeFromBytes(result.bytes, 'image/jpeg') }
      }
    } catch {
      // 试下一个后缀。
    }
  }
  throw new BackendError('MEDIA_NOT_FOUND', '封面图片加载失败')
}

function mimeLooksImage(bytes: Uint8Array): boolean {
  return mimeFromBytes(bytes, '') !== ''
}

/* ---------------- HTML 净化 ---------------- */

/**
 * 净化正文 HTML，并把资源地址改写成令牌（页面受 CSP 限制不能直接加载第三方图片/视频）。
 * 净化本身走 sanitize.ts 的白名单重建；这里只负责地址改写。
 * 相对地址没有可用的 base：协议相对地址补 https，其余相对地址丢弃。
 */
export function sanitizeArticle(html: string): string {
  const toToken = (url: string): string | null => (/^\/\//.test(url) ? `https:${url}` : /^https?:\/\//i.test(url) ? url : null)
  return sanitizeHtml(html, {
    imageToken: url => { const absolute = toToken(url); return absolute ? imgTokenOf(absolute) : null },
    videoToken: url => { const absolute = toToken(url); return absolute ? videoTokenOf(absolute) : null },
  })
}

/* ---------------- 回环代理服务 ---------------- */

interface LoopbackEntry {
  url: string
  headers: Record<string, string>
  mime: string
  /** HLS：该地址是播放列表，需读取正文并把里面的相对地址改写成回环地址 */
  playlist?: boolean
}

let server: Server | null = null
let origin = ''
let endpointToken = ''
const entries = new Map<string, LoopbackEntry>()

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'range',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  }
}

async function ensureServer(): Promise<string> {
  if (server && origin) return origin
  const next = createServer((req, res) => { void handleLoopback(req, res) })
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(0, '127.0.0.1', () => { next.removeListener('error', reject); resolve() })
  })
  const port = (next.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`
  server = next
  endpointToken = `game-box-media-${Date.now().toString(36)}`
  try {
    await requestHost('endpoint.allow', { token: endpointToken, url: origin, kind: 'subFrame', pid: process.pid })
  } catch (error) {
    await stopLoopback()
    throw new BackendError('MEDIA_ERROR', `媒体回环端点注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return origin
}

export async function stopLoopback(): Promise<void> {
  if (endpointToken) {
    await requestHost('endpoint.revoke', { token: endpointToken }, 5_000).catch(() => undefined)
    endpointToken = ''
  }
  const current = server
  server = null
  origin = ''
  entries.clear()
  if (current) await new Promise<void>(resolve => current.close(() => resolve()))
}

onShutdown(() => { void stopLoopback() })

/**
 * 解析回环请求的路径：/<id> 取条目本身；/<id>/<相对路径> 取以条目地址为基准的子资源（HLS 的子播放列表与分片）。
 * 子资源只能是同一目录（或其下级）里的相对地址，不能借这个代理访问任意站点。
 */
function resolveLoopbackTarget(pathname: string): { entry: LoopbackEntry; url: string } | null {
  const segments = pathname.split('/').filter(Boolean)
  const entry = entries.get(segments[0] ?? '')
  if (!entry) return null
  const rest = segments.slice(1)
  if (!rest.length) return { entry, url: entry.url }
  const base = new URL(entry.url)
  // 把请求里的相对路径拼到基址目录下；拒绝绝对地址、协议相对地址与 .. 逃逸
  const joined = rest.join('/')
  if (/^[a-z][a-z0-9+.-]*:/i.test(joined) || joined.startsWith('//')) return null
  const target = new URL(joined, base.href)
  const allowedPrefix = new URL('.', base.href).href
  if (!target.href.startsWith(allowedPrefix) || target.origin !== base.origin) return null
  return { entry, url: target.href }
}

async function handleLoopback(req: { url?: string; method?: string; headers: Record<string, string | string[] | undefined> }, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://game-box.local')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }
  let resolved: { entry: LoopbackEntry; url: string } | null
  try { resolved = resolveLoopbackTarget(url.pathname) } catch { resolved = null }
  if (!resolved) {
    res.writeHead(404, corsHeaders())
    res.end('not found')
    return
  }
  const { entry, url: target } = resolved
  const rangeHeader = req.headers.range
  const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader
  try {
    const adapter = getAdapter()
    // 播放列表（m3u8）：整段读出，把里面的相对地址改写成回环地址后再交给播放器
    if (entry.playlist && /\.m3u8$/i.test(new URL(target).pathname)) {
      const response = await adapter.request({ url: target, headers: entry.headers, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 })
      if (response.status < 200 || response.status >= 300) throw new BackendError('MEDIA_NOT_FOUND', `播放列表加载失败（HTTP ${response.status}）`)
      const text = new TextDecoder('utf-8').decode(response.body)
      const id = url.pathname.split('/').filter(Boolean)[0]
      const rewritten = rewritePlaylist(text, target, `${origin}/${id}/`)
      res.writeHead(200, { ...corsHeaders(), 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(rewritten) })
      res.end(req.method === 'HEAD' ? undefined : rewritten)
      return
    }
    const stream = await adapter.openStream(target, { headers: entry.headers, ...(range ? { range } : {}) })
    const outHeaders: Record<string, string | number> = {
      ...corsHeaders(),
      'content-type': stream.headers['content-type'] || entry.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    }
    const contentRange = stream.headers['content-range']
    const contentLength = stream.headers['content-length']
    if (contentRange) outHeaders['content-range'] = contentRange
    if (contentLength) outHeaders['content-length'] = contentLength
    res.writeHead(stream.status === 206 || stream.status === 200 ? stream.status : 200, outHeaders)
    if (req.method === 'HEAD') { stream.abort(); res.end(); return }
    for (;;) {
      const chunk = await stream.read()
      if (!chunk) break
      if (!res.write(chunk.bytes as Buffer)) await new Promise<void>(resolve => res.once('drain', resolve))
    }
    res.end()
  } catch {
    if (!res.headersSent) res.writeHead(502, corsHeaders())
    res.end('media error')
  }
}

/**
 * 改写 m3u8 里的地址：每一行不是注释的 URI（分片、子播放列表、加密密钥的 URI="…"）都换成回环地址。
 * 只改写能以当前播放列表为基准解析的地址；解析后不在同一来源下的保持原样（播放器请求不到，会被 CSP 拦住）。
 */
export function rewritePlaylist(text: string, playlistUrl: string, prefix: string): string {
  const base = new URL(playlistUrl)
  const map = (uri: string): string => {
    const trimmed = uri.trim()
    if (!trimmed) return uri
    try {
      const resolved = new URL(trimmed, base.href)
      // 只代理与播放列表同来源的地址：回环代理解析子资源时要求同源同目录
      if (resolved.origin !== base.origin) return uri
      const here = new URL('.', base.href).href
      if (!resolved.href.startsWith(here)) return uri
      return prefix + resolved.href.slice(here.length)
    } catch {
      return uri
    }
  }
  return text
    .split(/\r?\n/)
    .map(line => {
      if (line.startsWith('#')) {
        // #EXT-X-MEDIA / #EXT-X-KEY / #EXT-X-MAP 行里的 URI="…"
        return line.replace(/\bURI="([^"]*)"/g, (whole, uri: string) => `URI="${map(uri)}"`)
      }
      return map(line)
    })
    .join('\n')
}

async function loopbackUrl(target: string, headers: Record<string, string>, mime: string, playlist = false): Promise<string> {
  const base = await ensureServer()
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  entries.set(id, { url: target, headers, mime, playlist })
  // 上限保护：只保留最近 64 个。
  while (entries.size > 64) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    entries.delete(oldest)
  }
  return `${base}/${id}`
}

/* ---------------- token 分发 ---------------- */

export async function mediaLoad(token: string): Promise<MediaPayload> {
  if (!token) throw new BackendError('INVALID_ARGUMENT', 'media token 不能为空')
  // 本地添加的条目封面：后端自己生成的图片 data URL，不经网络。只放行 image/* 类型（含 AVIF）。
  if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(token)) {
    const mime = token.slice(5, token.indexOf(';'))
    return { url: token, mime }
  }
  const colon = token.indexOf(':')
  const kind = colon > 0 ? token.slice(0, colon) : ''
  const payload = colon > 0 ? token.slice(colon + 1) : ''
  switch (kind) {
    case 'cover':
      return coverPayload(payload)
    case 'img':
      return imagePayload(b64decode(payload))
    case 'video':
      return videoPayload(b64decode(payload))
    default:
      throw new BackendError('INVALID_ARGUMENT', '无法识别的 media token')
  }
}

async function coverPayload(seed: string): Promise<MediaPayload> {
  if (!seed) throw new BackendError('INVALID_ARGUMENT', 'cover token 缺少地址')
  const resolved = await resolveCover(seed)
  if (resolved.bytes.length <= SMALL_IMAGE_LIMIT) {
    const mime = mimeFromBytes(resolved.bytes, resolved.mime || 'image/jpeg')
    return { url: `data:${mime};base64,${Buffer.from(resolved.bytes).toString('base64')}`, mime }
  }
  return { url: await loopbackUrl(resolved.url, {}, mimeFromBytes(resolved.bytes, 'image/jpeg')), mime: mimeFromBytes(resolved.bytes, 'image/jpeg') }
}

async function imagePayload(url: string): Promise<MediaPayload> {
  if (!/^https?:\/\//i.test(url)) throw new BackendError('INVALID_ARGUMENT', '图片地址无效')
  // token 里可能带 ref: 前缀指明 referer：img:<b64url> 之外还有一种 ref 组合写法。
  const result = await fetchImage(url, refererFor(url))
  if (result.status !== 200) throw new BackendError('MEDIA_NOT_FOUND', `图片加载失败（HTTP ${result.status}）`)
  const mime = isImageMime(result.mime) ? result.mime : mimeFromBytes(result.bytes, 'image/jpeg')
  if (result.bytes.length <= SMALL_IMAGE_LIMIT) {
    return { url: `data:${mime};base64,${Buffer.from(result.bytes).toString('base64')}`, mime }
  }
  return { url: await loopbackUrl(url, refererHeaders(url), mime), mime }
}

function refererFor(url: string): string | undefined {
  // 少数图床校验 referer；统一带站点自身地址足够，且不带用户数据。
  try {
    const host = new URL(url).hostname
    if (/(steampowered|steamstatic|akamai)/i.test(host)) return 'https://store.steampowered.com/'
    if (/(uy5|kelongwo)/i.test(host)) return 'https://www.uy5.net'
    if (/(fucnm)/i.test(host)) return 'https://dl.fucnm.com'
    if (/(3dmgame)/i.test(host)) return 'https://mod.3dmgame.com/'
    return undefined
  } catch {
    return undefined
  }
}

function refererHeaders(url: string): Record<string, string> {
  const referer = refererFor(url)
  return referer ? { referer } : {}
}

async function videoPayload(url: string): Promise<MediaPayload> {
  if (!/^https?:\/\//i.test(url)) throw new BackendError('INVALID_ARGUMENT', '视频地址无效')
  // HLS 播放列表：交给回环代理的播放列表模式（读取并改写里面的相对地址）；其余按流式视频代理
  let isPlaylist = /\.m3u8$/i.test(new URL(url).pathname)
  let mime = isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp4'
  if (!isPlaylist) {
    // 扩展名不可靠（带不带 .mp4 都有）：探测一次，按内容类型判断是播放列表还是普通视频
    try {
      const response = await getAdapter().request({ url, headers: { ...refererHeaders(url), range: 'bytes=0-0', 'user-agent': IMAGE_UA }, timeoutMs: 15_000, maxBytes: 64 * 1024 })
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase()
      if (/mpegurl/.test(contentType)) { isPlaylist = true; mime = 'application/vnd.apple.mpegurl' }
      else if (contentType.startsWith('video/') || contentType.startsWith('audio/') || contentType === 'application/octet-stream') mime = contentType === 'application/octet-stream' ? 'video/mp4' : contentType
    } catch {
      // 探测失败不影响：按流式视频代理，真有问题会在播放时报错
    }
  }
  return { url: await loopbackUrl(url, refererHeaders(url), mime, isPlaylist), mime }
}

export function videoTokenOf(url: string): string {
  return `video:${Buffer.from(url, 'utf8').toString('base64url')}`
}
