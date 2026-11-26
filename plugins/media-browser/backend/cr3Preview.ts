/**
 * 佳能 CR3 的 JPEG 预览定位。
 *
 * CR3 是 ISO BMFF。全尺寸预览是一条 "JPEG" track：
 *   moov > trak > mdia > minf > stbl > stsd   含类型为 'JPEG' 的 sample entry（只是描述符）
 *                                   > stco/co64  每个 chunk 在文件中的绝对偏移
 *                                   > stsz       每个 sample 的字节数
 *                                   > stsc       sample 在 chunk 间的分布
 * JPEG 的实际字节在 mdat 里，由以上三张表定位。与 LibRaw 一致，取最大的那个 sample。
 */

export interface Cr3Sample {
  /** 文件绝对偏移 */
  offset: number
  length: number
}

interface BoxRange {
  /** box 头之后（载荷）的起点 */
  payload: number
  /** box 结束（不含） */
  end: number
}

function be32(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0
}

function type4(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
}

/** 遍历 [start, end) 内的 box，对每个调用 visit；返回 true 表示命中并停止 */
function walkBoxes(bytes: Uint8Array, start: number, end: number, visit: (type: string, box: BoxRange) => boolean): void {
  let position = start
  for (let guard = 0; guard < 100_000 && position + 8 <= end; guard++) {
    let size = be32(bytes, position)
    let header = 8
    if (size === 1) {
      if (position + 16 > end) return
      // 64 位长度只取低 32 位：CR3 远小于 4 GiB
      size = be32(bytes, position + 12)
      header = 16
    } else if (size === 0) {
      size = end - position
    }
    if (size < header) return
    const boxEnd = Math.min(position + size, end)
    if (visit(type4(bytes, position + 4), { payload: position + header, end: boxEnd })) return
    position += size
  }
}

function findBox(bytes: Uint8Array, start: number, end: number, type: string): BoxRange | null {
  let found: BoxRange | null = null
  walkBoxes(bytes, start, end, (childType, box) => {
    if (childType !== type) return false
    found = box
    return true
  })
  return found
}

/** 沿指定路径逐层下钻找 box；任一层找不到返回 null */
function findPath(bytes: Uint8Array, start: number, end: number, path: string[]): BoxRange | null {
  let current: BoxRange = { payload: start, end }
  for (const type of path) {
    const next = findBox(bytes, current.payload, current.end, type)
    if (!next) return null
    current = next
  }
  return current
}

function readChunkOffsets(bytes: Uint8Array, box: BoxRange): number[] {
  // 全盒：version/flags(4) + entry_count(4) + 条目
  const count = Math.min(be32(bytes, box.payload + 4), 65_536)
  const out: number[] = []
  for (let index = 0; index < count; index++) {
    out.push(be32(bytes, box.payload + 8 + index * 4))
  }
  return out
}

function readSampleSizes(bytes: Uint8Array, box: BoxRange): number[] {
  const fixedSize = be32(bytes, box.payload + 4)
  const count = Math.min(be32(bytes, box.payload + 8), 65_536)
  if (fixedSize !== 0) return new Array<number>(count).fill(fixedSize)
  const out: number[] = []
  for (let index = 0; index < count; index++) out.push(be32(bytes, box.payload + 12 + index * 4))
  return out
}

interface StscEntry {
  firstChunk: number
  samplesPerChunk: number
}

function readSampleToChunk(bytes: Uint8Array, box: BoxRange): StscEntry[] {
  const count = Math.min(be32(bytes, box.payload + 4), 65_536)
  const out: StscEntry[] = []
  for (let index = 0; index < count; index++) {
    const at = box.payload + 8 + index * 12
    out.push({ firstChunk: be32(bytes, at), samplesPerChunk: be32(bytes, at + 4) })
  }
  return out
}

/** stsd 里是否含指定类型的 sample entry */
function stsdHasEntry(bytes: Uint8Array, stbl: BoxRange, entryType: string): boolean {
  const stsd = findBox(bytes, stbl.payload, stbl.end, 'stsd')
  if (!stsd) return false
  // stsd：version/flags(4) + entry_count(4)，随后每个 sample entry 以「4 字节尺寸 + 4 字节类型」开头。
  // 只需要知道有没有该类型，逐个 entry 按自身尺寸跳转即可。
  let at = stsd.payload + 8
  for (let guard = 0; guard < 16 && at + 8 <= stsd.end; guard++) {
    const size = be32(bytes, at)
    if (type4(bytes, at + 4) === entryType) return true
    if (size < 8) break
    at += size
  }
  return false
}

/**
 * 在 moov 段里找含 'JPEG' sample entry 的 track，按三张表展开出全部 sample 的文件位置，取最大的。
 * @param moov  完整 moov box（含 box 头）
 */
export function largestCr3JpegSample(moov: Uint8Array): Cr3Sample | null {
  let best: Cr3Sample | null = null
  const moovBody: BoxRange = { payload: 8, end: moov.length }
  walkBoxes(moov, moovBody.payload, moovBody.end, (type, trak) => {
    if (type !== 'trak') return false
    const stbl = findPath(moov, trak.payload, trak.end, ['mdia', 'minf', 'stbl'])
    if (!stbl || !stsdHasEntry(moov, stbl, 'JPEG')) return false
    const stco = findBox(moov, stbl.payload, stbl.end, 'stco') ?? findBox(moov, stbl.payload, stbl.end, 'co64')
    const stsz = findBox(moov, stbl.payload, stbl.end, 'stsz')
    const stsc = findBox(moov, stbl.payload, stbl.end, 'stsc')
    if (!stco || !stsz || !stsc) return false
    const chunkOffsets = readChunkOffsets(moov, stco)
    const sizes = readSampleSizes(moov, stsz)
    const runs = readSampleToChunk(moov, stsc)
    // 按 stsc 展开：第 run 条目说明"从 firstChunk（1 基）起每 chunk 有 samplesPerChunk 个 sample"
    let sampleIndex = 0
    for (let run = 0; run < runs.length && sampleIndex < sizes.length; run++) {
      const firstChunk = runs[run].firstChunk - 1
      const lastChunk = (runs[run + 1]?.firstChunk ?? chunkOffsets.length + 1) - 1
      for (let chunk = firstChunk; chunk < lastChunk && sampleIndex < sizes.length; chunk++) {
        // 同一 chunk 内的 sample 连续存放
        let at = chunkOffsets[chunk]
        if (at === undefined) break
        for (let inChunk = 0; inChunk < runs[run].samplesPerChunk && sampleIndex < sizes.length; inChunk++) {
          const length = sizes[sampleIndex++]
          if (length > 0 && (!best || length > best.length)) best = { offset: at, length }
          at += length
        }
      }
    }
    return false
  })
  // stco/co64 里存的就是文件绝对偏移，无需换算
  return best
}

/**
 * 定位 ISO BMFF 文件的顶层 'moov' box。
 * moov 可以在 mdat 之前或之后，所以不能只看文件头：逐个读 box 头、按 size 跳到下一个，
 * 不把 mdat 读进内存。readRange 由调用方提供按需读取；返回 null 表示没找到或结构异常。
 */
export async function locateMoov(readRange: (offset: number, length: number) => Promise<Buffer>, fileSize: number): Promise<{ offset: number; length: number } | null> {
  let cursor = 0
  // 上限防御损坏的 size 字段造成的死循环
  for (let guard = 0; guard < 4_096 && cursor + 8 <= fileSize; guard++) {
    const header = await readRange(cursor, Math.min(fileSize - cursor, 16))
    if (header.length < 8) return null
    let size = be32(header, 0)
    let headerLength = 8
    if (size === 1) {
      if (header.length < 16) return null
      size = be32(header, 12)
      headerLength = 16
    } else if (size === 0) {
      size = fileSize - cursor
    }
    if (size < headerLength) return null
    if (type4(header, 4) === 'moov') return { offset: cursor, length: size }
    cursor += size
  }
  return null
}
