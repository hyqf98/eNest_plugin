import { analyzeSql } from '@db/sql-intelligence/syntax/cursorContext.js'
import { isName } from '@db/sql-intelligence/syntax/tokenizer.js'
import { cteFor } from '@db/sql-intelligence/syntax/scopeGraph.js'
import { getDialect } from '@db/sql-intelligence/dialects/registry.js'
import { createCatalogContext } from '@db/sql-intelligence/providers/catalogContext.js'

/** Extract physical field names, never output aliases or guessed expression inputs.
 * This is a text-only operation; the caller decides whether to read missing metadata.
 */
export function queryColumnSet(request, catalog = {}) {
  const dialect = getDialect(request.dialect), analysis = analyzeSql(request.sql, request.cursor, dialect)
  const scope = analysis.scope
  const unavailable = reason => ({ columns: [], requiredTables: [], reason })
  if (!scope.select || !scope.projections.length) return unavailable('请把查询光标放在需要保存字段的 SELECT 语句中。')
  if (scope.tables.length !== 1) return unavailable('当前查询块包含多张表或没有来源表。请为每张表分别维护字段组。')
  const reference = scope.tables[0]
  if (reference.derivedScope || cteFor(reference, scope, dialect)) return unavailable('CTE 和派生表的输出不直接保存为物理表字段组，请使用来源表查询。')
  const names = []
  for (const projection of scope.projections) {
    if (projection.star) return unavailable('请先在查询中展开星号，再保存需要的字段。')
    const tokens = projection.tokens.slice()
    const as = tokens.findIndex(token => token.upper === 'AS' && !token.quoted)
    if (as >= 0) {
      if (as !== tokens.length - 2 || !isName(tokens.at(-1))) return unavailable('查询包含尚未完成的字段别名。')
      tokens.splice(as)
    } else if (tokens.length > 1 && isName(tokens.at(-1)) && tokens.at(-2)?.value !== '.') tokens.pop()
    if (!tokens.length || tokens.length % 2 !== 1 || tokens.some((token, index) => index % 2 === 0 ? !isName(token) : token.value !== '.')) return unavailable('查询包含计算表达式。字段组只保存直接字段，请单独维护表达式模板。')
    const parts = tokens.filter((_, index) => index % 2 === 0)
    if (parts.length > 2 || parts.length === 2 && !dialect.matches(reference.alias, parts[0].value, parts[0].quoted)) return unavailable('字段限定名无法对应当前来源表，请使用一致的表别名。')
    names.push(parts.at(-1))
  }
  const metadata = createCatalogContext(analysis, request, catalog), table = metadata.resolveTable(reference)
  if (!table) return unavailable('来源表尚未读取或存在同名表，请先明确数据库／Schema 并读取表结构。')
  if (!table.columnsLoaded && !table.columns?.length || ['unloaded', 'loading', 'stale', 'truncated'].includes(table.state)) {
    return { columns: [], requiredTables: [{ name: table.name, database: table.database, schema: table.schema, type: table.type }], reason: '正在确认来源表字段…' }
  }
  const columns = []
  for (const name of names) {
    const matches = table.columns.filter(column => dialect.matches(column.name, name.value, name.quoted))
    if (matches.length !== 1) return unavailable(`无法确认字段“${name.value}”，没有更改字段组。`)
    if (!columns.includes(matches[0].name)) columns.push(matches[0].name)
  }
  // Empty namespaces must stay explicit: an empty string in a rule means
  // "any namespace", while null means this object's absent namespace.
  const namespace = key => (Object.hasOwn(table, key) ? table[key] : request[key]) || null
  return { columns, requiredTables: [], table: table.name, scope: { connectionId: request.connectionId, database: namespace('database'), schema: namespace('schema'), table: table.name } }
}
