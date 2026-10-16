/** Acceptance guards are local snapshots, never a reason to run another database request. */
export function completionScopeIdentity(scope) {
  return JSON.stringify([scope.connectionId, scope.consoleId, scope.sessionKey, scope.documentId,
    scope.surface, scope.generation, scope.configRevision, scope.dialect, scope.database,
    scope.schema, scope.searchPath, scope.contextKnown, scope.connected, scope.sessionContextRevision])
}

const identity = (table, scope) => [table.database ?? scope.database ?? '', table.schema ?? scope.schema ?? '', table.type || 'table', table.name, !!table.temporary]
const objectKey = (table, scope) => JSON.stringify(identity(table, scope))

export function dependencySnapshot(dependencies, catalog, scope) {
  const tables = catalog.tables || []
  return dependencies.map(dependency => {
    const key = objectKey(dependency, scope)
    const table = tables.find(candidate => objectKey(candidate, scope) === key)
    if (dependency.mode === 'identity') return JSON.stringify(table ? identity(table, scope) : null)
    // A new same-name object can make an unqualified reference ambiguous. Unrelated
    // objects and their lazy field reads do not retire an otherwise valid candidate.
    const competing = tables.filter(candidate => String(candidate.name).toLowerCase() === String(dependency.name).toLowerCase()).map(candidate => objectKey(candidate, scope)).sort()
    return JSON.stringify([table || null, competing])
  })
}
