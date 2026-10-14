/**
 * image-core — 纯函数核心：格式元信息、体积格式化、二分压缩、EXIF 解析、中位切分色板、变换矩阵。
 * 不触碰 DOM / canvas，全部逻辑可在 node 下自测；绘制在 main.js 完成。
 */
;(function (root) {
  const SUPPORTED_MIME = ['image/png', 'image/jpeg', 'image/webp']
  const FORMAT_LABEL = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' }

  function mimeOf(name = '') {
    const ext = String(name).split('.').pop().toLowerCase()
    if (ext === 'png') return 'image/png'
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'webp') return 'image/webp'
    return ''
  }

  function formatBytes(bytes) {
    const size = Number(bytes)
    if (!Number.isFinite(size) || size < 0) return '—'
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
    return `${(size / 1024 / 1024).toFixed(2)} MB`
  }

  function ratioText(before, after) {
    const a = Number(before), b = Number(after)
    if (!(a > 0) || !(b >= 0)) return null
    const saved = Math.round((1 - b / a) * 100)
    if (!Number.isFinite(saved)) return null
    return saved >= 0 ? `-${saved}%` : `+${-saved}%`
  }

  /**
   * 二分质量逼近目标体积。encode(quality) → Promise<{ blob, bytes } | null>，由调用方注入 canvas.toBlob。
   * quality 收敛到 [min, max]；目标不可达（最高质量仍超）时返回最大质量结果并标记 saturated。
   */
  async function compressToTarget({ encode, targetBytes, maxIterations = 9, tolerance = 0.08 }) {
    const cap = Number(targetBytes)
    if (!(cap > 0)) throw new Error('目标体积需大于 0')
    let low = 0.05, high = 1, best = null
    for (let i = 0; i < maxIterations; i += 1) {
      const mid = (low + high) / 2
      const result = await encode(mid)
      if (!result || !(result.bytes > 0)) break
      if (result.bytes <= cap) {
        best = { ...result, quality: mid, saturated: false }
        if (result.bytes >= cap * (1 - tolerance)) break
        low = mid
      } else {
        high = mid
      }
      if (high - low < 0.02) break
    }
    if (!best) {
      const top = await encode(1)
      return top ? { ...top, quality: 1, saturated: true } : null
    }
    return best
  }

  function scaleSize(width, height, mode, value) {
    const w = Math.round(Number(width)), h = Math.round(Number(height))
    if (!(w > 0) || !(h > 0)) throw new Error('尺寸无效')
    const v = Number(value)
    let next
    if (mode === 'percent') next = { width: Math.round(w * v / 100), height: Math.round(h * v / 100) }
    else next = w >= h ? { width: Math.round(v), height: Math.round(v * h / w) } : { width: Math.round(v * w / h), height: Math.round(v) }
    if (!(next.width > 0) || !(next.height > 0)) throw new Error('缩放结果尺寸无效')
    return next
  }

  /** 旋转 90° 步进（0-3）+ 水平/垂直翻转后的绘制参数（在原图坐标系计算）。 */
  function transformPlan({ rotate = 0, flipX = false, flipY = false, width, height }) {
    const quarter = ((Math.round(Number(rotate) / 90) % 4) + 4) % 4
    const swap = quarter % 2 === 1
    return {
      quarter,
      swap,
      width: swap ? height : width,
      height: swap ? width : height
    }
  }

  function applyTransform(ctx, image, plan, flipX, flipY) {
    const cx = plan.width / 2, cy = plan.height / 2
    ctx.translate(cx, cy)
    ctx.rotate(plan.quarter * Math.PI / 2)
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
    ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)
  }

  /** 水印九宫格位置 → 归一化锚点。 */
  const WATERMARK_SLOTS = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
  function watermarkAnchor(slot) {
    const index = WATERMARK_SLOTS.indexOf(slot)
    const position = index >= 0 ? index : 7
    const row = Math.floor(position / 3), col = position % 3
    return { x: col === 0 ? 0 : col === 1 ? 0.5 : 1, y: row === 0 ? 0 : row === 1 ? 0.5 : 1 }
  }

  function watermarkStyle({ opacity = 80, fontSize = 28 } = {}) {
    const alpha = Math.min(1, Math.max(0.02, Number(opacity) / 100))
    const size = Math.min(400, Math.max(8, Math.round(Number(fontSize) || 28)))
    return { alpha, size }
  }

  // ---------- EXIF（JPEG APP1 TIFF 段轻量解析） ----------

  const EXIF_TAGS = {
    0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x0132: 'dateTime',
    0x829a: 'exposureTime', 0x829d: 'fNumber', 0x8827: 'iso', 0x9003: 'dateTimeOriginal',
    0x920a: 'focalLength', 0xa002: 'pixelXDimension', 0xa003: 'pixelYDimension'
  }
  const GPS_TAGS = { 0x0001: 'gpsLatitudeRef', 0x0002: 'gpsLatitude', 0x0003: 'gpsLongitudeRef', 0x0004: 'gpsLongitude' }
  const ORIENTATIONS = { 1: '正常', 3: '旋转 180°', 6: '需顺时针 90°', 8: '需逆时针 90°' }

  function decodeUtf16(bytes, little) {
    let text = ''
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]
      if (code === 0) break
      text += String.fromCharCode(code)
    }
    return text
  }

  function readValue(view, dataStart, entryOffset, little) {
    const u16 = off => little ? view.getUint16(off, true) : view.getUint16(off)
    const u32 = off => little ? view.getUint32(off, true) : view.getUint32(off)
    const type = u16(entryOffset + 2), count = u32(entryOffset + 4)
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }
    const unit = sizes[type]
    if (!unit || count > 512) return null
    const valueOffset = unit * count <= 4 ? entryOffset + 8 : dataStart + u32(entryOffset + 8)
    if (valueOffset + unit * count > view.byteLength) return null
    const rational = off => {
      const num = u32(off), den = u32(off + 4)
      return den ? num / den : 0
    }
    if (type === 2) {
      const bytes = []
      for (let i = 0; i < count; i += 1) bytes.push(view.getUint8(valueOffset + i))
      return decodeAscii(bytes)
    }
    if (type === 3) return u16(valueOffset)
    if (type === 4) return u32(valueOffset)
    if (type === 5) {
      const list = []
      for (let i = 0; i < Math.min(count, 8); i += 1) list.push(rational(valueOffset + i * 8))
      return list
    }
    if (type === 10) {
      const list = []
      for (let i = 0; i < Math.min(count, 8); i += 1) {
        const num = view.getInt32(valueOffset + i * 8, little), den = view.getInt32(valueOffset + i * 8 + 4, little)
        list.push(den ? num / den : 0)
      }
      return list
    }
    return u32(valueOffset)
  }

  function decodeAscii(bytes) {
    let text = ''
    for (const byte of bytes) { if (byte === 0) break; text += String.fromCharCode(byte) }
    return text.trim()
  }

  function walkIfd(view, tiffStart, ifdOffset, little, map, collect) {
    const u16 = off => little ? view.getUint16(off, true) : view.getUint16(off)
    const u32 = off => little ? view.getUint32(off, true) : view.getUint32(off)
    const count = u16(ifdOffset)
    if (count > 256) return null
    for (let i = 0; i < count; i += 1) {
      const entry = ifdOffset + 2 + i * 12
      if (entry + 12 > view.byteLength) break
      const tag = u16(entry)
      const key = map[tag]
      if (key) {
        const value = readValue(view, tiffStart, entry, little)
        if (value !== null && value !== undefined && value !== '') collect(key, value)
      }
      if (tag === 0x8769) {
        const exifIfd = tiffStart + u32(entry + 8)
        if (exifIfd + 2 < view.byteLength) walkIfd(view, tiffStart, exifIfd, little, EXIF_TAGS, collect)
      }
      if (tag === 0x8825) {
        const gpsIfd = tiffStart + u32(entry + 8)
        if (gpsIfd + 2 < view.byteLength) walkIfd(view, tiffStart, gpsIfd, little, GPS_TAGS, collect)
      }
    }
    return u32(ifdOffset + 2 + count * 12)
  }

  /** 从 JPEG ArrayBuffer 解析常用 EXIF；非 JPEG 或无 APP1 返回 {}。 */
  function parseExif(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return {}
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 2
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const size = view.getUint16(offset + 2)
      if (marker === 0xe1 && offset + 10 < bytes.length && decodeAscii(bytes.slice(offset + 4, offset + 10)) === 'Exif') {
        const tiffStart = offset + 10
        const little = view.getUint16(tiffStart) === 0x4949
        const result = {}
        try {
          const ifd = tiffStart + view.getUint32(tiffStart + 4, little)
          walkIfd(view, tiffStart, ifd, little, { ...EXIF_TAGS, ...GPS_TAGS }, (key, value) => { result[key] = value })
        } catch { /* 截断的 APP1 按已解析内容返回 */ }
        return result
      }
      if (marker === 0xda) break
      offset += 2 + size
    }
    return {}
  }

  function exifSummary(raw = {}) {
    const summary = {}
    const camera = [raw.make, raw.model].filter(Boolean).join(' ').trim()
    if (camera) summary.camera = camera
    const shot = raw.dateTimeOriginal || raw.dateTime
    if (typeof shot === 'string' && shot.trim()) summary.time = shot.trim()
    if (raw.orientation) summary.orientation = ORIENTATIONS[raw.orientation] || `方向标记 ${raw.orientation}`
    if (raw.exposureTime > 0) summary.exposure = raw.exposureTime < 1 ? `1/${Math.round(1 / raw.exposureTime)} s` : `${Math.round(raw.exposureTime * 100) / 100} s`
    if (raw.fNumber > 0) summary.aperture = `f/${Math.round(raw.fNumber * 10) / 10}`
    if (raw.iso) summary.iso = `ISO ${raw.iso}`
    if (raw.focalLength > 0) summary.focal = `${Math.round(raw.focalLength)} mm`
    if (Array.isArray(raw.gpsLatitude) && Array.isArray(raw.gpsLongitude)) {
      const lat = dmsToDegrees(raw.gpsLatitude) * (raw.gpsLatitudeRef === 'S' ? -1 : 1)
      const lon = dmsToDegrees(raw.gpsLongitude) * (raw.gpsLongitudeRef === 'W' ? -1 : 1)
      if (Number.isFinite(lat) && Number.isFinite(lon)) summary.gps = `${lat.toFixed(5)}, ${lon.toFixed(5)}`
    }
    return summary
  }

  function dmsToDegrees(list) {
    if (!Array.isArray(list) || list.length < 3) return NaN
    const [deg, min, sec] = list
    return Number(deg) + Number(min) / 60 + Number(sec) / 3600
  }

  // ---------- 色板：中位切分（RGB 立方体递归切分，取 6 色） ----------

  function medianCut(pixels, colorCount = 6) {
    const samples = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels)
    const list = []
    for (let i = 0; i + 3 < samples.length; i += 4) {
      const r = samples[i], g = samples[i + 1], b = samples[i + 2], a = samples[i + 3]
      if (a < 128) continue
      list.push([r, g, b])
    }
    if (!list.length) return []
    let buckets = [list]
    while (buckets.length < colorCount) {
      let target = -1, spread = 0, channel = 0
      buckets.forEach((bucket, index) => {
        if (bucket.length < 2) return
        for (const axis of [0, 1, 2]) {
          let lo = 255, hi = 0
          for (const pixel of bucket) { if (pixel[axis] < lo) lo = pixel[axis]; if (pixel[axis] > hi) hi = pixel[axis] }
          if (hi - lo > spread) { spread = hi - lo; target = index; channel = axis }
        }
      })
      if (target < 0 || spread <= 0) break
      const bucket = buckets[target]
      bucket.sort((a, b) => a[channel] - b[channel])
      const mid = Math.floor(bucket.length / 2)
      buckets = buckets.filter((_, index) => index !== target).concat([bucket.slice(0, mid), bucket.slice(mid)])
    }
    const merged = new Map()
    for (const bucket of buckets) {
      if (!bucket.length) continue
      const sum = bucket.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0])
      const entry = {
        r: Math.round(sum[0] / bucket.length),
        g: Math.round(sum[1] / bucket.length),
        b: Math.round(sum[2] / bucket.length),
        count: bucket.length
      }
      const key = `${entry.r},${entry.g},${entry.b}`
      const existing = merged.get(key)
      if (existing) existing.count += entry.count
      else merged.set(key, entry)
    }
    return [...merged.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, colorCount)
  }

  function toHex({ r, g, b }) {
    const part = value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0').toUpperCase()
    return `#${part(r)}${part(g)}${part(b)}`
  }

  function paletteFromPixels(data, colorCount = 6) {
    return medianCut(data, colorCount).map(entry => ({ hex: toHex(entry), count: entry.count }))
  }

  // ---------- 帧调度：大数据重处理按块让出主线程 ----------

  function yieldFrame() {
    return new Promise(resolve => setTimeout(resolve, 0))
  }

  root.ImageCore = {
    SUPPORTED_MIME, FORMAT_LABEL, WATERMARK_SLOTS,
    mimeOf, formatBytes, ratioText, compressToTarget, scaleSize,
    transformPlan, applyTransform, watermarkAnchor, watermarkStyle,
    parseExif, exifSummary, paletteFromPixels, medianCut, toHex, yieldFrame
  }
})(globalThis)
