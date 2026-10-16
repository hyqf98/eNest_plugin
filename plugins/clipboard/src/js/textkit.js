/** 剪贴板文本变换纯逻辑：JSON / 行处理 / 大小写 / 正则替换 / 暂存片段归一化。 */

/** JSON 格式化：minify 或 2 空格缩进；非法 JSON 抛错 */
export function formatJson(text, { minify = false } = {}) {
  const value = JSON.parse(String(text ?? ''))
  return JSON.stringify(value, null, minify ? 0 : 2)
}

/** 行去重：保留首次出现顺序；可选择同时去除空行 */
export function uniqueLines(text, { trim = true, dropEmpty = false } = {}) {
  const lines = String(text ?? '').split(/\r?\n/)
  const seen = new Set()
  const out = []
  for (const line of lines) {
    const key = trim ? line.trim() : line
    if (dropEmpty && !key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trim ? key : line)
  }
  return out.join('\n')
}

/** 行排序：asc / desc / length（长度升序）；空行按原样参与 */
export function sortLines(text, mode = 'asc') {
  const lines = String(text ?? '').split(/\r?\n/)
  const collator = new Intl.Collator('zh-CN', { numeric: true })
  const sorted = lines.sort((a, b) =>
    mode === 'desc' ? collator.compare(b, a)
    : mode === 'length' ? a.length - b.length || collator.compare(a, b)
    : collator.compare(a, b),
  )
  return sorted.join('\n')
}

const CASE_KINDS = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: (s) => s.replace(/\p{L}[\p{L}\p{M}']*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  camel: (s) => {
    const words = String(s).split(/[\s_\-.]+/).filter(Boolean)
    if (!words.length) return ''
    return words[0].toLowerCase() + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('')
  },
  snake: (s) =>
    String(s)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s\-.]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase())
      .join('_'),
  kebab: (s) =>
    String(s)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s_.]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase())
      .join('-'),
}

/** 大小写 / 命名风格转换 */
export function changeCase(text, kind) {
  const fn = CASE_KINDS[kind]
  if (!fn) throw new Error(`未知的大小写转换：${kind}`)
  return fn(String(text ?? ''))
}

export const CASE_KIND_LIST = Object.keys(CASE_KINDS)

/** 去格式化：压平所有空白为单个空格并去首尾 */
export function stripFormatting(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 正则替换：pattern 非法时抛错；flags 缺省 g */
export function regexReplace(text, pattern, replacement, flags = 'g') {
  if (!pattern) throw new Error('正则表达式为空')
  let re
  try {
    re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g')
  } catch (err) {
    throw new Error(`正则表达式无效：${err.message}`)
  }
  return String(text ?? '').replace(re, replacement ?? '')
}

/** 暂存片段归一化：标题自动截取、上限约束（临时性质：与 snippets 插件的长期管理区分） */
export function normalizeSnippet(input, maxBody = 5000) {
  const body = String(input?.body ?? '')
  if (!body.trim()) throw new Error('片段内容为空')
  const title = (String(input?.title ?? '').trim() || body.trim().split(/\r?\n/)[0].slice(0, 30) || '片段').slice(0, 60)
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : crypto.randomUUID(),
    title,
    body: body.slice(0, maxBody),
    createdAt: Number(input?.createdAt) || Date.now(),
  }
}

/** 人类可读字节 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
