/** SQL product identity stays separate from wire-protocol compatibility. */
const commonKeywords = 'SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON USING AS AND OR NOT NULL IS IN EXISTS BETWEEN LIKE GROUP BY ORDER HAVING LIMIT OFFSET DISTINCT UNION ALL CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE WITH ASC DESC'.split(' ')
const commonFunctions = [
  { name: 'COUNT', parameters: ['expression'], returns: 'number', description: '统计行数或非空表达式。' },
  { name: 'SUM', parameters: ['expression'], returns: 'number' },
  { name: 'AVG', parameters: ['expression'], returns: 'number' },
  { name: 'MIN', parameters: ['expression'] }, { name: 'MAX', parameters: ['expression'] },
  { name: 'COALESCE', parameters: ['value', 'fallback', '...values'] },
  { name: 'LOWER', parameters: ['text'], returns: 'string' },
  { name: 'UPPER', parameters: ['text'], returns: 'string' }
]
const definitions = {
  mysql: { quote: '`', qualifier: 'database', functions: [{ name: 'IFNULL', parameters: ['value', 'fallback'] }, { name: 'DATE_FORMAT', parameters: ['date', 'format'] }, { name: 'NOW', parameters: [] }] },
  mariadb: { base: 'mysql' }, tidb: { base: 'mysql' }, oceanbase: { base: 'mysql' }, doris: { base: 'mysql' }, starrocks: { base: 'mysql' },
  postgres: { quote: '"', fold: 'lower', functions: [{ name: 'DATE_TRUNC', parameters: ['precision', 'timestamp'], returns: 'temporal' }, { name: 'STRING_AGG', parameters: ['value', 'delimiter'] }, { name: 'NOW', parameters: [] }], keywords: ['RETURNING', 'ILIKE', 'CONFLICT', 'LATERAL', 'FILTER', 'OVER'] },
  postgresql: { base: 'postgres' }, timescale: { base: 'postgres' }, cockroachdb: { base: 'postgres' }, yugabytedb: { base: 'postgres' }, questdb: { base: 'postgres' },
  sqlite: { quote: '"', functions: [{ name: 'STRFTIME', parameters: ['format', 'time', '...modifiers'] }, { name: 'DATETIME', parameters: ['time', '...modifiers'] }], keywords: ['PRAGMA', 'RETURNING', 'GLOB'] },
  duckdb: { quote: '"', keywords: ['QUALIFY', 'EXCLUDE', 'REPLACE'] },
  mssql: { quote: '[', pagination: 'top', keywords: ['TOP', 'OUTPUT', 'APPLY'] }, sqlserver: { base: 'mssql' },
  oracle: { quote: '"', fold: 'upper', pagination: 'fetch', keywords: ['FETCH', 'FIRST', 'ROWS', 'ONLY', 'MINUS'] },
  clickhouse: { quote: '`', keywords: ['PREWHERE', 'ARRAY', 'FINAL'] },
  tdengine: { quote: '`', keywords: ['INTERVAL', 'SLIDING', 'FILL', 'STABLE'] },
  influxql: { quote: '"', keywords: ['MEASUREMENTS', 'SLIMIT', 'FILL'] },
  cassandra: { quote: '"', keywords: ['ALLOW', 'FILTERING', 'TTL'] }
}
const certifiedStructure = new Set(['mysql', 'postgres', 'sqlite'])

export function getDialect(value = 'mysql', options = {}) {
  const id = String(typeof value === 'object' ? value.id || value.dialectId : value).toLowerCase()
  const definition = definitions[id]
  const baseId = definition?.base || id
  const base = definitions[baseId] || {}
  const descriptor = { ...base, ...definition, ...options }
  const known = !!definition
  const quote = descriptor.quote || '"'
  const reserved = new Set([...commonKeywords, ...(descriptor.keywords || []), 'TABLE', 'VIEW', 'USER', 'KEY', 'PRIMARY', 'REFERENCES', 'CREATE', 'ALTER', 'DROP'])
  if (['top', 'fetch'].includes(descriptor.pagination)) reserved.delete('LIMIT')
  return {
    id, baseId, known, family: 'sql', version: options.version || null,
    statementRules: { ...(descriptor.statementRules || {}) },
    capabilities: { lexical: known, objects: known, scopes: certifiedStructure.has(id), projectionRewrite: certifiedStructure.has(id), relationships: known, signatures: known, diagnostics: certifiedStructure.has(id) },
    keywords: known ? [...reserved] : commonKeywords,
    functions: known ? [...commonFunctions, ...(descriptor.functions || [])] : [],
    qualifier: descriptor.qualifier || 'schema',
    normalize(name, quoted = false) {
      const text = String(name || '')
      if (quoted) return text
      return descriptor.fold === 'upper' ? text.toUpperCase() : text.toLowerCase()
    },
    matches(actual, requested, quoted = false) {
      if (quoted && descriptor.fold) return String(actual) === String(requested)
      if (descriptor.fold && !quoted) return String(actual) === this.normalize(requested)
      return String(actual).toLowerCase() === String(requested).toLowerCase()
    },
    quoteIdentifier(name) {
      const text = String(name)
      const folded = descriptor.fold === 'lower' ? text.toLowerCase() : descriptor.fold === 'upper' ? text.toUpperCase() : text
      if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(text) && !reserved.has(text.toUpperCase()) && text === folded) return text
      const close = quote === '[' ? ']' : quote
      return quote + text.split(close).join(close + close) + close
    },
    literal(value) {
      if (value === null) return 'NULL'
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      if (typeof value === 'boolean') return id === 'sqlite' || descriptor.pagination === 'top' ? value ? '1' : '0' : value ? 'TRUE' : 'FALSE'
      return "'" + String(value).replaceAll("'", "''") + "'"
    },
    select(columns, table, limit) {
      const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200
      if (descriptor.pagination === 'top') return `SELECT TOP (${count}) ${columns}\nFROM ${table};`
      if (descriptor.pagination === 'fetch') return `SELECT ${columns}\nFROM ${table}\nFETCH FIRST ${count} ROWS ONLY;`
      return `SELECT ${columns}\nFROM ${table}\nLIMIT ${count};`
    }
  }
}

export function listDialects() { return Object.keys(definitions).map(id => getDialect(id)) }

/** A new dialect can be registered without changing providers. */
export function registerDialect(id, definition) {
  if (!id || !definition || typeof definition !== 'object') throw new TypeError('方言定义无效')
  definitions[id] = { ...definition }
}
