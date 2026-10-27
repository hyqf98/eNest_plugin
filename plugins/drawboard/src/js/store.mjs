/**
 * store.mjs —— 草稿与设置的持久化（插件私有存储，防抖 800ms）
 * 数据形态：{ version: 1, activeId, drafts: [{ id, name, createdAt, updatedAt, objects, viewport }] }
 * 贴图不进 JSON：对象只存 blobId，dataUrl 经 storage.blobs 现取。
 */

import { normalizeSettings } from './theme.mjs'

export const DATA_KEY = 'drawboard.data.v1'
export const SETTINGS_KEY = 'drawboard.settings.v1'
const SAVE_DEBOUNCE = 800

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

  function saveData(data) {
    pending = data
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const snapshot = { ...pending, drafts: pending.drafts.map(serializeDraft) }
      void kit.save(DATA_KEY, snapshot).catch(() => {})
    }, SAVE_DEBOUNCE)
  }

  function saveSettings(settings) {
    void kit.save(SETTINGS_KEY, normalizeSettings(settings)).catch(() => {})
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
      const snapshot = { ...pending, drafts: pending.drafts.map(serializeDraft) }
      void kit.save(DATA_KEY, snapshot).catch(() => {})
    }
  }

  return { loadData, loadSettings, saveData, saveSettings, flush }
}

/** 贴图：入 blob 拿 id；退化环境（无 blobs）时返回 null 由调用方直接内联 dataUrl */
export async function putImageBlob(kit, dataUrl, name = 'image') {
  try {
    if (kit?.api?.storage?.blobs?.put || (typeof window !== 'undefined' && window.enest?.storage?.blobs?.put)) {
      const api = kit?.api || window.enest
      const blob = await api.storage.blobs.put({ dataUrl, name })
      return blob?.id || null
    }
  } catch {
    /* 落回内联 */
  }
  return null
}

export async function getImageBlob(kit, blobId) {
  try {
    const api = kit?.api || (typeof window !== 'undefined' && window.enest) || null
    const blob = await api?.storage?.blobs?.get?.(blobId)
    return blob?.dataUrl || null
  } catch {
    return null
  }
}
