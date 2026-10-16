export function diagnosticProvider({ analysis, metadata, config }) {
  const diagnostics = []
  const severity = (key, fallback) => config.diagnostics?.[key] || fallback
  const push = (code, message, from, to, level) => { if (level !== 'off') diagnostics.push({ code, message, from, to, severity: level }) }
  for (const scope of analysis.scopes) {
    const aliases = new Set()
    for (const reference of scope.tables) {
      const alias = analysis.dialect.normalize(reference.alias, reference.aliasQuoted)
      if (aliases.has(alias)) push('duplicateAlias', `别名 ${reference.alias} 在同一查询块中重复`, reference.start, reference.aliasEnd || reference.end, severity('duplicateAlias', 'warning'))
      aliases.add(alias)
    }
    for (const projection of scope.projections) if (projection.star) push('selectStar', '可显式展开字段，或选择已配置的常用字段组', projection.start, projection.end, severity('selectStar', 'hint'))
  }
  if (['UPDATE', 'DELETE'].includes(analysis.statementKind) && !analysis.scope.ownTokens.some(token => token.upper === 'WHERE')) push('unsafeMutation', '当前修改语句没有 WHERE 条件；此提示不替代执行确认', analysis.statement.start, analysis.statement.end, severity('unsafeMutation', 'warning'))
  if (severity('unknownColumn', 'off') !== 'off') {
    for (const projection of analysis.scope.projections) {
      if (!projection.name || projection.tokens.some(token => token.upper === 'AS') || projection.tokens.some(token => token.value === '(')) continue
      const known = analysis.references.some(reference => metadata.columnsFor(reference).some(column => analysis.dialect.matches(column.name, projection.name, projection.quoted)))
      if (!known && analysis.references.length && !metadata.requiredTables.length) push('unknownColumn', `当前作用域未确认字段 ${projection.name}`, projection.start, projection.end, severity('unknownColumn', 'off'))
    }
  }
  return diagnostics
}
