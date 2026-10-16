import { candidate } from '@db/sql-intelligence/edits/editPlanner.js'
import { qualifiedTable } from './catalogContext.js'
import { hasKnownRelation } from './relationshipMetadata.js'

export function objectProvider(context) {
  const { analysis, metadata, request, config } = context
  if (!analysis.expectsTable) return []
  const { dialect, identifier } = analysis
  const qualifier = identifier.qualifier
  const joinPosition = analysis.scope.ownTokens.filter(token => token.end <= identifier.from).findLast(token => ['FROM', 'JOIN', 'WHERE', 'ON'].includes(token.upper))?.upper === 'JOIN'
  const boundTables = joinPosition ? analysis.references.filter(reference => reference.end < identifier.from).map(reference => metadata.resolveTable(reference)).filter(Boolean) : []
  const items = metadata.allTables.filter(table => !['denied', 'failed'].includes(table.state)).filter(table => {
    if (qualifier) return dialect.matches(dialect.qualifier === 'database' ? table.database || request.database : table.schema || '', qualifier)
    return !table.database || !request.database || table.database === request.database || dialect.qualifier === 'database'
  }).map(table => {
    let insertText = qualifier ? dialect.quoteIdentifier(table.name) : qualifiedTable(table, dialect, request)
    // Alias insertion is only safe if the user has not already written one after the replacement.
    const after = analysis.tokens.find(token => token.start >= identifier.to && token.start > identifier.from && token.kind !== 'comment')
    const hasFollowingAlias = after?.kind === 'identifier' || after?.upper === 'AS' || after?.kind === 'word' && !dialect.keywords.includes(after.upper)
    if (config.behavior?.autoAlias && analysis.clause === 'table' && !hasFollowingAlias) {
      const seed = table.name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0]).join('').toLowerCase() || 't'
      let alias = seed, count = 1
      while (analysis.references.some(reference => reference.alias.toLowerCase() === alias)) alias = seed + ++count
      insertText += ` AS ${dialect.quoteIdentifier(alias)}`
    }
    const related = boundTables.some(bound => metadata.objectId(bound) !== metadata.objectId(table) && hasKnownRelation(bound, table, dialect))
    const description = [table.schema || table.database, related ? '已知外键关联' : '', table.comment].filter(Boolean).join(' · ')
    return candidate(analysis, { id: `object:${metadata.objectId(table)}`, kind: table.type === 'view' ? 'view' : 'table', label: table.name, insertText, filterText: `${table.name} ${config.behavior?.commentSearch === false ? '' : table.comment || ''}`, owner: table.schema || table.database, detail: [table.schema || table.database, table.type || 'table', table.comment].filter(Boolean).join(' · '), presentation: { type: table.type === 'view' ? 'view' : 'table', description }, metadataDependencies: [{ name: table.name, database: table.database, schema: table.schema, type: table.type || 'table', temporary: !!table.temporary, mode: 'identity' }], semanticRank: related ? 170 : 100, reason: related ? '与当前查询表存在已知外键关系' : '当前 FROM / JOIN 对象' })
  })
  if (!qualifier) {
    for (let scope = analysis.scope; scope; scope = scope.parent) for (const cte of scope.ctes) items.push(candidate(analysis, { kind: 'table', label: cte.name, insertText: dialect.quoteIdentifier(cte.name), detail: '当前语句 CTE', source: 'document', semanticRank: 115 }))
  }
  return items
}
