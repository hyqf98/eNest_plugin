/**
 * 查询语法（与 backend/search.ts 同一套 token 规则）：
 * 引号 "精确短语"、-排除词、*通配符、多词 AND。这里仅做展示层镜像：
 * 名字高亮与语法提示，真正的查询构建由后端完成。
 */

export function parseQuery(input) {
  const tokens = { includes: [], excludes: [] }
  const regex = /"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|(\S+)/g
  let match
  while ((match = regex.exec(String(input ?? ''))) !== null) {
    const quoted = match[1] !== undefined || match[2] !== undefined || match[3] !== undefined || match[4] !== undefined
    let raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? ''
    if (!raw) continue
    if (!quoted && raw.startsWith('\\-')) raw = raw.slice(1)
    else if (!quoted && raw.startsWith('-') && raw.length > 1) { tokens.excludes.push(raw.slice(1)); continue }
    tokens.includes.push({ raw, quoted })
  }
  return tokens
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把名字中命中 include 词的部分包上 <mark>；返回 HTML（入参名字需已转义）。 */
export function highlightName(escapedName, tokens) {
  let html = escapedName
  const terms = []
  for (const { raw } of tokens.includes) {
    const cleaned = raw.replace(/\*/g, '')
    if (cleaned.length >= 1) terms.push(cleaned)
  }
  if (!terms.length) return html
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    html = html.replace(new RegExp(`(${escapeRegExp(term)})`, 'gi'), '\u0001$1\u0002')
  }
  return html
    .replace(/\u0001/g, '<mark>')
    .replace(/\u0002/g, '</mark>')
}

export function formatSize(bytes, isDirectory) {
  if (isDirectory) return '目录'
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function formatWhen(mtimeMs) {
  if (!mtimeMs) return ''
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24 && date.getDate() === now.getDate()) return `${hours} 小时前`
  const sameYear = date.getFullYear() === now.getFullYear()
  const pad = value => String(value).padStart(2, '0')
  return sameYear
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
