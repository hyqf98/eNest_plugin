const controls = /[\x00-\x1f\x7f-\x9f]/
export const commandSnapshotKey = snapshot => snapshot ? JSON.stringify([snapshot.promptId, snapshot.revision, snapshot.text, snapshot.cursor, snapshot.cwd]) : ''

/** Prepare a single, append-only PTY write; no shell editing shortcuts are synthesized. */
export function prepareCommandAction(value, snapshot, execute = false) {
  const command = String(value ?? '')
  if (controls.test(command)) throw new Error('选中内容包含换行或控制字符，请复制后在终端检查；快速操作只接受单行命令')
  const text = command
  if (!text.trim()) throw new Error('请先选中一条命令')
  if (!snapshot || snapshot.cursor !== snapshot.text.length) throw new Error('请回到已启用提示、没有待回显输入的空闲命令行末尾')
  if (!text.startsWith(snapshot.text)) throw new Error('当前命令已有内容，请先清空，或复制命令后自行粘贴')
  const suffix = text.slice(snapshot.text.length)
  return { command: text, payload: suffix + (execute ? '\r' : ''), execute, snapshotKey: commandSnapshotKey(snapshot) }
}

/** Capture target and prompt before confirmation; revalidate after every asynchronous boundary. */
export function createCommandActions({ getSession, send, beforeExecute, onExecuted, onInserted, onError }) {
  async function run(value, { execute = false, target = getSession() } = {}) {
    try {
      if (!target?.sessionId || !target.term || getSession() !== target) throw new Error('目标会话已切换或断开，请重新选择命令')
      const sessionId = target.sessionId, term = target.term
      const plan = prepareCommandAction(value, term.readCommand?.(), execute)
      if (execute && beforeExecute && !await beforeExecute(plan.command, target)) return false
      if (getSession() !== target || target.sessionId !== sessionId || target.term !== term || commandSnapshotKey(term.readCommand?.()) !== plan.snapshotKey) throw new Error('命令行或目标会话已变化，本次操作已取消')
      if (plan.payload) {
        term.noteInput?.(plan.payload)
        try { await send(sessionId, plan.payload) }
        catch (error) { term.invalidateCommand?.(); throw error }
      }
      if (execute) onExecuted?.(plan.command, target)
      else onInserted?.(plan.command, target)
      if (getSession() === target) term.focus?.()
      return true
    } catch (error) { onError?.(error); return false }
  }
  async function history(direction, target = getSession()) {
    let sent = false
    try {
      if (![-1, 1].includes(direction) || !target?.sessionId || getSession() !== target || !target.term?.readCommand?.()) throw new Error('请回到已识别的空闲命令行后切换历史')
      const sessionId = target.sessionId, data = direction < 0 ? '\x1b[A' : '\x1b[B'
      target.term.noteInput?.(data)
      sent = true
      await send(sessionId, data)
      if (getSession() === target) target.term.focus?.()
      return true
    } catch (error) { if (sent) target?.term?.invalidateCommand?.(); onError?.(error); return false }
  }
  return { run, history, insert: (value, target) => run(value, { target }), execute: (value, target) => run(value, { execute: true, target }) }
}
