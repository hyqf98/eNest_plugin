/**
 * markdown v2 —— 表格源码操作（列宽拖拽 / 右键增删行列共用）。
 * 输入是表格块的 Markdown 源码（含表头、分隔行、数据行），输出改写后的源码。
 */

export function tableRowCells(line) {
  const cells = []
  let start = 0
  for (let index = 0; index <= line.length; index++) {
    if (index < line.length && (line[index] !== '|' || line[index - 1] === '\\')) continue
    const segment = line.slice(start, index)
    const value = segment.trim()
    const from = start + (value ? segment.length - segment.trimStart().length : Math.min(1, segment.length))
    cells.push({ from, to: from + value.length, rawFrom: start, rawTo: index, value })
    start = index + 1
  }
  if (cells.length > 1 && !cells[0].value) cells.shift()
  if (cells.length > 1 && !cells.at(-1).value) cells.pop()
  return cells
}

const splitRow = line => tableRowCells(line).map(cell => cell.value)

const joinRow = (cells) => `| ${cells.join(' | ')} |`

export function parseTable(text) {
  const lines = text.split('\n')
  if (lines.length < 2) return null
  const header = splitRow(lines[0])
  const delimiters = splitRow(lines[1])
  if (!header.length || header.length !== delimiters.length || !delimiters.every(value => /^:?-+:?$/.test(value))) return null
  const aligns = delimiters.map((d) => {
    const s = d.trim()
    const left = s.startsWith(':')
    const right = s.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return ''
  })
  const rows = lines.slice(2).map(splitRow)
  return { header, delimiters, aligns, rows, lines }
}

const alignCell = align => {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  if (align === 'left') return ':---'
  return '---'
}

export function serializeTable({ header, aligns, delimiters = aligns.map(alignCell), rows, lines = [] }) {
  return [header, delimiters, ...rows].map((cells, index) => {
    const original = lines[index]
    if (original != null) {
      const previous = splitRow(original)
      if (previous.length === cells.length && previous.every((value, col) => value === cells[col])) return original
    }
    return joinRow(cells)
  }).join('\n')
}

/** 在列索引 at 处插入空列（at = 0..cols） */
export function insertColumn(table, at) {
  const inserting = (values, value) => [...values.slice(0, at), ...Array(Math.max(0, at - values.length)).fill(''), value, ...values.slice(at)]
  return { ...table, header: inserting(table.header, ''), aligns: inserting(table.aligns, ''), delimiters: inserting(table.delimiters, '---'), rows: table.rows.map(row => inserting(row, '')) }
}

export function deleteColumn(table, at) {
  if (table.header.length <= 1) return table
  const excluding = values => values.filter((_, index) => index !== at)
  return { ...table, header: excluding(table.header), aligns: excluding(table.aligns), delimiters: excluding(table.delimiters), rows: table.rows.map(excluding) }
}

/** at = 0..rows.length（0 表示插在第一条数据行前） */
export function insertRow(table, at) {
  const wid = table.header.length
  const blank = new Array(wid).fill('')
  const rows = [...table.rows]
  const lines = [...table.lines]
  rows.splice(at, 0, blank)
  lines.splice(at + 2, 0, joinRow(blank))
  return { ...table, rows, lines }
}

export function deleteRow(table, at) {
  const rows = [...table.rows]
  const lines = [...table.lines]
  rows.splice(at, 1)
  lines.splice(at + 2, 1)
  return { ...table, rows, lines }
}

export function tableCellRange(text, rowIndex, columnIndex) {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || !Number.isInteger(columnIndex) || columnIndex < 0) return null
  const lines = text.split('\n')
  const lineIndex = rowIndex === 0 ? 0 : rowIndex + 1
  if (lineIndex >= lines.length) return null
  const line = lines[lineIndex]
  const base = lines.slice(0, lineIndex).reduce((length, item) => length + item.length + 1, 0)
  const cells = tableRowCells(line)
  const cell = cells[columnIndex]
  if (cell) return { from: base + cell.from, to: base + cell.to, value: cell.value, prefix: '', suffix: '' }
  const trimmed = line.trimEnd()
  const trailingPipe = trimmed.endsWith('|') && trimmed.at(-2) !== '\\'
  const prefix = `${trailingPipe ? ' ' : ' | '}${' | '.repeat(columnIndex - cells.length)}`
  return { from: base + trimmed.length, to: base + trimmed.length, value: '', prefix, suffix: trailingPipe ? ' |' : '' }
}

export const cellInputValue = value => value.replace(/\\\|/g, '|')
export const cellSourceValue = value => value.replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>')

/* ---------------- 列宽持久化（不污染 md 源码，存插件 storage） ---------------- */

const WIDTH_KEY = 'md-table-widths'
const widthsByTable = new Map()
let loading
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
  if (widthsByTable.size > 256) widthsByTable.delete(widthsByTable.keys().next().value)
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

export function loadPersistedWidths() {
  if (!loading) loading = readWidths()
  return loading
}

async function readWidths() {
  const api = window.enest || window.zapi
  if (!api?.storage?.get) return
  try {
    const obj = await api.storage.get(WIDTH_KEY)
    if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj).slice(-256)) {
        if (!widthsByTable.has(key) && Array.isArray(value) && value.every(width => Number.isFinite(width) && width > 0)) widthsByTable.set(key, value)
      }
    }
  } catch { /* 忽略 */ }
}

export { hashTable }
