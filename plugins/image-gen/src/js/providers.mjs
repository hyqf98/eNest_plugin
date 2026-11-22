/**
 * providers — 渠道配置 + 三协议注册表。
 * images：POST /images/generations + /images/edits（OpenAI Images 协议族，含 one-api 等中转）。
 * chat：POST /chat/completions 多模态出图（content 数组带 image_url，响应取 markdown 图或 data:）。
 * responses：POST /responses 携带 image_generation 工具（output 取 image_generation_call.result b64）。
 * 渠道存插件私有 KV；密钥经 vault.set 存 secretRef，请求时交主进程解引用注入。
 */

import { requestJson, requestJsonStreamed, downloadBinary, buildMultipart, toBase64 } from './netFetch.mjs'

const PROVIDERS_KEY = 'image-gen.providers.v1'

export const API_KIND = { IMAGES: 'images', CHAT: 'chat', RESPONSES: 'responses' }
export const API_KINDS = [API_KIND.IMAGES, API_KIND.CHAT, API_KIND.RESPONSES]

export function normalizeBaseUrl(input) {
  let url = String(input ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  // 用户填到根或 /v1 均可：末段不是 /v\d 时自动补 /v1（拼接协议路径的统一前提）
  if (!/\/v\d+$/.test(url)) url += '/v1'
  return url
}

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

export const DEFAULT_PROVIDERS = [
  { id: 'default', name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', apiKind: API_KIND.IMAGES, secretRef: '', isDefault: true }
]

export async function loadProviders() {
  try {
    const saved = await store().storage.get(PROVIDERS_KEY)
    if (Array.isArray(saved) && saved.length) {
      // 旧记录无 apiKind：按 images 迁移（images 是首个协议）
      return saved.map(p => ({ ...p, apiKind: API_KINDS.includes(p.apiKind) ? p.apiKind : API_KIND.IMAGES }))
    }
  } catch { /* 首次 */ }
  return DEFAULT_PROVIDERS
}

export async function saveProviders(list) {
  await store().storage.set(PROVIDERS_KEY, list)
  return list
}

/** 保存/更新渠道：apiKey 非空时写入 vault 并仅保留 secretRef */
export async function upsertProvider(provider, apiKey) {
  const list = await loadProviders()
  const record = { ...provider, apiKind: API_KINDS.includes(provider.apiKind) ? provider.apiKind : API_KIND.IMAGES, baseUrl: normalizeBaseUrl(provider.baseUrl) }
  if (apiKey && apiKey.trim()) {
    const enest = store()
    const vaultKey = `image-gen.provider.${record.id}`
    const res = await enest.vault.set(vaultKey, apiKey.trim())
    record.secretRef = res?.secretRef ?? vaultKey
  }
  const index = list.findIndex(p => p.id === record.id)
  if (index >= 0) list[index] = { ...list[index], ...record }
  else list.push(record)
  // 全表唯一默认：新记录 isDefault 时取消其他默认
  if (record.isDefault) {
    for (const p of list) if (p.id !== record.id) delete p.isDefault
  }
  await saveProviders(list)
  return record
}

export async function removeProvider(id) {
  const list = await loadProviders()
  const target = list.find(p => p.id === id)
  if (target?.secretRef) {
    try { await store().vault.remove(`image-gen.provider.${id}`) } catch { /* 已不存在 */ }
  }
  const next = list.filter(p => p.id !== id)
  if (target?.isDefault && next.length) next[0].isDefault = true
  await saveProviders(next)
  return next
}

/** 默认渠道：标记 isDefault 的第一条，否则首条 */
export function getDefaultProvider(list) {
  const providers = list ?? []
  return providers.find(p => p.isDefault) ?? providers[0] ?? null
}

/* —— 协议注册表 ——
 * 协议 = { id, apiKind, test, listModels, generate, edit }
 * generate/edit 返回 { images: [{bytes, mime}], usage, revised }
 */

/** 从 OpenAI Images 响应提取图片字节数组（b64_json 或 url 两种载体） */
async function extractImages(json, onProgress, signal) {
  const data = Array.isArray(json?.data) ? json.data : []
  const images = []
  for (const item of data) {
    if (item?.b64_json) {
      const binary = atob(item.b64_json)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      images.push(bytes)
    } else if (item?.url) {
      images.push(await downloadBinary(item.url, { signal }))
    }
    if (onProgress) onProgress()
  }
  if (!images.length) throw new Error('响应中没有图片数据')
  return images
}

function guessMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  return 'image/png'
}

function finishImages(bytesList, { usage = null, revised = null } = {}) {
  return { images: bytesList.map(bytes => ({ bytes, mime: guessMime(bytes) })), usage, revised }
}

/** GET {base}/models 拉模型列表，返回字符串数组 */
async function listModelsViaModelsEndpoint(provider) {
  const json = await requestJson({
    url: `${provider.baseUrl}/models`,
    secretRef: provider.secretRef || undefined,
    timeoutMs: 20000
  })
  const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : [])
  return list.map(m => String(m?.id ?? '')).filter(Boolean)
}

/** 图片模型启发式：id 含这些关键词按图片模型展示（忽略大小写） */
const IMAGE_MODEL_HINT = /(image|dall|banana|seedream|flux|sd|mj|cogview|gpt-image|iragi)/i

export function isLikelyImageModel(id) {
  return IMAGE_MODEL_HINT.test(String(id ?? ''))
}

export const imagesProtocol = {
  id: 'openai-images',
  apiKind: API_KIND.IMAGES,
  label: 'Images 协议',
  /** 连接测试：GET {base}/models，返回模型数（tooltip 用） */
  async test(provider) {
    const models = await listModelsViaModelsEndpoint(provider)
    return { modelCount: models.length }
  },
  listModels: listModelsViaModelsEndpoint,
  /** 文生图：POST /images/generations（流式收 b64） */
  async generate(provider, { prompt, size, quality, n, onProgress, signal }) {
    const payload = { model: provider.model, prompt }
    if (size && size !== 'auto') payload.size = size
    if (quality && quality !== 'auto') payload.quality = quality
    payload.n = Math.max(1, Math.min(4, Number(n) || 1))
    const { json } = await requestJsonStreamed({
      url: `${provider.baseUrl}/images/generations`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      secretRef: provider.secretRef || undefined,
      onProgress,
      signal
    })
    const images = await extractImages(json, onProgress, signal)
    return finishImages(images, {
      usage: json?.usage ?? null,
      revised: typeof json?.data?.[0]?.revised_prompt === 'string' ? json.data[0].revised_prompt : null
    })
  },
  /** 图生图/编辑：POST /images/edits（multipart，可多图 + 可选 mask） */
  async edit(provider, { prompt, images, mask, size, quality, onProgress, signal }) {
    const files = images.map((img, i) => ({ name: 'image[]', filename: `input-${i}.${(img.mime.split('/')[1] || 'png')}`, mime: img.mime, bytes: img.bytes }))
    if (mask) files.push({ name: 'mask', filename: `mask.${(mask.mime.split('/')[1] || 'png')}`, mime: mask.mime, bytes: mask.bytes })
    const fields = { model: provider.model, prompt }
    if (size && size !== 'auto') fields.size = size
    if (quality && quality !== 'auto') fields.quality = quality
    const { bytes, contentType } = buildMultipart(fields, files)
    const { json } = await requestJsonStreamed({
      url: `${provider.baseUrl}/images/edits`,
      method: 'POST',
      headers: { 'content-type': contentType },
      bodyBase64: toBase64(bytes),
      secretRef: provider.secretRef || undefined,
      onProgress,
      signal
    })
    const result = await extractImages(json, onProgress, signal)
    return finishImages(result, { usage: json?.usage ?? null })
  }
}

/* —— chat 协议：多模态 /chat/completions 出图 —— */
async function imagesFromChatContent(content, onProgress) {
  const urls = []
  if (Array.isArray(content)) {
    for (const part of content) {
      const url = part?.image_url?.url ?? part?.image_url ?? (part?.type === 'image_url' ? part?.url : null)
      if (typeof url === 'string' && url) urls.push(url)
    }
  } else if (typeof content === 'string') {
    // markdown 图片 ![..](url) 与裸 data: URI
    for (const m of content.matchAll(/!\[[^\]]*\]\((\s*<)?([^)\s>]+)/g)) urls.push(m[2])
    for (const m of content.matchAll(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g)) urls.push(m[0])
  }
  const bytesList = []
  for (const url of urls) {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      if (comma < 0) continue
      const binary = atob(url.slice(comma + 1))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      bytesList.push(bytes)
    } else if (/^https?:/i.test(url)) {
      bytesList.push(await downloadBinary(url))
    }
    if (onProgress) onProgress()
  }
  return bytesList
}

export const chatProtocol = {
  id: 'openai-chat',
  apiKind: API_KIND.CHAT,
  label: 'Chat 协议',
  async test(provider) {
    const models = await listModelsViaModelsEndpoint(provider)
    return { modelCount: models.length }
  },
  listModels: listModelsViaModelsEndpoint,
  /** 文生图：messages 只带文本，提示词后缀翻译尺寸 */
  async generate(provider, { prompt, size, n, onProgress, signal }) {
    const payload = {
      model: provider.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false
    }
    const { json } = await requestJsonStreamed({
      url: `${provider.baseUrl}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      secretRef: provider.secretRef || undefined,
      onProgress,
      signal
    })
    const message = json?.choices?.[0]?.message
    const images = await imagesFromChatContent(message?.content, onProgress)
    if (!images.length) throw new Error('模型未返回图片，请确认该模型支持图像生成')
    return finishImages(images.slice(0, Math.max(1, Number(n) || 1)), {
      usage: json?.usage ?? null,
      revised: null
    })
  },
  /** 图生图：content 数组混排 text 与 image_url（dataUri） */
  async edit(provider, { prompt, images, onProgress, signal }) {
    const content = [{ type: 'text', text: prompt }]
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: img.dataUrl } })
    }
    const payload = {
      model: provider.model,
      messages: [{ role: 'user', content }],
      stream: false
    }
    const { json } = await requestJsonStreamed({
      url: `${provider.baseUrl}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      secretRef: provider.secretRef || undefined,
      onProgress,
      signal
    })
    const message = json?.choices?.[0]?.message
    const result = await imagesFromChatContent(message?.content, onProgress)
    if (!result.length) throw new Error('模型未返回图片，请确认该模型支持图像生成')
    return finishImages(result, { usage: json?.usage ?? null })
  }
}

/* —— responses 协议：/responses + image_generation 工具 —— */

/** responses 响应 output[]：取 image_generation_call 的 result（b64）与 output_text */
async function parseResponsesOutput(json, onProgress) {
  const output = Array.isArray(json?.output) ? json.output : []
  const bytesList = []
  for (const item of output) {
    if (typeof item?.type === 'string' && item.type.includes('image_generation_call') && item.result) {
      const binary = atob(item.result)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      bytesList.push(bytes)
    }
    if (onProgress) onProgress()
  }
  const revised = output.map(o => (typeof o?.type === 'string' && o.type.includes('image_generation_call') ? o?.revised_prompt ?? null : null))
    .find(Boolean) ?? null
  return { bytesList, revised }
}

export const responsesProtocol = {
  id: 'openai-responses',
  apiKind: API_KIND.RESPONSES,
  label: 'Responses 协议',
  async test(provider) {
    const models = await listModelsViaModelsEndpoint(provider)
    return { modelCount: models.length }
  },
  listModels: listModelsViaModelsEndpoint,
  /** 文生图：input 数组 + image_generation 工具 */
  async generate(provider, { prompt, size, quality, n, onProgress, signal }) {
    const tool = { type: 'image_generation' }
    if (size && size !== 'auto') tool.size = size
    if (quality && quality !== 'auto') tool.quality = quality
    const payload = {
      model: provider.model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      tools: [tool]
    }
    const { json } = await requestJsonStreamed({
      url: `${provider.baseUrl}/responses`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      secretRef: provider.secretRef || undefined,
      onProgress,
      signal
    })
    const { bytesList, revised } = await parseResponsesOutput(json, onProgress)
    if (!bytesList.length) throw new Error('响应中没有 image_generation 结果')
    return finishImages(bytesList, { usage: json?.usage ?? null, revised })
  },
  /** 图生图：input 数组混排 input_text 与 input_image（dataUri 或 https） */
  async edit(provider, { prompt, images, size, quality, onProgress, signal }) {
    const tool = { type: 'image_generation' }
    if (size && size !== 'auto') tool.size = size
    if (quality && quality !== 'auto') tool.quality = quality
    const content = [{ type: 'input_text', text: prompt }]
    for (const img of images) content.push({ type: 'input_image', image_url: img.dataUrl })
    const payload = {
      model: provider.model,
      input: [{ role: 'user', content }],
      tools: [tool]
    }
    const { json } = await requestJsonStreamed({
      url: `${provider.baseUrl}/responses`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      secretRef: provider.secretRef || undefined,
      onProgress,
      signal
    })
    const { bytesList } = await parseResponsesOutput(json, onProgress)
    if (!bytesList.length) throw new Error('响应中没有 image_generation 结果')
    return finishImages(bytesList, { usage: json?.usage ?? null })
  }
}

/** 协议注册表：按渠道 apiKind 分发，找不到即抛错，不静默回退 */
const PROTOCOLS = new Map()
export function registerProtocol(protocol) { PROTOCOLS.set(protocol.apiKind, protocol) }
export function getProtocol(apiKind) {
  const found = PROTOCOLS.get(apiKind)
  if (!found) throw new Error(`未注册的协议：${apiKind}`)
  return found
}
registerProtocol(imagesProtocol)
registerProtocol(chatProtocol)
registerProtocol(responsesProtocol)
