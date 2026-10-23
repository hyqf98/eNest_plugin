/**
 * markdown v2 —— 表格源码操作（列宽拖拽 / 右键增删行列共用）。
 * 输入是表格块的 Markdown 源码（含表头、分隔行、数据行），输出改写后的源码。
 */

const splitRow = (line) => {
  // 去掉首尾竖线后按未转义竖线切分
  let inner = line.trim()
  if (inner.startsWith('|')) inner = inner.slice(1)
  if (inner.endsWith('|')) inner = inner.slice(0, -1)
  return inner.split(/(?<!\\)\|/).map((c) => c.trim())
}

const joinRow = (cells) => `| ${cells.join(' | ')} |`

export function parseTable(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return null
  const header = splitRow(lines[0])
  const delimiters = splitRow(lines[1])
  const aligns = delimiters.map((d) => {
    const s = d.trim()
    const left = s.startsWith(':')
    const right = s.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return 'left'
  })
  const rows = lines.slice(2).map(splitRow)
  return { header, aligns, rows, lines }
}

const alignCell = (align) => {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  return '---'
}

export function serializeTable({ header, aligns, rows }) {
  const cols = header.length
  const normalize = (cells) => {
    const out = cells.slice(0, cols)
    while (out.length < cols) out.push('')
    return out
  }
  const out = [
    joinRow(normalize(header)),
    joinRow(aligns.slice(0, cols).map(alignCell)),
    ...rows.map((r) => joinRow(normalize(r))),
  ]
  return out.join('\n')
}

/** 在列索引 at 处插入空列（at = 0..cols） */
export function insertColumn(table, at) {
  const t = { header: [...table.header], aligns: [...table.aligns], rows: table.rows.map((r) => [...r]) }
  t.header.splice(at, 0, ' ')
  t.aligns.splice(at, 0, 'left')
  t.rows = t.rows.map((r) => { const c = [...r]; c.splice(at, 0, ' '); return c })
  return t
}

export function deleteColumn(table, at) {
  if (table.header.length <= 1) return table
  const t = { header: [...table.header], aligns: [...table.aligns], rows: table.rows.map((r) => [...r]) }
  t.header.splice(at, 1)
  t.aligns.splice(at, 1)
  t.rows = t.rows.map((r) => { const c = [...r]; c.splice(at, 1); return c })
  return t
}

/** at = 0..rows.length（0 表示插在第一条数据行前） */
export function insertRow(table, at) {
  const wid = table.header.length
  const blank = new Array(wid).fill(' ')
  const rows = [...table.rows]
  rows.splice(at, 0, blank)
  return { ...table, rows }
}

export function deleteRow(table, at) {
  const rows = [...table.rows]
  rows.splice(at, 1)
  return { ...table, rows }
}

/* ---------------- 列宽持久化（不污染 md 源码，存插件 storage） ---------------- */

const WIDTH_KEY = 'md-table-widths'
const widthsByTable = new Map()
let loaded = false
let persistTimer = 0

function hashTable(text) {
  let h = 5381
  const s = text.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}

export function getTableWidths(tableText) {
  return widthsByTable.get(hashTable(tableText)) ?? null
}

export function setTableWidths(tableText, widths) {
  widthsByTable.set(hashTable(tableText), widths)
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => { void persistWidths() }, 600)
}

async function persistWidths() {
  const api = window.enest || window.zapi
  if (!api?.storage?.set) return
  try {
    const obj = {}
    for (const [k, v] of widthsByTable) obj[k] = v
    await api.storage.set(WIDTH_KEY, obj)
  } catch { /* 存不进就只保留会话内 */ }
}

export async function loadPersistedWidths() {
  if (loaded) return
  loaded = true
  const api = window.enest || window.zapi
  if (!api?.storage?.get) return
  try {
    const obj = await api.storage.get(WIDTH_KEY)
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) widthsByTable.set(k, v)
    }
  } catch { /* 忽略 */ }
}

export { hashTable }
