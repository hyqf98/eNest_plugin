/** Clipboard and value conversion helpers shared by the grid's local edit paths. */
export function parseGridTsv(text, maxCells = 10000) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  if (source.length > 1024 * 1024) throw new Error('单次粘贴不能超过 1 MB')
  const rows = []; let row = [], value = '', quoted = false, cells = 0
  const field = () => { if (++cells > maxCells) throw new Error(`单次粘贴不能超过 ${maxCells} 个单元格`); row.push(value); value = '' }
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char === '"') { if (source[index + 1] === '"') { value += '"'; index++ } else quoted = false }
      else value += char
    } else if (char === '"' && value === '') quoted = true
    else if (char === '\t') field()
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index++
      field(); rows.push(row); row = []
    } else value += char
  }
  if (quoted) throw new Error('粘贴内容的引号没有闭合')
  if (value !== '' || row.length || !rows.length) { field(); rows.push(row) }
  if (rows.some(item => item.length !== rows[0].length)) throw new Error('粘贴区域的每一行必须有相同列数')
  return rows
}

export function gridTsv(rows) {
  return rows.map(row => row.map(value => {
    const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
    return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }).join('\t')).join('\n')
}

export function coerceGridValue(value, column) {
  if (value == null || typeof value !== 'string') return value
  const type = String(column?.dataType || column?.type || '').toLowerCase()
  if (value === '') return value
  if (/bool/.test(type)) {
    if (/^(true|1)$/i.test(value)) return true
    if (/^(false|0)$/i.test(value)) return false
    throw new Error(`${column.name} 需要 true / false 或 1 / 0`)
  }
  if (/int|serial/.test(type) && /^[+-]?\d+$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : value
  }
  if (/float|double|real/.test(type) && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (/json/.test(type)) { try { return JSON.parse(value) } catch { throw new Error(`${column.name} 需要有效 JSON`) } }
  // Keep decimal/numeric and large integers as text so clipboard edits never lose precision.
  return value
}

export function quoteGridIdentifier(value, dialect = 'mysql') {
  const text = String(value ?? '')
  if (/sqlserver|mssql/i.test(dialect)) return `[${text.replace(/]/g, ']]')}]`
  if (/mysql|mariadb|tidb|clickhouse|doris|starrocks|tdengine/i.test(dialect)) return '`' + text.replace(/`/g, '``') + '`'
  return '"' + text.replace(/"/g, '""') + '"'
}
