/**
 * favorites — 收藏数据层：enest.storage KV（索引）+ assets（图片字节）。
 * 收藏条目：{ id, source, label, assetId, mime, width, height, animated, at }
 * 断网时收藏夹离线可用：assets.get(assetId) → dataUrl 渲染。
 */

import { storage, fromDataUrl, loadImageBytes, toDataUrl } from './api.mjs'

const KEY = 'favorites'
const MAX_FAVORITES = 2000

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return []
  if (Array.isArray(raw)) return raw.filter(entry => entry && entry.id && entry.assetId)
  return []
}

export async function listFavorites() {
  const raw = await storage().get(KEY)
  const entries = normalize(raw)
  return entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

async function save(entries) {
  await storage().set(KEY, entries.slice(0, MAX_FAVORITES))
  await storage().flush()
}

/** 收藏一张图：imageUrl 字节（或现成 dataUrl）→ assets.put + 索引 upsert */
export async function addFavorite(item, dataUrlIn) {
  let dataUrl = dataUrlIn
  if (!dataUrl) dataUrl = await loadImageBytes(item.imageUrl)
  const { bytes, mime } = fromDataUrl(dataUrl)
  const name = `${(item.label || item.id).slice(0, 40).replace(/[\\/:*?"<>|]/g, '')}${mime === 'image/gif' ? '.gif' : ''}`
  const put = await storage().assets.put({ bytes: bytes.buffer, mime, name })
  if (!put || !put.assetId) throw new Error('保存图片失败')
  let entries = normalize(await storage().get(KEY))
  entries = entries.filter(entry => entry.id !== item.id)
  entries.unshift({
    id: item.id, source: item.source, label: item.label || '', assetId: put.assetId,
    mime, width: item.width ?? 0, height: item.height ?? 0, animated: Boolean(item.animated), at: Date.now(),
  })
  await save(entries)
  return entries[0]
}

/** 本地导入：dataUrl（pick/fromDrop 读回）→ assets.put + 索引 */
export async function importLocal(dataUrl, name = '') {
  const { bytes, mime } = fromDataUrl(dataUrl)
  if (!mime.startsWith('image/')) throw new Error('仅支持图片文件')
  const put = await storage().assets.put({ bytes: bytes.buffer, mime, name: name || 'local' })
  if (!put || !put.assetId) throw new Error('保存图片失败')
  let entries = normalize(await storage().get(KEY))
  const id = `local:${put.assetId}`
  entries = entries.filter(entry => entry.id !== id)
  entries.unshift({
    id, source: 'local', label: name.replace(/\.[a-z0-9]+$/i, '') || '本地图片', assetId: put.assetId,
    mime, width: 0, height: 0, animated: mime === 'image/gif', at: Date.now(),
  })
  await save(entries)
  return entries[0]
}

export async function removeFavorite(id) {
  let entries = normalize(await storage().get(KEY))
  const target = entries.find(entry => entry.id === id)
  if (target) {
    try { await storage().assets.remove(target.assetId) } catch { /* 资源已不存在 */ }
  }
  const next = entries.filter(entry => entry.id !== id)
  await save(next)
  return next
}

export async function clearFavorites() {
  let entries = normalize(await storage().get(KEY))
  for (const entry of entries) {
    try { await storage().assets.remove(entry.assetId) } catch { /* 资源已不存在 */ }
  }
  await save([])
}

/** 收藏夹条目 → 可渲染 dataUrl */
export async function favoriteDataUrl(entry) {
  const got = await storage().assets.get(entry.assetId)
  if (!got) return null
  return got.dataUrl
}

/** 批量取（首页渲染），LRU 内存缓存避免重复 assets.get */
const renderCache = new Map()
export async function favoriteDataUrlCached(entry) {
  const hit = renderCache.get(entry.assetId)
  if (hit) {
    renderCache.delete(entry.assetId)
    renderCache.set(entry.assetId, hit)
    return hit
  }
  const dataUrl = await favoriteDataUrl(entry)
  if (!dataUrl) return null
  renderCache.set(entry.assetId, dataUrl)
  if (renderCache.size > 400) renderCache.delete(renderCache.keys().next().value)
  return dataUrl
}

export { toDataUrl }
