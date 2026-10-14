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
    `${s.title}\n${s.content}\n${s.tags.join(' ')}`.toLowerCase().includes(q),
  )
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

/** 归一化导入/新建的片段对象 */
export function normalizeSnippet(input, id) {
  if (!input || typeof input !== 'object') throw new Error('片段数据格式不正确')
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('片段缺少标题')
  return {
    id: typeof id === 'string' && id ? id : typeof input.id === 'string' ? input.id : crypto.randomUUID(),
    title: title.slice(0, 80),
    lang: String(input.lang ?? '').trim().slice(0, 24),
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
