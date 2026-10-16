import { candidate } from '@db/sql-intelligence/edits/editPlanner.js'
import { scopeMatches } from './catalogContext.js'

export function visibleColumns(columns) { return columns.filter(column => !column.hidden && !column.invisible && !column.isHidden && column.starVisible !== false) }

export function projectionProvider({ analysis, metadata, request, config }) {
  if (!analysis.dialect.capabilities.projectionRewrite || request.contextKnown === false || analysis.unsafeProjection || analysis.clause !== 'select') return []
  const { dialect, scope, cursor } = analysis
  const projection = scope.projections.find(item => item.star && item.start <= cursor && item.end >= cursor)
  const items = []
  const ready = reference => {
    const table = metadata.resolveTable(reference)
    return reference.derivedScope || table && !['stale', 'loading', 'unloaded', 'denied', 'failed', 'truncated'].includes(table.state) && Array.isArray(table.columns) && table.columns.length
  }
  if (projection && config.behavior?.starExpansion !== 'off') {
    const references = scope.tables.filter(reference => !projection.star.qualifier || dialect.matches(reference.alias, projection.star.qualifier))
    if (references.length && references.every(ready)) {
      const columns = references.flatMap(reference => visibleColumns(metadata.columnsFor(reference)).map(column => `${dialect.quoteIdentifier(reference.alias)}.${dialect.quoteIdentifier(column.name)}`))
      if (columns.length) items.push(candidate(analysis, { id: `projection:all:${scope.id}:${projection.start}`, kind: 'snippet', label: '展开全部可见字段', insertText: columns.join(', '), filterText: '', detail: `${columns.length} 个字段 · 保持数据库列序`, source: 'projection', semanticRank: 200, reason: '显式展开当前星号', editPlan: { from: projection.start, to: projection.end, text: columns.join(', '), additionalEdits: [] } }))
    }
  }
  for (const reference of scope.tables) {
    const table = metadata.resolveTable(reference)
    if (!table || !ready(reference)) continue
    for (const set of config.columnSets || []) {
      if (set.disabled || !scopeMatches(set.scope, request, table)) continue
      const missing = set.columns.filter(name => !table.columns.some(column => column.name === name))
      if (missing.length) continue
      const names = set.order === 'schema' ? table.columns.filter(column => set.columns.includes(column.name)).map(column => column.name) : set.columns
      const text = names.map(name => `${dialect.quoteIdentifier(reference.alias)}.${dialect.quoteIdentifier(name)}`).join(', ')
      if (!text) continue
      const range = projection ? { from: projection.start, to: projection.end } : { from: analysis.identifier.from, to: analysis.identifier.to }
      if (projection?.star.qualifier && !dialect.matches(reference.alias, projection.star.qualifier)) continue
      items.push(candidate(analysis, { id: `columnSet:${set.id}:${reference.alias}`, kind: 'snippet', label: `常用字段：${set.label}`, insertText: text, filterText: `${set.label} ${set.columns.join(' ')}`, detail: `${table.name} · ${names.length} 个字段`, source: 'columnSet', reason: '已配置的字段组', semanticRank: 160, editPlan: { ...range, text, additionalEdits: [] } }))
    }
  }
  return items
}
