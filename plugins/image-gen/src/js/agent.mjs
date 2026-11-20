/**
 * agent — 发送逻辑与会话持久化。
 * 有附件 → edit 路径，纯文本 → generate 路径；按渠道 apiKind 分发到对应协议。
 * images 协议直传 size/n/quality；chat/responses 把尺寸翻译成提示词后缀
 * （原始参数仍存消息 meta）。生成完每张图 assets.put + 写预览库记录。
 * 会话索引 `image-gen.sessions.v1` + 分键 `image-gen.session.<id>`。
 */

import { getProtocol } from './providers.mjs'
import { fromDataUrl, toDataUrl } from './netFetch.mjs'
import { saveAsset, attachRecord } from './assets.mjs'
import { saveAssetToDirectory } from './backendBridge.mjs'

const SESSIONS_KEY = 'image-gen.sessions.v1'
const sessionKey = id => `image-gen.session.${id}`

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

/* —— 会话索引 + 分键读写 —— */

export async function loadSessionIndex() {
  try {
    const saved = await store().storage.get(SESSIONS_KEY)
    if (Array.isArray(saved)) return saved
  } catch { /* 首次 */ }
  return []
}

export async function loadSession(id) {
  try {
    const saved = await store().storage.get(sessionKey(id))
    if (Array.isArray(saved)) return saved
  } catch { /* 空 */ }
  return []
}

/** 写分键 + 同步索引（标题 = 首条 prompt 截 24 字） */
export async function persistSession(session) {
  const storage = store().storage
  const firstPrompt = session.messages.find(m => m.role === 'user')?.prompt ?? ''
  const title = firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话'
  await storage.set(sessionKey(session.id), session.messages)
  const index = await loadSessionIndex()
  const entry = { id: session.id, title, updatedAt: Date.now() }
  const found = index.findIndex(s => s.id === session.id)
  if (found >= 0) index[found] = entry
  else index.unshift(entry)
  await storage.set(SESSIONS_KEY, index)
}

export async function deleteSession(id) {
  const storage = store().storage
  await storage.remove(sessionKey(id))
  const index = await loadSessionIndex()
  await storage.set(SESSIONS_KEY, index.filter(s => s.id !== id))
}

/* —— 尺寸 → 提示词后缀（chat / responses 协议用） —— */

const RATIO_BY_SIZE = {
  '1024x1024': '1:1 方形构图',
  '1536x1024': '3:2 横构图',
  '1024x1536': '2:3 竖构图'
}

function sizeSuffix(size) {
  return RATIO_BY_SIZE[size] ? `，画面比例 ${RATIO_BY_SIZE[size]}` : ''
}

/** 附件 {dataUrl} → {bytes, mime, dataUrl}（统一为协议入参形状） */
function toProtocolImages(attachments) {
  return attachments.map(att => {
    if (att.bytes && att.mime) return { ...att, dataUrl: att.dataUrl ?? toDataUrl(att.bytes, att.mime) }
    const { bytes, mime } = fromDataUrl(att.dataUrl)
    return { bytes, mime, dataUrl: att.dataUrl }
  })
}

/**
 * 执行一次生成/编辑。
 * ctx：{ provider, prompt, attachments, size, quality, n, saveDir, onProgress, signal }
 * 返回 { images: [{assetId, mime}], revised, usage, ms, savedPaths }
 */
export async function runGeneration(ctx) {
  const { provider, prompt, attachments = [], size = 'auto', quality = 'auto', n = 1, saveDir = null, onProgress, signal } = ctx
  const protocol = getProtocol(provider.apiKind)
  const startAt = Date.now()
  const textualOnly = provider.apiKind !== 'images'
  // chat / responses：尺寸进提示词后缀；images：直传参数
  const finalPrompt = textualOnly && sizeSuffix(size) && !prompt.includes(sizeSuffix(size))
    ? prompt + sizeSuffix(size)
    : prompt

  let result
  if (attachments.length) {
    result = await protocol.edit(provider, {
      prompt: finalPrompt, images: toProtocolImages(attachments), size, quality, onProgress
    })
  } else {
    result = await protocol.generate(provider, {
      prompt: finalPrompt, size, quality, n, onProgress
    })
  }
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')

  const ms = Date.now() - startAt
  const images = []
  const savedPaths = []
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  for (let i = 0; i < result.images.length; i += 1) {
    const img = result.images[i]
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const ext = (img.mime.split('/')[1] || 'png').replace('jpeg', 'jpg')
    const put = await saveAsset({ bytes: img.bytes, mime: img.mime, name: `${stamp}-${i + 1}.${ext}` })
    images.push({ assetId: put.assetId, mime: img.mime })
    // 自定义保存目录：句柄有效时同步写盘，失败回落资产库并在记录中留空
    if (saveDir?.handleId) {
      try {
        const path = await saveAssetToDirectory({ handleId: saveDir.handleId, name: `${stamp}-${i + 1}.${ext}`, dataUrl: toDataUrl(img.bytes, img.mime) })
        savedPaths.push(path)
      } catch { savedPaths.push('') }
    } else {
      savedPaths.push('')
    }
  }

  const recordId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  for (let i = 0; i < images.length; i += 1) {
    // 每张图一条记录（同批共享 prompt/meta），预览库多图不丢
    await attachRecord({
      id: `${recordId}-${i + 1}`,
      assetId: images[i].assetId,
      prompt,
      revised: result.revised ?? null,
      providerName: provider.name,
      model: provider.model,
      apiKind: provider.apiKind,
      size,
      sessionId: ctx.sessionId ?? null,
      at: Date.now(),
      savedPath: savedPaths[i] ?? ''
    })
  }

  return { images, revised: result.revised ?? null, usage: result.usage ?? null, ms, savedPaths, model: provider.model, apiKind: provider.apiKind, size, n, quality }
}
