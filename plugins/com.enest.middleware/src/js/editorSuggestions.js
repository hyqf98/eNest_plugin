/** Local, deterministic JSON assistance. It never requests metadata or sends a message. */
export function collectJsonKeys(value) {
  const keys = new Set()
  try {
    const visit = node => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(visit); return }
      for (const [key, child] of Object.entries(node)) { keys.add(key); visit(child) }
    }
    visit(JSON.parse(value))
  } catch { /* Incomplete JSON is normal during editing. */ }
  return [...keys]
}

export function jsonSuggestions(value, caret, knownKeys = []) {
  const before = value.slice(0, caret)
  // Scan JSON strings so literals inside quoted values are never rewritten.
  let stringStart = -1, quoted = false, escaped = false
  for (let i = 0; i < before.length; i++) {
    const char = before[i]
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; if (quoted) stringStart = i }
  }
  if (quoted) {
    const leading = before.slice(0, stringStart).trimEnd()
    if (!/[{,]$/.test(leading)) return []
    const prefix = before.slice(stringStart + 1)
    if (/["\\\r\n]/.test(prefix)) return []
    const tail = value.slice(caret)
    return [...new Set(knownKeys)].filter(key => key.toLowerCase().startsWith(prefix.toLowerCase()) && key !== prefix).slice(0, 8).map(key => ({ label: key, detail: '当前内容中的字段', from: stringStart + 1, to: caret, text: JSON.stringify(key).slice(1, -1) + (tail.startsWith('"') ? '' : '"') }))
  }
  const match = before.match(/[A-Za-z]*$/)
  const prefix = match?.[0] || ''
  const from = caret - prefix.length
  const context = before.slice(0, from).trimEnd()
  if (context && !/[:[, ]$/.test(context)) return []
  const candidates = [
    { label: 'true', detail: '布尔值 · 真', text: 'true' },
    { label: 'false', detail: '布尔值 · 假', text: 'false' },
    { label: 'null', detail: '空值', text: 'null' },
    { label: '{}', detail: 'JSON 对象', text: '{}' },
    { label: '[]', detail: 'JSON 数组', text: '[]' }
  ]
  return candidates.filter(item => item.label.startsWith(prefix.toLowerCase())).map(item => ({ ...item, from, to: caret }))
}

export function newlineEdit(value, start, end = start) {
  const line = value.slice(0, start).split('\n').at(-1)
  const indent = line.match(/^\s*/)?.[0] || ''
  const opens = /[\[{]\s*$/.test(line)
  const closes = /^[\]}]/.test(value.slice(end))
  const text = `\n${indent}${opens ? '  ' : ''}${opens && closes ? `\n${indent}` : ''}`
  return { from: start, to: end, text, caret: start + 1 + indent.length + (opens ? 2 : 0) }
}
