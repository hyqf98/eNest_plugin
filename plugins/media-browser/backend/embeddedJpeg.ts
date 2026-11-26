/**
 * 从相机 RAW 文件里提取内嵌的 JPEG 预览图。
 *
 * TIFF 系（尼康 NEF/NRW、佳能 CR2、宾得 PEF、索尼 ARW、奥林巴斯 ORF、DNG、松下 RW2…）：
 *   预览 JPEG 以 StripOffsets/StripByteCounts 或 JPEGInterchangeFormat 存放，偏移都相对文件起点。
 *   各家位置不同，所以要从 IFD0 出发走遍后续 IFD、SubIFD 与 ExifIFD，取面积最大的一张：
 *   NEF 全尺寸在 SubIFD，CR2 全尺寸在 IFD1，ARW 预览在 IFD0 的 0x0201，RW2 在 IFD0 的专有标签 0x2e。
 * 佳能 CR3：ISO BMFF，见 cr3Preview.ts。
 * 富士 RAF：固定文件头，0x54 是 JPEG 偏移、0x58 是长度。
 *
 * 本模块是纯函数，不依赖 Node API。
 */


export interface EmbeddedJpeg {
  offset: number
  length: number
  width?: number
  height?: number
}

export function isJpegStart(bytes: Uint8Array, offset: number): boolean {
  return offset + 1 < bytes.length && bytes[offset] === 0xff && bytes[offset + 1] === 0xd8
}

function type4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

/** 读 JPEG 的 SOF 段取尺寸；解析不了返回 undefined */
export function jpegDimensions(bytes: Uint8Array, start: number, end: number): { width: number; height: number } | undefined {
  let position = start + 2
  while (position + 4 <= end) {
    if (bytes[position] !== 0xff) { position++; continue }
    const marker = bytes[position + 1]
    if (marker === 0xff) { position++; continue }
    // 不带长度字段的独立标记：SOI、RSTn、TEM
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { position += 2; continue }
    const segmentLength = (bytes[position + 2] << 8) | bytes[position + 3]
    // SOF0–SOF15，排除 DHT(C4)、JPG(C8)、DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (position + 9 > end) return undefined
      return { height: (bytes[position + 5] << 8) | bytes[position + 6], width: (bytes[position + 7] << 8) | bytes[position + 8] }
    }
    position += 2 + Math.max(segmentLength, 2)
  }
  return undefined
}

/* ---------------- TIFF 结构 ---------------- */

const STRIP_OFFSET_TAGS = new Set([0x0111, 0x0144])
const STRIP_COUNT_TAGS = new Set([0x0117, 0x0145])

interface Tiff {
  view: DataView
  little: boolean
}

function readUint(tiff: Tiff, at: number, width: 2 | 4 | 8): number {
  if (width === 2) return tiff.view.getUint16(at, tiff.little)
  if (width === 4) return tiff.view.getUint32(at, tiff.little)
  return tiff.view.getUint32(at + 4, tiff.little) * 0x1_0000_0000 + tiff.view.getUint32(at, tiff.little)
}

function typeWidth(type: number): 2 | 4 | 8 | 0 {
  return type === 3 ? 2 : type === 4 ? 4 : type === 16 || type === 18 ? 8 : 0
}

interface IfdEntry {
  tag: number
  values: number[]
}

interface Ifd {
  entries: IfdEntry[]
  /** 条目表之后 4 字节：下一个 IFD 的偏移，0 表示没有 */
  next: number
}

/** 读一个 IFD 的全部条目与 next 指针；越界或数量异常时返回空 */
function readIfd(tiff: Tiff, ifdOffset: number): Ifd {
  const { view } = tiff
  const empty: Ifd = { entries: [], next: 0 }
  if (ifdOffset + 2 > view.byteLength) return empty
  const count = view.getUint16(ifdOffset, tiff.little)
  if (count > 512) return empty
  const entries: IfdEntry[] = []
  for (let index = 0; index < count; index++) {
    const at = ifdOffset + 2 + index * 12
    if (at + 12 > view.byteLength) break
    const tag = view.getUint16(at, tiff.little)
    const type = view.getUint16(at + 2, tiff.little)
    const valueCount = view.getUint32(at + 4, tiff.little)
    const width = typeWidth(type)
    if (!width || valueCount > 4096) continue
    const inline = valueCount * width <= 4
    // 值不在行内时，条目里存的是 4 字节的偏移（Long8 的元素是 8 字节，但偏移字段仍是 4 字节）
    const start = inline ? at + 8 : readUint(tiff, at + 8, 4)
    const values: number[] = []
    for (let i = 0; i < valueCount; i++) {
      const pointer = start + i * width
      if (pointer + width > view.byteLength) break
      values.push(readUint(tiff, pointer, width))
    }
    entries.push({ tag, values })
  }
  const nextAt = ifdOffset + 2 + count * 12
  const next = nextAt + 4 <= view.byteLength ? view.getUint32(nextAt, tiff.little) : 0
  return { entries, next }
}

function pairsOf({ entries, next }: Ifd): { strips: { offset: number; length: number }[]; children: number[]; next: number } {
  let offsets: number[] = []
  let counts: number[] = []
  const children: number[] = []
  let exifOffset = 0
  let exifLength = 0
  for (const entry of entries) {
    if (STRIP_OFFSET_TAGS.has(entry.tag)) offsets = offsets.concat(entry.values)
    else if (STRIP_COUNT_TAGS.has(entry.tag)) counts = counts.concat(entry.values)
    else if (entry.tag === 0x014a || entry.tag === 0x8769) children.push(...entry.values)
    else if (entry.tag === 0x0201) exifOffset = entry.values[0] ?? 0
    else if (entry.tag === 0x0202) exifLength = entry.values[0] ?? 0
  }
  const strips: { offset: number; length: number }[] = []
  for (let i = 0; i < Math.min(offsets.length, counts.length); i++) {
    if (offsets[i] > 0 && counts[i] > 0) strips.push({ offset: offsets[i], length: counts[i] })
  }
  if (exifOffset > 0 && exifLength > 0) strips.push({ offset: exifOffset, length: exifLength })
  return { strips, children, next }
}

/** 松下 RW2/RWL：IFD0 的 0x2e 是内嵌 JPEG 文档，没有配套长度标签，需要扫到 EOI */
const RW2_JPEG_TAG = 0x002e

/** 从 SOI 起扫到 JPEG 的 EOI；上限由文件末尾决定。找不到返回 null */
function jpegEnd(bytes: Uint8Array, start: number): number {
  let position = start + 2
  while (position + 1 < bytes.length) {
    if (bytes[position] === 0xff) {
      const marker = bytes[position + 1]
      if (marker === 0xd9) return position + 2
      // EOI 之前遇不到 SOI；其它标记继续扫
    }
    position++
  }
  return -1
}

/** 把 IFD 条目里的一个 (offset, length) 变成候选；校验 SOI 并读尺寸 */
function candidate(bytes: Uint8Array, offset: number, length: number): EmbeddedJpeg | null {
  if (offset <= 0 || length <= 0 || !isJpegStart(bytes, offset)) return null
  const end = Math.min(offset + length, bytes.length)
  return { offset, length: end - offset, ...jpegDimensions(bytes, offset, end) }
}

/**
 * 遍历 TIFF 的 IFD 图并收集内嵌 JPEG。
 * - 横向：每个 IFD 的 next 指针（CR2 的全尺寸预览在 IFD1）
 * - 纵向：SubIFDs(0x014A) 与 ExifIFD(0x8769)（NEF 的全尺寸预览在 SubIFD）
 * 偏移一律相对文件起点。队列代替递归，访问集合防环。
 */
export function tiffPreviews(bytes: Uint8Array, little: boolean): EmbeddedJpeg[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tiff: Tiff = { view, little }
  const found: EmbeddedJpeg[] = []
  const seen = new Set<number>()
  const queue: number[] = [view.getUint32(4, little)]
  while (queue.length && seen.size < 128) {
    const ifdOffset = queue.shift()!
    if (!ifdOffset || seen.has(ifdOffset)) continue
    seen.add(ifdOffset)
    const ifd = readIfd(tiff, ifdOffset)
    const { strips, children, next } = pairsOf(ifd)
    if (next) queue.push(next)
    queue.push(...children)
    for (const strip of strips) {
      const item = candidate(bytes, strip.offset, strip.length)
      if (item) found.push(item)
    }
    // RW2：IFD0 的 0x2e 直接给出 JPEG 起点，长度靠扫 EOI
    for (const entry of ifd.entries) {
      if (entry.tag !== RW2_JPEG_TAG) continue
      const start = entry.values[0]
      if (!start) continue
      const end = jpegEnd(bytes, start)
      const item = end > start ? candidate(bytes, start, end - start) : null
      if (item) found.push(item)
    }
  }
  return found
}

/* ---------------- 入口：按文件头分流 ---------------- */

function largest(candidates: EmbeddedJpeg[]): EmbeddedJpeg | null {
  const score = (item: EmbeddedJpeg) => (item.width ?? 0) * (item.height ?? 0) || item.length
  return candidates.reduce<EmbeddedJpeg | null>((best, current) => (!best || score(current) > score(best) ? current : best), null)
}

/** 文件头是否是 ISO BMFF（CR3 走这条） */
export function isBmffFile(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && type4(bytes, 4) === 'ftyp'
}

/** 富士 RAF：0x54 处是 JPEG 偏移，0x58 处是长度（均为 big-endian） */
function rafJpeg(bytes: Uint8Array): EmbeddedJpeg | null {
  if (bytes.length < 0x60 || type4(bytes, 0) !== 'FUJI') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(0x54, false)
  const length = view.getUint32(0x58, false)
  if (!offset || !length || offset + length > bytes.length) return null
  if (!isJpegStart(bytes, offset)) return null
  const end = offset + length
  return { offset, length, ...jpegDimensions(bytes, offset, end) }
}

/**
 * 取 TIFF 系 RAW 或 RAF 里面积最大的内嵌 JPEG；CR3（ISO BMFF）与无法识别的格式返回 null。
 * bytes 应覆盖文件头部：IFD 都在头部，预览数据段可能很远，调用方按返回的 offset/length 再读。
 */
export function findLargestEmbeddedJpeg(bytes: Uint8Array): EmbeddedJpeg | null {
  if (bytes.length < 16) return null
  const header = type4(bytes, 0)
  // 'II*\0' 小端 TIFF；'MM\0*' 大端 TIFF
  if (header === 'II*\u0000' || header === 'MM\u0000*') return largest(tiffPreviews(bytes, bytes[0] === 0x49))
  // 松下 RW2/RWL：'IIU\0'（magic 0x55），结构与 TIFF 相同
  if (header === 'IIU\u0000') return largest(tiffPreviews(bytes, true))
  // 奥林巴斯 ORF：'IIRO' / 'IIRS' / 'MMSR'，magic 不同但结构与 TIFF 相同
  if (header === 'IIRO' || header === 'IIRS') return largest(tiffPreviews(bytes, true))
  if (header === 'MMSR') return largest(tiffPreviews(bytes, false))
  if (header === 'FUJI') return rafJpeg(bytes)
  return null
}
