/** Editor/store adapter. SQL syntax, providers, metadata and configuration live in sql-intelligence/. */
import { DbHost } from './api.js'
import { state, bumpCompletionUsage, bumpScopedCompletionUsage } from './store.js'

const KIND_META = {
  keyword: { color: '#c792ea', label: '关键字', mark: 'K' },
  table: { color: '#82aaff', label: '表', mark: 'T' },
  view: { color: '#82aaff', label: '视图', mark: 'V' },
  column: { color: '#c3e88d', label: '列', mark: 'C' },
  function: { color: '#ffcb6b', label: '函数', mark: 'F' },
  database: { color: '#89ddff', label: '库', mark: 'D' },
  schema: { color: '#89ddff', label: '库', mark: 'S' },
  snippet: { color: '#f78c6c', label: '模板', mark: 'S' },
  alias: { color: '#f07178', label: '别名', mark: 'A' },
  measurement: { color: '#82aaff', label: '时序表', mark: 'M' }
}

export function kindMeta(kind) {
  return KIND_META[kind] || { color: '#9aa7b8', label: kind || '其它' }
}

// Thin compatibility facade. Engines and metadata stay independent of the store/editor.
let runtimePromise, runtimeOptions = {}, configResolver
let behaviorConfig, behaviorCache = new Map()
const runtime = () => runtimePromise ||= import('./sql-intelligence/index.js').then(({ CompletionRuntime }) => { const service = new CompletionRuntime(runtimeOptions); configResolver = service.config.bind(service); return service })
export function configureCompletionRuntime(options) { runtimeOptions = options; return runtime().then(service => service.configure(options)) }
export const getCompletionCatalog = scope => runtime().then(service => service.catalog(scope))
export const ensureCompletionColumns = (scope, refs) => runtime().then(service => service.metadata.ensureColumns(service.scope(scope), refs))
export const warmCompletionCatalog = scope => runtime().then(service => service.metadata.ensureObjects(service.scope(scope)))
export const captureCompletionMetadataRead = scope => runtime().then(service => service.captureMetadataRead(scope))
export const validateCompletionMetadataRead = (scope, ticket) => runtime().then(service => service.metadataReadCurrent(scope, ticket))
export const publishCompletionTable = (scope, ref, detail, ticket) => runtime().then(service => service.publishMetadataTable(scope, ref, detail, ticket))
export const invalidateCompletionContext = (scope, reason) => runtime().then(service => service.invalidate(scope, reason))
export const recordCompletionExecution = (scope, execution) => runtime().then(service => service.record(scope, execution))
export const disposeCompletionRuntime = () => runtimePromise?.then(service => service.dispose())
export const validateCompletionItem = (item, scope, options = {}) => runtime().then(service => service.validateItem(item, scope, { ...options, rawConfig: state.ui.completion, legacy: state.ui }))
let configGeneration = 0, lastConfiguration
export function completionContextKey(scope) {
  if (lastConfiguration !== state.ui.completion) { lastConfiguration = state.ui.completion; configGeneration++ }
  return JSON.stringify([configGeneration,scope.dialect, scope.searchPath, scope.configRevision, scope.sessionKey, scope.connectionId, scope.consoleId, scope.documentId, scope.database, scope.schema, scope.surface, scope.generation, scope.contextRevision, scope.sessionContextRevision, scope.contextKnown])
}
export function getCompletionBehavior(scope = {}) {
  if (behaviorConfig !== state.ui.completion) { behaviorConfig = state.ui.completion; behaviorCache.clear() }
  const key = JSON.stringify([scope.connectionId, scope.dialect, scope.database, scope.schema, scope.table, state.ui.autoAliasAfterTable, state.ui.learnUsage])
  if (behaviorCache.has(key)) return behaviorCache.get(key)
  const behavior = configResolver?.(scope, state.ui.completion, state.ui).behavior || { automatic: true, delayMs: 70, minPrefixLength: 1, acceptOnEnter: false, acceptOnTab: true, ...(state.ui.completion?.behavior || {}) }
  if (behaviorCache.size >= 32) behaviorCache.clear()
  behaviorCache.set(key, behavior)
  return behavior
}
export async function requestCompletion(request, options = {}) {
  const service = await runtime()
  const scope = service.scope(request)
  if (/mongo|redis|elasticsearch|opensearch|influx|neo4j/.test(request.dialect || '')) {
    if (options.method === 'signature') return null
    // Native languages keep their existing driver provider on an isolated read-only session.
    if (scope.connected !== true || scope.contextKnown === false) return { items: [], isIncomplete: false }
    const result = await service.metadata.withMetadataSession(scope, ({ sessionKey }) => DbHost.completion({ sessionKey, sql: request.sql, cursor: request.cursor, database: scope.database, schema: scope.schema }))
    return service.ticketedResult(result, scope, service.catalog(scope), service.config(scope, state.ui.completion, state.ui))
  }
  const usagePrefix = JSON.stringify([scope.connectionId, scope.dialect, scope.database || '', scope.schema || '']) + ':'
  const usage = Object.fromEntries(Object.entries(state.completionUsage).filter(([key]) => key.startsWith(usagePrefix)).map(([key, count]) => [key.slice(usagePrefix.length), count]))
  const result = await service.complete(request, { rawConfig: state.ui.completion, legacy: state.ui, usage, ...options })
  if (!result?.items) return result
  return { ...result, items: result.items.map(item => ({ ...item, _usageKey: usagePrefix + item.id, _learnUsage: result.config?.learnUsage !== false })) }
}
export const requestSignatureHelp = request => requestCompletion(request, { method: 'signature' })
export async function previewSqlCompletion({ text, cursorOffset, scope, config, catalog }) {
  const service = await runtime()
  const { engineRequest } = await import('./sql-intelligence/index.js')
  return service.engine.run('complete', engineRequest({ ...scope, dialect: scope.dialect || scope.dialectId, sql: text, cursor: cursorOffset }), { catalog, config: service.config(scope, config, state.ui), usage: {} })
}

export function applyCompletionItem(item) {
  if (item._learnUsage === false || item._learnUsage === undefined && getCompletionBehavior().learnUsage === false) return
  if (item._usageKey) bumpScopedCompletionUsage(item._usageKey)
  else bumpCompletionUsage(item.kind, item.owner, item.label)
}

/**
 * 子序列模糊匹配（与宿主 completion.ts fuzzyMatch 对齐）
 * 返回 { rank, ranges }：3=前缀 2=包含 1=子序列；ranges 为 label 内高亮下标
 */
export function fuzzyMatch(label, prefix) {
  if (!prefix) return { rank: 2, ranges: [] }
  const l = String(label).toLowerCase()
  const p = String(prefix).toLowerCase()
  const idx = l.indexOf(p)
  if (idx >= 0) {
    const ranges = []
    for (let i = 0; i < p.length; i++) ranges.push(idx + i)
    return { rank: idx === 0 ? 3 : 2, ranges }
  }
  const ranges = []
  let li = 0
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi]
    let found = -1
    while (li < l.length) {
      if (l[li] === ch) {
        found = li
        break
      }
      li++
    }
    if (found < 0) return null
    ranges.push(found)
    li = found + 1
  }
  return { rank: 1, ranges }
}

export function filterItems(items, prefix, limit = 80) {
  const p = (prefix || '').toLowerCase()
  if (!p) return items.slice(0, limit)
  const exact = []
  const start = []
  const sub = []
  for (const it of items) {
    const label = String(it.label || '').toLowerCase()
    const filter = String(it.filterText || it.label || '').toLowerCase()
    if (label === p || filter === p) {
      it._matchRanges = it.matchRanges || []
      exact.push(it)
    } else {
      // 优先 filterText（多表列带别名前缀时的裸列名），其次 label 子序列
      const fz = fuzzyMatch(filter, p) || fuzzyMatch(label, p)
      if (!fz) continue
      it._matchRanges = fz.ranges
      if (label.startsWith(p) || filter.startsWith(p)) start.push(it)
      else sub.push(it)
    }
  }
  return [...exact, ...start, ...sub].slice(0, limit)
}
