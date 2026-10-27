/**
 * markdown —— 阅读/呈现偏好应用层（设置 → CSS 变量与动效属性）+ 用户 CSS 主题存储。
 *
 * 呈现偏好全部落到 CSS 变量与 data-* 属性上，切换即时生效，不重建编辑器：
 *   --md-img-max-w / --md-img-max-h    图片最大宽高
 *   --md-html-max-w / --md-html-max-h  HTML 块最大宽高
 *   data-code-theme                    代码块配色（变量组在 CONTENT_CSS 里定义）
 *   data-md-motion / -preset / -scope  动效开关、预设、作用分区
 *
 * 用户 CSS 主题的持久化选择（重要）：
 *   优先用宿主统一 API `window.enest.storage.files.stream`——它把文件写进宿主管理的
 *   插件私有输出区（{dataRoot}/plugin-files/<sha256(pluginId)>），带配额、生命周期和
 *   `storage.files.remove` 回收，正是「保存到持久化路径对应的插件位置」的要求；
 *   索引（名称 ↔ 文件 id）存 KV。
 *   当宿主不支持 files.stream 时退化为 KV 存 CSS 文本（单值 512KiB 上限，CSS 足够）。
 *   两种情况都额外尽力镜像到 backend 的 `theme.write`，保证老版本/手工丢进 themes/
 *   的 CSS 仍能被列出并应用。
 */

import { call } from './rpc.js'
import { applyTheme, adaptTyporaCss } from '../render/theme.js'

const THEME_INDEX_KEY = 'md.themes.index'
const THEME_CSS_KEY_PREFIX = 'md.theme.css.'
const CHUNK = 512 * 1024

function api() {
  return (typeof window !== 'undefined' ? (window.enest || window.zapi) : null)
}

/* ---------------- 呈现偏好 ---------------- */

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 百分比或像素：0/空 = 不限（none） */
function length(value, fallbackPercent) {
  const n = num(value, fallbackPercent)
  if (n <= 0) return 'none'
  return `${n}%`
}

/**
 * @param {HTMLElement} [root] 忽略入参，统一写到 documentElement：
 *   变量与 data-* 属性只有挂在根元素上，才能同时覆盖编辑器、设置页与导出容器。
 */
export function applyContentMetrics(_root, settings = {}) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const style = root.style
  style.setProperty('--md-img-max-w', length(settings.imageMaxWidth, 100))
  style.setProperty('--md-img-max-h', settings.imageMaxHeight > 0 ? `${num(settings.imageMaxHeight, 0)}px` : 'none')
  style.setProperty('--md-html-max-w', length(settings.htmlBlockMaxWidth, 100))
  style.setProperty('--md-html-max-h', settings.htmlBlockMaxHeight > 0 ? `${num(settings.htmlBlockMaxHeight, 0)}px` : 'none')

  const codeTheme = String(settings.codeTheme || 'default')
  const allowed = new Set(['default', 'github', 'monokai', 'dracula', 'solarized', 'nord'])
  const theme = allowed.has(codeTheme) ? codeTheme : 'default'
  if (theme === 'default') root.removeAttribute('data-code-theme')
  else root.setAttribute('data-code-theme', theme)
}

/**
 * 动效：总开关 + 预设 + 分区（同样写在 documentElement 上）。
 * 分区从四个 switch 合成空格分隔列表（CSS 用 [attr~='x'] 包含匹配）。
 */
export function applyMotionSettings(_root, settings = {}) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const on = settings.motionEnabled === true
  root.dataset.mdMotion = on ? 'on' : 'off'
  const preset = String(settings.motionPreset || 'both')
  root.dataset.mdMotionPreset = ['flow', 'breathe', 'both', 'subtle'].includes(preset) ? preset : 'both'
  const scope = []
  if (settings.motionMermaid !== false) scope.push('mermaid')
  if (settings.motionTable !== false) scope.push('table')
  if (settings.motionHighlight !== false) scope.push('highlight')
  if (settings.motionCode !== false) scope.push('code')
  root.dataset.mdMotionScope = scope.join(' ')
}

/* ---------------- 用户 CSS 主题 ---------------- */

/**
 * CSS 安全过滤：去掉 @import（外链样式表）与 url(http(s)://…)（远程资源），
 * 避免上传的 CSS 把页面内容发到外部或加载任意远程样式。
 * 只做保守的文本替换，不改写合法规则。
 */
export function sanitizeUserCss(css) {
  return String(css ?? '')
    .replace(/@import[^;]*;?/gi, '/* @import 已移除 */')
    .replace(/url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi, 'none')
    .replace(/expression\s*\(/gi, '/* expression( */')
}

function textToBytes(text) {
  return new TextEncoder().encode(text)
}

function bytesToText(buffer) {
  return new TextDecoder('utf-8').decode(new Uint8Array(buffer))
}

async function readIndex() {
  const a = api()
  try {
    const stored = await a?.storage?.get?.(THEME_INDEX_KEY)
    return Array.isArray(stored) ? stored.filter((e) => e && typeof e.id === 'string') : []
  } catch {
    return []
  }
}

async function writeIndex(list) {
  const a = api()
  await a?.storage?.set?.(THEME_INDEX_KEY, list)
  try { await a?.storage?.flush?.() } catch { /* 尽力 */ }
}

/**
 * 列出用户主题：宿主私有文件区（storage.files）+ backend themes/ 目录里手工放入的 CSS。
 * 返回 [{ id, name, source: 'user', fileId? }]
 */
export async function loadUserThemes() {
  const list = []
  const seen = new Set()
  const index = await readIndex()
  for (const entry of index) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    list.push({ id: entry.id, name: entry.name || entry.id, source: 'user', fileId: entry.fileId })
  }
  // backend 目录里的 CSS（含老版本写入与用户手工放置）
  try {
    const { themes } = await call('theme.list')
    for (const theme of themes || []) {
      if (seen.has(theme.name)) continue
      seen.add(theme.name)
      list.push({ id: theme.name, name: theme.name, source: 'user' })
    }
  } catch { /* backend 未授权 */ }
  return list
}

/** 用 storage.files 写入 CSS；不可用时返回 null（调用方退 KV） */
async function writeWithFileStream(css) {
  const a = api()
  const streams = a?.storage?.files?.stream
  if (!streams?.open) return null
  const bytes = textToBytes(css)
  const { streamId } = await streams.open({ extension: 'css' })
  try {
    let sequence = 0
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const slice = bytes.subarray(offset, offset + CHUNK)
      // 复制到独立 ArrayBuffer：IPC 传输需要可转移的缓冲区
      const chunk = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
      await streams.write(streamId, sequence++, chunk)
    }
    const result = await streams.finish(streamId)
    return { fileId: result.id, size: result.size }
  } catch (error) {
    try { await streams.abort(streamId) } catch { /* 忽略 */ }
    throw error
  }
}

async function readWithFileStream(fileId) {
  const a = api()
  const files = a?.storage?.files
  if (!files?.get || !fileId) return null
  let offset = 0
  let text = ''
  for (let guard = 0; guard < 4096; guard++) {
    const chunk = await files.get(fileId, { offset, length: CHUNK })
    if (!chunk) return null
    if (chunk.bytes && chunk.bytes.byteLength) text += bytesToText(chunk.bytes)
    if (chunk.nextOffset === null || chunk.nextOffset === undefined) break
    offset = chunk.nextOffset
  }
  return text
}

/**
 * 保存（或覆盖）一个用户 CSS 主题。
 * @returns {Promise<{ id: string, name: string, fileId?: string, storage: 'files'|'kv' }>}
 */
export async function saveUserTheme(name, css) {
  const id = String(name).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '') || `theme-${Date.now()}`
  const clean = sanitizeUserCss(css)
  if (!clean.trim()) throw new Error('CSS 内容为空')

  const index = await readIndex()
  const previous = index.find((entry) => entry.id === id)
  let fileId
  let storage = 'kv'
  try {
    const written = await writeWithFileStream(clean)
    if (written) { fileId = written.fileId; storage = 'files' }
  } catch {
    // 宿主文件区不可用/超配额 → 退 KV
  }
  if (!fileId) {
    const a = api()
    await a?.storage?.set?.(THEME_CSS_KEY_PREFIX + id, clean)
    storage = 'kv'
  }

  const next = index.filter((entry) => entry.id !== id)
  next.push({ id, name: String(name).trim() || id, fileId, at: Date.now() })
  await writeIndex(next)
  if (previous?.fileId && previous.fileId !== fileId) {
    try { await api()?.storage?.files?.remove?.(previous.fileId) } catch { /* 尽力回收 */ }
  }

  // 尽力镜像到 backend themes/ 目录：老版本与手工管理都能看到
  try {
    await call('theme.write', id, clean)
  } catch { /* backend 未授权时忽略 */ }

  return { id, name: String(name).trim() || id, fileId, storage }
}

/** 读取主题 CSS（优先宿主私有文件区 → KV → backend 目录） */
export async function readUserTheme(id) {
  const index = await readIndex()
  const entry = index.find((item) => item.id === id)
  if (entry?.fileId) {
    try {
      const text = await readWithFileStream(entry.fileId)
      if (text) return text
    } catch { /* 落到 KV */ }
  }
  try {
    const kv = await api()?.storage?.get?.(THEME_CSS_KEY_PREFIX + id)
    if (typeof kv === 'string' && kv) return kv
  } catch { /* 落到 backend */ }
  try {
    const { css } = await call('theme.read', id)
    return css || ''
  } catch {
    return ''
  }
}

/** 应用用户主题：注入 <style>（Typora CSS 兼容改写） */
export async function applyUserTheme(id, baseCss) {
  const css = await readUserTheme(id)
  if (!css) return false
  applyTheme(id, (baseCss || '') + adaptTyporaCss(sanitizeUserCss(css)))
  return true
}

/** 删除主题（回收宿主文件 + KV + backend 镜像） */
export async function deleteUserTheme(id) {
  const index = await readIndex()
  const entry = index.find((item) => item.id === id)
  if (entry?.fileId) {
    try { await api()?.storage?.files?.remove?.(entry.fileId) } catch { /* 忽略 */ }
  }
  try { await api()?.storage?.remove?.(THEME_CSS_KEY_PREFIX + id) } catch { /* 忽略 */ }
  await writeIndex(index.filter((item) => item.id !== id))
  try {
    await call('theme.delete', id)
  } catch { /* backend 未授权 */ }
}

/**
 * 从本地 .css 文件导入：用 localFiles 句柄读取文本（32MiB 上限），
 * 然后走 saveUserTheme 的存储链路。
 */
export async function importUserThemeFromPicker() {
  const a = api()
  const handles = await a?.localFiles?.pick?.({ kind: 'file', multiple: false, access: 'read' })
  const handle = handles?.[0]
  if (!handle) return null
  if (!/\.css$/i.test(handle.name)) throw new Error('请选择 .css 文件')
  const text = await a.localFiles.read({ handleId: handle.id, encoding: 'text', maxBytes: 4 * 1024 * 1024 })
  const name = handle.name.replace(/\.css$/i, '')
  const saved = await saveUserTheme(name, text)
  return { ...saved, css: sanitizeUserCss(text) }
}

export { THEME_INDEX_KEY, THEME_CSS_KEY_PREFIX }
