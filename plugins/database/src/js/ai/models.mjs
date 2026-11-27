/**
 * models.mjs — AI 供应商配置 CRUD + OpenAI 兼容 LLM 客户端
 * 供应商列表：KV db.ai.providers.v1 = [{ id, name, baseUrl, model, secretRef, isDefault }]
 * 密钥只经 vault（键 db.ai.provider.<id>），页面永不持有明文；net.fetch 的
 * auth.secretRef 由主进程解引用注入 Authorization 头。
 * chat()：先订阅 enest.net.onChunk 再 stream fetch；SSE 按 data: 行解析，
 * delta.content 增量回调 onDelta，delta.tool_calls 按 index 累积分片；
 * 网关不支持流式（非 text/event-stream 或直接整包）时自动非流式重试一次。
 */

import { Vault, storageGet, storageSet } from '../api.js'

const PROVIDERS_KEY = 'db.ai.providers.v1'
const vaultKeyOf = (id) => `db.ai.provider.${id}`

/**
 * 思考程度档位（对齐 deepseek-harness 的 ModelReasoningEffort 语义）。
 * `id` 直接进请求体 reasoning_effort；`default` 表示不传该字段、由网关取默认。
 * 不同网关对档位的接受范围不同，未知值会被忽略而非报错，故保留原始 id 透传。
 */
export const REASONING_EFFORTS = [
  { id: undefined, name: '默认', hint: '由模型决定' },
  { id: 'low', name: '低', hint: '更快，适合简单查询' },
  { id: 'medium', name: '中', hint: '平衡速度与质量' },
  { id: 'high', name: '高', hint: '更慢，适合复杂分析' }
]

export function effortName(id) {
  return REASONING_EFFORTS.find((item) => item.id === id)?.name || '默认'
}

function uid() {
  return `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 补协议头与 /v1：host 形式视为 https://host/v1，已有协议但无路径时补 /v1 */
export function normalizeBaseUrl(input) {
  let url = String(input || '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  url = url.replace(/\/+$/, '')
  try {
    const parsed = new URL(url)
    if (!/\/v\d+$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname === '/' ? '/v1' : `${parsed.pathname}/v1`
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function sanitize(p) {
  return {
    id: String(p?.id || uid()),
    name: String(p?.name || '').trim(),
    baseUrl: String(p?.baseUrl || ''),
    model: String(p?.model || '').trim(),
    secretRef: p?.secretRef ? String(p.secretRef) : '',
    isDefault: p?.isDefault === true,
    // 该供应商支持的思考程度档位；空数组表示不展示思考程度（网关不支持）。
    reasoningEfforts: Array.isArray(p?.reasoningEfforts)
      ? p.reasoningEfforts.filter((id) => REASONING_EFFORTS.some((item) => item.id === id))
      : []
  }
}

/* ── 供应商 CRUD（内存缓存 + KV 持久化）── */

let providersCache = null

export async function listProviders() {
  if (!providersCache) {
    const stored = await storageGet(PROVIDERS_KEY, [])
    providersCache = Array.isArray(stored) ? stored.map(sanitize) : []
  }
  return providersCache.map((p) => ({ ...p }))
}

export function defaultProvider(list) {
  return list.find((p) => p.isDefault) || list[0] || null
}

/**
 * 新建/更新供应商。secret 非空时写入 vault（键 db.ai.provider.<id>），
 * 返回的配置只含 secretRef。isDefault 唯一化。
 */
export async function saveProvider(input) {
  const list = await listProviders()
  const exists = input.id ? list.find((p) => p.id === input.id) : null
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  if (!String(input.name || '').trim()) throw new Error('请填写供应商名称')
  if (!baseUrl) throw new Error('服务地址格式不正确')
  if (!String(input.model || '').trim()) throw new Error('请填写模型名称')
  const next = sanitize({
    ...exists,
    ...input,
    id: exists?.id || uid(),
    baseUrl,
    secretRef: exists?.secretRef || ''
  })
  if (input.secret) {
    const result = await Vault.set(vaultKeyOf(next.id), String(input.secret))
    next.secretRef = result?.secretRef || result || vaultKeyOf(next.id)
  }
  // isDefault 唯一化：显式 false 不设默认；首个供应商自动成为默认
  const wantsDefault = input.isDefault !== undefined ? input.isDefault === true : !list.some((p) => p.isDefault)
  next.isDefault = wantsDefault || (exists?.isDefault && input.isDefault === undefined)
  if (next.isDefault) for (const p of list) p.isDefault = p.id === next.id
  const idx = list.findIndex((p) => p.id === next.id)
  if (idx >= 0) list[idx] = next
  else list.unshift(next)
  await storageSet(PROVIDERS_KEY, list)
  providersCache = list
  return { ...next }
}

export async function removeProvider(id) {
  const list = await listProviders()
  const target = list.find((p) => p.id === id)
  if (!target) return false
  if (target.secretRef) await Vault.remove(target.secretRef).catch(() => { /* 宿主滞后时凭据保留，无碍 */ })
  const next = list.filter((p) => p.id !== id)
  if (target.isDefault && next.length) next[0].isDefault = true
  await storageSet(PROVIDERS_KEY, next)
  providersCache = next
  return true
}

export async function setDefaultProvider(id) {
  const list = await listProviders()
  if (!list.some((p) => p.id === id)) throw new Error('供应商不存在')
  for (const p of list) p.isDefault = p.id === id
  await storageSet(PROVIDERS_KEY, list)
  providersCache = list
  return list.map((p) => ({ ...p }))
}

/** GET {base}/models 拉取可选模型（无凭据供应商也可用） */
export async function fetchModels(provider) {
  const host = window.enest || window.zapi
  if (!host?.net?.fetch) throw new Error('宿主网络接口不可用')
  const base = normalizeBaseUrl(provider?.baseUrl)
  if (!base) throw new Error('服务地址无效')
  const res = await host.net.fetch({
    url: `${base}/models`,
    method: 'GET',
    timeoutMs: 20000,
    ...(provider?.secretRef ? { auth: { secretRef: provider.secretRef } } : {})
  })
  let parsed = null
  try { parsed = JSON.parse(res.body || 'null') } catch { parsed = null }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(parsed?.error?.message || `获取模型列表失败（HTTP ${res.status}）`)
  }
  const models = Array.isArray(parsed?.data) ? parsed.data.map((m) => m?.id).filter(Boolean) : []
  return models
}

/* ── LLM 客户端 ── */

function netApi() {
  const host = window.enest || window.zapi
  if (!host?.net?.fetch) throw new Error('宿主网络接口不可用（需要 net.fetch 权限）')
  return host
}

function errorMessageFrom(status, text) {
  let detail = ''
  try {
    const parsed = JSON.parse(text || 'null')
    detail = parsed?.error?.message || parsed?.message || ''
  } catch { detail = '' }
  return `${detail || (text || '').slice(0, 160) || '请求失败'}（HTTP ${status}）`
}

/** OpenAI tools 参数（TOOL_DEFS -> { tools: [{ type:'function', function }] }） */
export function toolsPayload(toolDefs) {
  if (!toolDefs?.length) return undefined
  return { tools: toolDefs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
}

/** 累积 delta.tool_calls 分片：[{ id, name, arguments }] -> [{ id, name, args }] */
function assembleToolCalls(rawCalls) {
  const byIndex = new Map()
  for (const part of rawCalls) {
    if (!part || typeof part !== 'object') continue
    const idx = Number.isInteger(part.index) ? part.index : 0
    if (!byIndex.has(idx)) byIndex.set(idx, { id: '', name: '', arguments: '' })
    const slot = byIndex.get(idx)
    if (part.id) slot.id = part.id
    if (part.function?.name) slot.name = part.function.name
    if (part.function?.arguments) slot.arguments += part.function.arguments
  }
  const out = []
  for (const [, slot] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    let args = null
    if (slot.arguments) {
      try { args = JSON.parse(slot.arguments) } catch { args = null }
    }
    out.push({ id: slot.id || `call_${idxSafe()}`, name: slot.name, args })
  }
  return out
}

let callSeq = 0
function idxSafe() { return `${Date.now().toString(36)}${(callSeq++).toString(36)}` }

/** 非流式补齐：部分网关忽略 stream，直接整包返回 JSON */
async function chatOnce({ provider, messages, tools, signal, stream, reasoningEffort }) {
  const host = netApi()
  const base = normalizeBaseUrl(provider.baseUrl)
  if (!base) throw new Error('服务地址无效')
  const body = {
    model: provider.model,
    messages,
    ...(tools ? { tools, tool_choice: 'auto' } : {}),
    // 仅当用户显式选了档位且该供应商声明支持时才带上；未选则交给网关默认。
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
  }
  if (!stream) {
    const res = await host.net.fetch({
      url: `${base}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 120000,
      ...(provider.secretRef ? { auth: { secretRef: provider.secretRef } } : {})
    })
    if (res.status < 200 || res.status >= 300) throw new Error(errorMessageFrom(res.status, res.body))
    let parsed = null
    try { parsed = JSON.parse(res.body || 'null') } catch { throw new Error(`响应不是 JSON（HTTP ${res.status}）`) }
    return { parsed, wasStream: false, contentType: '' }
  }

  // 流式：先订阅 onChunk 再 fetch（早到分片暂存）
  return new Promise((resolve, reject) => {
    const parts = []
    let settled = false
    let requestInfo = null
    const off = host.net.onChunk(({ reqId, chunk, done, error }) => {
      if (reqId !== requestInfo?.reqId) return
      if (error) { finish(() => reject(new Error(`请求失败：${error}`))); return }
      if (chunk) parts.push(chunk)
      if (done) finish(() => resolve(decode()))
    })
    const onAbort = () => finish(() => reject(abortError()))
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const timer = setTimeout(() => finish(() => reject(new Error('请求超时'))), 120000)
    function decode() {
      const bytes = decodeBase64Chunks(parts)
      const text = new TextDecoder().decode(bytes)
      const status = requestInfo?.status ?? 0
      if (status < 200 || status >= 300) throw new Error(errorMessageFrom(status, text))
      // 网关可能忽略 stream 参数整包返回 JSON
      if (!/text\/event-stream/i.test(requestInfo?.headers?.['content-type'] || '') && text.trimStart().startsWith('{')) {
        try { return { parsed: JSON.parse(text), wasStream: false, contentType: requestInfo?.headers?.['content-type'] || '' } } catch { /* 走 SSE 解析 */ }
      }
      return { text, wasStream: true, contentType: requestInfo?.headers?.['content-type'] || '' }
    }
    function finish(settle) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off?.()
      signal?.removeEventListener?.('abort', onAbort)
      settle()
    }
    host.net.fetch({
      url: `${base}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true }),
      stream: true,
      timeoutMs: 120000,
      ...(provider.secretRef ? { auth: { secretRef: provider.secretRef } } : {})
    }).then((res) => {
      requestInfo = res
      if (res.status < 200 || res.status >= 300) requestInfo = { ...res, headers: res.headers || {} }
    }).catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
  })
}

function abortError() {
  const e = new Error('已停止')
  e.name = 'AbortError'
  return e
}

function decodeBase64Chunks(chunks) {
  let total = 0
  const buffers = chunks.map((chunk) => {
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

/** 解析 SSE 文本为 data 载荷序列（跳过注释/空行/[DONE] 由调用方判定） */
function* sseLines(text) {
  const events = text.split(/\r?\n\r?\n/)
  for (const event of events) {
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
}

/**
 * 流式对话入口。
 * @param reasoningEffort 思考程度档位（'low'|'medium'|'high'）；空表示不传、由网关决定。
 * @returns {Promise<{ content: string, reasoning: string, toolCalls: [{ id, name, args }] }>}
 * onDelta(chunk) 在 delta.content 到达时回调；onReasoning(chunk) 在
 * delta.reasoning_content 到达时回调（思维链，与正文分开呈现）。
 * 取消经 signal（AbortError 抛出）。网关不支持 stream 时自动用非流式重试一次。
 */
export async function chat({ provider, messages, toolDefs, onDelta, onReasoning, signal, reasoningEffort }) {
  if (!provider?.baseUrl || !provider?.model) throw new Error('请先在设置中配置 AI 模型供应商')
  const tools = toolsPayload(toolDefs)
  // 供应商未声明支持思考程度时，忽略传入的档位，避免向不支持的网关塞未知字段。
  const effort = provider.reasoningEfforts?.includes(reasoningEffort) ? reasoningEffort : undefined
  let result
  try {
    result = await chatOnce({ provider, messages, tools, signal, stream: true, reasoningEffort: effort })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    result = { parsed: null }
  }

  // 非流式整包：直接解析（含首次流式失败后的非流式重试）
  if (result?.parsed) {
    const choice = result.parsed?.choices?.[0]?.message || {}
    const content = String(choice.content || '')
    const reasoning = String(choice.reasoning_content || '')
    if (onReasoning && reasoning) onReasoning(reasoning)
    if (onDelta && content) onDelta(content)
    const toolCalls = Array.isArray(choice.tool_calls)
      ? assembleToolCalls(choice.tool_calls.map((c) => ({ ...c, index: c.index ?? 0, function: { name: c.function?.name, arguments: c.function?.arguments } })))
      : []
    return { content, reasoning, toolCalls }
  }

  // SSE 增量
  const text = result?.text ?? ''
  const rawCalls = []
  let content = ''
  let reasoning = ''
  let sawDone = false
  let sawEvent = false
  for (const data of sseLines(text)) {
    if (data === '[DONE]') { sawDone = true; break }
    if (!data) continue
    let payload = null
    try { payload = JSON.parse(data) } catch { continue }
    sawEvent = true
    const delta = payload?.choices?.[0]?.delta
    if (!delta) continue
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content
      onReasoning?.(delta.reasoning_content)
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      onDelta?.(delta.content)
    }
    if (Array.isArray(delta.tool_calls)) rawCalls.push(...delta.tool_calls)
  }
  if (!sawEvent && !sawDone) {
    // 疑似不支持流式：非流式重试一次
    const fallback = await chatOnce({ provider, messages, tools, signal, stream: false, reasoningEffort: effort })
    const choice = fallback.parsed?.choices?.[0]?.message || {}
    const content2 = String(choice.content || '')
    const reasoning2 = String(choice.reasoning_content || '')
    if (onReasoning && reasoning2) onReasoning(reasoning2)
    if (onDelta && content2) onDelta(content2)
    const toolCalls = Array.isArray(choice.tool_calls)
      ? assembleToolCalls(choice.tool_calls.map((c) => ({ ...c, index: c.index ?? 0, function: { name: c.function?.name, arguments: c.function?.arguments } })))
      : []
    return { content: content2, reasoning: reasoning2, toolCalls }
  }
  return { content, reasoning, toolCalls: rawCalls.length ? assembleToolCalls(rawCalls) : [] }
}

export const PROVIDERS_STORAGE_KEY = PROVIDERS_KEY
