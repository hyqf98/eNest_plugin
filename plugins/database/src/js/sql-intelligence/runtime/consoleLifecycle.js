/** Keep engine identity even when the host reports a compatible wire-protocol dialect. */
export const completionDialect = connection => connection?.driver || connection?.dialect || 'mysql'

/** A pending/failed close must never make an uncertain console look newly connected. */
export function createCompletionConsoleLifecycle({ sessionKeys, generations, contexts, close, invalidate }) {
  const pending = new Map()
  const retire = scope => { void Promise.resolve().then(() => invalidate(scope, '控制台正在断开或已关闭')).catch(() => {}) }
  return {
    isClosing: consoleId => pending.has(consoleId),
    close(consoleId, scope) {
      if (pending.has(consoleId)) return pending.get(consoleId)
      const sessionKey = sessionKeys.get(consoleId)
      const context = contexts.get(consoleId)
      generations.set(consoleId, (generations.get(consoleId) || 0) + 1)
      const task = Promise.resolve().then(async () => {
        retire(scope)
        try {
          if (sessionKey) await close(sessionKey)
          if (sessionKeys.get(consoleId) === sessionKey) sessionKeys.delete(consoleId)
          contexts.delete(consoleId)
          return sessionKey
        } catch (error) {
          // An RPC failure does not prove whether the native session closed. Keep its handle
          // available for retry, but only an actual reconnect may restore known context.
          contexts.set(consoleId, { contextKnown: false, sessionContextRevision: (context?.sessionContextRevision || 0) + 1 })
          throw error
        } finally {
          retire(scope)
          pending.delete(consoleId)
        }
      })
      pending.set(consoleId, task)
      return task
    }
  }
}
