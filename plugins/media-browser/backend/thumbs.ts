/**
 * 缩略图生成策略。
 *
 * - SVG：矢量图，路由直接返回原文件，不生成。
 * - RAW：解析内嵌 JPEG 预览（零转码，尼康/佳能等机身内嵌的全尺寸 JPEG）。
 * - 其它图片（含 JPEG/PNG）：经外部工具缩小，避免十几 MB 的原图拖慢网格。
 * - HEIC/TIFF 与没解析出预览的 RAW：macOS 用 qlmanage，其它平台用 ffmpeg；都不行给占位。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findLargestEmbeddedJpeg, isBmffFile } from './embeddedJpeg.ts'
import { largestCr3JpegSample, locateMoov } from './cr3Preview.ts'

const execFileAsync = promisify(execFile)

/** 需要解析内嵌预览的相机 RAW */
export const RAW_EXTENSIONS = new Set([
  'nef', 'nrw', 'cr2', 'cr3', 'crw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'dng', 'pef', 'ptx', 'srw',
  'x3f', '3fr', 'ari', 'cap', 'iiq', 'kdc', 'mdc', 'mos', 'mrw', 'erf', 'k25', 'kc2',
])

/** 必须经外部工具兜底才能出图的图片 */
export const FALLBACK_IMAGE_EXTENSIONS = new Set(['tif', 'tiff', 'heic', 'heif'])

/** 缩略图最长边 */
export const THUMB_SIZE = 512

/** RAW 文件头读取窗口：预览的 IFD 索引在头部，预览数据段可能很远，按偏移另读 */
const HEAD_BYTES = 256 * 1024
/** moov 段读取上限：CR3 的 moov 通常只有几十 KB */
const MOOV_BYTES = 4 * 1024 * 1024

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

async function fileStat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

export async function statOf(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  return fileStat(path)
}

/** 读文件的一段；越界部分不读 */
async function readSlice(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
      if (!bytesRead) break
      filled += bytesRead
    }
    return filled === length ? buffer : buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }
}

/**
 * 从 RAW 里切出内嵌 JPEG，按容器分流：
 * - TIFF 系（NEF/CR2/ORF/ARW/DNG…）与 RAF：预览的索引在文件头，读头部解析，再按偏移读预览数据。
 * - CR3（ISO BMFF）：'moov' 可能在文件尾，先逐 box 定位，只读 'moov' 那一段。
 * 预览数据本身按 length 精确读取，不把整个文件读进内存。
 */
export async function extractEmbeddedJpeg(path: string, size: number): Promise<Buffer | null> {
  const head = await readSlice(path, 0, Math.min(size, HEAD_BYTES))
  const headBytes = new Uint8Array(head.buffer, head.byteOffset, head.byteLength)
  const readRange = (offset: number, length: number) => readSlice(path, offset, length)
  let offset = 0
  let length = 0
  if (isBmffFile(headBytes)) {
    const moov = await locateMoov(readRange, size)
    if (!moov) return null
    const box = await readRange(moov.offset, Math.min(moov.length, MOOV_BYTES))
    const found = largestCr3JpegSample(new Uint8Array(box.buffer, box.byteOffset, box.byteLength))
    if (!found) return null
    offset = found.offset
    length = found.length
  } else {
    const found = findLargestEmbeddedJpeg(headBytes)
    if (!found) return null
    offset = found.offset
    length = found.length
  }
  const end = Math.min(offset + length, size)
  if (end <= head.length) return Buffer.from(head.subarray(offset, end))
  return readRange(offset, end - offset)
}

/* ---------------- 外部工具兜底 ---------------- */

let ffmpegAvailable: boolean | undefined

/** ffmpeg 是否可用（本机检测一次并缓存结果） */
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable === undefined) {
    ffmpegAvailable = await new Promise<boolean>(resolve => {
      execFile('ffmpeg', ['-version'], { timeout: 4_000 }, error => resolve(error === null))
    })
  }
  return ffmpegAvailable
}

/** macOS 自带的 QuickLook 缩略图器 */
export function hasQuickLook(): boolean {
  return process.platform === 'darwin' && existsSync('/usr/bin/qlmanage')
}

/** 运行外部命令，超时或非零退出都按失败处理 */
async function run(command: string, args: string[], timeout: number): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout })
    return true
  } catch {
    return false
  }
}

/**
 * 用系统 QuickLook 生成缩略图。qlmanage 输出名固定是 <原名>.png 且与输入同目录名冲突，
 * 所以每个文件用一个独立临时目录，生成后再转成 JPEG。
 */
async function thumbnailWithQuickLook(path: string): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'media-browser-ql-'))
  try {
    const ok = await run('/usr/bin/qlmanage', ['-t', '-s', String(THUMB_SIZE), '-o', dir, path], 15_000)
    if (!ok) return null
    const produced = join(dir, `${path.split('/').pop()}.png`)
    if (!existsSync(produced)) return null
    return convertToJpeg(produced)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** ffmpeg 抽一帧当缩略图：覆盖 TIFF、视频首帧等 */
async function thumbnailWithFfmpeg(path: string, seekSeconds = 0): Promise<Buffer | null> {
  if (!(await hasFfmpeg())) return null
  const dir = await mkdtemp(join(tmpdir(), 'media-browser-ff-'))
  const output = join(dir, 'thumb.jpg')
  try {
    // -y 覆盖、-frames:v 1 只取一帧、scale 保持比例最长边不超过 THUMB_SIZE
    const args = seekSeconds > 0
      ? ['-v', 'error', '-ss', String(seekSeconds), '-i', path, '-frames:v', '1', '-vf', `scale='min(${THUMB_SIZE},iw)':'-2'`, '-q:v', '4', '-y', output]
      : ['-v', 'error', '-i', path, '-frames:v', '1', '-vf', `scale='min(${THUMB_SIZE},iw)':'-2'`, '-q:v', '4', '-y', output]
    if (!(await run('ffmpeg', args, 20_000))) return null
    return readFile(output).catch(() => null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** PNG → JPEG（去掉 alpha，白底）；ffmpeg 可用才转，不可用就原样返回 PNG（浏览器能直接显示） */
async function convertToJpeg(input: string): Promise<Buffer | null> {
  const png = await readFile(input).catch(() => null)
  if (!png) return null
  if (!(await hasFfmpeg())) return png
  const dir = await mkdtemp(join(tmpdir(), 'media-browser-cv-'))
  const output = join(dir, 'out.jpg')
  try {
    const ok = await run('ffmpeg', ['-v', 'error', '-i', input, '-q:v', '4', '-y', output], 10_000)
    return ok ? await readFile(output).catch(() => png) : png
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ---------------- 主入口 ---------------- */

export type ThumbOutcome =
  | { kind: 'ok'; jpeg: Buffer }
  | { kind: 'unsupported' }

/**
 * 为一个文件生成 JPEG 缩略图。
 * @param kind     image / video
 * @param ext      小写扩展名
 * @param size     文件字节数
 */
/**
 * 为一个媒体文件生成 JPEG 缩略图。
 *
 * - 视频：ffmpeg 抽帧（跳过开头几帧黑场/淡入）。
 * - RAW：切出内嵌的预览 JPEG 再缩小；解析不出就走外部工具。
 * - 其它图片（JPEG/PNG/WebP/GIF/BMP/TIFF/HEIC/AVIF…）：外部工具转码并缩小。
 *   相机 JPG 动辄十几 MB，直接当缩略图会让网格滚动卡顿，所以一律缩到 THUMB_SIZE。
 * - SVG 不进这里：由路由直接返回原文件。
 */
export async function generateThumb(path: string, kind: 'image' | 'video', ext: string, size: number): Promise<ThumbOutcome> {
  if (kind === 'video') {
    const frame = await thumbnailWithFfmpeg(path, 0.5).catch(() => null)
    return frame ? { kind: 'ok', jpeg: frame } : { kind: 'unsupported' }
  }
  if (RAW_EXTENSIONS.has(ext)) {
    const embedded = await extractEmbeddedJpeg(path, size).catch(() => null)
    if (embedded) {
      const shrunk = await shrinkJpeg(embedded).catch(() => null)
      return { kind: 'ok', jpeg: shrunk ?? embedded }
    }
  }
  // HEIC/TIFF 与多数 RAW：macOS 的 QuickLook 覆盖最全，优先用它
  if (hasQuickLook() && (FALLBACK_IMAGE_EXTENSIONS.has(ext) || RAW_EXTENSIONS.has(ext))) {
    const viaQuickLook = await thumbnailWithQuickLook(path).catch(() => null)
    if (viaQuickLook) return { kind: 'ok', jpeg: viaQuickLook }
  }
  const viaFfmpeg = await thumbnailWithFfmpeg(path, 0).catch(() => null)
  if (viaFfmpeg) return { kind: 'ok', jpeg: viaFfmpeg }
  return { kind: 'unsupported' }
}

/** 把已有 JPEG 缩到最长边不超过 THUMB_SIZE；没 ffmpeg 或失败时原样返回 */
async function shrinkJpeg(input: Buffer): Promise<Buffer | null> {
  if (!(await hasFfmpeg())) return null
  const dir = await mkdtemp(join(tmpdir(), 'media-browser-sh-'))
  const source = join(dir, 'in.jpg')
  const output = join(dir, 'out.jpg')
  try {
    await writeFile(source, input)
    const ok = await run('ffmpeg', ['-v', 'error', '-i', source, '-frames:v', '1', '-vf', `scale='min(${THUMB_SIZE},iw)':'-2'`, '-q:v', '4', '-y', output], 10_000)
    return ok ? await readFile(output) : null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
