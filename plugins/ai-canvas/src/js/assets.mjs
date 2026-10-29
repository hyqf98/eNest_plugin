/**
 * assets — 生成图片落盘（宿主 storage.assets 标准静态资源通道）+ 画廊索引 + blob 预览缓存。
 * put：Uint8Array → ArrayBuffer → assets.put；预览经 get 回 dataUrl 再转 blob: URL
 * （插件页 CSP img-src 为 'self' data: blob:，enest://media 不放行）。
 * 画廊索引存私有 KV：assetId → { prompt, providerName, model, nodeId, draftId, at }。
 */

const GALLERY_KEY = 'ai-canvas.gallery-meta.v1'
const GALLERY_LIMIT = 800
const BLOB_CACHE_LIMIT = 48
const IMAGE_READ_CONCURRENCY = 3
const imageReadWaiters = []
let activeImageReads = 0

async function withImageRead(read) {
  if (activeImageReads >= IMAGE_READ_CONCURRENCY) await new Promise(resolve => imageReadWaiters.push(resolve))
  else activeImageReads += 1
  try {
    return await read()
  } finally {
    // Hand the slot to the oldest waiter without letting new calls bypass it.
    const next = imageReadWaiters.shift()
    if (next) next()
    else activeImageReads -= 1
  }
}

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
  return withImageRead(() => enest.storage.assets.list())
}

/** dataUrl 读回（导出/大图查看用） */
export async function getAsset(assetId) {
  const enest = store()
  if (!enest.storage.assets?.get) return null
  return withImageRead(() => enest.storage.assets.get(assetId))
}

export async function deleteAsset(assetId) {
  const enest = store()
  const assets = enest.storage.assets
  const remove = assets?.remove ?? assets?.delete
  if (!remove) return false
  await remove.call(assets, assetId)
  // An absent resource is already deleted, but a prior failed index write still needs retrying.
  dropBlob(assetId)
  await updateGalleryMeta(meta => { delete meta[assetId] })
  return true
}

/* —— blob 预览缓存：assetId → blob: URL（LRU，超限逐出） —— */
const blobCache = new Map()
const pendingBlobs = new Map()

function dropBlob(assetId) {
  pendingBlobs.delete(assetId)
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
    if (pendingBlobs.get(assetId) !== task) return null
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
  })().finally(() => { if (pendingBlobs.get(assetId) === task) pendingBlobs.delete(assetId) })
  pendingBlobs.set(assetId, task)
  return task
}

/* —— 画廊索引 —— */
let galleryMetaTail = Promise.resolve()

async function readGalleryMeta(storage) {
  const saved = await storage.get(GALLERY_KEY)
  if (saved === undefined || saved === null) return {}
  if (typeof saved !== 'object' || Array.isArray(saved)) throw new Error('画廊索引格式无效，未覆盖已有数据')
  return { ...saved }
}

function updateGalleryMeta(change) {
  const task = galleryMetaTail.then(async () => {
    const storage = store().storage
    // Writes cannot use the display-only empty fallback: a failed read must not erase the index.
    const meta = await readGalleryMeta(storage)
    change(meta)
    if (storage.commit) await storage.commit([{ op: 'set', key: GALLERY_KEY, value: meta }])
    else {
      await storage.set(GALLERY_KEY, meta)
      if (storage.flush) await storage.flush()
    }
    return meta
  })
  galleryMetaTail = task.then(() => undefined, () => undefined)
  return task
}

export async function loadGalleryMeta() {
  try {
    return await readGalleryMeta(store().storage)
  } catch { /* Display may omit metadata; writes use the strict reader above. */ }
  return {}
}

export async function attachGalleryMeta(assetId, record) {
  const snapshot = structuredClone(record)
  return updateGalleryMeta(meta => {
    meta[assetId] = snapshot
    const keys = Object.keys(meta)
    if (keys.length > GALLERY_LIMIT) {
      keys.sort((a, b) => (meta[a]?.at ?? 0) - (meta[b]?.at ?? 0))
      for (const k of keys.slice(0, keys.length - GALLERY_LIMIT)) delete meta[k]
    }
  })
}

/** 画廊重命名：只改索引里的展示名，不动资源本身 */
export async function renameAsset(assetId, name) {
  return updateGalleryMeta(meta => {
    const record = meta[assetId] ?? {}
    meta[assetId] = { ...record, name: String(name ?? '').trim() || null }
  })
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
