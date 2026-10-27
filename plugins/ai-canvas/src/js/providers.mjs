/**
 * providers — Provider 协议注册表 + 配置管理。
 * 首期实现 OpenAI Images 协议类（/v1/images/generations + /v1/images/edits），
 * 覆盖官方与 one-api / new-api 等中转站；后续按同一协议接口注册其他协议类。
 * 配置存插件私有 KV；密钥经 vault.set 存 secretRef，请求时交主进程解引用注入。
 */

import { requestJson, requestJsonStreamed, downloadBinary, buildMultipart, toBase64 } from './netFetch.mjs'

const PROVIDERS_KEY = 'ai-canvas.providers.v1'

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

export function normalizeBaseUrl(input) {
  let url = String(input ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  // 用户填到根或 /v1 均可：末段不是 /v\d 时自动补 /v1（拼接 images 路径的统一前提）
  if (!/\/v\d+$/.test(url)) url += '/v1'
  return url
}

export const DEFAULT_PROVIDERS = [
  { id: 'default', name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', secretRef: '', isDefault: true }
]

export async function loadProviders() {
  try {
    const saved = await store().storage.get(PROVIDERS_KEY)
    if (Array.isArray(saved) && saved.length) return saved
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
  const record = { ...provider, baseUrl: normalizeBaseUrl(provider.baseUrl) }
  if (apiKey && apiKey.trim()) {
    const enest = store()
    const vaultKey = `ai-canvas.provider.${record.id}`
    const res = await enest.vault.set(vaultKey, apiKey.trim())
    record.secretRef = res?.secretRef ?? vaultKey
  }
  const index = list.findIndex(p => p.id === record.id)
  if (index >= 0) list[index] = { ...list[index], ...record }
  else list.push(record)
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
  if (target?.isDefault && next.length) next[0].isDefault = true
  await saveProviders(next)
  return next
}

export async function getDefaultProvider(list) {
  const providers = list ?? await loadProviders()
  return providers.find(p => p.isDefault) ?? providers[0] ?? null
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

/** 协议注册表：节点定义引用 protocol id，运行时在此解析 */
const PROTOCOLS = new Map()
export function registerProtocol(protocol) { PROTOCOLS.set(protocol.id, protocol) }
export function getProtocol(id) { return PROTOCOLS.get(id) ?? openaiImagesProtocol }
registerProtocol(openaiImagesProtocol)
