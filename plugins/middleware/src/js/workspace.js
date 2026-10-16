import { normalizeRequest } from './protocol.js'

/** Serializable task identities; connection names never participate in identity. */
export const taskId = (connectionId, pageId) => pageId === 'settings' ? 'workspace:settings' : `${encodeURIComponent(connectionId)}:${pageId}`
export const PAGE_IDS = ['overview', 'topics', 'messages', 'groups', 'monitor', 'trace', 'publish']

export function restoreTasks(ui, connections) {
  const byId = new Map(connections.map(connection => [connection.id, connection]))
  const source = Array.isArray(ui.workspace?.tabs)
    ? ui.workspace.tabs
    : (ui.openTabs || []).map(connectionId => ({ connectionId, pageId: ui.lastPage?.[connectionId] || 'overview' }))
  const seen = new Set()
  return source.filter(task => {
    if (task?.pageId === 'settings') {
      if (seen.has('workspace:settings')) return false
      seen.add('workspace:settings'); return true
    }
    const connection = byId.get(task?.connectionId)
    if (!connection || !PAGE_IDS.includes(task.pageId) || task.pageId === 'trace' && connection.kind !== 'rocketmq') return false
    const id = taskId(task.connectionId, task.pageId)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }).map(({ connectionId, pageId }) => ({ id: taskId(connectionId, pageId), connectionId: pageId === 'settings' ? null : connectionId, pageId }))
}

/** Bound API prevents callbacks and late responses from following another active tab. */
export function bindTaskApi(api, sessionKey, { isAlive = () => true, mode = 'shell', readOnly = false, kind } = {}) {
  const writeActions = /^(messages\.(send|resend)|topic\.(create|update|delete|purge)|exchange\.(create|delete)|binding\.(create|delete)|partitions\.grow|configs\.alter|group\.resetOffsets|client\.kick|retained\.delete)$/
  return {
    ...api,
    async mw(action, input = {}) {
      if (!isAlive() && action !== 'tail.stop') throw new Error('此任务已关闭，请重新打开')
      if ((mode === 'quick' || readOnly) && writeActions.test(action)) throw new Error('当前工作区为只读，无法执行写操作')
      const request = normalizeRequest(action, input, kind)
      const result = await api.mw(action, { ...request, sessionKey, surface: mode })
      if (!isAlive() && action !== 'tail.stop') {
        if (action === 'tail.start') await api.mw('tail.stop', { sessionKey, tailId: input.tailId, surface: mode }).catch(() => {})
        throw new Error('此任务已关闭，已忽略旧响应')
      }
      return result
    },
    session: Object.fromEntries(['get', 'set', 'remove'].map(operation => [operation, (key, value) => api.session[operation](`${sessionKey}:${key}`, value)]))
  }
}
