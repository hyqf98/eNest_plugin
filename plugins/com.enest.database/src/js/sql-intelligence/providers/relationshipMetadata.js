/** Preserve grouped constraints: one relation can contain several paired columns. */
export function foreignKeyParts(key) {
  const columns = key.columns || (key.column ? [key.column] : [])
  const referencedColumns = key.refColumns || key.referencedColumns || key.targetColumns || (key.refColumn ? [key.refColumn] : [])
  return {
    columns: columns.map(column => typeof column === 'string' ? column : column.name),
    referencedColumns: referencedColumns.map(column => typeof column === 'string' ? column : column.name),
    table: key.refTable || key.referencedTable || key.targetTable,
    schema: key.refSchema || key.referencedSchema,
    database: key.refDatabase || key.referencedDatabase
  }
}

export function referencesTable(key, source, target, dialect) {
  const relation = foreignKeyParts(key)
  if (!relation.table || !dialect.matches(target.name, relation.table)) return false
  if (relation.database && target.database !== relation.database) return false
  if (relation.schema ? target.schema !== relation.schema : source.schema && target.schema && source.schema !== target.schema) return false
  return relation.columns.length > 0 && relation.columns.length === relation.referencedColumns.length
}

export function hasKnownRelation(left, right, dialect) {
  return [[left, right], [right, left]].some(([source, target]) => (source.foreignKeys || source.fks || []).some(key => referencesTable(key, source, target, dialect)))
}
