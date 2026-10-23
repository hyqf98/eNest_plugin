/**
 * markdown v2 —— backend RPC 前端封装（enest.backend.call + backend.event）。
 *
 * 图片缓存设计（内存关键路径）：
 *  - 插件页 CSP 只放行 data:/blob:，图片必须经后端转 dataUrl；
 *  - dataUrl 字符串在 JS 里占 base64×2 字节，多图场景是内存大头 → 这里统一转
 *    Blob URL（浏览器只持原二进制），并按总字节 LRU 淘汰，超限自动 revokeObjectURL；
 *  - 导出等需要真 dataUrl 的场景用 blobToDataUrl 现场转换。
 */
const api = window.enest || window.zapi

export function call(method, ...args) {
  if (!api?.backend?.call) return Promise.reject(new Error('后端不可用：请更新 eNest 并授权 backend.node'))
  return api.backend.call(method, args)
}

export function onBackendEvent(handler) {
  api?.on?.('backend.event', handler)
  return () => api?.off?.('backend.event', handler)
}

/* ---------------- 图片缓存（单一来源，字节 LRU） ---------------- */

const CACHE_MAX_BYTES = 48 * 1024 * 1024 // 48MB 总量上限
const cache = new Map() // key -> { url: blobUrl|dataUrl, bytes, objectUrl? }
const inflight = new Map()

function cacheBytes() {
  let total = 0
  for (const entry of cache.values()) total += entry.bytes
  return total
}

function evictIfNeeded() {
  // Map 迭代顺序即插入顺序，最早写入的最先淘汰
  let guard = 0
  while (cacheBytes() > CACHE_MAX_BYTES && cache.size > 1 && guard++ < 500) {
    const oldest = cache.keys().next().value
    const entry = cache.get(oldest)
    if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl)
    cache.delete(oldest)
  }
}

function storeCache(key, dataUrl) {
  const bytes = Math.floor(dataUrl.length * 0.75)
  // 大图转 Blob URL 省内存；小图直接用 dataUrl（避免对象 URL 管理开销）
  if (bytes > 3 * 1024 * 1024) {
    try {
      const blob = dataUrlToBlob(dataUrl)
      const objectUrl = URL.createObjectURL(blob)
      cache.set(key, { url: objectUrl, bytes, objectUrl })
    } catch {
      cache.set(key, { url: dataUrl, bytes })
    }
  } else {
    cache.set(key, { url: dataUrl, bytes })
  }
  evictIfNeeded()
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(',')
  const mime = /^data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream'
  const bin = atob(body)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return new Blob([buf], { type: mime })
}

/** Blob URL → dataUrl（导出用，低频） */
export async function blobToDataUrl(url) {
  if (!url.startsWith('blob:')) return url
  const blob = await fetch(url).then((r) => r.blob())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('blob 读取失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 解析文档内图片 URL 为可直接 <img src> 的地址（blob:/data:）。
 * 后端按 docPath 解析相对路径并返回 dataUrl；本层缓存 + 大图 Blob 化。
 */
export async function resolveImageToDataUrl(docPath, url) {
  if (!url) return null
  if (url.startsWith('data:') || url.startsWith('blob:')) return url
  const key = `${docPath}::${url}`
  if (cache.has(key)) {
    // LRU 触碰：重插到末尾
    const entry = cache.get(key)
    cache.delete(key)
    cache.set(key, entry)
    return entry.url
  }
  if (inflight.has(key)) return inflight.get(key)
  const task = (async () => {
    try {
      let dataUrl = null
      if (/^https?:\/\//i.test(url)) {
        const down = await call('assets.readDataUrl', url)
        dataUrl = down.dataUrl
      } else {
        const path = await call('assets.resolveRelative', docPath, url)
        const read = await call('assets.readDataUrl', path)
        dataUrl = read.dataUrl
      }
      if (dataUrl) storeCache(key, dataUrl)
      return dataUrl ? cache.get(key).url : null
    } catch {
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, task)
  return task
}

/* ---------------- 粘贴图片（clipboard / paste 事件） ---------------- */

export function dataUrlToParts(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!m) throw new Error('无效的图片数据')
  return { mime: m[1], bytesB64: m[2] }
}

export async function readClipboardImage() {
  try { return (await api?.clipboard?.readImage?.())?.dataUrl ?? null } catch { return null }
}
