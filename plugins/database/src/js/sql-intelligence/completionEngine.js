import { getDialect } from '@db/sql-intelligence/dialects/registry.js'
import { analyzeSql as analyze } from '@db/sql-intelligence/syntax/cursorContext.js'
import { createCatalogContext } from '@db/sql-intelligence/providers/catalogContext.js'
import { objectProvider } from '@db/sql-intelligence/providers/objectProvider.js'
import { columnProvider } from '@db/sql-intelligence/providers/columnProvider.js'
import { functionProvider, keywordProvider, enumProvider } from '@db/sql-intelligence/providers/functionProvider.js'
import { projectionProvider } from '@db/sql-intelligence/providers/projectionProvider.js'
import { relationProvider } from '@db/sql-intelligence/providers/relationProvider.js'
import { templateProvider, templateTableNeeds } from '@db/sql-intelligence/providers/templateProvider.js'
import { diagnosticProvider } from '@db/sql-intelligence/providers/diagnosticProvider.js'
import { activeSignature, signatureProvider } from '@db/sql-intelligence/providers/signatureProvider.js'
import { rankCandidates } from '@db/sql-intelligence/ranking/rankCandidates.js'
import { resolveConfig } from '@db/sql-intelligence/configuration/resolveConfig.js'

const providers = [objectProvider, columnProvider, functionProvider, keywordProvider, enumProvider, projectionProvider, relationProvider, templateProvider, signatureProvider]

export function analyzeSql(sql, cursor, dialect = 'mysql') { return analyze(String(sql || ''), cursor, typeof dialect === 'object' && dialect.quoteIdentifier ? dialect : getDialect(dialect)) }

/** Pure, deterministic completion: no store, network, DOM or editor dependency. */
export function buildCompletion(request, options = {}) {
  if (String(request.sql || '').length > 500000) return { items: [], replace: { from: request.cursor, to: request.cursor }, isIncomplete: false, context: { limited: true, reason: '当前脚本超过 500000 字符，请拆分文档以启用智能提示' }, requiredTables: [], diagnostics: [] }
  const dialect = getDialect(request.dialect || 'mysql')
  const analysis = analyzeSql(request.sql, request.cursor, dialect)
  let config = options.config || {}
  const catalog = options.catalog || { tables: [] }
  const metadata = createCatalogContext(analysis, request, catalog)
  const singleTable = analysis.scope.tables.length === 1 ? metadata.resolveTable(analysis.scope.tables[0]) : null
  if (singleTable && config.profiles?.some(profile => profile.scope?.table)) {
    const { _sources, ...input } = config
    config = resolveConfig(input, {
      ...request, dialectId: dialect.id, table: singleTable.name,
      database: Object.hasOwn(singleTable, 'database') ? singleTable.database : request.database,
      schema: Object.hasOwn(singleTable, 'schema') ? singleTable.schema : request.schema
    })
  }
  const context = { analysis, metadata, request, config, catalog, boundTable: singleTable }
  const requiredTables = [...metadata.requiredTables, ...templateTableNeeds(context)].filter((table, index, all) => all.findIndex(other => other.name === table.name && other.database === table.database && other.schema === table.schema) === index)
  const all = analysis.suppressed ? [] : providers.flatMap(provider => provider(context))
  const ranked = rankCandidates(all, analysis, config, options.usage)
  const limit = Math.max(1, Math.min(Number(config.behavior?.maxItems) || 100, 500))
  return {
    items: ranked.slice(0, limit).map(item => ({ ...item, editPlan: { ...item.editPlan, documentId: request.documentId, expectedModelVersion: request.modelVersion, expectedCatalogRevision: catalog.revision } })),
    replace: { from: analysis.identifier.from, to: analysis.identifier.to },
    isIncomplete: ranked.length > limit || requiredTables.length > 0,
    context: { clause: analysis.clause, scopeId: analysis.scope.id, suppressed: analysis.suppressed, dialect: dialect.id, capabilities: dialect.capabilities, statement: analysis.statement, prefix: analysis.identifier.prefix, qualifier: analysis.identifier.qualifier },
    requiredTables,
    metadataDependencies: metadata.dependencies,
    config: config.behavior,
    diagnostics: analysis.suppressed ? [] : diagnosticProvider(context)
  }
}

export function signatureHelp(request, options = {}) {
  const analysis = analyzeSql(request.sql, request.cursor, request.dialect)
  const metadata = createCatalogContext(analysis, request, options.catalog)
  const boundTable = analysis.scope.tables.length === 1 ? metadata.resolveTable(analysis.scope.tables[0]) : null
  const result = activeSignature(analysis, options.config || {}, request, boundTable)
  return result ? { activeSignature: 0, activeParameter: result.active.parameter, signatures: result.signatures } : null
}

export { getDialect } from '@db/sql-intelligence/dialects/registry.js'
