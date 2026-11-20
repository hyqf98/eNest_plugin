/**
 * 前后端桥接：backend.call 封装 + 历史 KV + 图片 dataUrl 缓存。
 * 图片走 LRU（内存 dataUrl，上限 60 张），章节列表与封面另用较小缓存。
 * call 永不 reject 丢失上下文：宿主桥缺失时 reject 由调用方 catch；
 * storage 读取失败回退空值，避免渲染周期内同步 throw 白屏。
 */
let bridgeMissing = false
const api = () => {
  const enest = window.enest || window.zapi
  if (!enest?.backend?.call) {
    bridgeMissing = true
    const err = new Error('漫画屋需要宿主后端支持（backend.node）')
    throw err
  }
  bridgeMissing = false
  return enest
}

export const call = (method, args = [], opts = {}) =>
  Promise.resolve().then(() => api().backend.call(method, args, { timeoutMs: opts.timeoutMs ?? 120_000 }))

/* ---------------- 历史（前端直用 storage KV） ---------------- */
const HISTORY_KEY = 'history'
const HISTORY_MAX = 200

export async function loadHistory() {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.get) return []
  const value = await enest.storage.get(HISTORY_KEY).catch(() => null)
  return Array.isArray(value) ? value : []
}
export async function saveHistoryEntry(entry) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  const id = `${entry.sourceKey}::${entry.comicId}`
  const list = await loadHistory()
  const { historyLimit } = await loadSettings()
  const next = [
    { ...entry, at: Date.now() },
    ...list.filter(h => `${h.sourceKey}::${h.comicId}` !== id),
  ].slice(0, historyLimit || HISTORY_MAX)
  // 历史 + 进度一次原子提交（标准 storage.commit，FULL WAL 回执）
  const all = await loadProgressAll()
  all[id] = { epId: entry.lastEpId ?? all[id]?.epId ?? '', page: entry.lastPage ?? all[id]?.page ?? 0, at: Date.now() }
  await enest.storage.commit([
    { op: 'set', key: HISTORY_KEY, value: next },
    { op: 'set', key: PROGRESS_KEY, value: all },
  ])
}
export async function removeHistoryEntry(sourceKey, comicId) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  const list = await loadHistory()
  await enest.storage.commit([
    { op: 'set', key: HISTORY_KEY, value: list.filter(h => !(h.sourceKey === sourceKey && h.comicId === comicId)) },
  ])
}
export async function clearHistory() {
  await call('history.clear')
}

/* ---------------- 阅读进度（单独 KV，按漫画记章节与页码） ---------------- */
const PROGRESS_KEY = 'reading.progress'
async function loadProgressAll() {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.get) return {}
  const value = await enest.storage.get(PROGRESS_KEY).catch(() => null)
  return value && typeof value === 'object' ? value : {}
}
export async function loadProgress() {
  return loadProgressAll()
}
export async function saveProgress(sourceKey, comicId, progress) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.set) return
  const all = await loadProgressAll()
  all[`${sourceKey}::${comicId}`] = { ...progress, at: Date.now() }
  const entries = Object.entries(all)
  if (entries.length > 300) {
    entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    await enest.storage.set(PROGRESS_KEY, Object.fromEntries(entries.slice(0, 300)))
    return
  }
  await enest.storage.set(PROGRESS_KEY, all)
}

/* ---------------- 搜索历史（KV，commit 原子提交） ---------------- */
const SEARCH_HISTORY_KEY = 'search.history'
const SEARCH_HISTORY_MAX = 20

export async function loadSearchHistory() {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.get) return []
  const value = await enest.storage.get(SEARCH_HISTORY_KEY).catch(() => null)
  return Array.isArray(value) ? value.filter(x => typeof x === 'string') : []
}
export async function saveSearchTerm(term) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  const list = await loadSearchHistory()
  const next = [term, ...list.filter(h => h !== term)].slice(0, SEARCH_HISTORY_MAX)
  await enest.storage.commit([{ op: 'set', key: SEARCH_HISTORY_KEY, value: next }])
}
export async function removeSearchTerm(term) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  const list = await loadSearchHistory()
  await enest.storage.commit([{ op: 'set', key: SEARCH_HISTORY_KEY, value: list.filter(h => h !== term) }])
}
export async function clearSearchHistory() {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  await enest.storage.commit([{ op: 'set', key: SEARCH_HISTORY_KEY, value: [] }])
}

/* ---------------- 设置（KV 持久化，读写统一走 storage API） ---------------- */
const SETTINGS_KEY = 'settings'
const SETTINGS_DEFAULTS = {
  readerGap: 4,          // 阅读页间距 px
  autoCache: false,      // 阅读时自动缓存本章
  cacheLimitMB: 2048,    // 缓存总量上限
  preloadCount: 3,       // 阅读器向后预加载页数
  historyLimit: 200,     // 历史上限条数
}

export async function loadSettings() {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.get) return { ...SETTINGS_DEFAULTS }
  const value = await enest.storage.get(SETTINGS_KEY).catch(() => null)
  return { ...SETTINGS_DEFAULTS, ...(value && typeof value === 'object' ? value : {}) }
}
export async function saveSettings(patch) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  const next = { ...(await loadSettings()), ...patch }
  await enest.storage.commit([{ op: 'set', key: SETTINGS_KEY, value: next }])
  return next
}

/* ---------------- 收藏（KV，commit 原子提交） ---------------- */
const FAVORITES_KEY = 'favorites'
const FAVORITES_MAX = 500

export async function loadFavorites() {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.get) return []
  const value = await enest.storage.get(FAVORITES_KEY).catch(() => null)
  return Array.isArray(value) ? value : []
}
export async function isFavorited(sourceKey, comicId) {
  const list = await loadFavorites()
  return list.some(f => f.sourceKey === sourceKey && f.comicId === comicId)
}
export async function toggleFavorite(item) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return false
  const list = await loadFavorites()
  const id = `${item.sourceKey}::${item.comicId}`
  const exists = list.some(f => `${f.sourceKey}::${f.comicId}` === id)
  const next = exists
    ? list.filter(f => `${f.sourceKey}::${f.comicId}` !== id)
    : [{ ...item, at: Date.now() }, ...list].slice(0, FAVORITES_MAX)
  await enest.storage.commit([{ op: 'set', key: FAVORITES_KEY, value: next }])
  return !exists
}
export async function removeFavorite(sourceKey, comicId) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  const list = await loadFavorites()
  await enest.storage.commit([{ op: 'set', key: FAVORITES_KEY, value: list.filter(f => !(f.sourceKey === sourceKey && f.comicId === comicId)) }])
}

/* ---------------- 图片加载（LRU dataUrl 缓存 + 并发闸门） ---------------- */
class Lru {
  constructor(max) { this.max = max; this.map = new Map() }
  get(key) {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)
    this.map.delete(key); this.map.set(key, value)
    return value
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
  }
}
// 首页封面量大（一次 60+ 张），缓存太小会互相淘汰导致重复请求；
// 阅读页单章 20-30 张、单图体积大，用较小上限控制内存。
const imageCache = new Lru(240)

/**
 * 前端并发闸门：首页一次渲染几十张封面时，若全部同时发 RPC，
 * 后端 10 并发队列会积压、部分请求超时或撞上后端空闲回收。
 * 这里限制同时在途 6 个，其余排队，配合失败自动重试。
 */
const IMAGE_CONCURRENCY = 6
let imageActive = 0
const imageWaiters = []
async function withImageSlot(fn) {
  if (imageActive >= IMAGE_CONCURRENCY) {
    await new Promise(resolve => imageWaiters.push(resolve))
  }
  imageActive++
  try {
    return await fn()
  } finally {
    imageActive--
    const next = imageWaiters.shift()
    if (next) next()
  }
}
/** 在途去重：同一 URL 并发请求合并为一次 */
const inflight = new Map()

export async function loadImage(sourceKey, url, comicId = '', epId = '') {
  const key = `${sourceKey}|${comicId}|${epId}|${url}`
  const cached = imageCache.get(key)
  if (cached) return cached
  const pending = inflight.get(key)
  if (pending) return pending

  const task = withImageSlot(async () => {
    // 单次失败自动重试一次（瞬时网络抖动/后端刚被唤醒）
    let lastError
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await call('image.load', [sourceKey, url, comicId, epId], { timeoutMs: 120_000 })
        // 大图由后端分块返回，这里拼接（画质无损）
        const base64 = res.chunked ? (res.chunks ?? []).join('') : res.base64
        const dataUrl = `data:${res.mime};base64,${base64}`
        imageCache.set(key, dataUrl)
        return dataUrl
      } catch (e) {
        lastError = e
        if (attempt === 0) await new Promise(r => setTimeout(r, 600))
      }
    }
    throw lastError
  }).finally(() => { inflight.delete(key) })

  inflight.set(key, task)
  return task
}
export function dropImageCache() { imageCache.map.clear() }
