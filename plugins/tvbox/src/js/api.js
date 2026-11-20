/**
 * 前后端桥接：backend.call 封装 + 收藏/历史/播放进度 KV + 海报 base64 LRU。
 */
const api = () => {
  const enest = window.enest || window.zapi
  if (!enest?.backend?.call) throw new Error('影视仓需要宿主后端支持（backend.node）')
  return enest
}

export const call = (method, args = [], opts = {}) =>
  api().backend.call(method, args, { timeoutMs: opts.timeoutMs ?? 120_000 })

/* ---------------- 历史（前端直用 storage KV） ---------------- */
const HISTORY_KEY = 'history'
const HISTORY_MAX = 200

export async function loadHistory() {
  const value = await api().storage.get(HISTORY_KEY)
  return Array.isArray(value) ? value : []
}
export async function saveHistoryEntry(entry) {
  const enest = api()
  const id = `${entry.siteKey}::${entry.vodId}`
  const list = await loadHistory()
  const prev = list.find(h => `${h.siteKey}::${h.vodId}` === id)
  // 「打开详情」这类轻量回写不传 positionSec 时保留旧进度（避免续播点被清零）；
  // 播放器显式传 positionSec: 0 才视为从头重看。
  const keepProgress = entry.positionSec === undefined && prev
  const merged = {
    flag: '', episodeName: '', positionSec: 0, ...prev, ...entry,
    ...(keepProgress ? { positionSec: prev.positionSec, episodeIndex: entry.episodeIndex ?? prev.episodeIndex, durationSec: prev.durationSec } : {}),
    at: Date.now(),
  }
  const next = [merged, ...list.filter(h => `${h.siteKey}::${h.vodId}` !== id)].slice(0, HISTORY_MAX)
  await enest.storage.set(HISTORY_KEY, next)
  return next
}
export async function removeHistoryEntry(siteKey, vodId) {
  const list = await loadHistory()
  await api().storage.set(HISTORY_KEY, list.filter(h => !(h.siteKey === siteKey && h.vodId === vodId)))
}
export async function clearHistory() {
  await api().storage.set(HISTORY_KEY, [])
}

/* ---------------- 收藏 ---------------- */
const FAVORITES_KEY = 'favorites'

export async function loadFavorites() {
  const value = await api().storage.get(FAVORITES_KEY)
  return Array.isArray(value) ? value : []
}
export async function toggleFavorite(item) {
  const list = await loadFavorites()
  const exists = list.some(f => f.siteKey === item.siteKey && f.vodId === item.vodId)
  const next = exists
    ? list.filter(f => !(f.siteKey === item.siteKey && f.vodId === item.vodId))
    : [{ ...item, at: Date.now() }, ...list]
  await api().storage.set(FAVORITES_KEY, next)
  return { next, exists }
}

/* ---------------- 搜索历史 ---------------- */
const SEARCH_HISTORY_KEY = 'search.history'
const SEARCH_HISTORY_MAX = 20

export async function loadSearchHistory() {
  const value = await api().storage.get(SEARCH_HISTORY_KEY)
  return Array.isArray(value) ? value : []
}
export async function saveSearchKeyword(kw) {
  const word = String(kw ?? '').trim()
  if (!word) return
  const list = await loadSearchHistory()
  await api().storage.set(SEARCH_HISTORY_KEY, [word, ...list.filter(w => w !== word)].slice(0, SEARCH_HISTORY_MAX))
}
export async function removeSearchKeyword(kw) {
  const list = await loadSearchHistory()
  await api().storage.set(SEARCH_HISTORY_KEY, list.filter(w => w !== kw))
}
export async function clearSearchHistory() {
  await api().storage.set(SEARCH_HISTORY_KEY, [])
}

/* ---------------- 海报加载（LRU dataUrl 缓存 + 并发闸 + 失败不缓存） ---------------- */
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
const posterCache = new Lru(160)
const posterInflight = new Map()      // 去重：同 URL 并发只发一次
const POSTER_CONCURRENCY = 6          // 前端→后端图片请求并发闸（后端还有全局闸，双层保护）
let posterActive = 0
const posterQueue = []

async function fetchPoster(url, ownerKey) {
  if (posterActive >= POSTER_CONCURRENCY) {
    await new Promise(resolve => posterQueue.push(resolve))
  }
  posterActive++
  try {
    let attempt = 0
    for (;;) {
      try {
        const { mime, base64 } = await call('image.load', [url, ownerKey], { timeoutMs: 30_000 })
        return `data:${mime};base64,${base64}`
      } catch (e) {
        attempt++
        if (attempt >= 2) throw e   // 最多重试 1 次
        await new Promise(r => setTimeout(r, 400 * attempt))
      }
    }
  } finally {
    posterActive--
    const next = posterQueue.shift()
    if (next) next()
  }
}

export async function loadPoster(url, ownerKey = '') {
  if (!url) return ''
  const key = `${ownerKey}|${url}`
  const cached = posterCache.get(key)
  if (cached !== undefined) return cached
  if (!/^https?:\/\//i.test(url)) return url   // 已是本地/相对地址
  // 失败不缓存（之前 catch 里 set('') 导致偶发失败后整个会话该图永远空白）
  let pending = posterInflight.get(key)
  if (!pending) {
    pending = fetchPoster(url, ownerKey)
      .then(dataUrl => { posterCache.set(key, dataUrl); return dataUrl })
      .catch(() => '')
      .finally(() => posterInflight.delete(key))
    posterInflight.set(key, pending)
  }
  return pending
}
export function dropPosterCache() { posterCache.map.clear(); posterInflight.clear() }
