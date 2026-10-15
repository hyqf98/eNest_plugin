import { captureScope, metadataScopeKey, metadataObjectId, tableReference, unavailableReason } from './MetadataIdentity.js'
import { normalizeTable, normalizeObjectList, metadataError } from './normalizeMetadata.js'
import { MetadataSessions, StaleMetadataError } from './MetadataSessions.js'

/**
 * Catalog discovery is independent of completion parsing and editor state.
 * All dependencies are injected; onUpdate(snapshot, scope) signals a new revision.
 * Snapshots contain metadata only, never credentials, sessions or query result rows.
 */
export class MetadataService {
  constructor({ open, close, listTables, describeTable, toConfig, onUpdate, now = Date.now,
    ttlMs = 60_000, columnTtlMs = 300_000, retryMs = 3_000, maxScopes = 16, maxObjects = 10_000 } = {}) {
    this.sessions = new MetadataSessions({ open, close, toConfig })
    this.listTables = listTables
    this.describeTable = describeTable
    this.onUpdate = onUpdate
    this.now = now
    this.ttlMs = ttlMs
    this.columnTtlMs = columnTtlMs
    this.retryMs = retryMs
    this.maxScopes = Math.max(1, maxScopes)
    this.maxObjects = maxObjects
    this.entries = new Map()
    this.epochs = new Map()
    this.revision = 0
    this.disposed = false
  }

  getSnapshot(scope = {}) {
    const key = metadataScopeKey(scope), entry = this.entries.get(key)
    if (entry) entry.lastAccess = this.now()
    const unavailable = unavailableReason(scope, this.disposed)
    const stale = entry?.objectsLoaded && this.now() - entry.objectsLoadedAt >= this.ttlMs
    const tables = [...(entry?.tables.values() || [])].map(table => {
      const expiredColumns = table.columnsLoaded && this.now() - (entry.columnLoadedAt.get(table.id) ?? entry.objectsLoadedAt) >= this.columnTtlMs
      return table.state === 'ready' && (stale || expiredColumns) ? Object.freeze({ ...table, state: 'stale' }) : table
    })
    return Object.freeze({
      scopeKey: key,
      revision: entry?.revision ?? this.revision,
      dialect: scope.dialect || '',
      database: scope.database,
      schema: scope.schema,
      databases: Object.freeze(scope.database ? [scope.database] : []),
      schemas: Object.freeze([...new Set([...(scope.schema ? [scope.schema] : []), ...(entry?.schemas || []), ...tables.map(table => table.schema).filter(Boolean)])]),
      tables: Object.freeze(tables),
      status: unavailable?.status || (stale && entry.status === 'ready' ? 'stale' : entry?.status || 'unloaded'),
      reason: unavailable?.reason || entry?.reason || '',
      complete: !!entry?.complete,
      updatedAt: entry?.updatedAt ?? null,
      pendingColumns: entry?.columnRequests.size || 0
    })
  }

  connectionEpoch(connectionId) { return this.epochs.get(connectionId) || 0 }

  async ensureObjects(scope) {
    if (unavailableReason(scope, this.disposed)) return this.getSnapshot(scope)
    const entry = this._entry(scope)
    if (entry.objectRequest) return entry.objectRequest
    if (entry.objectsLoaded && entry.maxObjects === this.maxObjects && this.now() - entry.objectsLoadedAt < this.ttlMs) return this.getSnapshot(scope)
    if (entry.objectsFailedAt != null && this.now() - entry.objectsFailedAt < this.retryMs) return this.getSnapshot(scope)
    if (typeof this.listTables !== 'function') {
      this._publish(entry, { status: 'unavailable', reason: '当前驱动没有提供对象目录接口' })
      return this.getSnapshot(scope)
    }
    entry.objectRequest = this.sessions.run(entry.key, entry.scope, () => this._current(entry), async ({ sessionKey }) => {
      return normalizeObjectList(await this.listTables({ sessionKey, database: entry.scope.database, schema: entry.scope.schema, maxObjects: this.maxObjects, isCurrent: () => this._current(entry) }))
    }).then(result => {
      if (!this._current(entry)) return
      const tables = new Map()
      const truncated = result.objects.length > this.maxObjects
      for (const item of result.objects.slice(0, this.maxObjects)) {
        const normalized = normalizeTable(entry.scope, item, item, Array.isArray(item.columns))
        const previous = entry.tables.get(normalized.id)
        tables.set(normalized.id, previous?.columnsLoaded ? Object.freeze({ ...previous, comment: normalized.comment || previous.comment }) : normalized)
      }
      entry.tables = tables
      entry.schemas = result.schemas
      entry.objectsLoaded = true
      entry.objectsLoadedAt = this.now()
      entry.maxObjects = this.maxObjects
      entry.objectsFailedAt = null
      this._publish(entry, { status: result.complete && !truncated ? 'ready' : 'partial', complete: result.complete && !truncated, reason: truncated ? `对象目录仅加载前 ${this.maxObjects} 项，查询引用的其他表仍可按需读取` : result.reason })
    }).catch(error => {
      if (!this._current(entry) || error?.code === 'STALE_METADATA') return
      entry.objectsFailedAt = this.now()
      this._publish(entry, metadataError(error))
    }).finally(() => { entry.objectRequest = null; this._prune(entry.key) }).then(() => this.getSnapshot(scope))
    this._publish(entry, { status: 'loading', reason: '' })
    return entry.objectRequest
  }

  async ensureColumns(scope, refs = []) {
    if (unavailableReason(scope, this.disposed) || !refs.length) return this.getSnapshot(scope)
    const entry = this._entry(scope)
    await this.ensureObjects(scope)
    if (!this._current(entry)) return this.getSnapshot(scope)
    const requests = refs.map(ref => this._ensureTable(entry, this._resolveReference(entry, ref)))
    await Promise.all(requests)
    return this.getSnapshot(scope)
  }

  /** Publish a successful tree/detail read without duplicating the database request. */
  publishTable(scope, ref, detail) {
    if (unavailableReason(scope, this.disposed)) return this.getSnapshot(scope)
    if (!detail || !Array.isArray(detail.columns)) return this.getSnapshot(scope)
    const entry = this._entry(scope), target = this._resolveReference(entry, ref)
    const table = normalizeTable(entry.scope, target, detail, true)
    if (!table.name) return this.getSnapshot(scope)
    entry.tables.set(table.id, table)
    entry.columnLoadedAt.set(table.id, this.now())
    entry.columnFailedAt.delete(table.id)
    // A direct describe is useful even when directory discovery is unavailable.
    this._publish(entry)
    return this.getSnapshot(scope)
  }

  /** Compatibility actions run on the same isolated, serial metadata queue. */
  async withMetadataSession(scope, action) {
    const unavailable = unavailableReason(scope, this.disposed)
    if (unavailable) throw Object.assign(new Error(unavailable.reason), { code: 'METADATA_UNAVAILABLE' })
    const entry = this._entry(scope)
    entry.activeActions++
    try { return await this.sessions.run(entry.key, entry.scope, () => this._current(entry), action) }
    finally { entry.activeActions--; this._prune(entry.key) }
  }

  async invalidate(connectionId, reason = '连接或对象目录已改变') {
    this.epochs.set(connectionId, (this.epochs.get(connectionId) || 0) + 1)
    this.revision++
    const retired = []
    for (const [key, entry] of this.entries) {
      if (entry.scope.connectionId !== connectionId) continue
      this.entries.delete(key)
      retired.push(this.sessions.retire(key))
      this._notify(Object.freeze({ ...this.getSnapshot(entry.scope), status: 'stale', reason }), entry.scope)
    }
    return Promise.allSettled(retired)
  }

  async dispose() {
    this.disposed = true
    this.entries.clear()
    this.revision++
    return this.sessions.dispose()
  }

  _entry(scope) {
    const key = metadataScopeKey(scope)
    let entry = this.entries.get(key)
    if (!entry) {
      const captured = captureScope(scope)
      entry = {
        key, scope: captured, epoch: this.epochs.get(captured.connectionId) || 0,
        tables: new Map(), columnLoadedAt: new Map(), columnFailedAt: new Map(), columnRequests: new Map(),
        objectsLoaded: false, objectsLoadedAt: 0, objectsFailedAt: null, objectRequest: null, activeActions: 0,
        status: 'unloaded', reason: '', complete: false, revision: this.revision, updatedAt: null,
        lastAccess: this.now()
      }
      this.entries.set(key, entry)
    }
    entry.lastAccess = this.now()
    this._prune(key)
    return entry
  }

  _current(entry) {
    return !this.disposed && this.entries.get(entry.key) === entry && entry.epoch === (this.epochs.get(entry.scope.connectionId) || 0)
  }

  _resolveReference(entry, ref) {
    const target = tableReference(entry.scope, ref)
    // SQLite and other drivers may supply a catalog namespace that was absent in the
    // connection config. Adopt its identity only when the directory match is unique.
    const candidates = [...entry.tables.values()].filter(table => table.name === target.name &&
      (!target.database || table.database === target.database) &&
      (!target.schema || table.schema === target.schema) && (!ref?.type || table.type === ref.type))
    if (candidates.length === 1) return { ...target, database: candidates[0].database, schema: candidates[0].schema, type: candidates[0].type }
    return target
  }

  _ensureTable(entry, ref) {
    if (!ref.name || !this._current(entry)) return Promise.resolve()
    const id = metadataObjectId(entry.scope, ref), table = entry.tables.get(id)
    if (entry.columnRequests.has(id)) return entry.columnRequests.get(id)
    if (table?.columnsLoaded && this.now() - (entry.columnLoadedAt.get(id) ?? entry.objectsLoadedAt) < this.columnTtlMs) return Promise.resolve()
    if (entry.columnFailedAt.has(id) && this.now() - entry.columnFailedAt.get(id) < this.retryMs) return Promise.resolve()
    if (typeof this.describeTable !== 'function') {
      entry.tables.set(id, Object.freeze({ ...(table || normalizeTable(entry.scope, ref)), state: 'unavailable', reason: '当前驱动没有提供字段描述接口' }))
      entry.columnFailedAt.set(id, this.now())
      this._publish(entry)
      return Promise.resolve()
    }
    entry.tables.set(id, Object.freeze({ ...(table || normalizeTable(entry.scope, ref)), state: 'loading', reason: '' }))
    const request = this.sessions.run(entry.key, entry.scope, () => this._current(entry), async ({ sessionKey }) => {
      const detail = await this.describeTable({ sessionKey, database: ref.database, schema: ref.schema, table: ref.name })
      if (!Array.isArray(detail?.columns)) throw new Error('数据库未返回可识别的字段列表')
      return detail
    }).then(detail => {
      if (!this._current(entry)) throw new StaleMetadataError()
      const current = entry.tables.get(id)
      entry.tables.set(id, normalizeTable(entry.scope, ref, { ...detail, comment: detail.comment || current?.comment }, true))
      entry.columnLoadedAt.set(id, this.now())
      entry.columnFailedAt.delete(id)
    }).catch(error => {
      if (!this._current(entry) || error?.code === 'STALE_METADATA') return
      const failure = metadataError(error)
      entry.tables.set(id, Object.freeze({ ...entry.tables.get(id), state: failure.status, reason: failure.reason }))
      entry.columnFailedAt.set(id, this.now())
    }).finally(() => { entry.columnRequests.delete(id); this._publish(entry); this._prune(entry.key) })
    entry.columnRequests.set(id, request)
    this._publish(entry)
    return request
  }

  _publish(entry, patch = {}) {
    if (!this._current(entry)) return
    Object.assign(entry, patch, { revision: ++this.revision, updatedAt: this.now() })
    this._notify(this.getSnapshot(entry.scope), entry.scope)
  }

  _notify(snapshot, scope) {
    try { this.onUpdate?.(snapshot, scope) } catch { /* A view subscriber cannot interrupt discovery. */ }
  }

  _prune(protectedKey) {
    if (this.entries.size <= this.maxScopes) return
    const candidates = [...this.entries.values()].filter(entry => entry.key !== protectedKey && !entry.objectRequest && !entry.columnRequests.size && !entry.activeActions).sort((a, b) => a.lastAccess - b.lastAccess)
    for (const entry of candidates) {
      if (this.entries.size <= this.maxScopes) break
      this.entries.delete(entry.key)
      void this.sessions.retire(entry.key).catch(() => {})
    }
  }
}

export function createMetadataService(options) { return new MetadataService(options) }
