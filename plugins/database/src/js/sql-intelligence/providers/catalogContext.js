import { cteFor } from '@db/sql-intelligence/syntax/scopeGraph.js'

export function objectId(table, request = {}) {
  return [request.connectionId || '', table.database || request.database || '', table.schema || request.schema || '', table.type || 'table', table.name].map(value => encodeURIComponent(value || '')).join('/')
}

export function createCatalogContext(analysis, request, catalog = {}) {
  const dialect = analysis.dialect
  const scopeById = new Map(analysis.scopes.map(scope => [scope.id, scope]))
  const allTables = Array.isArray(catalog.tables) ? catalog.tables : []
  const dependencies = new Map()
  const remember = table => {
    if (table) dependencies.set(objectId(table, request) + (table.temporary ? ':temporary' : ''), { name: table.name, database: table.database, schema: table.schema, type: table.type || 'table', temporary: !!table.temporary })
    return table
  }
  const tableMatches = reference => allTables.filter(table => {
    if (!dialect.matches(table.name, reference.name, reference.quoted)) return false
    if (table.temporary && (reference.database || reference.schema) && !['temp', 'pg_temp'].includes(reference.schema)) return false
    if (reference.database && !dialect.matches(table.database || request.database || '', reference.database, reference.parts?.at(-2)?.quoted)) return false
    if (reference.schema && !dialect.matches(table.schema || '', reference.schema, reference.parts?.at(-2)?.quoted)) return false
    if (!reference.database && table.database && request.database && table.database !== request.database) return false
    return !['denied', 'failed'].includes(table.state)
  })
  function resolveTable(reference) {
    const scope = scopeById.get(reference.scopeId) || analysis.scope
    // A virtual relation can shadow a physical table with exactly the same name.
    // It must not inherit that table's rules, enums, fields or metadata identity.
    if (reference.derivedScope || !reference.schema && !reference.database && cteFor(reference, scope, dialect)) return undefined
    const matches = tableMatches(reference)
    if (!reference.schema && !reference.database) {
      const temporary = matches.find(table => table.temporary)
      if (temporary) return remember(temporary)
    }
    if (matches.length <= 1) return remember(matches[0])
    const exactCase = matches.filter(table => table.name === reference.name)
    const candidates = exactCase.length ? exactCase : matches
    const searchPath = request.searchPath || (request.schema ? [request.schema] : [])
    for (const schema of searchPath) { const inSchema = candidates.filter(table => table.schema === schema); if (inSchema.length === 1) return remember(inSchema[0]) }
    return undefined // Ambiguous names are never silently resolved to the first table.
  }
  function columnsFor(reference, trail = new Set()) {
    const scope = scopeById.get(reference.scopeId) || analysis.scope
    const cte = !reference.schema && !reference.database ? cteFor(reference, scope, dialect) : null
    const virtualScope = reference.derivedScope || cte?.scope
    if (virtualScope) {
      if (trail.has(virtualScope.id)) return []
      const next = new Set(trail).add(virtualScope.id)
      if (cte?.columns.length) return cte.columns.map(name => ({ name, type: '', virtual: true }))
      return virtualScope.projections.flatMap(projection => {
        if (projection.name) return [{ name: projection.name, type: '', virtual: true }]
        if (!projection.star) return []
        const refs = virtualScope.tables.filter(table => !projection.star.qualifier || dialect.matches(table.alias, projection.star.qualifier))
        return refs.flatMap(table => columnsFor(table, next))
      })
    }
    return resolveTable(reference)?.columns || []
  }
  const requiredTables = analysis.referencedTables.filter(reference => {
    const scope = scopeById.get(reference.scopeId) || analysis.scope
    if (cteFor(reference, scope, dialect)) return false
    const table = resolveTable(reference)
    if (table?.temporary) return false
    // Do not issue metadata I/O for each character of an unknown FROM prefix.
    // References elsewhere in the statement and exact catalog names are settled.
    if (!table && reference.start <= analysis.cursor && reference.end >= analysis.cursor) return false
    return !table || !Array.isArray(table.columns) || !table.columns.length || ['unloaded', 'loading', 'stale', 'truncated'].includes(table.state)
  }).map(reference => {
    const table = resolveTable(reference)
    return table ? { name: table.name, database: table.database, schema: table.schema, type: table.type } : reference
  })
  return { allTables, resolveTable, columnsFor, requiredTables, get dependencies() { return [...dependencies.values()] }, objectId: table => objectId(table, request) }
}

export function scopeMatches(scope, request, table) {
  if (!scope) return true
  return ['connectionId', 'database', 'schema', 'dialectId', 'table'].every(key => {
    if (scope[key] === undefined || scope[key] === '') return true
    const actual = key === 'table' ? table?.name || request.table : key === 'dialectId' ? request.dialect?.id || request.dialect || request.dialectId : table && Object.hasOwn(table, key) ? table[key] : request[key]
    if (scope[key] === null) return actual == null || actual === ''
    return scope[key] === actual
  })
}

export function qualifiedTable(table, dialect, request) {
  const parts = []
  if (table.database && table.database !== request.database && dialect.qualifier === 'database') parts.push(table.database)
  if (table.schema && (table.schema !== request.schema || request.alwaysQualify)) parts.push(table.schema)
  parts.push(table.name)
  return parts.map(part => dialect.quoteIdentifier(part)).join('.')
}
