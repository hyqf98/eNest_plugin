/**
 * providers — Provider 配置 + 协议注册表。
 * 首期实现 OpenAI 协议族：images（/v1/images/generations + /v1/images/edits）
 * 与 chat（/v1/chat/completions），覆盖官方与 one-api / new-api 等中转站。
 * Provider 带 kind（'images' | 'chat'），旧记录缺 kind 按 images 迁移。
 * 配置存插件私有 KV；密钥经 vault.set 存 secretRef，请求时交主进程解引用注入。
 */

import { requestJson, requestJsonStreamed, downloadBinary, buildMultipart, toBase64 } from './netFetch.mjs'

const PROVIDERS_KEY = 'ai-canvas.providers.v1'

export const PROVIDER_KIND = { IMAGES: 'images', CHAT: 'chat' }

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

export function normalizeBaseUrl(input) {
  let url = String(input ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  // 用户填到根或 /v1 均可：末段不是 /v\d 时自动补 /v1（拼接协议路径的统一前提）
  if (!/\/v\d+$/.test(url)) url += '/v1'
  return url
}

export const DEFAULT_PROVIDERS = [
  { id: 'default', name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', kind: PROVIDER_KIND.IMAGES, secretRef: '', isDefault: true }
]

export async function loadProviders() {
  try {
    const saved = await store().storage.get(PROVIDERS_KEY)
    if (Array.isArray(saved) && saved.length) {
      // 旧记录无 kind：按 images 迁移（openai-images 是首个协议）
      return saved.map(p => ({ ...p, kind: p.kind ?? PROVIDER_KIND.IMAGES }))
    }
  } catch { /* 首次 */ }
  return DEFAULT_PROVIDERS
}

export async function saveProviders(list) {
  await store().storage.set(PROVIDERS_KEY, list)
  return list
}

/** 保存/更新供应商：apiKey 非空时写入 vault 并仅保留 secretRef */
export async function upsertProvider(provider, apiKey) {
  const list = await loadProviders()
  const record = { ...provider, kind: provider.kind ?? PROVIDER_KIND.IMAGES, baseUrl: normalizeBaseUrl(provider.baseUrl) }
  if (apiKey && apiKey.trim()) {
    const enest = store()
    const vaultKey = `ai-canvas.provider.${record.id}`
    const res = await enest.vault.set(vaultKey, apiKey.trim())
    record.secretRef = res?.secretRef ?? vaultKey
  }
  const index = list.findIndex(p => p.id === record.id)
  if (index >= 0) list[index] = { ...list[index], ...record }
  else list.push(record)
  // 同 kind 唯一默认：新记录 isDefault 时取消同 kind 其他默认
  if (record.isDefault) {
    for (const p of list) if (p.id !== record.id && p.kind === record.kind) delete p.isDefault
  }
  await saveProviders(list)
  return record
}

export async function removeProvider(id) {
  const list = await loadProviders()
  const target = list.find(p => p.id === id)
  if (target?.secretRef) {
    try { await store().vault.remove(`ai-canvas.provider.${id}`) } catch { /* 已不存在 */ }
  }
  const next = list.filter(p => p.id !== id)
  if (target?.isDefault) {
    const fallback = next.find(p => p.kind === target.kind)
    if (fallback) fallback.isDefault = true
  }
  await saveProviders(next)
  return next
}

/** 按 kind 取默认供应商（缺省 images） */
export async function getDefaultProvider(list, kind = PROVIDER_KIND.IMAGES) {
  const providers = list ?? await loadProviders()
  const sameKind = providers.filter(p => (p.kind ?? PROVIDER_KIND.IMAGES) === kind)
  return sameKind.find(p => p.isDefault) ?? sameKind[0] ?? null
}

/* —— 协议注册表 ——
 * 协议类 = { id, label, actions: { generate, edit, test } }
 * 后续接入其他家（chat 出图、Stability、fal…）时在此追加注册即可，节点层不变。
 */

/** 从 OpenAI Images 响应提取图片字节数组（b64_json 或 url 两种载体） */
async function extractImages(json, onProgress) {
  const data = Array.isArray(json?.data) ? json.data : []
  const images = []
  for (const item of data) {
    if (item?.b64_json) {
      const binary = atob(item.b64_json)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      images.push(bytes)
    } else if (item?.url) {
      images.push(await downloadBinary(item.url))
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

export const openaiImagesProtocol = {
  id: 'openai-images',
  label: 'OpenAI Images 协议',
  /** 连接测试：GET {base}/models，仅验证地址与密钥可达 */
  async test(provider) {
    await requestJson({
      url: `${provider.baseUrl}/models`,
      secretRef: provider.secretRef || undefined,
      timeoutMs: 20000
    })
    return true
  },
  /** 文生图：POST /images/generations */
  async generate(provider, { prompt, size, quality, n, onProgress }) {
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
      onProgress
    })
    const images = await extractImages(json, onProgress)
    return { images: images.map(bytes => ({ bytes, mime: guessMime(bytes) })), usage: json?.usage ?? null, revised: typeof json?.data?.[0]?.revised_prompt === 'string' ? json.data[0].revised_prompt : null }
  },
  /** 图生图/编辑：POST /images/edits（multipart，可多图 + 可选 mask） */
  async edit(provider, { prompt, images, mask, size, quality, onProgress }) {
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
      onProgress
    })
    const result = await extractImages(json, onProgress)
    return { images: result.map(b => ({ bytes: b, mime: guessMime(b) })), usage: json?.usage ?? null, revised: null }
  }
}

export const openaiChatProtocol = {
  id: 'openai-chat',
  label: 'OpenAI Chat Completions 协议',
  /** 连接测试：GET {base}/models */
  async test(provider) {
    await requestJson({
      url: `${provider.baseUrl}/models`,
      secretRef: provider.secretRef || undefined,
      timeoutMs: 20000
    })
    return true
  },
  /** 对话补全：POST /chat/completions（非流式，优化提示词场景足够） */
  async complete(provider, { system, user, temperature = 0.7, maxTokens = 2048 }) {
    const messages = []
    if (String(system ?? '').trim()) messages.push({ role: 'system', content: String(system) })
    messages.push({ role: 'user', content: String(user ?? '') })
    const payload = { model: provider.model, messages, temperature }
    if (maxTokens) payload.max_tokens = maxTokens
    const json = await requestJson({
      url: `${provider.baseUrl}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      secretRef: provider.secretRef || undefined,
      timeoutMs: 110000
    })
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型未返回内容')
    return { text: text.trim(), usage: json?.usage ?? null }
  }
}

/** 协议注册表：节点定义引用 protocol id，运行时在此解析（找不到即抛错，不静默回退） */
const PROTOCOLS = new Map()
export function registerProtocol(protocol) { PROTOCOLS.set(protocol.id, protocol) }
export function getProtocol(id) {
  const found = PROTOCOLS.get(id)
  if (!found) throw new Error(`未注册的协议：${id}`)
  return found
}
registerProtocol(openaiImagesProtocol)
registerProtocol(openaiChatProtocol)
