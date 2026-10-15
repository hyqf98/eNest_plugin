/** Identity deliberately preserves identifier case: database rules differ by driver/server. */
export function captureScope(scope = {}) {
  return {
    ...scope,
    connectionId: String(scope.connectionId || scope.connection?.id || ''),
    surface: scope.surface || 'shell',
    connection: scope.connection ? { ...scope.connection, options: { ...scope.connection.options } } : undefined
  }
}

export function metadataScopeKey(scope = {}) {
  return JSON.stringify([
    scope.connectionId || scope.connection?.id || '', scope.configRevision ?? 0,
    scope.consoleId || '', scope.generation ?? 0, scope.surface || 'shell',
    scope.database || '', scope.schema || '', scope.dialect || '', scope.sessionContextRevision ?? 0
  ])
}

export function tableReference(scope, ref) {
  const value = typeof ref === 'string' ? { name: ref } : ref || {}
  return {
    name: String(value.name || value.table || ''),
    database: value.database ?? scope.database,
    schema: value.schema ?? scope.schema,
    type: value.type || 'table'
  }
}

export function metadataObjectId(scope, ref) {
  const value = tableReference(scope, ref)
  return JSON.stringify([scope.connectionId || '', value.database || '', value.schema || '', value.type, value.name])
}

export function unavailableReason(scope, disposed = false) {
  if (disposed) return { status: 'unavailable', reason: '补全元数据服务已关闭' }
  if (!(scope.connectionId || scope.connection?.id)) return { status: 'unavailable', reason: '尚未选择连接' }
  if (scope.contextKnown === false) return { status: 'unavailable', reason: '当前数据库上下文尚未确认' }
  if (scope.connected !== true) return { status: 'offline', reason: '尚未连接；连接后按需读取补全元数据' }
  return null
}
