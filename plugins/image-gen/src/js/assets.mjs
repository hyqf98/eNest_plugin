/**
 * assets — 生成图落库（storage.assets 标准静态资源通道）+ 预览记录索引 + blob 预览缓存。
 * put：Uint8Array → 拷贝新 ArrayBuffer → assets.put；预览经 get 回 dataUrl 再转 blob: URL
 * （插件页 CSP img-src 为 'self' data: blob:，enest://media 不放行）。
 * 预览库索引存私有 KV `image-gen.records.v1`（FIFO 1000）。
 */

const RECORDS_KEY = 'image-gen.records.v1'
const RECORDS_LIMIT = 1000
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
  dropBlob(assetId)
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

/** 经缓存取预览 URL；data: 前缀（本地未落盘附件）直接透传 */
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

/* —— 预览库记录（FIFO）—— */
let recordsTail = Promise.resolve()

async function readRecords(storage) {
  const saved = await storage.get(RECORDS_KEY)
  if (saved === undefined || saved === null) return []
  if (!Array.isArray(saved)) throw new Error('生成记录格式无效，未覆盖已有数据')
  return saved
}

function updateRecords(change) {
  const task = recordsTail.then(async () => {
    const storage = store().storage
    // Writes cannot use the display-only empty fallback: a failed read must not erase the index.
    const records = await readRecords(storage)
    change(records)
    if (storage.commit) await storage.commit([{ op: 'set', key: RECORDS_KEY, value: records }])
    else {
      await storage.set(RECORDS_KEY, records)
      if (storage.flush) await storage.flush()
    }
    return records
  })
  recordsTail = task.then(() => undefined, () => undefined)
  return task
}

export async function loadRecords() {
  try {
    return await readRecords(store().storage)
  } catch { /* Display may omit records; writes use the strict reader above. */ }
  return []
}

/** 生成成功后追加一条记录（时间倒序插入队首） */
export async function attachRecord(record) {
  const snapshot = structuredClone(record)
  return updateRecords(records => {
    records.unshift(snapshot)
    if (records.length > RECORDS_LIMIT) records.length = RECORDS_LIMIT
  })
}

/** 删除记录（不动资源本身，资源由调用方显式删除） */
export async function removeRecord(id) {
  return updateRecords(records => {
    const index = records.findIndex(r => r.id === id)
    if (index >= 0) records.splice(index, 1)
  })
}
