/**
 * RAW 内嵌预览解析器的回归测试。
 *
 * 夹具按各格式的真实结构手工构造，不依赖相机文件与外部工具。结构依据 ExifTool / LibRaw 源码：
 * - NEF 全尺寸预览在 IFD0 / SubIFD 的 StripOffsets；ExifIFD 只放 160×120 缩略图
 * - CR2 全尺寸预览在 IFD1，需要跟进 IFD0 的 next 指针
 * - RW2 头是 'IIU\0'，预览在 IFD0 的专有标签 0x2e 且没有配套长度
 * - RAF 的 JPEG 偏移在 0x54、长度在 0x58
 * - CR3 的 JPEG 字节在 mdat，由 stsd('JPEG') + stco + stsz + stsc 定位
 *
 * 这里只验证解析器的控制流。真实相机文件还有多条 strip、Long8 类型、厂商 makernote 预览等
 * 这里没有覆盖的情况，不能据此认为所有真实文件都可解析。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { findLargestEmbeddedJpeg } from '../backend/embeddedJpeg.ts'
import { largestCr3JpegSample } from '../backend/cr3Preview.ts'

/** 手工拼一个带 SOF0 尺寸段的最小 JPEG；扫描数据用填充字节代替，解析器只读段头 */
function minimalJpeg(width: number, height: number): Uint8Array {
  const scanBytes = 64
  const bytes = new Uint8Array(2 + 19 + scanBytes + 2)
  let at = 0
  bytes[at++] = 0xff; bytes[at++] = 0xd8 // SOI
  bytes[at++] = 0xff; bytes[at++] = 0xc0 // SOF0
  bytes[at++] = 0x00; bytes[at++] = 0x11 // 段长度 17
  bytes[at++] = 0x08 // 精度
  bytes[at++] = height >> 8; bytes[at++] = height & 0xff
  bytes[at++] = width >> 8; bytes[at++] = width & 0xff
  bytes[at++] = 0x01 // 分量数
  bytes[at++] = 0x01; bytes[at++] = 0x11; bytes[at++] = 0x00
  at += scanBytes
  bytes[at++] = 0xff; bytes[at++] = 0xd9 // EOI
  return bytes
}

const BIG = { jpeg: minimalJpeg(640, 480), width: 640, height: 480 }
const SMALL = { jpeg: minimalJpeg(160, 120), width: 160, height: 120 }

/** 一条 IFD 条目：[tag, type, value]；type 3 = SHORT，4 = LONG */
type Entry = [number, number, number]

/**
 * 构造一个小端 TIFF 文件，布局固定为：头(8) IFD0 ExifIFD IFD1 数据段。
 * 直接返回各数据段应使用的偏移，由调用方填进条目里——显式写偏移，不靠自动回填。
 */
function tiffLayout(ifd0: Entry[], exif: Entry[] | null = null, ifd1: Entry[] | null = null) {
  const sizeOf = (entries: Entry[]) => 2 + entries.length * 12 + 4
  const exifAt = 8 + sizeOf(ifd0)
  const ifd1At = exif ? exifAt + sizeOf(exif) : exifAt
  const dataAt = ifd1 ? ifd1At + sizeOf(ifd1) : ifd1At
  return { ifd0At: 8, exifAt, ifd1At, dataAt }
}

function writeIfd(buf: Buffer, at: number, entries: Entry[], next: number): void {
  buf.writeUInt16LE(entries.length, at)
  let cursor = at + 2
  for (const [tag, type, value] of entries) {
    buf.writeUInt16LE(tag, cursor)
    buf.writeUInt16LE(type, cursor + 2)
    buf.writeUInt32LE(1, cursor + 4)
    if (type === 3) buf.writeUInt16LE(value, cursor + 8)
    else buf.writeUInt32LE(value, cursor + 8)
    cursor += 12
  }
  buf.writeUInt32LE(next, cursor)
}

function place(buf: Buffer, at: number, bytes: Uint8Array): void {
  Buffer.from(bytes).copy(buf, at)
}

test('NEF：IFD0 持有全尺寸预览、ExifIFD 持有小缩略图时取大的那张', () => {
  const ifd0: Entry[] = [[0x0100, 3, 640], [0x0103, 3, 6], [0x0111, 4, 0], [0x0115, 3, 480], [0x0117, 4, 0], [0x8769, 4, 0]]
  const exif: Entry[] = [[0x0201, 4, 0], [0x0202, 4, 0]]
  const layout = tiffLayout(ifd0, exif)
  const bigAt = layout.dataAt
  const smallAt = bigAt + BIG.jpeg.length
  ifd0[2][2] = bigAt; ifd0[4][2] = BIG.jpeg.length; ifd0[5][2] = layout.exifAt
  exif[0][2] = smallAt; exif[1][2] = SMALL.jpeg.length

  const buf = Buffer.alloc(smallAt + SMALL.jpeg.length)
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(layout.ifd0At, 4)
  writeIfd(buf, layout.ifd0At, ifd0, 0)
  writeIfd(buf, layout.exifAt, exif, 0)
  place(buf, bigAt, BIG.jpeg)
  place(buf, smallAt, SMALL.jpeg)

  const found = findLargestEmbeddedJpeg(new Uint8Array(buf))
  assert.equal(found?.width, BIG.width)
  assert.equal(found?.height, BIG.height)
  assert.equal(found?.offset, bigAt)
  assert.equal(found?.length, BIG.jpeg.length)
})

test('CR2 式：IFD0 只有小图，跟进 next 指针到 IFD1 才能拿到全尺寸预览', () => {
  const ifd0: Entry[] = [[0x0111, 4, 0], [0x0117, 4, 0]]
  const ifd1: Entry[] = [[0x0111, 4, 0], [0x0117, 4, 0]]
  const layout = tiffLayout(ifd0, null, ifd1)
  const smallAt = layout.dataAt
  const bigAt = smallAt + SMALL.jpeg.length
  ifd0[0][2] = smallAt; ifd0[1][2] = SMALL.jpeg.length
  ifd1[0][2] = bigAt; ifd1[1][2] = BIG.jpeg.length

  const buf = Buffer.alloc(bigAt + BIG.jpeg.length)
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(layout.ifd0At, 4)
  writeIfd(buf, layout.ifd0At, ifd0, layout.ifd1At)
  writeIfd(buf, layout.ifd1At, ifd1, 0)
  place(buf, smallAt, SMALL.jpeg)
  place(buf, bigAt, BIG.jpeg)

  const found = findLargestEmbeddedJpeg(new Uint8Array(buf))
  assert.equal(found?.offset, bigAt, '不应停在 IFD0 的小图上')
  assert.equal(found?.width, BIG.width)
})

test('大端 TIFF（MM）与奥林巴斯 ORF 头都能解析', () => {
  // 大端：只放一张大图在 IFD0
  const be = Buffer.alloc(8 + 2 + 2 * 12 + 4 + BIG.jpeg.length)
  const beData = 8 + 2 + 2 * 12 + 4
  be.write('MM', 0, 'latin1'); be.writeUInt16BE(42, 2); be.writeUInt32BE(8, 4)
  be.writeUInt16BE(2, 8)
  be.writeUInt16BE(0x0111, 10); be.writeUInt16BE(4, 12); be.writeUInt32BE(1, 14); be.writeUInt32BE(beData, 18)
  be.writeUInt16BE(0x0117, 22); be.writeUInt16BE(4, 24); be.writeUInt32BE(1, 26); be.writeUInt32BE(BIG.jpeg.length, 30)
  be.writeUInt32BE(0, 34)
  place(be, beData, BIG.jpeg)
  assert.equal(findLargestEmbeddedJpeg(new Uint8Array(be))?.width, BIG.width)

  // ORF：与 NEF 同构，只是头 4 字节是 'IIRO'
  const ifd0: Entry[] = [[0x0111, 4, 0], [0x0117, 4, 0]]
  const layout = tiffLayout(ifd0)
  ifd0[0][2] = layout.dataAt; ifd0[1][2] = BIG.jpeg.length
  const orf = Buffer.alloc(layout.dataAt + BIG.jpeg.length)
  orf.write('IIRO', 0, 'latin1'); orf.writeUInt32LE(layout.ifd0At, 4)
  writeIfd(orf, layout.ifd0At, ifd0, 0)
  place(orf, layout.dataAt, BIG.jpeg)
  assert.equal(findLargestEmbeddedJpeg(new Uint8Array(orf))?.width, BIG.width)
})

test('松下 RW2：IIU\\0 头，预览在 IFD0 的 0x2e 且没有长度标签', () => {
  const ifd0: Entry[] = [[0x0100, 3, 640], [0x002e, 4, 0]]
  const layout = tiffLayout(ifd0)
  ifd0[1][2] = layout.dataAt
  const buf = Buffer.alloc(layout.dataAt + BIG.jpeg.length)
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(0x55, 2); buf.writeUInt32LE(layout.ifd0At, 4)
  writeIfd(buf, layout.ifd0At, ifd0, 0)
  place(buf, layout.dataAt, BIG.jpeg)
  // 0x2e 没有配套长度：解析器要扫到 EOI 才知道长度
  const found = findLargestEmbeddedJpeg(new Uint8Array(buf))
  assert.equal(found?.offset, layout.dataAt)
  assert.equal(found?.width, BIG.width)
})

test('富士 RAF：0x54 是 JPEG 偏移、0x58 是长度', () => {
  const buf = Buffer.alloc(0x60 + BIG.jpeg.length)
  buf.write('FUJIFILMCCD-RAW ', 0, 'latin1')
  buf.writeUInt32BE(0x60, 0x54)
  buf.writeUInt32BE(BIG.jpeg.length, 0x58)
  place(buf, 0x60, BIG.jpeg)
  const found = findLargestEmbeddedJpeg(new Uint8Array(buf))
  assert.equal(found?.offset, 0x60)
  assert.equal(found?.width, BIG.width)
})

test('佳能 CR3：按 stsd/stco/stsz/stsc 在 mdat 里取最大的 sample', () => {
  const be32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b }
  const box = (type: string, ...parts: Array<Buffer | string>) => {
    const body = Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)))
    const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length, 0); head.write(type, 4, 'latin1')
    return Buffer.concat([head, body])
  }
  const stsd = box('stsd', Buffer.alloc(4), be32(1), box('JPEG', Buffer.alloc(78)))
  const stsz = box('stsz', Buffer.alloc(4), be32(0), be32(2), be32(SMALL.jpeg.length), be32(BIG.jpeg.length))
  const stsc = box('stsc', Buffer.alloc(4), be32(1), be32(1), be32(1), be32(1))
  const moovWith = (smallOffset: number, bigOffset: number) =>
    box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd, box('stco', Buffer.alloc(4), be32(2), be32(smallOffset), be32(bigOffset)), stsz, stsc)))))
  const ftyp = box('ftyp', Buffer.alloc(4), 'crx ', 'isom')
  // moov 长度固定，所以先用占位偏移算出 mdat 的位置，再用真实偏移重建 moov
  const smallAt = ftyp.length + moovWith(0, 0).length + 8
  const bigAt = smallAt + SMALL.jpeg.length
  const moov = moovWith(smallAt, bigAt)
  assert.equal(ftyp.length + moov.length + 8, smallAt, '占位算出的偏移应与真实布局一致')

  const found = largestCr3JpegSample(new Uint8Array(moov.buffer, moov.byteOffset, moov.length))
  assert.equal(found?.offset, bigAt, '应取较大的 sample')
  assert.equal(found?.length, BIG.jpeg.length)
})

test('普通 JPEG 与随机字节不应被误判为含内嵌预览', () => {
  assert.equal(findLargestEmbeddedJpeg(BIG.jpeg), null)
  const junk = new Uint8Array(4096).map((_, index) => (index * 2654435761 >>> 0) & 0xff)
  assert.equal(findLargestEmbeddedJpeg(junk), null)
})
