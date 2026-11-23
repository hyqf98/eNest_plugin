/** 缩略图资产（storage.assets）与内存缓存。 */
import { host } from './env.js'

const cache = new Map()
const MAX_CACHE = 240

export async function putThumb(dataUrl, name = '缩略图') {
  if (!dataUrl) return ''
  const asset = await host.storage.assets.put({ dataUrl, name })
  const id = asset.assetId || asset.id
  if (id) cache.set(id, dataUrl)
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  return id
}

export async function getThumb(thumbId) {
  if (!thumbId) return ''
  const hit = cache.get(thumbId)
  if (hit) return hit
  const asset = await host.storage.assets.get(thumbId).catch(() => null)
  if (!asset?.dataUrl) return ''
  cache.set(thumbId, asset.dataUrl)
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  return asset.dataUrl
}

export async function removeThumb(thumbId) {
  if (!thumbId) return false
  cache.delete(thumbId)
  return host.storage.assets.remove(thumbId).catch(() => false)
}
