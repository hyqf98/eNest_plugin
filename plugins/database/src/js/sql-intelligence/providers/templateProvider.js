import { candidate, compileSnippet } from '@db/sql-intelligence/edits/editPlanner.js'
import { scopeMatches, qualifiedTable } from './catalogContext.js'
import { visibleColumns } from './projectionProvider.js'

function templateEnabled(template, analysis, request, boundTable) {
  // A dynamic template chooses its object later in the table loop. Filtering
  // its namespace against the editor default would hide cross-schema targets.
  const { database: _database, schema: _schema, table: _table, ...sessionScope } = template.scope || {}
  const scope = template.generator === 'snippet' ? template.scope : sessionScope
  return !template.disabled && (!template.language || template.language === 'sql') && (!template.dialects?.length || template.dialects.includes(analysis.dialect.id)) && scopeMatches(scope, request, template.generator === 'snippet' ? boundTable : undefined)
}

function selectTemplates(config) {
  const builtins = [{ id: 'builtin.select-all', label: '查询全部字段', trigger: 'sel', generator: 'select', projection: { source: 'allColumns' }, limit: { value: 200 }, contexts: ['statementStart'] }]
  const user = config.templates || []
  return [...builtins.filter(item => !user.some(other => other.id === item.id)), ...user]
}

function matchesContext(template, analysis) {
  const aliases = { from: 'table', join: 'table', groupBy: 'group', orderBy: 'order', insert: 'insertColumns', update: 'updateSet', expression: 'select' }
  return (template.contexts || ['statementStart']).some(name => name === 'any' || (aliases[name] || name) === analysis.clause)
}

/** A typed table name requests at most five descriptions; a bare trigger never prewarms the catalog. */
export function templateTableNeeds({ analysis, metadata, config, request }) {
  if (request.contextKnown === false || analysis.identifier.qualifier || analysis.scope.tables.length) return []
  const tokens = analysis.scope.tokens.filter(token => token.kind !== 'comment')
  const first = tokens[0]?.value?.toLowerCase()
  const typedTemplate = selectTemplates(config).some(template => !template.disabled && template.trigger?.toLowerCase() === first)
  if (!(analysis.clause === 'select' || typedTemplate) || tokens.length < 2 || tokens.length > 4) return []
  const prefix = analysis.identifier.prefix.toLowerCase()
  if (!prefix) return []
  const matches = metadata.allTables.filter(table => table.name.toLowerCase().startsWith(prefix) && (!table.database || !request.database || table.database === request.database))
  const exact = matches.filter(table => table.name.toLowerCase() === prefix)
  return (exact.length ? exact : matches).sort((a, b) => Number(b.schema === request.schema) - Number(a.schema === request.schema)).slice(0, exact.length === 1 ? 1 : 5).filter(table => !table.temporary && (!table.columns?.length || ['unloaded', 'stale'].includes(table.state))).map(table => ({ name: table.name, database: table.database, schema: table.schema, type: table.type }))
}

export function templateProvider({ analysis, metadata, config, request, boundTable }) {
  if (analysis.identifier.qualifier || request.contextKnown === false || !analysis.dialect.known) return []
  const items = [], dialect = analysis.dialect
  const starting = analysis.clause === 'statementStart'
  const tableQuery = analysis.clause === 'select' && !analysis.scope.tables.length && !analysis.scope.parent
  const statementTokens = analysis.scope.tokens.filter(token => token.kind !== 'comment')
  for (const template of selectTemplates(config)) {
    if (!templateEnabled(template, analysis, request, boundTable)) continue
    if (!matchesContext(template, analysis) && !(tableQuery && template.generator === 'select')) continue
    if (template.generator === 'snippet') {
      const snippet = compileSnippet(template.body, { database: request.database || '', schema: request.schema || '' })
      items.push(candidate(analysis, { id: `template:${template.id}`, kind: 'snippet', label: template.trigger, filterText: `${template.trigger} ${template.label}`, insertText: snippet, detail: template.label, source: 'user', semanticRank: 140, editPlan: { from: analysis.identifier.from, to: analysis.identifier.to, text: snippet, snippet, additionalEdits: [] } }))
      continue
    }
    const typedTriggerAndTable = starting && statementTokens.length === 2 && statementTokens[0].value.toLowerCase() === template.trigger?.toLowerCase()
    const safeWholeStatement = starting && statementTokens.length <= 1 || typedTriggerAndTable || tableQuery && statementTokens.length <= 2 && statementTokens[0]?.upper === 'SELECT'
    if (!safeWholeStatement) continue
    for (const table of metadata.allTables) {
      if (!scopeMatches(template.scope, request, table) || ['failed', 'denied', 'truncated', 'unknown'].includes(table.state)) continue
      if (table.database && request.database && table.database !== request.database && dialect.qualifier !== 'database') continue
      const availableSets = (config.columnSets || []).filter(item => !item.disabled && scopeMatches(item.scope, request, table))
      const set = template.projection?.source === 'columnSet'
        ? template.projection.columnSetId
          ? availableSets.find(item => item.id === template.projection.columnSetId)
          : availableSets.find(item => item.default) || availableSets[0]
        : null
      if (template.projection?.source === 'columnSet' && !set) continue
      const ambiguousName = metadata.allTables.filter(item => item.name === table.name).length > 1
      const displayName = ambiguousName ? [table.schema || table.database, table.name].filter(Boolean).join('.') : table.name
      const identity = { id: `template:${template.id}:${metadata.objectId(table)}`, kind: 'snippet', label: `${template.trigger} · ${displayName}`, filterText: `${template.trigger} ${table.name} ${table.comment || ''} ${template.label}`, source: template.id.startsWith('builtin.') ? 'template' : 'user', semanticRank: table.schema === request.schema ? 135 : 125 }
      if (!table.columns?.length || ['stale', 'unloaded', 'loading'].includes(table.state)) {
        if (table.temporary) continue
        // A name-only candidate makes the cold catalog usable without describing
        // every table. Only explicitly accepting this target loads its columns.
        items.push(candidate(analysis, { ...identity, insertText: '', detail: `${template.label}${set ? ` · ${set.label}` : ''} · 选择后读取字段`, presentation: { type: '', description: `${template.label}${set ? ` · ${set.label}` : ''} · 选择后读取字段` }, metadataDependencies: [{ name: table.name, database: table.database, schema: table.schema, type: table.type || 'table', temporary: !!table.temporary, mode: 'identity' }], resolve: { kind: 'templateColumns', table: { name: table.name, database: table.database, schema: table.schema, type: table.type } }, editPlan: { from: analysis.cursor, to: analysis.cursor, text: '', additionalEdits: [] } }))
        continue
      }
      let columns = visibleColumns(table.columns)
      if (template.projection?.source === 'columnSet') {
        if (!set || set.columns.some(name => !table.columns.some(column => column.name === name))) continue
        columns = set.order === 'schema' ? table.columns.filter(column => set.columns.includes(column.name)) : set.columns.map(name => table.columns.find(column => column.name === name))
      }
      const tableName = qualifiedTable(table, dialect, request)
      let text
      if (template.generator === 'select') {
        const strategy = template.alias?.strategy
        const alias = strategy && strategy !== 'none' ? (strategy === 'initials' ? table.name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0]).join('') : table.name[0]).toLowerCase() || 't' : ''
        const prefix = alias ? dialect.quoteIdentifier(alias) + '.' : ''
        text = dialect.select(columns.map(column => prefix + dialect.quoteIdentifier(column.name)).join(', '), tableName + (alias ? ` AS ${dialect.quoteIdentifier(alias)}` : ''), template.limit?.value)
      }
      else if (template.generator === 'insert') {
        columns = columns.filter(column => !column.generated && !column.isGenerated && !column.identity && !column.autoIncrement)
        text = `INSERT INTO ${tableName} (${columns.map(column => dialect.quoteIdentifier(column.name)).join(', ')})\nVALUES (${columns.map((column, index) => '${' + (index + 1) + ':' + (column.defaultValue !== undefined ? 'DEFAULT' : 'NULL') + '}').join(', ')});$0`
      } else if (template.generator === 'update') {
        columns = columns.filter(column => !column.generated && !column.isGenerated && !column.identity && !column.pk && !column.primaryKey)
        text = `UPDATE ${tableName}\nSET ${columns.map((column, index) => dialect.quoteIdentifier(column.name) + ' = ${' + (index + 1) + ':NULL}').join(', ')}\nWHERE \${${columns.length + 1}:条件};$0`
      } else continue
      if (!columns.length) continue
      items.push(candidate(analysis, { ...identity, metadataDependencies: [{ name: table.name, database: table.database, schema: table.schema, type: table.type || 'table', temporary: !!table.temporary, mode: 'structure' }], insertText: text, detail: `${template.label}${set ? ` · ${set.label}` : ''} · ${columns.length} 个字段`, reason: '生成新查询，不自动执行', editPlan: { from: analysis.statement.start, to: analysis.statement.end, text, snippet: template.generator === 'select' ? undefined : text, additionalEdits: [] } }))
    }
  }
  return items
}
