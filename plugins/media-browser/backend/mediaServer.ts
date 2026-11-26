/**
 * 媒体回环服务：把关联目录里的图片/视频/缩略图经 127.0.0.1 提供给页面。
 *
 * 页面受 CSP 限制不能直接读本地文件，也不能拿到绝对路径。这里用不透明的 mediaId 换内容：
 * mediaId 是后端签发的随机串，只在本进程有效，页面无法用它访问关联目录之外的文件。
 *
 * 路由：
 *   /t/<mediaId>   缩略图（JPEG）
 *   /o/<mediaId>   原图（浏览器可解码的格式直接给原文件）
 *   /v/<mediaId>   视频原文件，支持 Range（拖动进度条）
 */

import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { onShutdown, requestHost } from './runtime.ts'
import { pathOf } from './entries.ts'
import { mediaKindOf } from './fs.ts'
import { extOf, generateThumb } from './thumbs.ts'
import { thumbCacheFile } from './thumbCache.ts'

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t', '3gp': 'video/3gpp', ogv: 'video/ogg',
}

const INLINE_IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'])

/** mediaId → entryId；上限防止长期滚动无限增长 */
const MEDIA_LIMIT = 50_000
const mediaIds = new Map<string, string>()

let server: Server | null = null
let origin = ''
let endpointToken = ''

export function mediaOrigin(): string {
  return origin
}

/** 为一个文件条目签发 mediaId（同一个条目复用同一个 id） */
export function mediaIdFor(entryId: string): string {
  for (const [id, owner] of mediaIds) if (owner === entryId) return id
  if (mediaIds.size >= MEDIA_LIMIT) {
    // Map 保持插入顺序，删最早的一批
    let dropped = 0
    for (const key of mediaIds.keys()) {
      mediaIds.delete(key)
      if (++dropped >= 1_000) break
    }
  }
  const id = randomUUID()
  mediaIds.set(id, entryId)
  return id
}

export function urlFor(kind: 't' | 'o' | 'v', entryId: string): string | null {
  if (!origin) return null
  return `${origin}/${kind}/${mediaIdFor(entryId)}`
}

/** 启动回环服务并向宿主登记端点；返回 origin */
export async function startMediaServer(): Promise<string> {
  if (server && origin) return origin
  const next = createServer((req, res) => { void handle(req, res) })
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(0, '127.0.0.1', () => { next.removeListener('error', reject); resolve() })
  })
  server = next
  origin = `http://127.0.0.1:${(next.address() as AddressInfo).port}`
  endpointToken = `media-browser-${randomUUID()}`
  try {
    await requestHost('endpoint.allow', { token: endpointToken, url: origin, kind: 'subFrame', pid: process.pid })
  } catch (error) {
    await stopMediaServer()
    throw new Error(`媒体回环端点注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return origin
}

export async function stopMediaServer(): Promise<void> {
  if (endpointToken) {
    await requestHost('endpoint.revoke', { token: endpointToken }, 5_000).catch(() => undefined)
    endpointToken = ''
  }
  const current = server
  server = null
  origin = ''
  mediaIds.clear()
  if (current) await new Promise<void>(resolve => current.close(() => resolve()))
}

onShutdown(() => stopMediaServer())

/* ---------------- 请求处理 ---------------- */

interface LooseRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}

const BASE_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body?: Buffer | string): void {
  res.writeHead(status, { ...BASE_HEADERS, ...headers })
  res.end(body)
}

/** 缩略图缓存键里带上扩展名，转换格式后换扩展名也不会命中旧缓存 */
interface ThumbSource { file: string; size: number; mtimeMs: number; ext: string; kind: 'image' | 'video'; absolute: string }

function cachedThumbPath(entryId: string): ThumbSource {
  const absolute = pathOf(entryId, 'file')
  const info = statSync(absolute)
  const ext = extOf(absolute)
  const kind = mediaKindOf(absolute)
  if (!kind) throw new Error('not a media file')
  return { file: thumbCacheFile(absolute, info.size, info.mtimeMs, ext), size: info.size, mtimeMs: info.mtimeMs, ext, kind, absolute }
}

async function thumbnailOf(entryId: string): Promise<{ body: Buffer; mime: string } | null> {
  let meta: ThumbSource
  try {
    meta = cachedThumbPath(entryId)
  } catch {
    return null
  }
  if (meta.file && existsSync(meta.file)) {
    return { body: readFileSync(meta.file), mime: 'image/jpeg' }
  }
  const outcome = await generateThumb(meta.absolute, meta.kind, meta.ext, meta.size)
  if (outcome.kind !== 'ok') return null
  if (meta.file) {
    try {
      writeFileSync(meta.file, outcome.jpeg)
    } catch {
      // 缓存写不进去不影响本次返回
    }
  }
  return { body: outcome.jpeg, mime: 'image/jpeg' }
}

/** 解析单段 Range: bytes=a-b / a- / -n；不合法或多段返回 null（按整文件处理） */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end }
}

function streamFile(res: ServerResponse, absolute: string, mime: string, rangeHeader: string | undefined, headOnly: boolean): void {
  const size = statSync(absolute).size
  const common: Record<string, string> = { 'content-type': mime, 'accept-ranges': 'bytes' }
  const range = parseRange(rangeHeader, size)
  if (range) {
    res.writeHead(206, { ...BASE_HEADERS, ...common, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(range.end - range.start + 1) })
    if (headOnly) { res.end(); return }
    createReadStream(absolute, { start: range.start, end: range.end }).on('error', () => res.destroy()).pipe(res)
    return
  }
  res.writeHead(200, { ...BASE_HEADERS, ...common, 'content-length': String(size) })
  if (headOnly) { res.end(); return }
  createReadStream(absolute).on('error', () => res.destroy()).pipe(res)
}

async function handle(req: LooseRequest, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'OPTIONS') { send(res, 204, {}); return }
  if (method !== 'GET' && method !== 'HEAD') { send(res, 405, {}, 'method not allowed'); return }
  const match = /^\/(t|o|v)\/([0-9a-f-]{36})$/.exec((req.url ?? '/').split('?')[0])
  if (!match) { send(res, 404, {}, 'not found'); return }
  const entryId = mediaIds.get(match[2])
  if (!entryId) { send(res, 404, {}, 'not found'); return }
  const headOnly = method === 'HEAD'
  try {
    if (match[1] === 't') {
      // SVG 是矢量图，体积小、任意缩放都清晰，直接给原文件
      const ext = extOf(pathOf(entryId, 'file'))
      if (ext === 'svg') { streamFile(res, pathOf(entryId, 'file'), 'image/svg+xml', undefined, headOnly); return }
      const thumb = await thumbnailOf(entryId)
      if (!thumb) { send(res, 404, {}, 'no thumbnail'); return }
      send(res, 200, { 'content-type': thumb.mime, 'content-length': String(thumb.body.length) }, headOnly ? undefined : thumb.body)
      return
    }
    const absolute = pathOf(entryId, 'file')
    const ext = extOf(absolute)
    const mime = MIME[ext] ?? 'application/octet-stream'
    // 原图只对浏览器能解码的格式开放；RAW/HEIC/TIFF 请缩略图
    if (match[1] === 'o' && !INLINE_IMAGE.has(ext)) {
      const thumb = await thumbnailOf(entryId)
      if (!thumb) { send(res, 404, {}, 'no preview'); return }
      send(res, 200, { 'content-type': thumb.mime, 'content-length': String(thumb.body.length) }, headOnly ? undefined : thumb.body)
      return
    }
    const rangeHeader = req.headers.range
    streamFile(res, absolute, mime, Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, headOnly)
  } catch {
    // 条目失效、文件被删、权限不足等一律 404，不泄露路径信息
    send(res, 404, {}, 'not found')
  }
}
