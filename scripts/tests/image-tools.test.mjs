import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = new URL('../../plugins/', import.meta.url)
function load(relative, name) {
  const context = vm.createContext({ structuredClone })
  vm.runInContext(readFileSync(new URL(relative, root), 'utf8'), context)
  return context[name]
}
const core = load('image-tools/src/js/image-core.js', 'ImageCore')
const plain = value => JSON.parse(JSON.stringify(value))

// ---------- 基础工具 ----------
test('mime detection and byte formatting stay stable', () => {
  assert.equal(core.mimeOf('photo.PNG'), 'image/png')
  assert.equal(core.mimeOf('a.JPG'), 'image/jpeg')
  assert.equal(core.mimeOf('b.webp'), 'image/webp')
  assert.equal(core.mimeOf('c.gif'), '')
  assert.equal(core.formatBytes(512), '512 B')
  assert.equal(core.formatBytes(2048), '2 KB')
  assert.equal(core.formatBytes(3 * 1024 * 1024), '3.00 MB')
  assert.equal(core.formatBytes(undefined), '—')
  assert.equal(core.ratioText(1000, 250), '-75%')
  assert.equal(core.ratioText(1000, 1500), '+50%')
  assert.equal(core.ratioText(0, 10), null)
})

// ---------- 二分压缩 ----------
test('binary search compression converges below the target size', async () => {
  // 模拟编码：质量越高体积越大（1024 + q*3000 字节）
  const encode = async quality => ({ bytes: Math.round(1024 + quality * 3000), blob: { quality } })
  const result = await core.compressToTarget({ encode, targetBytes: 4096 })
  assert.ok(result, 'returns a result')
  assert.ok(result.bytes <= 4096, `under target: ${result.bytes}`)
  assert.equal(result.saturated, false)
  assert.ok(result.quality > 0 && result.quality < 1)
})

test('unreachable target saturates at max quality instead of failing', async () => {
  const encode = async quality => ({ bytes: 10000 + quality * 100, blob: {} })
  const result = await core.compressToTarget({ encode, targetBytes: 100 })
  assert.ok(result)
  assert.equal(result.saturated, true)
  assert.equal(result.quality, 1)
})

test('invalid target is rejected', async () => {
  await assert.rejects(() => core.compressToTarget({ encode: async () => ({ bytes: 1 }), targetBytes: 0 }), /目标体积/)
})

// ---------- 缩放 ----------
test('scale by longest edge preserves aspect ratio', () => {
  assert.deepEqual(plain(core.scaleSize(2000, 1000, 'long', 1000)), { width: 1000, height: 500 })
  assert.deepEqual(plain(core.scaleSize(800, 1600, 'long', 400)), { width: 200, height: 400 })
  assert.deepEqual(plain(core.scaleSize(100, 100, 'long', 50)), { width: 50, height: 50 })
  assert.deepEqual(plain(core.scaleSize(200, 100, 'percent', 50)), { width: 100, height: 50 })
  assert.throws(() => core.scaleSize(0, 10, 'long', 10))
})

// ---------- 变换 ----------
test('transform plan swaps dimensions on quarter turns', () => {
  assert.deepEqual(plain(core.transformPlan({ rotate: 90, width: 200, height: 100 })), { quarter: 1, swap: true, width: 100, height: 200 })
  assert.deepEqual(plain(core.transformPlan({ rotate: 180, width: 200, height: 100 })), { quarter: 2, swap: false, width: 200, height: 100 })
  assert.deepEqual(plain(core.transformPlan({ rotate: 270, width: 200, height: 100 })), { quarter: 3, swap: true, width: 100, height: 200 })
  assert.deepEqual(plain(core.transformPlan({ rotate: 360, width: 200, height: 100 })), { quarter: 0, swap: false, width: 200, height: 100 })
  assert.deepEqual(plain(core.transformPlan({ rotate: -90, width: 200, height: 100 })), { quarter: 3, swap: true, width: 100, height: 200 })
})

// ---------- 水印 ----------
test('watermark anchor covers nine slots and style clamps inputs', () => {
  assert.deepEqual(plain(core.watermarkAnchor('top-left')), { x: 0, y: 0 })
  assert.deepEqual(plain(core.watermarkAnchor('middle-center')), { x: 0.5, y: 0.5 })
  assert.deepEqual(plain(core.watermarkAnchor('bottom-right')), { x: 1, y: 1 })
  assert.deepEqual(plain(core.watermarkAnchor('bogus')), { x: 0.5, y: 1 }, 'fallback = bottom-center')
  assert.equal(core.WATERMARK_SLOTS.length, 9)
  assert.deepEqual(plain(core.watermarkStyle({ opacity: 0, fontSize: 9999 })), { alpha: 0.02, size: 400 })
  assert.deepEqual(plain(core.watermarkStyle({ opacity: 100, fontSize: 0 })), { alpha: 1, size: 28 })
})

// ---------- EXIF ----------
/** 构造带规范 APP1 段的 JPEG：FFD8 FFE1 size "Exif\0\0" + TIFF + FFD9 */
function buildJpeg(tiffBytes) {
  const payloadLength = 6 + tiffBytes.length
  const segment = [0xff, 0xe1, payloadLength + 8 >> 8 & 0xff, payloadLength + 8 & 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiffBytes]
  return new Uint8Array([0xff, 0xd8, ...segment, 0xff, 0xd9]).buffer
}

function buildTiff() {
  // II 小端 + IFD0（Make / Model / Orientation）
  const bytes = []
  const push = (...list) => bytes.push(...list)
  const u16 = value => push(value & 0xff, value >> 8 & 0xff)
  const u32 = value => push(value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >> 24 & 0xff)
  const text = value => { for (const ch of value) push(ch.charCodeAt(0)); push(0) }

  push(0x49, 0x49) // little endian
  u16(42)
  u32(8) // IFD0 offset
  u16(3) // entries
  const makeOffset = 8 + 2 + 3 * 12 + 4
  u16(0x010f); u16(2); u32(6); u32(makeOffset)
  const modelOffset = makeOffset + 6
  u16(0x0110); u16(2); u32(6); u32(modelOffset)
  u16(0x0112); u16(3); u32(1); u32(6) // orientation = 6（顺时针 90°）
  u32(0) // next IFD
  assert.equal(bytes.length, makeOffset)
  text('Canon')
  assert.equal(bytes.length, modelOffset)
  text('R5   ')
  return bytes
}

test('EXIF parser extracts camera and orientation from a constructed APP1', () => {
  const raw = core.parseExif(buildJpeg(buildTiff()))
  assert.equal(plain(raw).make, 'Canon')
  assert.equal(plain(raw).model, 'R5')
  assert.equal(plain(raw).orientation, 6)
  const summary = core.exifSummary(raw)
  assert.equal(summary.camera, 'Canon R5')
  assert.equal(summary.orientation, '需顺时针 90°')
})

test('EXIF GPS rational triple converts to decimal degrees with hemisphere', () => {
  const summary = core.exifSummary({ gpsLatitude: [31, 14, 0], gpsLatitudeRef: 'N', gpsLongitude: [121, 29, 0], gpsLongitudeRef: 'E' })
  assert.match(summary.gps, /^31\.23\d+, 121\.48\d+$/)
  const south = core.exifSummary({ gpsLatitude: [31, 14, 0], gpsLatitudeRef: 'S', gpsLongitude: [121, 29, 0], gpsLongitudeRef: 'W' })
  assert.match(south.gps, /^-31\.23/, 'southern latitude negative')
})

test('non-JPEG or truncated data returns empty EXIF instead of throwing', () => {
  assert.deepEqual(plain(core.parseExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)), {})
  assert.deepEqual(plain(core.parseExif(new Uint8Array([0xff, 0xd8, 0x00]).buffer)), {})
  assert.deepEqual(plain(core.parseExif(new ArrayBuffer(0))), {})
  assert.deepEqual(plain(core.exifSummary({})), {})
})

// ---------- 色板（中位切分） ----------
test('median cut extracts distinct dominant colors and hex output', () => {
  const width = 4, height = 2
  const data = new Uint8Array(width * height * 4)
  const put = (index, r, g, b) => { data[index * 4] = r; data[index * 4 + 1] = g; data[index * 4 + 2] = b; data[index * 4 + 3] = 255 }
  // 4 个红 + 4 个蓝
  for (let i = 0; i < 4; i += 1) put(i, 220, 40, 40)
  for (let i = 4; i < 8; i += 1) put(i, 30, 60, 200)
  const palette = core.paletteFromPixels(data, 6)
  assert.equal(palette.length, 2)
  const hexes = plain(palette.map(entry => entry.hex)).sort()
  assert.deepEqual(hexes, ['#1E3CC8', '#DC2828'])
  assert.equal(palette[0].count + palette[1].count, 8)
})

test('palette ignores transparent pixels and caps at requested count', () => {
  const data = new Uint8Array(6 * 4)
  for (let i = 0; i < 3; i += 1) { data[i * 4] = 10; data[i * 4 + 3] = 0 } // 透明
  for (let i = 3; i < 6; i += 1) { data[i * 4] = 255; data[i * 4 + 3] = 255 }
  const palette = core.paletteFromPixels(data, 6)
  assert.equal(palette.length, 1)
  assert.equal(palette[0].hex, '#FF0000')
  const ramp = []
  for (let i = 0; i < 32; i += 1) { const value = i * 8; ramp.push(value, value, 255 - value, 255) }
  assert.ok(core.paletteFromPixels(new Uint8Array(ramp), 6).length <= 6)
})

test('toHex clamps out-of-range channels', () => {
  assert.equal(core.toHex({ r: 300, g: -5, b: 16 }), '#FF0010')
})
