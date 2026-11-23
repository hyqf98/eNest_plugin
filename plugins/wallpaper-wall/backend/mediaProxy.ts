import { createReadStream, existsSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { extname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { request } from 'undici'
import { getProxyDispatcher } from '@backend/net'
import { onShutdown, requestHost } from '@backend/runtime'

interface VideoSession {
  filePath?: string
  url?: string
  headers?: Record<string, string>
  createdAt: number
}

const sessions = new Map<string, VideoSession>()
let server: Server | null = null
let origin = ''
let endpointToken = ''

export async function createVideoSession(input: Omit<VideoSession, 'createdAt'>): Promise<{ url: string; token: string; poster?: string }> {
  const base = await ensureMediaServer()
  const token = randomBytes(18).toString('base64url')
  sessions.set(token, { ...input, createdAt: Date.now() })
  for (const [key, session] of sessions) {
    if (Date.now() - session.createdAt > 60 * 60 * 1000) sessions.delete(key)
  }
  return { url: `${base}/v/${token}`, token }
}

export function releaseVideoSession(token: string): void {
  sessions.delete(token)
}

export async function stopMediaProxy(): Promise<void> {
  if (endpointToken) {
    await requestHost('endpoint.revoke', { token: endpointToken }, 5_000).catch(() => {})
    endpointToken = ''
  }
  const current = server
  server = null
  origin = ''
  sessions.clear()
  if (current) await new Promise<void>(resolve => current.close(() => resolve()))
}

async function ensureMediaServer(): Promise<string> {
  if (server && origin) return origin
  const next = createServer((req, res) => { void handleRequest(req, res) })
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(0, '127.0.0.1', () => { next.removeListener('error', reject); resolve() })
  })
  const port = (next.address() as AddressInfo).port
  server = next
  origin = `http://127.0.0.1:${port}`
  endpointToken = `wallpaper-wall-media-${Date.now().toString(36)}`
  try {
    await requestHost('endpoint.allow', { token: endpointToken, url: origin, kind: 'subFrame', pid: process.pid })
  } catch (error) {
    await stopMediaProxy()
    throw new Error(`媒体回环端点注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return origin
}

async function handleRequest(req: import('node:http').IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://wallpaper-wall.local')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, corsHeaders())
    res.end('method not allowed')
    return
  }
  const match = /^\/v\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
  if (!match) {
    res.writeHead(404, corsHeaders())
    res.end('not found')
    return
  }
  const session = sessions.get(match[1] ?? '')
  if (!session) {
    res.writeHead(404, corsHeaders())
    res.end('session expired')
    return
  }
  const range = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range
  try {
    if (session.filePath) await serveFile(session.filePath, range, req.method === 'HEAD', res)
    else if (session.url) await proxyRemote(session.url, session.headers, range, req.method === 'HEAD', res)
    else {
      res.writeHead(404, corsHeaders())
      res.end('no source')
    }
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, corsHeaders())
    res.end(error instanceof Error ? error.message : 'media error')
  }
}

async function serveFile(filePath: string, range: string | undefined, headOnly: boolean, res: ServerResponse): Promise<void> {
  if (!existsSync(filePath)) { res.writeHead(404, corsHeaders()); res.end('missing file'); return }
  const info = await stat(filePath)
  const contentType = mediaType(filePath)
  const parsed = parseRange(range, info.size)
  if (parsed === 'invalid') { res.writeHead(416, { ...corsHeaders(), 'content-range': `bytes */${info.size}` }); res.end(); return }
  const start = parsed ? parsed.start : 0
  const end = parsed ? parsed.end : Math.max(0, info.size - 1)
  const length = end - start + 1
  const headers: Record<string, string | number> = {
    ...corsHeaders(),
    'content-type': contentType,
    'content-length': length,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  if (parsed) headers['content-range'] = `bytes ${start}-${end}/${info.size}`
  res.writeHead(parsed ? 206 : 200, headers)
  if (headOnly) { res.end(); return }
  const stream = createReadStream(filePath, { start, end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

async function proxyRemote(target: string, headers: Record<string, string> | undefined, range: string | undefined, headOnly: boolean, res: ServerResponse): Promise<void> {
  const response = await request(target, {
    method: headOnly ? 'HEAD' : 'GET',
    headers: { ...headers, ...(range ? { range } : {}) },
    dispatcher: getProxyDispatcher(),
    signal: AbortSignal.timeout(120_000),
  })
  if (response.statusCode < 200 || response.statusCode >= 400 && response.statusCode !== 416) {
    await response.body.dump().catch(() => {})
    res.writeHead(response.statusCode || 502, corsHeaders())
    res.end('upstream error')
    return
  }
  const out: Record<string, string | number> = corsHeaders()
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'] as const) {
    const value = response.headers[key]
    if (typeof value === 'string') out[key] = value
  }
  if (!out['accept-ranges']) out['accept-ranges'] = 'bytes'
  res.writeHead(response.statusCode, out)
  if (headOnly) { await response.body.dump().catch(() => {}); res.end(); return }
  try {
    for await (const chunk of response.body) {
      if (!res.write(chunk)) await new Promise<void>(resolve => res.once('drain', resolve))
    }
    res.end()
  } catch {
    res.destroy()
  }
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return 'invalid'
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (!startText && !endText) return 'invalid'
  let start = startText ? Number(startText) : 0
  let end = endText ? Number(endText) : size - 1
  if (!startText && endText) {
    const suffix = Number(endText)
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return 'invalid'
  end = Math.min(end, size - 1)
  return { start, end }
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.mp4': return 'video/mp4'
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    case '.m4v': return 'video/mp4'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    default: return 'application/octet-stream'
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'range',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  }
}

onShutdown(() => stopMediaProxy())
