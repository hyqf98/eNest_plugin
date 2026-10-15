/** 代码片段纯逻辑：占位符解析、过滤排序、导入归一化。供页面与 node 自测共用。 */

/** 提取内容中的 ${name} 占位符（去重、保序；$$ 转义忽略） */
export function extractVars(content) {
  const out = []
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  let m
  while ((m = re.exec(String(content || '')))) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** 按值表渲染占位符；缺失变量保留原样 */
export function renderVars(content, values = {}) {
  return String(content || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (raw, name) => {
    const v = values[name]
    return v === undefined || v === null ? raw : String(v)
  })
}

/** 搜索过滤：标题 + 内容 + 标签 */
export function filterSnippets(snippets, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return snippets.slice()
  return snippets.filter((s) =>
    `${s.title}\n${s.content}\n${s.tags.join(' ')}\n${s.group || ''}`.toLowerCase().includes(q),
  )
}

/** 分组名归一：空白视为「未分组」 */
export function groupOf(snippet) {
  const g = String(snippet?.group ?? '').trim()
  return g || '未分组'
}

/** 全部分组（含未分组），按名称排序但「未分组」永远排最后 */
export function collectGroups(snippets) {
  const set = new Set(snippets.map(groupOf))
  const list = [...set].filter((g) => g !== '未分组').sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  if (set.has('未分组')) list.push('未分组')
  return list
}

/** 按分组聚合，组内沿用传入顺序（调用方先排序） */
export function groupBy(snippets) {
  const map = new Map()
  for (const s of snippets) {
    const g = groupOf(s)
    if (!map.has(g)) map.set(g, [])
    map.get(g).push(s)
  }
  return map
}

/** 分组统计：名称 → 条数 */
export function groupCounts(snippets) {
  const counts = new Map()
  for (const s of snippets) counts.set(groupOf(s), (counts.get(groupOf(s)) || 0) + 1)
  return counts
}

/** 排序：使用次数降序 → 最近复制降序 → 更新时间降序 */
export function sortSnippets(snippets) {
  return snippets.slice().sort(
    (a, b) =>
      (b.useCount || 0) - (a.useCount || 0) ||
      (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
      (b.updatedAt || 0) - (a.updatedAt || 0),
  )
}

/** 语言 → 着色标签 class（浅集合，避免百色齐放） */
const LANG_CLASSES = ['js', 'ts', 'py', 'sh', 'go', 'rs', 'sql', 'html', 'css', 'json', 'yaml', 'md']
export function langClass(lang) {
  const key = String(lang || '').trim().toLowerCase()
  if (!key) return ''
  if (LANG_CLASSES.includes(key)) return `lang-${key}`
  if (key === 'python') return 'lang-py'
  if (key === 'rust') return 'lang-rs'
  if (key === 'shell' || key === 'bash' || key === 'zsh') return 'lang-sh'
  if (key === 'typescript') return 'lang-ts'
  if (key === 'javascript') return 'lang-js'
  return 'lang-other'
}

/**
 * 轻量代码高亮 tokenizer：纯正则单遍扫描，返回可安全拼入 HTML 的片段标记。
 * 返回 [{ type: 'text'|'str'|'comment'|'num'|'keyword'|'fn', value }]，不引入外部依赖。
 * scope：'c'（C 系：js/ts/go/rust/…）、'py'、'sh'、'markup'（html/xml）。
 */
export function tokenizeCode(source, scope = 'c') {
  const out = []
  const s = String(source ?? '')
  const push = (type, value) => {
    if (!value) return
    const last = out[out.length - 1]
    if (last && last.type === type) last.value += value
    else out.push({ type, value })
  }
  if (scope === 'markup') {
    // 注释 / 开闭标签名 / 属性名 / 字符串 / 其余文本；顺序匹配保证不丢字符
    const re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^\s>/]*|"[^"]*"|'[^']*'|[a-zA-Z-]+(?==)|\/?>/g
    let last = 0
    let m
    while ((m = re.exec(s))) {
      if (m.index > last) push('text', s.slice(last, m.index))
      const t = m[0]
      if (t.startsWith('<!--')) push('comment', t)
      else if (t.startsWith('<')) push('keyword', t)
      else if (/^["']/.test(t)) push('str', t)
      else if (/^[a-zA-Z-]+$/.test(t)) push('fn', t)
      else push('keyword', t)
      last = m.index + t.length
    }
    if (last < s.length) push('text', s.slice(last))
    return out
  }
  const keywords = KEYWORD_SETS[scope] || KEYWORD_SETS.c
  const lineComment = scope === 'py' || scope === 'sh' ? '#' : scope === 'sql' ? '--' : '//'
  const blockComment = scope === 'py' || scope === 'sh' ? null : /\/\*[\s\S]*?\*\//
  // 组序与 groupDefs 一一对应，动态解析避免缺组错位
  const groupDefs = [
    ...(blockComment ? ['block'] : []),
    'line',
    'str',
    'num',
    'word',
  ]
  const parts = [
    blockComment ? blockComment.source : null,
    `${lineComment}[^\\n]*`,
    '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`',
    '0[xX][0-9a-fA-F]+|\\b\\d+(?:\\.\\d+)?\\b',
    '[A-Za-z_$][\\w$]*',
  ].filter(Boolean)
  const re = new RegExp(parts.map((p) => `(${p})`).join('|'), 'g')
  let last = 0
  let m
  while ((m = re.exec(s))) {
    if (m.index > last) push('text', s.slice(last, m.index))
    const full = m[0]
    const kind = groupDefs.findIndex((_, i) => m[i + 1] !== undefined)
    const value = kind === groupDefs.indexOf('word') ? full : full
    if (kind === 0 && groupDefs[0] === 'block') push('comment', full)
    else if (groupDefs[kind] === 'line') push('comment', full)
    else if (groupDefs[kind] === 'str') push('str', full)
    else if (groupDefs[kind] === 'num') push('num', full)
    else if (groupDefs[kind] === 'word') {
      const after = s.slice(m.index + full.length)
      if (keywords.has(value)) push('keyword', full)
      else if (/^\s*\(/.test(after)) push('fn', full)
      else push('text', full)
    }
    last = m.index + full.length
  }
  if (last < s.length) push('text', s.slice(last))
  return out
}

const KEYWORD_SETS = {
  c: new Set(
    ('break case catch class const continue default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while yield async await of static get set null undefined true false interface type enum namespace public private protected implements readonly struct impl fn pub use mut match loop crate self package func chan defer go select map range as from satisfies keyof infer declare abstract override').split(
      ' ',
    ),
  ),
  py: new Set('def class import from as return if elif else for while try except finally with lambda pass break continue raise yield global nonlocal assert del in is not and or None True False async await print self'.split(' ')),
  sh: new Set('if then else elif fi for while do done case esac function return export local echo cd exit set source alias in'.split(' ')),
  sql: new Set('select from where group by order limit offset join left right inner outer full cross on as and or not null is in like between insert into values update set delete create table view index primary key unique foreign references distinct union all case when then else end asc desc having with'.split(' ')),
}
export const KEYWORD_SET = KEYWORD_SETS

/** 语言 → tokenizer scope；未知语言按 C 系处理，css/json/yaml 也能获得基础着色 */
export function langScope(lang) {
  const key = String(lang || '').trim().toLowerCase()
  if (key === 'python') return 'py'
  if (['shell', 'bash', 'zsh'].includes(key)) return 'sh'
  if (key === 'sql') return 'sql'
  if (['html', 'xml', 'svg', 'vue'].includes(key)) return 'markup'
  return 'c'
}

/** token 流 → 带 class 的安全 HTML */
export function highlightToHtml(source, scope = 'c') {
  const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  return tokenizeCode(source, scope)
    .map((t) => (t.type === 'text' ? safe(t.value) : `<span class="tk-${t.type}">${safe(t.value)}</span>`))
    .join('')
}

/** token 流按行切分 → 每行安全 HTML（跨行 token 如块注释/模板字符串正确分段） */
export function highlightLines(source, scope = 'c') {
  const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const lines = ['']
  for (const t of tokenizeCode(source, scope)) {
    const parts = String(t.value).split('\n')
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push('')
      if (!part) return
      lines[lines.length - 1] +=
        t.type === 'text' ? safe(part) : `<span class="tk-${t.type}">${safe(part)}</span>`
    })
  }
  return lines
}

/**
 * 缩进驱动的行级折叠区间：[{ start, end, depth }]（0 起行号、含首尾）。
 * 空行不算缩进；超限（默认 1500 行）返回 null，由调用方降级为不可折叠渲染。
 */
export function computeFoldRanges(source, { maxLines = 1500 } = {}) {
  const lines = String(source ?? '').split('\n')
  if (lines.length > maxLines) return null
  const indentOf = (line) => {
    if (!line.trim()) return null
    const lead = /^[ \t]*/.exec(line)[0]
    let w = 0
    for (const ch of lead) w += ch === '\t' ? 4 : 1
    return w
  }
  const indents = lines.map(indentOf)
  const folds = []
  for (let i = 0; i < lines.length; i++) {
    const w = indents[i]
    if (w === null) continue
    let j = i + 1
    while (j < lines.length && indents[j] === null) j++
    if (j >= lines.length || indents[j] <= w) continue
    // 块尾：最后一个缩进仍大于起始行的非空行（尾随空行并入块内）
    let end = j
    for (let k = j; k < lines.length; k++) {
      if (indents[k] === null) continue
      if (indents[k] > w) end = k
      else break
    }
    if (end > i) {
      // 编辑器惯例：折叠时把紧随其后的同缩进收尾行（} ) ]）一并收进块内
      const closing = lines[end + 1]
      if (closing !== undefined && closing.trim() && indents[end + 1] === w && /^[}\)\]]/.test(closing.trim()))
        end++
      folds.push({ start: i, end, depth: 0 })
    }
  }
  // depth = 严格包含自己的折叠块数量
  for (const f of folds)
    f.depth = folds.reduce(
      (n, o) => n + (o !== f && o.start < f.start && f.end <= o.end ? 1 : 0),
      0,
    )
  return folds
}

/** 归一化导入/新建的片段对象 */
export function normalizeSnippet(input, id) {
  if (!input || typeof input !== 'object') throw new Error('片段数据格式不正确')
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('片段缺少标题')
  return {
    id: typeof id === 'string' && id ? id : typeof input.id === 'string' ? input.id : uuid(),
    title: title.slice(0, 80),
    lang: String(input.lang ?? '').trim().slice(0, 24),
    group: String(input.group ?? '').trim().slice(0, 40),
    tags: Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
      : String(input.tags ?? '')
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 12),
    content: String(input.content ?? '').slice(0, 64 * 1024),
    createdAt: Number(input.createdAt) || Date.now(),
    updatedAt: Number(input.updatedAt) || Date.now(),
    useCount: Math.max(0, Number(input.useCount) || 0),
    lastUsedAt: Number(input.lastUsedAt) || 0,
  }
}

/** 分组名合法性：非空且不含换行即可用 */
export function validGroupName(name) {
  const g = String(name ?? '').trim()
  return g && !/[\n\r]/.test(g) ? g.slice(0, 40) : ''
}

/** UUID：浏览器用 crypto.randomUUID，其它环境（如 node 测试子进程）退化为随机串 */
export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(16)) : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

/** 解析导入的 JSON 文本 → 片段数组 */
export function parseImport(text) {
  const data = JSON.parse(String(text ?? ''))
  const list = Array.isArray(data) ? data : data?.snippets
  if (!Array.isArray(list) || !list.length) throw new Error('导入内容不含片段')
  return list.map((item) => normalizeSnippet(item))
}

/** 导出对象 */
export function buildExport(snippets) {
  return { version: 1, exportedAt: Date.now(), snippets }
}
