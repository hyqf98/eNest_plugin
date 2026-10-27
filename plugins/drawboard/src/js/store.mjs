/**
 * store.mjs —— 草稿与设置的持久化（插件私有存储，防抖 800ms）
 * 数据形态：{ version: 1, activeId, drafts: [{ id, name, createdAt, updatedAt, objects, viewport }] }
 * 贴图不进 JSON：保留草稿的 blobId 字段，资源经 storage.assets 现取（兼容旧 blobs）。
 */

import { normalizeSettings } from './theme.mjs'

export const DATA_KEY = 'drawboard.data.v1'
export const SETTINGS_KEY = 'drawboard.settings.v1'
const SAVE_DEBOUNCE = 800
const IMAGE_READ_CONCURRENCY = 3
const imageReadWaiters = []
let activeImageReads = 0

async function withImageRead(read) {
  if (activeImageReads >= IMAGE_READ_CONCURRENCY) await new Promise(resolve => imageReadWaiters.push(resolve))
  else activeImageReads += 1
  try {
    return await read()
  } finally {
    // Keep the same slot through compatibility fallbacks and release it on failure.
    const next = imageReadWaiters.shift()
    if (next) next()
    else activeImageReads -= 1
  }
}

let seq = 0
export function draftId() {
  seq += 1
  return `d${Date.now().toString(36)}${seq.toString(36)}`
}

export function makeDraft(name = '草稿 1') {
  return { id: draftId(), name, createdAt: Date.now(), updatedAt: Date.now(), objects: [], viewport: null }
}

export function serializeDraft(draft) {
  // objects 里的临时字段（_w/_measured/_born）不落盘
  return {
    ...draft,
    updatedAt: Date.now(),
    objects: draft.objects.map((obj) => {
      const clean = { ...obj }
      delete clean._w
      delete clean._measured
      delete clean._born
      return clean
    }),
  }
}

export function createPersistence(kit) {
  let timer = null
  let pending = null
  let pendingSettings = null
  let dataWrite = Promise.resolve()
  let settingsWrite = Promise.resolve()
  let loadCache = null

  async function loadData() {
    if (loadCache) return loadCache
    loadCache = (async () => {
      try {
        const raw = await kit.load(DATA_KEY, null)
        if (!raw || !Array.isArray(raw.drafts) || !raw.drafts.length) return null
        return raw
      } catch {
        return null
      }
    })()
    return loadCache
  }

  async function loadSettings() {
    try {
      const raw = await kit.load(SETTINGS_KEY, null)
      return normalizeSettings(raw)
    } catch {
      return normalizeSettings(null)
    }
  }

  function reportSaveError(error) {
    kit.toast(`保存失败：${error.message || error}`, 'error')
  }

  function writePendingData() {
    if (!pending) return dataWrite
    const data = pending
    const snapshot = { ...data, drafts: data.drafts.map(serializeDraft) }
    dataWrite = kit.save(DATA_KEY, snapshot).then(() => { if (pending === data) pending = null })
    return dataWrite
  }

  function writePendingSettings() {
    if (!pendingSettings) return settingsWrite
    const value = pendingSettings
    settingsWrite = kit.save(SETTINGS_KEY, value).then(() => { if (pendingSettings === value) pendingSettings = null })
    return settingsWrite
  }

  function saveData(data) {
    pending = data
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void writePendingData().catch(reportSaveError)
    }, SAVE_DEBOUNCE)
  }

  function saveSettings(settings) {
    pendingSettings = normalizeSettings(settings)
    void writePendingSettings().catch(reportSaveError)
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await Promise.all([writePendingData(), writePendingSettings()])
    if (kit.api?.storage?.flush) await kit.flush()
  }

  return { loadData, loadSettings, saveData, saveSettings, flush }
}

/** 只在没有宿主图片存储时内联；写入失败交给界面报错，不能塞回有大小上限的 KV。 */
export async function putImageBlob(kit, dataUrl, name = 'image') {
  const api = kit?.api || (typeof window !== 'undefined' && window.enest) || null
  const storage = api?.storage
  if (storage?.assets?.put) {
    // 二进制输入也兼容尚未支持 dataUrl 输入的旧 assets 宿主。
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
    if (!match) throw new Error('图片存储仅支持 PNG、JPEG、WebP 和 GIF')
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const asset = await storage.assets.put({ bytes: bytes.buffer, mime: match[1], name })
    return asset.assetId
  }
  if (storage?.blobs?.put) {
    const blob = await storage.blobs.put({ dataUrl, name })
    return blob.id
  }
  return null
}

export async function getImageBlob(kit, blobId) {
  const api = kit?.api || (typeof window !== 'undefined' && window.enest) || null
  const storage = api?.storage
  return withImageRead(async () => {
    if (storage?.assets?.get) {
      try {
        const asset = await storage.assets.get(blobId)
        if (asset?.dataUrl) return asset.dataUrl
      } catch { /* 旧 assets 宿主不认识附件 UUID；保留原 ID 向兼容接口读取。 */ }
    }
    try {
      const blob = await storage?.blobs?.get?.(blobId)
      return blob?.dataUrl || null
    } catch {
      return null
    }
  })
}
