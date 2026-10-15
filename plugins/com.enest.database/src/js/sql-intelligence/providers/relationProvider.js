import { candidate } from '@db/sql-intelligence/edits/editPlanner.js'
import { foreignKeyParts, referencesTable } from './relationshipMetadata.js'

export function relationProvider({ analysis, metadata, request }) {
  if (analysis.clause !== 'on' || analysis.identifier.qualifier || request.contextKnown === false) return []
  const refs = analysis.scope.tables.filter(reference => reference.start < analysis.cursor)
  const current = refs.at(-1)
  if (!current || refs.length < 2) return []
  const items = [], dialect = analysis.dialect
  for (const other of refs.slice(0, -1)) {
    for (const [source, target] of [[current, other], [other, current]]) {
      const table = metadata.resolveTable(source), targetTable = metadata.resolveTable(target)
      if (!table || !targetTable) continue
      for (const fk of table.foreignKeys || table.fks || []) {
        const relation = foreignKeyParts(fk)
        if (!referencesTable(fk, table, targetTable, dialect)) continue
        // Flattened individual columns cannot establish a compound constraint. Only grouped metadata is used as grouped SQL.
        const text = relation.columns.map((column, index) => `${dialect.quoteIdentifier(source.alias)}.${dialect.quoteIdentifier(column)} = ${dialect.quoteIdentifier(target.alias)}.${dialect.quoteIdentifier(relation.referencedColumns[index])}`).join(' AND ')
        items.push(candidate(analysis, { id: `relation:${source.alias}:${target.alias}:${fk.name || text}`, kind: 'snippet', label: text, insertText: text, detail: `外键 ${fk.name || ''}${relation.columns.length > 1 ? ` · ${relation.columns.length} 列联合约束` : ''}`, semanticRank: 180, source: 'foreignKey', reason: '数据库已声明的外键关系' }))
      }
    }
  }
  return items
}
