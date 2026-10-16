/** Resolve form scopes without borrowing another connection's namespace or console. */
export function settingsMetadataScope(input, active, connection, surface, explicit = false) {
  const same = active.connectionId === connection.id
  const namespace = key => input[key] === undefined
    ? (same ? active[key] ?? connection[key] : connection[key])
    : input[key] ?? '' // A rule's null is an explicitly absent namespace.
  return {
    ...input, connection, connectionId: connection.id, dialect: connection.driver,
    database: namespace('database'), schema: namespace('schema'), surface,
    consoleId: same ? active.consoleId : `settings:${connection.id}`,
    sessionKey: same ? active.sessionKey : '', generation: same ? active.generation : 0,
    configRevision: same ? active.configRevision : 0,
    sessionContextRevision: same ? active.sessionContextRevision : 0,
    contextKnown: same ? active.contextKnown : true, connected: explicit || same && active.connected
  }
}
