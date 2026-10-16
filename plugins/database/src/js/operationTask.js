import { state } from './store.js'

/** Serialize user database jobs while allowing metadata navigation to remain responsive. */
export async function runDatabaseTask(context, run) {
  if (state.runtime.executing) throw new Error('请等待当前数据库任务完成')
  const session = state.sessions.find((item) => state.runtime.consoleSessionKeys.get(item.id) === context.sessionKey)
  const task = { consoleId: session?.id, editorId: context.editorId || session?.activeEditorId, ...context }
  state.runtime.executing = true
  state.runtime.activeQuery = task
  document.dispatchEvent(new Event('database-task-changed'))
  try { return await run() }
  finally {
    if (state.runtime.activeQuery === task) { state.runtime.executing = false; state.runtime.activeQuery = null }
    document.dispatchEvent(new Event('database-task-changed'))
  }
}
