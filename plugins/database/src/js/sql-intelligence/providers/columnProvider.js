import { candidate } from '@db/sql-intelligence/edits/editPlanner.js'

export function columnProvider({ analysis, metadata, config }) {
  if (!['select', 'where', 'on', 'having', 'order', 'group', 'insertColumns', 'updateSet'].includes(analysis.clause)) return []
  const { dialect, identifier } = analysis
  let references = analysis.references
  if (['insertColumns', 'updateSet'].includes(analysis.clause)) references = references.filter(reference => reference.target)
  if (identifier.qualifier) references = references.filter(reference => dialect.matches(reference.alias, identifier.qualifier, identifier.qualifierParts.at(-1)?.quoted) || dialect.matches(reference.name, identifier.qualifier, identifier.qualifierParts.at(-1)?.quoted))
  const written = new Set()
  if (analysis.clause === 'insertColumns') {
    const target = references[0]
    for (const token of analysis.scope.tokens) if (token.start > (target?.end || Infinity) && token.end <= identifier.from && token.kind === 'word') written.add(dialect.normalize(token.value, token.quoted))
  } else if (analysis.clause === 'updateSet') {
    const before = analysis.scope.tokens.filter(token => token.end <= identifier.from)
    for (let index = 0; index < before.length - 1; index++) if (before[index + 1].value === '=') written.add(dialect.normalize(before[index].value, before[index].quoted))
  }
  return references.flatMap(reference => metadata.columnsFor(reference).filter(column => {
    if (written.has(dialect.normalize(column.name))) return false
    if (['insertColumns', 'updateSet'].includes(analysis.clause) && (column.generated || column.isGenerated || column.computed || column.identity && analysis.clause === 'updateSet')) return false
    return true
  }).map(column => {
    const qualified = !identifier.qualifier && references.length > 1
    const bare = dialect.quoteIdentifier(column.name)
    const name = qualified ? `${dialect.quoteIdentifier(reference.alias)}.${bare}` : bare
    const insertText = analysis.clause === 'updateSet' ? `${name} = ` : name
    const table = metadata.resolveTable(reference)
    const type = column.type || column.dataType || ''
    const flags = [column.pk || column.primaryKey ? 'PK' : '', column.nullable === false ? '必填' : '', column.defaultValue !== undefined && column.defaultValue !== null ? '有默认值' : '', column.generated || column.isGenerated ? '生成列' : ''].filter(Boolean)
    return candidate(analysis, { id: `column:${table ? metadata.objectId(table) : `document/${reference.scopeId}/${reference.name}`}:${reference.alias}:${column.name}`, kind: 'column', label: qualified ? `${reference.alias}.${column.name}` : column.name, insertText, filterText: `${column.name} ${config.behavior?.commentSearch === false ? '' : column.comment || ''}`, owner: reference.name, detail: [reference.alias || reference.name, type, ...flags, column.comment].filter(Boolean).join(' · '), presentation: { type, description: [...flags, column.comment || reference.alias || reference.name].filter(Boolean).join(' · ') }, semanticRank: 120, reason: identifier.qualifier ? '当前别名的字段' : '当前查询作用域的字段' })
  }))
}
