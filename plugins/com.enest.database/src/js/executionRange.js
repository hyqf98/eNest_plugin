import { planSqlScript } from '@db/executionParser.js'
import { getDialect } from '@db/sql-intelligence/dialects/registry.js'

const nonSql = /mongo|redis|elasticsearch|opensearch|influxdb|neo4j/i

/** Host-generated script grammar keeps caret, selection and execute-all boundaries identical. */
export function executionStatements(source, dialectValue = 'mysql') {
  const sql = String(source ?? '')
  const dialect = typeof dialectValue === 'object' ? dialectValue : getDialect(dialectValue)
  return planSqlScript(sql, dialect.baseId || dialect.id, dialect.statementRules).map(unit => ({
    // A current custom-delimited routine is already server-ready. Sending its trailing
    // delimiter without the original DELIMITER command would change the host grammar.
    sql: unit.kind === 'directive' ? '' : unit.delimiter === ';' ? sql.slice(unit.start, unit.contentEnd) : unit.sql,
    start: unit.start,
    end: unit.end,
    kind: unit.kind,
    ...(unit.error ? { unsupportedReason: `第 ${unit.line}–${unit.endLine} 行：${unit.error}` } : {}),
    ...(unit.kind === 'directive' ? { directive: true } : {})
  }))
}

export function currentExecutionStatement(source, cursor, dialect = 'mysql') {
  const sql = String(source ?? ''), position = Math.max(0, Math.min(sql.length, Number(cursor) || 0))
  const statements = executionStatements(sql, dialect)
  if (!statements.length) return { sql: '', start: position, end: position }
  const matched = statements.find(statement => position >= statement.start && position < statement.end)
  if (matched && !matched.directive) return matched
  if (matched?.unsupportedReason) return matched
  if (matched?.directive) return [...statements].reverse().find(statement => !statement.directive && statement.end <= matched.start) || statements.find(statement => !statement.directive) || matched
  return statements.find(statement => !statement.directive && statement.start > position) || [...statements].reverse().find(statement => !statement.directive) || statements.at(-1)
}

/** Selected text always wins; otherwise run the caret statement. Whole document is explicit. */
export function resolveExecutionRange(source, { start = 0, end = start, cursor = start, mode = 'current', dialect = 'mysql' } = {}) {
  const sql = String(source ?? '')
  const from = Math.max(0, Math.min(sql.length, Math.min(start, end)))
  const to = Math.max(from, Math.min(sql.length, Math.max(start, end)))
  const selected = from !== to
  if (mode === 'all' || selected || nonSql.test(typeof dialect === 'string' ? dialect : dialect.id)) {
    const range = mode === 'all' || !selected ? { sql, start: 0, end: sql.length } : { sql: sql.slice(from, to), start: from, end: to }
    if (!nonSql.test(typeof dialect === 'string' ? dialect : dialect.id)) {
      const unsupported = executionStatements(range.sql, dialect).find(statement => statement.unsupportedReason)
      if (unsupported) range.unsupportedReason = unsupported.unsupportedReason
    }
    return range
  }
  return currentExecutionStatement(sql, cursor, dialect)
}
