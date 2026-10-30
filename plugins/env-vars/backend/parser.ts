/**
 * zsh 启动文件解析与受管块（eNest managed block）读写。
 *
 * 解析规则：
 * - `export NAME=...` 与裸 `NAME=...`（exported:false）
 * - 值支持双引号 / 单引号 / 无引号；`$'...'` 忽略；行尾续行 `\` 简单跳过
 * - `$(...)`、反引号、`${...}` 保留原样并标记 hasReference
 * - 受管块 `# >>> eNest env-vars managed >>>` … `# <<< eNest env-vars managed <<<` 内的行标 managed
 */

export const MANAGED_BEGIN = '# >>> eNest env-vars managed >>>'
export const MANAGED_END = '# <<< eNest env-vars managed <<<'

const RE_EXPORT = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const RE_ASSIGN = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const RE_REFERENCE = /\$\(|`|\$\{/

export interface ParsedEntry {
  name: string
  value: string
  line: number
  exported: boolean
  managed: boolean
  hasReference: boolean
}

/** 去掉值的引号并保留引用标记。 */
function unwrapValue(raw: string): { value: string; hasReference: boolean } {
  let text = raw.trim()
  // 行尾注释粗略剔除：仅当注释前有空白且不在引号内（保守处理，避免误删 # 路径）
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    if (end > 0) text = text.slice(1, end)
  } else if (text.startsWith("'")) {
    const end = text.indexOf("'", 1)
    if (end > 0) text = text.slice(1, end)
  } else {
    const comment = text.match(/\s+#/)
    if (comment?.index !== undefined) text = text.slice(0, comment.index).trimEnd()
  }
  const hasReference = RE_REFERENCE.test(text)
  return { value: text, hasReference }
}

export function parseShellFile(content: string): ParsedEntry[] {
  const lines = content.split('\n')
  const entries: ParsedEntry[] = []
  let managed = false
  let continued = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === MANAGED_BEGIN) { managed = true; continue }
    if (line.trim() === MANAGED_END) { managed = false; continue }
    if (continued) { // 上一行以 \ 续行：本行并入上一条，不单独成条
      continued = /\\\s*$/.test(line)
      continue
    }
    const exportMatch = RE_EXPORT.exec(line)
    const assignMatch = exportMatch ? null : RE_ASSIGN.exec(line)
    const match = exportMatch ?? assignMatch
    if (!match) continue
    if (/\\\s*$/.test(line)) { continued = true; continue } // 跳过续行语句
    if (line.trimStart().startsWith("$'")) continue // $'...' ANSI-C 形式忽略
    const { value, hasReference } = unwrapValue(match[2])
    entries.push({ name: match[1], value, line: i + 1, exported: Boolean(exportMatch), managed, hasReference })
  }
  return entries
}

/** 单引号 shell 转义：值内单引号写成 '\''。 */
export function shellSingleQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

/** 生成受管块内容（含首尾标记）。 */
export function renderManagedBlock(vars: { name: string; value: string }[]): string {
  const body = vars.map(item => `export ${item.name}=${shellSingleQuote(item.value)}`).join('\n')
  return [MANAGED_BEGIN, body, MANAGED_END].join('\n')
}

export interface ManagedSplit {
  /** 受管块前的内容（含尾随换行处理） */
  before: string
  managedVars: { name: string; value: string; line: number }[]
  /** 受管块后的内容 */
  after: string
  hasBlock: boolean
}

/** 拆分文件为受管块前 / 块内变量 / 块后三段；文件其余内容一字不动。 */
export function splitManaged(content: string): ManagedSplit {
  const lines = content.split('\n')
  let beginIndex = -1
  let endIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === MANAGED_BEGIN && beginIndex < 0) beginIndex = i
    else if (lines[i].trim() === MANAGED_END && beginIndex >= 0 && endIndex < 0) { endIndex = i; break }
  }
  if (beginIndex < 0 || endIndex < 0) {
    return { before: content, managedVars: [], after: '', hasBlock: false }
  }
  const before = lines.slice(0, beginIndex).join('\n')
  const after = lines.slice(endIndex + 1).join('\n')
  const managedVars: { name: string; value: string; line: number }[] = []
  for (let i = beginIndex + 1; i < endIndex; i++) {
    const match = RE_EXPORT.exec(lines[i]) ?? RE_ASSIGN.exec(lines[i])
    if (!match) continue
    const { value } = unwrapValue(match[2])
    managedVars.push({ name: match[1], value, line: i + 1 })
  }
  return { before, managedVars, after, hasBlock: true }
}

/** 将新受管块合入原文：已有块整块替换，否则追加到末尾（前留一空行）。 */
export function mergeManaged(content: string, vars: { name: string; value: string }[]): string {
  const block = vars.length ? renderManagedBlock(vars) : ''
  const split = splitManaged(content)
  if (split.hasBlock) {
    const before = split.before.length ? split.before.replace(/\n*$/, '\n') : ''
    const afterBody = split.after.replace(/^\n+/, '')
    const parts = [before]
    if (block) {
      if (before && !before.endsWith('\n\n')) parts.push('\n')
      parts.push(block, '\n')
    }
    if (afterBody) parts.push('\n', afterBody)
    return parts.join('').replace(/^\n+/, match => match.length > 1 ? '\n' : match)
  }
  const base = content.replace(/\s*$/, '')
  if (!block) return base ? base + '\n' : ''
  return (base ? base + '\n\n' : '') + block + '\n'
}
