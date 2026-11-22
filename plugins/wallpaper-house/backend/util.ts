import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import type { WallpaperErrorCode } from '../src/shared/contracts'
import { formatWallpaperError } from '../src/shared/contracts'

export class WallpaperError extends Error {
  readonly code: WallpaperErrorCode

  constructor(code: WallpaperErrorCode, message: string) {
    super(formatWallpaperError(code, message))
    this.name = 'WallpaperError'
    this.code = code
  }
}

export function fail(code: WallpaperErrorCode, message: string): never {
  throw new WallpaperError(code, message)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 4096)
  return String(error).slice(0, 4096)
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function requireString(value: unknown, name: string, maxLength = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    fail('INVALID_ARGUMENT', `${name} 必须是非空字符串`)
  }
  return value
}

export function optionalString(value: unknown, name: string, maxLength = 8192): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string' || value.length > maxLength) fail('INVALID_ARGUMENT', `${name} 必须是字符串`)
  return value
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail('INVALID_ARGUMENT', `${name} 必须是布尔值`)
  return value
}

export function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail('INVALID_ARGUMENT', `${name} 必须是 ${min}–${max} 的整数`)
  }
  return value as number
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function requireHttpUrl(value: unknown, name: string): string {
  const text = requireString(value, name, 8192)
  if (!isHttpUrl(text)) fail('INVALID_ARGUMENT', `${name} 必须是 http(s) URL`)
  return text
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function shortHash(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

export function safeFileName(value: string, fallback = 'wallpaper'): string {
  const raw = basename(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim()
  const normalized = raw.replace(/^\.+/, '').slice(0, 120)
  return normalized || fallback
}

export function extensionFor(item: { mediaType: string; mime?: string; fullUrl?: string }): string {
  const mime = (item.mime || '').toLowerCase()
  if (mime.includes('png')) return '.png'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('mp4')) return '.mp4'
  if (mime.includes('webm')) return '.webm'
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  let fromUrl = ''
  try {
    fromUrl = item.fullUrl ? extname(new URL(item.fullUrl).pathname).toLowerCase() : ''
  } catch {
    fromUrl = ''
  }
  if (/^\.(jpg|jpeg|png|webp|gif|mp4|webm|avif)$/.test(fromUrl)) return fromUrl === '.jpeg' ? '.jpg' : fromUrl
  return item.mediaType === 'video' ? '.mp4' : '.jpg'
}

export function sanitizeLogText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/g, url => {
      try {
        const parsed = new URL(url)
        return `${parsed.origin}${parsed.pathname}`
      } catch {
        return '[url]'
      }
    })
    .replace(/(apikey|api_key|token|secret|authorization)=([^&\s]+)/gi, '$1=[redacted]')
    .slice(0, 16_384)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 512) return false
  if (value.includes('\\') || value.includes('\u0000')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  return segments.every(segment => segment && segment !== '.' && segment !== '..')
}

export function pickString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function pickNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function pickBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of items) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id)
    result.push(item)
  }
  return result
}
