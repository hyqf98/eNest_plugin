const textValue = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item) : String(value)
const mysqlDriver = driver => /^(mysql|mariadb|tidb|oceanbase|doris|starrocks)$/.test(driver || '')

export function toCsv(cols, rows, { bom = true, delimiter = ',', headers = true } = {}) {
  const cell = value => { const text = textValue(value); return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text }
  return (bom ? '\uFEFF' : '') + [...(headers ? [cols] : []), ...rows].map(row => row.map(cell).join(delimiter)).join('\r\n')
}

export function toJson(cols, rows, { nullAsNull = true } = {}) {
  if (new Set(cols).size !== cols.length) return JSON.stringify({ columns: cols, rows }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2)
  return JSON.stringify(rows.map(row => Object.fromEntries(cols.map((column, i) => [column, row[i] == null ? nullAsNull ? null : '' : row[i]]))), (_key, value) => typeof value === 'bigint' ? String(value) : value, 2)
}

export function quoteExportIdentifier(name, driver = 'mysql') {
  const quote = mysqlDriver(driver) ? '`' : /^(mssql|sqlserver)$/.test(driver) ? '[' : '"'
  return quote === '[' ? `[${String(name).replaceAll(']', ']]')}]` : quote + String(name).replaceAll(quote, quote + quote) + quote
}

export function exportSqlLiteral(value, driver = 'mysql') {
  if (value == null) return 'NULL'
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('SQL 导出不支持非有限数值'); return String(value) }
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return /^(sqlite|mssql|sqlserver|oracle)$/.test(driver) ? value ? '1' : '0' : value ? 'TRUE' : 'FALSE'
  const text = textValue(value)
  // MySQL backslash behavior depends on sql_mode. Hex text preserves control characters in both modes.
  if (mysqlDriver(driver) && /[\\\x00-\x1f]/.test(text)) return `CONVERT(X'${[...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, '0')).join('')}' USING utf8mb4)`
  if (text.includes('\0')) throw new Error('此数据库的 SQL 文本不能包含 NUL，请使用 JSON 导出')
  if (/^(postgres|postgresql|timescale)$/.test(driver) && /[\\\r\n\t]/.test(text)) return `E'${text.replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}'`
  return `${/^(mssql|sqlserver)$/.test(driver) ? 'N' : ''}'${text.replaceAll("'", "''")}'`
}

export function toSql(cols, rows, tableRef, { transaction = true, batchSize = 100, driver = 'mysql' } = {}) {
  if (new Set(cols).size !== cols.length) throw new Error('SQL 导出要求字段名唯一，请在查询中为重复列设置别名')
  const scope = mysqlDriver(driver) ? tableRef?.database || tableRef?.schema : tableRef?.schema || (driver === 'sqlite' && ['main', 'temp'].includes(tableRef?.database) ? tableRef.database : '')
  const table = [scope, tableRef?.table || 'exported_table'].filter(Boolean).map(name => quoteExportIdentifier(name, driver)).join('.')
  if (transaction && /^(clickhouse|doris|starrocks)$/.test(driver)) throw new Error('此数据库不支持通用事务导出，请取消“SQL 文件包含事务语句”')
  const output = transaction && driver !== 'oracle' ? [mysqlDriver(driver) ? 'START TRANSACTION;' : /^(mssql|sqlserver)$/.test(driver) ? 'BEGIN TRANSACTION;' : 'BEGIN;'] : []
  const size = driver === 'oracle' ? 1 : Math.max(1, Math.min(1000, Number(batchSize) || 100))
  for (let i = 0; i < rows.length; i += size) {
    const values = rows.slice(i, i + size).map(row => `(${row.map(value => exportSqlLiteral(value, driver)).join(', ')})`).join(',\n  ')
    output.push(`INSERT INTO ${table} (${cols.map(name => quoteExportIdentifier(name, driver)).join(', ')}) VALUES\n  ${values};`)
  }
  if (transaction) output.push('COMMIT;')
  return output.join('\n')
}

export function toMarkdown(cols, rows) {
  const cell = value => value == null ? 'NULL' : textValue(value).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>')
  return [`| ${cols.map(cell).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n')
}
export function toTsv(cols, rows, options = {}) { return toCsv(cols, rows, { ...options, bom: false, delimiter: '\t' }) }
export function buildExport(format, cols, rows, tableRef, prefs = {}) {
  const stem = String(prefs.filename || `result-${Date.now()}`).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\.(csv|json|sql|md|tsv)$/i, '') || 'result'
  const builders = {
    csv: () => toCsv(cols, rows, { bom: prefs.exportBom !== false, delimiter: prefs.delimiter || ',', headers: prefs.headers !== false }),
    tsv: () => toTsv(cols, rows, { headers: prefs.headers !== false }),
    json: () => toJson(cols, rows),
    sql: () => toSql(cols, rows, tableRef, { driver: prefs.driver || 'mysql', transaction: prefs.transaction !== false }),
    md: () => toMarkdown(cols, rows)
  }
  const type = format === 'markdown' ? 'md' : builders[format] ? format : 'csv'
  return { filename: `${stem}.${type}`, content: builders[type]() }
}
