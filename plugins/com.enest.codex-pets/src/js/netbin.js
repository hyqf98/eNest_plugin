/**
 * netbin — 插件网络层：JSON 请求 + 流式二进制下载 + blob LRU 缓存。
 * 宿主 net.fetch 约束：仅 https、并发 8（此处自限 4）、非流式 2MB 纯文本、
 * 流式（stream:true）经 net.chunk 推 base64 分片（32MB 上限）。
 * 插件页面 CSP 禁止外链，所有远程图片必须经此层转 blob: URL。
 */

const CONCURRENCY = 4

/** 在途请求队列（并发 ≤ CONCURRENCY） */
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
    task().then(resolve, reject).finally(() => {
      active -= 1
      pump()
    })
  }
}

export function api() {
  const enest = window.enest || window.zapi
  if (!enest?.net?.fetch) throw new Error('宿主网络接口不可用')
  return enest
}

/** JSON GET（自动拼 API_BASE，非 2xx 抛错带状态）；预览夹具环境走隔离演示数据 */
export async function getJson(path) {
  if (isPreviewFixture()) {
    const { demoListPets, demoGetPet } = await import('./demo.js')
    if (path.startsWith('/api/pets/')) {
      const id = decodeURIComponent(path.slice('/api/pets/'.length).split('?')[0])
      return { pet: demoGetPet(id) }
    }
    if (path.startsWith('/api/pets')) {
      const params = new URLSearchParams(path.split('?')[1] ?? '')
      return demoListPets({
        query: params.get('q') ?? '',
        tags: params.getAll('tag'),
        sort: params.get('sort') ?? 'new',
        page: Number(params.get('page')) || 1
      })
    }
    return {}
  }
  const url = path.startsWith('http') ? path : `https://codex-pets.net${path}`
  return schedule(async () => {
    const res = await api().net.fetch({ url, method: 'GET', timeoutMs: 20000 })
    let body = null
    try {
      body = JSON.parse(res.body)
    } catch {
      throw new Error(`接口响应不是 JSON（HTTP ${res.status}）`)
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(body?.error ? `${body.error}（HTTP ${res.status}）` : `请求失败（HTTP ${res.status}）`)
    }
    return body
  })
}

/** 截图 / 预览夹具环境（scripts/preview-fixture.mjs 注入 window.__preview） */
function isPreviewFixture() {
  return typeof window !== 'undefined' && window.__preview !== undefined
}

/**
 * 流式二进制下载 → Uint8Array。
 * stream:true 立即返回元信息，base64 分片经 net.chunk 事件推送。
 * 注意：宿主对每个网络块独立 base64 编码（块边界任意、中间块可含 padding），
 * 必须逐片解码为字节再拼接，不能把 base64 字符串 join 后整体 atob。
 */
export async function downloadBinary(url, { timeoutMs = 120000, onProgress } = {}) {
  return schedule(() => new Promise((resolve, reject) => {
    const enest = api()
    const parts = []
    let settled = false
    const off = enest.net.onChunk(({ reqId, chunk, done, error }) => {
      if (reqId !== requestInfo?.reqId) return
      if (error) {
        finish(() => reject(new Error(`下载失败：${error}`)))
        return
      }
      if (chunk) {
        parts.push(chunk)
        if (onProgress) onProgress(chunk.length * 0.75)
      }
      if (done) {
        finish(() => resolve(decodeBase64Chunks(parts)))
      }
    })
    let requestInfo = null
    const timer = setTimeout(() => finish(() => reject(new Error('下载超时'))), timeoutMs)
    function finish(settle) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off?.()
      settle()
    }
    enest.net.fetch({ url, method: 'GET', stream: true, timeoutMs })
      .then(res => {
        if (res.status < 200 || res.status >= 300) {
          finish(() => reject(new Error(`下载失败（HTTP ${res.status}）`)))
          return
        }
        requestInfo = res
      })
      .catch(err => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
  }))
}

/** 逐片 base64 → 字节拼接（片边界任意对齐均正确） */
export function decodeBase64Chunks(chunks) {
  try {
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
    for (const buffer of buffers) {
      out.set(buffer, offset)
      offset += buffer.length
    }
    return out
  } catch (err) {
    throw new Error(`下载数据解码失败：${err.message}`)
  }
}

/** blob LRU：poster 全缓存上限 240、spritesheet 上限 8（对齐原站 hover 才拉全图的行为） */
const blobCache = new Map()
const blobLimits = { poster: 240, spritesheet: 12 }

export function cacheKey(kind, url) {
  return `${kind}:${url}`
}

/** 经缓存的远程图片下载 → blob URL（命中直接返回；data:/demo: URL 直接透传） */
export async function fetchImageBlob(kind, url) {
  if (url.startsWith('data:')) return url
  if (url.startsWith('demo://')) {
    const { demoImageFor } = await import('./demo.js')
    return demoImageFor(url)
  }
  const key = cacheKey(kind, url)
  if (blobCache.has(key)) {
    const hit = blobCache.get(key)
    blobCache.delete(key)
    blobCache.set(key, hit)
    return hit
  }
  const data = await downloadBinary(url)
  const blobUrl = URL.createObjectURL(new Blob([data], { type: 'image/webp' }))
  blobCache.set(key, blobUrl)
  const limit = blobLimits[kind] ?? 60
  while (blobCache.size > limit) {
    const oldest = blobCache.keys().next().value
    const oldestUrl = blobCache.get(oldest)
    blobCache.delete(oldest)
    if (oldestUrl) URL.revokeObjectURL(oldestUrl)
  }
  return blobUrl
}

/** Uint8Array → dataURL（安装校验 / 导出用） */
export function toDataUrl(bytes, mime = 'application/octet-stream') {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/** Uint8Array → base64（agent.writeAssets 载荷用） */
export function toBase64(bytes) {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
