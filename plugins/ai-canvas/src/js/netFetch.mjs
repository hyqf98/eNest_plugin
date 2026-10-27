/**
 * netFetch — AI 画布网络层：JSON 请求（vault 鉴权注入）+ 流式响应下载 + multipart 构造。
 * 宿主 net.fetch 约束：并发 8（此处自限 4）、非流式响应 2MB、流式 32MB（base64 分片经 net.chunk 推送）。
 * 密钥经 auth.secretRef 由主进程解引用注入 Authorization，页面永不明文持有。
 */

const CONCURRENCY = 4
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

/** Uint8Array → dataURL（预览/导出用） */
export function toDataUrl(bytes, mime) {
  return `data:${mime};base64,${toBase64(bytes)}`
}

/** dataURL → { bytes, mime } */
export function fromDataUrl(dataUrl) {
  const match = /^data:([\w.+/-]+);base64,(.*)$/.exec(dataUrl)
  if (!match) throw new Error('无效的图片数据')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return { bytes, mime: match[1] }
}

/**
 * JSON 请求（可携带 secretRef 鉴权）。
 * 响应按 JSON 解析；非 2xx 抛错并尽量带服务端 error.message。
 */
export async function requestJson({ url, method = 'GET', headers = {}, body, secretRef, timeoutMs = 30000 }) {
  return schedule(async () => {
    const res = await api().net.fetch({
      url, method, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(secretRef ? { auth: { secretRef } } : {}),
      timeoutMs
    })
    let parsed = null
    try { parsed = JSON.parse(res.body || 'null') } catch { /* 保持 null */ }
    if (res.status < 200 || res.status >= 300) {
      const detail = parsed?.error?.message || parsed?.message || (res.body || '').slice(0, 200)
      throw new Error(`${detail || '请求失败'}（HTTP ${res.status}）`)
    }
    return parsed
  })
}

/**
 * POST + 流式响应收集：适配大响应（gpt-image b64_json 单响应可达数十 MB）。
 * 先订阅 net.chunk 再发起请求；早到分片暂存，宿主对每块独立 base64 编码。
 * 返回 { status, json }（响应体解码为 UTF-8 文本后按 JSON 解析）。
 * timeoutMs 缺省贴着宿主 net.fetch 的 120s 上限留 2s 余量，避免被静默截断。
 */
export async function requestJsonStreamed({ url, method = 'POST', headers = {}, body, bodyBase64, secretRef, timeoutMs = 118000, onProgress }) {
  return schedule(() => new Promise((resolve, reject) => {
    const enest = api()
    const parts = []
    let settled = false
    let requestInfo = null
    const off = enest.net.onChunk(({ reqId, chunk, done, error }) => {
      if (reqId !== requestInfo?.reqId) return
      if (error) { finish(() => reject(new Error(`请求失败：${error}`))); return }
      if (chunk) {
        parts.push(chunk)
        if (onProgress) onProgress(chunk.length * 0.75)
      }
      if (done) finish(() => resolve(decode()))
    })
    const timer = setTimeout(() => finish(() => reject(new Error('请求超时'))), timeoutMs)
    function decode() {
      const bytes = decodeBase64Chunks(parts)
      const text = new TextDecoder().decode(bytes)
      const status = requestInfo?.status ?? 0
      if (status < 200 || status >= 300) {
        let detail = text.slice(0, 200)
        try { const parsed = JSON.parse(text); detail = parsed?.error?.message || parsed?.message || detail } catch { /* 非 JSON */ }
        throw new Error(`${detail || '请求失败'}（HTTP ${status}）`)
      }
      try { return { status, json: JSON.parse(text) } } catch {
        throw new Error(`响应不是 JSON（HTTP ${status}）：${text.slice(0, 160)}`)
      }
    }
    function finish(settle) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off?.()
      settle()
    }
    enest.net.fetch({
      url, method, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
      ...(secretRef ? { auth: { secretRef } } : {}),
      stream: true, timeoutMs
    }).then(res => {
      if (res.status < 200 || res.status >= 300) {
        // 错误响应体小，直接等 chunk 完成后 decode 抛错
        requestInfo = res
        return
      }
      requestInfo = res
    }).catch(err => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
  }))
}

/** 流式下载二进制（远程图片 URL → Uint8Array） */
export async function downloadBinary(url, { timeoutMs = 120000 } = {}) {
  return schedule(() => new Promise((resolve, reject) => {
    const enest = api()
    const parts = []
    let settled = false
    let requestInfo = null
    const off = enest.net.onChunk(({ reqId, chunk, done, error }) => {
      if (reqId !== requestInfo?.reqId) return
      if (error) { finish(() => reject(new Error(`下载失败：${error}`))); return }
      if (chunk) parts.push(chunk)
      if (done) finish(() => resolve(decodeBase64Chunks(parts)))
    })
    const timer = setTimeout(() => finish(() => reject(new Error('下载超时'))), timeoutMs)
    function finish(settle) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off?.()
      settle()
    }
    enest.net.fetch({ url, method: 'GET', stream: true, timeoutMs }).then(res => {
      if (res.status < 200 || res.status >= 300) {
        finish(() => reject(new Error(`下载失败（HTTP ${res.status}）`)))
        return
      }
      requestInfo = res
    }).catch(err => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
  }))
}

/** 手工构造 multipart/form-data 二进制体（图片编辑上传） */
export function buildMultipart(fields, files) {
  const boundary = `----eNestAiCanvas${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const encoder = new TextEncoder()
  const chunks = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  for (const file of files) {
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`))
    chunks.push(file.bytes)
    chunks.push(encoder.encode('\r\n'))
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`))
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return { bytes: out, contentType: `multipart/form-data; boundary=${boundary}` }
}
