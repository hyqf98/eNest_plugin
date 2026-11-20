/**
 * 前后端桥接：backend.call 封装 + 历史/收藏/进度/搜索历史 KV + 封面 dataUrl 缓存。
 * 封面走 LRU（内存 dataUrl，上限 60 张）。
 * storage 读取失败回退空值，避免渲染周期内同步 throw 白屏。
 */
const api = () => {
  const enest = window.enest || window.zapi
  if (!enest?.backend?.call) throw new Error('小说屋需要宿主后端支持（backend.node）')
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
  const id = `${entry.sourceKey}::${entry.bookId}`
  const list = await loadHistory()
  const { historyLimit } = await loadSettings()
  const next = [
    { ...entry, at: Date.now() },
    ...list.filter(h => `${h.sourceKey}::${h.bookId}` !== id),
  ].slice(0, historyLimit || HISTORY_MAX)
  // 历史 + 进度一次原子提交（标准 storage.commit，FULL WAL 回执）
  const all = await loadProgressAll()
  all[id] = { chId: entry.lastChId ?? all[id]?.chId ?? '', chTitle: entry.lastChTitle ?? all[id]?.chTitle ?? '', offset: entry.lastOffset ?? all[id]?.offset ?? 0, at: Date.now() }
  await enest.storage.commit([
    { op: 'set', key: HISTORY_KEY, value: next },
    { op: 'set', key: PROGRESS_KEY, value: all },
  ])
}
export async function removeHistoryEntry(sourceKey, bookId) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  const list = await loadHistory()
  await enest.storage.commit([
    { op: 'set', key: HISTORY_KEY, value: list.filter(h => !(h.sourceKey === sourceKey && h.bookId === bookId)) },
  ])
}
export async function clearHistory() {
  await call('history.clear')
}

/* ---------------- 阅读进度（单独 KV，按书记录章节与滚动偏移） ---------------- */
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
export async function saveProgress(sourceKey, bookId, progress) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.set) return
  const all = await loadProgressAll()
  all[`${sourceKey}::${bookId}`] = { ...progress, at: Date.now() }
  const entries = Object.entries(all)
  if (entries.length > 300) {
    entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    await enest.storage.set(PROGRESS_KEY, Object.fromEntries(entries.slice(0, 300)))
    return
  }
  await enest.storage.set(PROGRESS_KEY, all)
}

/* ---------------- 搜索历史 ---------------- */
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

/* ---------------- 设置 ---------------- */
const SETTINGS_KEY = 'settings'
export const SETTINGS_DEFAULTS = {
  fontSize: 17,          // 正文字号 px
  lineHeight: 1.9,       // 正文行高
  paraGap: 14,           // 段间距 px
  readerWidth: 720,      // 阅读版心宽度 px
  readerTheme: 'paper',  // paper | white | dark | green
  autoCache: false,      // 阅读时自动缓存本章
  cacheLimitMB: 1024,    // 缓存总量上限
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

/* ---------------- 收藏 ---------------- */
const FAVORITES_KEY = 'favorites'
const FAVORITES_MAX = 500

export async function loadFavorites() {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.get) return []
  const value = await enest.storage.get(FAVORITES_KEY).catch(() => null)
  return Array.isArray(value) ? value : []
}
export async function isFavorited(sourceKey, bookId) {
  const list = await loadFavorites()
  return list.some(f => f.sourceKey === sourceKey && f.bookId === bookId)
}
export async function toggleFavorite(item) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return false
  const list = await loadFavorites()
  const id = `${item.sourceKey}::${item.bookId}`
  const exists = list.some(f => `${f.sourceKey}::${f.bookId}` === id)
  const next = exists
    ? list.filter(f => `${f.sourceKey}::${f.bookId}` !== id)
    : [{ ...item, at: Date.now() }, ...list].slice(0, FAVORITES_MAX)
  await enest.storage.commit([{ op: 'set', key: FAVORITES_KEY, value: next }])
  return !exists
}
export async function removeFavorite(sourceKey, bookId) {
  const enest = window.enest || window.zapi
  if (!enest?.storage?.commit) return
  const list = await loadFavorites()
  await enest.storage.commit([{ op: 'set', key: FAVORITES_KEY, value: list.filter(f => !(f.sourceKey === sourceKey && f.bookId === bookId)) }])
}

/* ---------------- 封面加载（LRU dataUrl 缓存） ---------------- */
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
const coverCache = new Lru(60)

export async function loadCover(sourceKey, url, bookUrl = '') {
  if (!url && !bookUrl) throw new Error('无封面')
  const key = `${sourceKey}|${bookUrl || url}`
  const cached = coverCache.get(key)
  if (cached) return cached
  const { mime, base64 } = await call('cover.load', [sourceKey, url || '', bookUrl], { timeoutMs: 60_000 })
  const dataUrl = `data:${mime};base64,${base64}`
  coverCache.set(key, dataUrl)
  return dataUrl
}
export function dropCoverCache() { coverCache.map.clear() }
