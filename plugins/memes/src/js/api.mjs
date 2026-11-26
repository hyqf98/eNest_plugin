/**
 * api — 表情包插件宿主接口封装：net.fetch（流式二进制收集）+ clipboard + storage + localFiles。
 * 宿主约束：非流式响应 2MB、流式 32MB（base64 分片经 net.chunk 推送）、并发 8（此处自限 6）。
 */

const CONCURRENCY = 6
const queue = []
let active = 0

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    pump()
  })
}
function pump() {
  while (active < CONCURRENCY && queue.length > 0) {
    const { task, resolve, reject } = queue.shift()
    active += 1
    task().then(resolve, reject).finally(() => { active -= 1; pump() })
  }
}

export function api() {
  const enest = window.enest || window.zapi
  if (!enest?.net?.fetch) throw new Error('宿主网络接口不可用')
  return enest
}

/** 逐片 base64 → 字节拼接（宿主对每块独立 base64，块边界任意对齐） */
export function decodeBase64Chunks(chunks) {
  let total = 0
  const buffers = chunks.map(chunk => {
    const binary = atob(chunk)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    total += bytes.length
    return bytes
  })
  const out = new Uint8Array(total)
  let offset = 0
  for (const buffer of buffers) { out.set(buffer, offset); offset += buffer.length }
  return out
}

export function toBase64(bytes) {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Uint8Array → dataURL */
export function toDataUrl(bytes, mime) {
  return `data:${mime};base64,${toBase64(bytes)}`
}

/** dataURL → { bytes, mime } */
export function fromDataUrl(dataUrl) {
  const match = /^data:([\w.+/-]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('无效的图片数据')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return { bytes, mime: match[1] }
}

/**
 * 流式下载二进制：远程 URL → { bytes, mime, status }。
 * 同 image-gen 的 downloadBinary 模式：reqId 未知时分片暂存，拿到后重放；done 帧重组。
 */
export function fetchBytes({ url, headers, timeoutMs = 60000, mimeHint, onProgress, signal }) {
  if (signal?.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'))
  return schedule(() => new Promise((resolve, reject) => {
    const enest = api()
    const parts = []
    let received = 0
    let settled = false
    let requestInfo = null
    const early = []
    const onEvent = event => {
      if (!requestInfo) { early.push(event); return }
      if (event.reqId !== requestInfo.reqId) return
      const { chunk, done, error } = event
      if (error) { finish(() => reject(new Error(`下载失败：${error}`))); return }
      if (chunk) {
        parts.push(chunk)
        received += chunk.length * 0.75
        if (onProgress) onProgress(received)
      }
      if (done) finish(() => resolve(decode()))
    }
    const off = enest.net.onChunk(onEvent)
    const timer = setTimeout(() => finish(() => reject(new Error('下载超时'))), timeoutMs)
    const onAbort = () => finish(() => reject(new DOMException('已取消', 'AbortError')))
    signal?.addEventListener('abort', onAbort, { once: true })
    function decode() {
      const bytes = decodeBase64Chunks(parts)
      const status = requestInfo?.status ?? 0
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`)
      const contentType = (requestInfo?.headers?.['content-type'] ?? '').split(';')[0].trim()
      const mime = mimeHint || (contentType && contentType !== 'application/octet-stream' ? contentType : 'image/png')
      return { bytes, mime, status }
    }
    function finish(settle) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      off?.()
      try { settle() } catch (err) { reject(err instanceof Error ? err : new Error(String(err))) }
    }
    enest.net.fetch({ url, headers, stream: true, timeoutMs }).then(res => {
      requestInfo = res
      const pending = early.splice(0, early.length)
      for (const event of pending) {
        if (event.reqId !== res.reqId) continue
        onEvent(event)
        if (settled) break
      }
    }).catch(err => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
  }))
}

/** 简单文本 GET（非流式，<2MB，用于小 JSON/HTML） */
export async function fetchText({ url, headers, timeoutMs = 30000 }) {
  return schedule(async () => {
    const res = await api().net.fetch({ url, headers, timeoutMs })
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
    return res.body || ''
  })
}

/** 大文本 GET（流式，<32MB）：超过非流式 2MB 预算的索引 JSON 必须走这里。 */
export async function fetchLargeText({ url, headers, timeoutMs = 60000 }) {
  const { bytes, status } = await fetchBytes({ url, headers, timeoutMs })
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`)
  return new TextDecoder('utf-8').decode(bytes)
}

/* ---------------- 图片字节 LRU（dataUrl 缓存，显示与复制复用） ---------------- */

const IMAGE_LRU_MAX = 200
const IMAGE_LRU_BYTES = 96 * 1024 * 1024
const imageCache = new Map() // url -> { dataUrl, bytes }
let imageCacheBytes = 0

export function cachedImageDataUrl(url) {
  const hit = imageCache.get(url)
  if (!hit) return null
  imageCache.delete(url)
  imageCache.set(url, hit)
  return hit.dataUrl
}

export async function loadImageBytes(url, { signal } = {}) {
  const cached = cachedImageDataUrl(url)
  if (cached) return cached
  const { bytes, mime } = await fetchBytes({ url, signal })
  const dataUrl = toDataUrl(bytes, mime)
  imageCache.set(url, { dataUrl, bytes: bytes.length })
  imageCacheBytes += bytes.length
  while (imageCache.size > IMAGE_LRU_MAX || imageCacheBytes > IMAGE_LRU_BYTES) {
    const oldest = imageCache.keys().next().value
    if (oldest === undefined) break
    imageCacheBytes -= imageCache.get(oldest).bytes
    imageCache.delete(oldest)
  }
  return dataUrl
}

/* ---------------- 剪贴板 / 存储 / 本地文件 ---------------- */

export async function copyImage(dataUrl) {
  return api().clipboard.writeImage(dataUrl)
}

export async function copyText(text) {
  return api().clipboard.writeText(text)
}

export function storage() {
  return api().storage
}

export function localFiles() {
  return api().localFiles
}
