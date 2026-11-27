import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryItem, MediaPreviewResult, ThumbResult, WallpaperItem } from '@backend/contracts'
import { ensurePluginPaths, pluginPaths } from '@backend/paths'
import { fetchBuffer } from '@backend/net'
import { shortHash, errorMessage } from '@backend/util'
import { loadImageCodec } from '@backend/imageCodec'
import { ThumbnailCache } from '../src/shared/thumbnailCache'

const DISK_LIMIT_BYTES = 512 * 1024 * 1024
const MAX_REMOTE_THUMB_BYTES = 8 * 1024 * 1024
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024
const memory = new ThumbnailCache<ThumbResult>(300)
const inFlight = new Map<string, Promise<ThumbResult>>()
let pruneRunning = false

export async function getThumbnail(request: { url: string; headers?: Record<string, string> }): Promise<ThumbResult> {
  const key = shortHash(request.url, 32)
  const cached = memory.get(key)
  if (cached) return cached
  const running = inFlight.get(key)
  if (running) return running
  const promise = (async () => {
    const disk = await readDiskThumb(key)
    if (disk) return memory.set(key, disk)
    const paths = await ensurePluginPaths()
    const response = await fetchBuffer(request.url, {
      headers: request.headers,
      maxBytes: MAX_REMOTE_THUMB_BYTES,
      timeoutMs: 20_000,
    })
    if (!response.contentType.startsWith('image/')) throw new Error(`缩略图不是图片：${response.contentType || 'unknown'}`)
    const normalized = await normalizeImage(response.buffer, 480, 80)
    const path = join(paths.thumbs, `${key}.bin`)
    await writeFile(path, normalized.buffer).catch(() => {})
    void pruneThumbs()
    return memory.set(key, { dataUrl: dataUrl(normalized.buffer, normalized.mime), bytes: normalized.buffer.length })
  })().finally(() => { inFlight.delete(key) })
  inFlight.set(key, promise)
  return promise
}

export async function getPreview(item: WallpaperItem): Promise<MediaPreviewResult> {
  if (item.mediaType === 'video' || item.mediaType === 'web') {
    return { dataUrl: null, mediaType: item.mediaType, message: '视频/Web 预览请在详情页播放或设置动态壁纸后查看' }
  }
  try {
    const response = await fetchBuffer(item.previewUrl || item.thumbUrl, {
      headers: item.thumbHeaders,
      maxBytes: MAX_PREVIEW_BYTES,
      timeoutMs: 25_000,
    })
    if (!response.contentType.startsWith('image/')) {
      return { dataUrl: null, mediaType: item.mediaType, message: '预览不是图片' }
    }
    const normalized = await normalizeImage(response.buffer, 1920, 86)
    return {
      dataUrl: dataUrl(normalized.buffer, normalized.mime),
      mediaType: item.mediaType,
      width: normalized.width,
      height: normalized.height,
    }
  } catch (error) {
    return { dataUrl: null, mediaType: item.mediaType, message: errorMessage(error) }
  }
}

export async function getLibraryThumbnail(item: LibraryItem, filePath: string | null): Promise<ThumbResult> {
  if (item.item.thumbUrl) {
    try {
      return await getThumbnail({ url: item.item.thumbUrl, headers: item.item.thumbHeaders })
    } catch {
      // 源站缩略图失败时尝试本地文件。
    }
  }
  if (item.mediaType === 'video' || item.mediaType === 'web' || !filePath || !existsSync(filePath)) return { dataUrl: null, bytes: 0 }
  try {
    const info = await stat(filePath)
    if (info.size > 64 * 1024 * 1024) return { dataUrl: null, bytes: 0 }
    const buffer = await readFile(filePath)
    const normalized = await normalizeImage(buffer, 480, 80)
    return { dataUrl: dataUrl(normalized.buffer, normalized.mime), bytes: normalized.buffer.length }
  } catch {
    return { dataUrl: null, bytes: 0 }
  }
}

export async function getLibraryPreview(item: LibraryItem, filePath: string | null): Promise<MediaPreviewResult> {
  if (item.mediaType === 'video' || item.mediaType === 'web') {
    return { dataUrl: null, mediaType: item.mediaType, message: '动态内容请在详情页播放或设为动态壁纸' }
  }
  if (item.item.previewUrl) {
    const remote = await getPreview(item.item)
    if (remote.dataUrl) return remote
  }
  if (!filePath || !existsSync(filePath)) return { dataUrl: null, mediaType: item.mediaType, message: '本地文件不存在' }
  try {
    const buffer = await readFile(filePath)
    const normalized = await normalizeImage(buffer, 1920, 86)
    return {
      dataUrl: dataUrl(normalized.buffer, normalized.mime),
      mediaType: item.mediaType,
      width: normalized.width,
      height: normalized.height,
    }
  } catch (error) {
    return { dataUrl: null, mediaType: item.mediaType, message: errorMessage(error) }
  }
}

export async function pruneThumbs(): Promise<void> {
  if (pruneRunning) return
  pruneRunning = true
  try {
    const dir = pluginPaths().thumbs
    await mkdir(dir, { recursive: true })
    const files = await readdir(dir)
    const entries = await Promise.all(files.map(async file => {
      const path = join(dir, file)
      const info = await stat(path).catch(() => null)
      return info?.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null
    }))
    const valid = entries.filter((entry): entry is { path: string; size: number; mtimeMs: number } => Boolean(entry))
    let total = valid.reduce((sum, entry) => sum + entry.size, 0)
    if (total <= DISK_LIMIT_BYTES) return
    valid.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of valid) {
      if (total <= DISK_LIMIT_BYTES) break
      await unlink(entry.path).catch(() => {})
      total -= entry.size
    }
  } finally {
    pruneRunning = false
  }
}

async function readDiskThumb(key: string): Promise<ThumbResult | null> {
  const path = join(pluginPaths().thumbs, `${key}.bin`)
  try {
    const buffer = await readFile(path)
    const mime = detectImageMime(buffer)
    if (!mime) return null
    return { dataUrl: dataUrl(buffer, mime), bytes: buffer.length }
  } catch {
    return null
  }
}

async function normalizeImage(buffer: Buffer, maxWidth: number, quality: number): Promise<{ buffer: Buffer; mime: string; width: number; height: number }> {
  const mime = detectImageMime(buffer)
  if (!mime) throw new Error('无法识别的图片格式')
  if (buffer.length <= 180 * 1024 && mime !== 'image/gif') {
    return { buffer, mime, width: 0, height: 0 }
  }
  try {
    const Jimp = await loadImageCodec()
    const image = await Jimp.read(buffer)
    const width = image.bitmap.width
    if (width > maxWidth) image.resize(maxWidth, Jimp.AUTO)
    image.quality(quality)
    const output = await image.getBufferAsync(Jimp.MIME_JPEG)
    return { buffer: output, mime: 'image/jpeg', width: image.bitmap.width, height: image.bitmap.height }
  } catch {
    return { buffer, mime, width: 0, height: 0 }
  }
}

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  return null
}

function dataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}
