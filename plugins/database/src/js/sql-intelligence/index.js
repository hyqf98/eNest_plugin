import { createMetadataService, metadataScopeKey } from '@db/sql-intelligence/metadata/index.js'
import { normalizeConfig, resolveConfig } from '@db/sql-intelligence/configuration/index.js'
import { EngineClient, analysisTaskKey } from '@db/sql-intelligence/runtime/EngineClient.js'
import { sessionEffects } from '@db/sql-intelligence/runtime/sessionEffects.js'
import { completionScopeIdentity, dependencySnapshot } from '@db/sql-intelligence/runtime/CompletionTicket.js'

// This allowlist is the Worker boundary: credentials, connection options and host handles never cross it.
export function engineRequest(request) {
  const result = { sql: String(request.sql || ''), cursor: Number.isFinite(request.cursor) ? request.cursor : 0 }
  for (const key of ['dialect', 'database', 'schema', 'connectionId', 'consoleId', 'documentId']) if (typeof request[key] === 'string') result[key] = request[key]
  for (const key of ['modelVersion', 'contextRevision', 'sessionContextRevision']) if (Number.isFinite(request[key])) result[key] = request[key]
  if (typeof request.contextKnown === 'boolean') result.contextKnown = request.contextKnown
  if (Array.isArray(request.searchPath)) result.searchPath = request.searchPath.filter(value => typeof value === 'string')
  return result
}
const sessionId = scope => JSON.stringify([scope.connectionId, scope.consoleId || scope.sessionKey, scope.surface, scope.generation || 0])
const uncertainTables = state => {
  state.tables = new Map([...state.tables].map(([key, table]) => [key, { ...table, columns: [], columnsLoaded: false, state: 'unknown', reason: '会话中的临时结构尚未确认，请重新创建或连接' }]))
}
function applySessionOperations(state, effects, scope) {
  for (const operation of effects.operations) {
    if (operation.kind === 'begin' && !state.transactionBase) { state.transactionBase = new Map(state.tables); state.savepoints.clear() }
    else if (operation.kind === 'commit') {
      for (const [name, table] of state.tables) if (table.onCommitDrop && effects.transactionalTemporary) state.tables.delete(name)
      state.transactionBase = null; state.savepoints.clear()
    }
    else if (operation.kind === 'rollback') {
      if (effects.transactionalTemporary) {
        if (state.transactionBase) state.tables = new Map(state.transactionBase)
        else uncertainTables(state)
      }
      state.transactionBase = null; state.savepoints.clear()
    } else if (operation.kind === 'savepoint' && operation.name) state.savepoints.set(operation.name, new Map(state.tables))
    else if (operation.kind === 'rollbackTo') {
      if (effects.transactionalTemporary) {
        const snapshot = state.savepoints.get(operation.name)
        if (snapshot) state.tables = new Map(snapshot)
        else uncertainTables(state)
      }
      let after = false
      for (const name of state.savepoints.keys()) { if (after) state.savepoints.delete(name); if (name === operation.name) after = true }
    } else if (operation.kind === 'release') state.savepoints.delete(operation.name)
    else if (operation.kind === 'uncertain') uncertainTables(state)
    else if (operation.kind === 'temporary') {
      const table = operation.table
      if (table.onCommitDrop && effects.transactionalTemporary && !state.transactionBase) continue
      if (!(operation.ifNotExists && state.tables.has(table.name))) state.tables.set(table.name, { ...table, database: table.database || scope.database })
    } else if (operation.kind === 'drop') {
      const table = state.tables.get(operation.name)
      if (table && (!operation.schema || operation.schema === table.schema || ['temp', 'pg_temp'].includes(operation.schema))) state.tables.delete(operation.name)
    }
  }
}

export class CompletionRuntime {
  constructor(options = {}) {
    this.options = options; this.engine = options.engineClient || new EngineClient(); this.sessions = new Map(); this.epoch = 0; this.disposed = false
    this.configurationGeneration = 0; this.requestSequence = 0; this.requests = new Map()
    this.metadata = createMetadataService(options)
  }
  configure(options) {
    if (this.options === options) return this
    const previous = this.metadata
    this.options = options; this.metadata = createMetadataService(options); this.epoch++; this.configurationGeneration++
    this.cancelRequests()
    void previous.dispose().catch(() => {})
    return this
  }
  scope(input = {}) {
    const scope = { ...this.options.getScope?.(input.sessionKey), ...input }
    const session = this.sessions.get(sessionId(scope))
    return { ...scope, contextKnown: scope.contextKnown !== false && !session?.unknown, sessionContextRevision: Math.max(scope.sessionContextRevision || 0, session?.revision || 0) }
  }
  config(scope, raw, legacy) {
    try { return resolveConfig(normalizeConfig(raw, legacy), { ...scope, dialectId: scope.dialect }) }
    catch (error) { const config = resolveConfig(normalizeConfig(null, legacy), { ...scope, dialectId: scope.dialect }); config._configurationError = error.message; return config }
  }
  catalog(input) {
    const scope = this.scope(input), snapshot = this.metadata.getSnapshot(scope)
    const temporary = [...(this.sessions.get(sessionId(scope))?.tables.values() || [])]
    return { ...snapshot, tables: snapshot.tables.concat(temporary), reason: !scope.contextKnown ? '会话设置已变化；重新连接后恢复结构补全' : snapshot.reason }
  }
  captureMetadataRead(input) {
    return { epoch: this.epoch, scopeKey: metadataScopeKey(this.scope(input)) }
  }
  metadataReadCurrent(input, ticket) {
    const scope = this.scope(input)
    return !!ticket && !this.disposed && scope.connected && scope.contextKnown && ticket.epoch === this.epoch && ticket.scopeKey === metadataScopeKey(scope)
  }
  publishMetadataTable(input, ref, detail, ticket) {
    const scope = this.scope(input)
    if (this.disposed || !scope.connected || !scope.contextKnown) return false
    if (ticket && !this.metadataReadCurrent(scope, ticket)) return false
    this.metadata.publishTable(scope, ref, detail)
    return true
  }
  ticketedResult(result, scope, catalog, config) {
    if (!result?.items) return result
    const common = { scope: completionScopeIdentity(scope), connectionEpoch: this.metadata.connectionEpoch(scope.connectionId), configurationGeneration: this.configurationGeneration, config: JSON.stringify(config) }
    const defaultDependencies = result.metadataDependencies || []
    const defaultSnapshots = dependencySnapshot(defaultDependencies, catalog, scope)
    return { ...result, items: result.items.map(item => {
      const dependencies = item.metadataDependencies || defaultDependencies
      const snapshots = item.metadataDependencies ? dependencySnapshot(dependencies, catalog, scope) : defaultSnapshots
      return { ...item, _completionTicket: { ...common, dependencies, snapshots } }
    }) }
  }
  validateItem(item, input, { rawConfig, legacy, modelVersion } = {}) {
    const ticket = item?._completionTicket, scope = this.scope(input)
    if (!ticket || this.disposed || ticket.scope !== completionScopeIdentity(scope)) return false
    if (ticket.configurationGeneration !== this.configurationGeneration || ticket.connectionEpoch !== this.metadata.connectionEpoch(scope.connectionId)) return false
    if (ticket.config !== JSON.stringify(this.config(scope, rawConfig, legacy))) return false
    const expectedVersion = item.editPlan?.expectedModelVersion
    if (expectedVersion !== undefined && expectedVersion !== modelVersion) return false
    const snapshots = dependencySnapshot(ticket.dependencies, this.catalog(scope), scope)
    return snapshots.length === ticket.snapshots.length && snapshots.every((snapshot, index) => snapshot === ticket.snapshots[index])
  }
  cancelRequests(connectionId, consoleId) {
    for (const [key, request] of this.requests) if ((!connectionId || request.connectionId === connectionId) && (!consoleId || request.consoleId === consoleId)) { request.retire(); this.requests.delete(key); this.engine.cancel?.(key) }
  }
  async complete(input, { rawConfig, legacy, usage, method = 'complete', waitForMetadata = false, channel = method === 'signature' ? 'signature' : 'completion', signal } = {}) {
    const scope = this.scope(input), config = this.config(scope, rawConfig, legacy), epoch = this.epoch
    const key = analysisTaskKey(method, scope, channel), sequence = ++this.requestSequence
    this.requests.get(key)?.retire()
    this.engine.cancel?.(key)
    let retire
    const retired = new Promise(resolve => { retire = () => resolve(null) })
    this.requests.set(key, { sequence, connectionId: scope.connectionId, consoleId: scope.consoleId, retire })
    const abort = () => { if (this.requests.get(key)?.sequence === sequence) { retire(); this.requests.delete(key); this.engine.cancel?.(key) } }
    signal?.addEventListener('abort', abort, { once: true })
    this.metadata.ttlMs = config.metadata.ttlMs
    this.metadata.columnTtlMs = config.metadata.ttlMs
    this.metadata.maxObjects = config.metadata.maxObjects
    const current = () => !this.disposed && !signal?.aborted && epoch === this.epoch && this.requests.get(key)?.sequence === sequence
    const stale = () => method === 'signature' ? null : { items: [], diagnostics: [], requiredTables: [], isIncomplete: false, stale: true, _unified: true, requestEpoch: epoch, reason: '查询上下文已改变，请重新触发补全' }
    try {
      if (!current()) return stale()
      if (waitForMetadata) await Promise.race([this.metadata.ensureObjects(scope), retired])
      if (!current()) return stale()
      let catalog = this.catalog(scope)
      const execute = () => Promise.race([this.engine.run(method, engineRequest(scope), { config, catalog, usage }, { key, signal }), retired])
      let result = await execute()
      if (!current() || result?.cancelled) return stale()
      if (!result || method === 'signature') return result
      if (waitForMetadata && result.requiredTables?.length) {
        await Promise.race([this.metadata.ensureColumns(scope, result.requiredTables), retired])
        if (!current()) return stale()
        catalog = this.catalog(scope); result = await execute()
        if (!current() || result?.cancelled) return stale()
      }
      else if (current() && scope.connected && scope.contextKnown) {
        if (config.metadata.prefetch === 'referenced') void this.metadata.ensureColumns(scope, result.requiredTables || []).catch(() => {})
        if (catalog.status === 'unloaded' || catalog.status === 'stale') void this.metadata.ensureObjects(scope).catch(() => {})
      }
      return this.ticketedResult({ ...result, _unified: true, config: result.config || config.behavior, catalogStatus: catalog.status, reason: config._configurationError || result.reason || catalog.reason, requestEpoch: epoch }, scope, catalog, config)
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.requests.get(key)?.sequence === sequence) this.requests.delete(key)
    }
  }
  async invalidate(input, reason) {
    this.epoch++
    const connectionId = typeof input === 'string' ? input : input?.connectionId
    this.cancelRequests(connectionId)
    for (const [key, value] of this.sessions) if (!input?.preserveSession && value.connectionId === connectionId && (typeof input === 'string' || !input?.consoleId || value.consoleId === input.consoleId)) this.sessions.delete(key)
    void this.metadata.invalidate(connectionId, reason).catch(() => {})
  }
  async record(input, { sql, success }) {
    const scope = this.scope(input), id = sessionId(scope), effects = sessionEffects(sql, scope.dialect, success)
    let state = this.sessions.get(id)
    if (!state) { state = { tables: new Map(), savepoints: new Map(), transactionBase: null, revision: scope.sessionContextRevision || 0, unknown: scope.contextKnown === false, connectionId: scope.connectionId, consoleId: scope.consoleId }; this.sessions.set(id, state) }
    if (effects.unknown) state.unknown = true
    applySessionOperations(state, effects, scope)
    if (effects.unknown || effects.invalidate || effects.operations.length) {
      state.revision++; this.epoch++
      this.cancelRequests(scope.connectionId, effects.unknown || effects.invalidate ? undefined : scope.consoleId)
    }
    if (effects.invalidate || effects.unknown) void this.metadata.invalidate(scope.connectionId, effects.unknown ? '会话设置已变化；重新连接后恢复结构补全' : '结构已变化，将重新读取').catch(() => {})
    return { contextChanged: effects.unknown || effects.invalidate || effects.operations.length > 0, contextKnown: !state.unknown, sessionContextRevision: state.revision }
  }
  async dispose() { this.disposed = true; this.epoch++; this.cancelRequests(); this.engine.dispose(); this.sessions.clear(); await this.metadata.dispose() }
}
