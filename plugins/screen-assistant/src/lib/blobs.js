/** 媒体原文件 → objectURL（LRU，卸载时 revoke）。 */
import { host } from './env.js'
import { dataUrlToBlob, mimeForExtension, readFileBytes } from './files.js'

const entries = new Map()
const MAX_TOTAL = 192 * 1024 * 1024
const MAX_ENTRIES = 12
let total = 0

function evict() {
  while (entries.size > MAX_ENTRIES || total > MAX_TOTAL) {
    const first = entries.keys().next().value
    const entry = entries.get(first)
    entries.delete(first)
    total -= entry.bytes
    URL.revokeObjectURL(entry.url)
  }
}

async function bytesFor(item) {
  if (item.legacyBlobId) {
    const blob = await host.storage.blobs.get(item.legacyBlobId)
    if (!blob?.dataUrl) throw new Error('旧版原图已不存在')
    return { blob: dataUrlToBlob(blob.dataUrl), bytes: blob.bytes || 0 }
  }
  if (!item.fileId) throw new Error('这条记录只有缩略图')
  const bytes = await readFileBytes(item.fileId, { maxBytes: item.kind === 'video' ? 256 * 1024 * 1024 : 128 * 1024 * 1024 })
  const mime = mimeForExtension(item.ext || (item.kind === 'video' ? 'webm' : item.kind === 'gif' ? 'gif' : 'png'))
  return { blob: new Blob([bytes], { type: mime }), bytes: bytes.byteLength }
}

/** 返回 { url, blob, bytes }；同一 item 复用，超出预算按插入顺序淘汰。 */
export async function objectUrlFor(item) {
  const existing = entries.get(item.id)
  if (existing) {
    entries.delete(item.id)
    entries.set(item.id, existing)
    return existing
  }
  const { blob, bytes } = await bytesFor(item)
  const entry = { url: URL.createObjectURL(blob), blob, bytes }
  entries.set(item.id, entry)
  total += entry.bytes
  evict()
  return entry
}

export function releaseObjectUrl(itemId) {
  const entry = entries.get(itemId)
  if (!entry) return
  entries.delete(itemId)
  total -= entry.bytes
  URL.revokeObjectURL(entry.url)
}

export function releaseAll() {
  for (const entry of entries.values()) URL.revokeObjectURL(entry.url)
  entries.clear()
  total = 0
}

export function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片无法读取'))
    image.src = url
  })
}

export async function imageElementFor(item) {
  const entry = await objectUrlFor(item)
  return loadImageElement(entry.url)
}

export async function blobFor(item) {
  return (await objectUrlFor(item)).blob
}
