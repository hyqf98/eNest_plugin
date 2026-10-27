/**
 * assets — 生成图片落盘（宿主 storage.assets 标准静态资源通道）+ 画廊索引 + blob 预览缓存。
 * put：Uint8Array → ArrayBuffer → assets.put；预览经 get 回 dataUrl 再转 blob: URL
 * （插件页 CSP img-src 为 'self' data: blob:，enest://media 不放行）。
 * 画廊索引存私有 KV：assetId → { prompt, providerName, model, nodeId, draftId, at }。
 */

const GALLERY_KEY = 'ai-canvas.gallery-meta.v1'
const GALLERY_LIMIT = 800
const BLOB_CACHE_LIMIT = 48

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

export async function saveAsset({ bytes, mime, name }) {
  const enest = store()
  if (!enest.storage.assets?.put) throw new Error('宿主静态资源接口不可用，请升级 eNest')
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return enest.storage.assets.put({ bytes: copy, mime, name })
}

export async function listAssets() {
  const enest = store()
  if (!enest.storage.assets?.list) return []
  return enest.storage.assets.list()
}

/** dataUrl 读回（导出/大图查看用） */
export async function getAsset(assetId) {
  const enest = store()
  if (!enest.storage.assets?.get) return null
  return enest.storage.assets.get(assetId)
}

export async function deleteAsset(assetId) {
  const enest = store()
  if (!enest.storage.assets?.delete) return false
  const meta = await loadGalleryMeta()
  delete meta[assetId]
  await store().storage.set(GALLERY_KEY, meta)
  dropBlob(assetId)
  return enest.storage.assets.delete(assetId)
}

/* —— blob 预览缓存：assetId → blob: URL（LRU，超限逐出） —— */
const blobCache = new Map()
const pendingBlobs = new Map()

function dropBlob(assetId) {
  const url = blobCache.get(assetId)
  if (url) { URL.revokeObjectURL(url); blobCache.delete(assetId) }
}

/** 经缓存取预览 URL；data: 前缀（本地上传未落盘前）直接透传 */
export async function assetPreviewUrl(assetId) {
  if (!assetId) return null
  if (String(assetId).startsWith('data:')) return assetId
  if (blobCache.has(assetId)) {
    const hit = blobCache.get(assetId)
    blobCache.delete(assetId); blobCache.set(assetId, hit)
    return hit
  }
  if (pendingBlobs.has(assetId)) return pendingBlobs.get(assetId)
  const task = (async () => {
    const asset = await getAsset(assetId)
    if (!asset?.dataUrl) return null
    // CSP connect-src 不放行 data:，用 atob 手工转 Blob（img-src 允许 blob:）
    const match = /^data:([\w.+/-]+);base64,(.*)$/.exec(asset.dataUrl)
    if (!match) return null
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }))
    blobCache.set(assetId, url)
    while (blobCache.size > BLOB_CACHE_LIMIT) {
      const oldest = blobCache.keys().next().value
      dropBlob(oldest)
    }
    return url
  })().finally(() => pendingBlobs.delete(assetId))
  pendingBlobs.set(assetId, task)
  return task
}

/* —— 画廊索引 —— */
export async function loadGalleryMeta() {
  try {
    const saved = await store().storage.get(GALLERY_KEY)
    if (saved && typeof saved === 'object') return saved
  } catch { /* 首次 */ }
  return {}
}

export async function attachGalleryMeta(assetId, record) {
  const meta = await loadGalleryMeta()
  meta[assetId] = record
  const keys = Object.keys(meta)
  if (keys.length > GALLERY_LIMIT) {
    keys.sort((a, b) => (meta[a]?.at ?? 0) - (meta[b]?.at ?? 0))
    for (const k of keys.slice(0, keys.length - GALLERY_LIMIT)) delete meta[k]
  }
  await store().storage.set(GALLERY_KEY, meta)
  return meta
}

/** 画廊合并视图：资源列表（新→旧）+ 索引元数据 */
export async function loadGallery() {
  const [assets, meta] = await Promise.all([listAssets(), loadGalleryMeta()])
  return assets.map(a => ({ ...a, record: meta[a.assetId] ?? null }))
}

export async function storageUsage() {
  const assets = await listAssets()
  const bytes = assets.reduce((sum, a) => sum + (a.bytes || 0), 0)
  return { count: assets.length, bytes }
}
