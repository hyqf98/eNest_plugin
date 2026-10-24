const USER_INPUT_TIMEOUT = 24 * 60 * 60 * 1000

/** Plugin-owned compatibility shape. Never mutate the frozen contextBridge API. */
export function createDatabaseApi(host) {
  if (!host) return null
  const timeoutFor = (method, args) => {
    const action = method === 'db.workbench' ? args[0]?.action : undefined
    if (method === 'db.cancel' || method === 'db.close' || action === 'cancel') return 250
    if (method === 'db.test' || action === 'test') return 15_000
    if (method === 'db.importRun') return 600_000
    if (method.startsWith('db.pick')) return USER_INPUT_TIMEOUT
    if (method === 'db.execute' || action === 'execute') {
      const input = action ? args[0].input : args[0]
      return Math.max(250, Math.min(600_000, Number(input?.timeoutMs) || 30_000)) + 500
    }
    return method === 'db.workbench' ? 60_000 : 30_000
  }
  const call = async (method, args = []) => {
    if (!host.backend?.call) throw new Error('eNest 0.2.2 native backend API is required')
    // User-paced native consent must not spend a query/cancellation deadline.
    const action = method === 'db.workbench' ? args[0]?.action : undefined
    const stopping = method === 'db.cancel' || method === 'db.close' || action === 'cancel'
    // Cancellation must reach its host deadline even when a synchronous driver cannot
    // answer an authorization preflight. The actual operation still rechecks consent.
    if (!stopping) await host.backend.call('db.authorize', [{ method, ...(action ? { action } : {}) }], { timeoutMs: USER_INPUT_TIMEOUT })
    try { return await host.backend.call(method, args, { timeoutMs: timeoutFor(method, args) }) }
    catch (error) {
      if (stopping && /timed out|timeout/i.test(String(error?.message || error))) {
        // A blocked synchronous native driver cannot process its own cancel message.
        await host.backend.stop()
      }
      throw error
    }
  }
  const completion = input => call('db.completion.suggest', [input])
  completion.suggest = completion
  return { ...host, db: {
    workbench: request => call('db.workbench', [request]),
    test: config => call('db.test', [config]), open: input => call('db.open', [input]),
    close: key => call('db.close', [key]), listSessions: () => call('db.listSessions'),
    pickSqliteFile: (options = {}) => call('db.pickSqliteFile', [options]),
    pickImportFile: () => call('db.pickImportFile'),
    execute: input => call('db.execute', [input]), explain: input => call('db.explain', [input]),
    cancel: input => call('db.cancel', [input]), applyChanges: input => call('db.applyChanges', [input]),
    importPreview: input => call('db.importPreview', [input]), importRun: input => call('db.importRun', [input]),
    schema: { tree: input => call('db.schema.tree', [input]), describe: input => call('db.schema.describe', [input]),
      ddl: input => call('db.schema.ddl', [input]) },
    completion, dialects: { list: () => call('db.dialects.list') }
  } }
}
