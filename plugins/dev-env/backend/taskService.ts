/**
 * taskService —— 长任务（安装/升级/清理/迁移）：spawn 子进程流式输出，
 * 经 backend 主动事件推送 task.output / task.end；task.cancel 走 SIGTERM→SIGKILL。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { pmAdapter, familyAdapter, runFamilyMigrate } from './registry'
import { assertSafeName } from './exec'
import type { TaskSpec } from './types'

const KILL_GRACE_MS = 4000
const MAX_LINE_BUFFER = 400

export interface TaskHandle {
  id: string
  label: string
  child?: ChildProcess
  cancelled: boolean
  finished: boolean
  lastLine: string
}

type Emit = (event: string, data: unknown) => void

const tasks = new Map<string, TaskHandle>()
let emitFn: Emit = () => {}
let nextTaskId = 1

export function setTaskEmitter(emit: Emit): void { emitFn = emit }

export function taskStatus(): { id: string; label: string; running: boolean }[] {
  return [...tasks.values()].map(task => ({ id: task.id, label: task.label, running: !task.finished }))
}

function taskLabel(spec: TaskSpec): string {
  switch (spec.kind) {
    case 'pm.install': return `安装 ${spec.name ?? ''}（${spec.pm}）`
    case 'pm.uninstall': return `卸载 ${spec.name ?? ''}（${spec.pm}）`
    case 'pm.upgrade': return spec.name ? `升级 ${spec.name}（${spec.pm}）` : `升级全部（${spec.pm}）`
    case 'pm.updateSource': return `更新源（${spec.pm}）`
    case 'pm.clean': return `清理（${spec.pm}）`
    case 'clean.run': return `清理（${spec.family}）`
    case 'migrate.run': return `迁移（${spec.family}）`
    default: return spec.kind
  }
}

/** 按任务种类构造命令行（spawn 子进程，输出流式转发）。 */
function commandFor(spec: TaskSpec): { cmd: string; args: string[] } {
  const pm = spec.pm
  switch (spec.kind) {
    case 'pm.install': {
      if (pm === 'brew') return spec.opts?.cask ? { cmd: 'brew', args: ['install', '--cask', assertSafeName(spec.name)] } : { cmd: 'brew', args: ['install', assertSafeName(spec.name)] }
      if (pm === 'winget') return { cmd: 'winget', args: ['install', '--id', assertSafeName(spec.name), '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements'] }
      if (pm === 'scoop') return { cmd: 'scoop.cmd', args: ['install', assertSafeName(spec.name)] }
      return { cmd: 'choco', args: ['install', assertSafeName(spec.name), '-y'] }
    }
    case 'pm.uninstall': {
      if (pm === 'brew') {
        const args = ['uninstall']
        if (spec.opts?.cask && spec.opts?.zap) args.push('--zap')
        if (spec.opts?.cask) args.push('--cask')
        return { cmd: 'brew', args: [...args, assertSafeName(spec.name)] }
      }
      if (pm === 'winget') return { cmd: 'winget', args: ['uninstall', '--id', assertSafeName(spec.name), '--exact', '--silent'] }
      if (pm === 'scoop') return spec.opts?.purge ? { cmd: 'scoop.cmd', args: ['uninstall', assertSafeName(spec.name), '--purge'] } : { cmd: 'scoop.cmd', args: ['uninstall', assertSafeName(spec.name)] }
      return { cmd: 'choco', args: ['uninstall', assertSafeName(spec.name), '-y'] }
    }
    case 'pm.upgrade': {
      if (pm === 'brew') return spec.name ? { cmd: 'brew', args: ['upgrade', assertSafeName(spec.name)] } : { cmd: 'brew', args: ['upgrade'] }
      if (pm === 'winget') return spec.name ? { cmd: 'winget', args: ['upgrade', '--id', assertSafeName(spec.name), '--exact', '--silent', '--include-unknown'] } : { cmd: 'winget', args: ['upgrade', '--all', '--include-unknown', '--silent'] }
      if (pm === 'scoop') return spec.name ? { cmd: 'scoop.cmd', args: ['update', assertSafeName(spec.name)] } : { cmd: 'scoop.cmd', args: ['update', '*'] }
      return spec.name ? { cmd: 'choco', args: ['upgrade', assertSafeName(spec.name), '-y'] } : { cmd: 'choco', args: ['upgrade', 'all', '-y'] }
    }
    case 'pm.updateSource': {
      if (pm === 'brew') return { cmd: 'brew', args: ['update'] }
      if (pm === 'scoop') return { cmd: 'scoop.cmd', args: ['update'] }
      throw new Error(`${pm} 不支持更新源`)
    }
    default:
      throw new Error(`任务种类 ${spec.kind} 不映射为独立命令`)
  }
}

function killTask(task: TaskHandle): void {
  const child = task.child
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }, KILL_GRACE_MS)
  timer.unref?.()
}

/** 启动长任务，返回 taskId；进度经 task.output / task.end 事件推送。 */
export function runTask(specInput: unknown): { taskId: string } {
  const spec = specInput as TaskSpec
  if (!spec || typeof spec !== 'object' || typeof spec.kind !== 'string') throw new Error('task.run 参数无效')
  const taskId = `task-${nextTaskId++}`
  const task: TaskHandle = { id: taskId, label: taskLabel(spec), cancelled: false, finished: false, lastLine: '' }
  tasks.set(taskId, task)
  if (tasks.size > 20) {
    for (const [id, entry] of tasks) {
      if (entry.finished) tasks.delete(id)
      if (tasks.size <= 20) break
    }
  }
  const output = (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue
      task.lastLine = line.slice(-500)
      emitFn('task', { type: 'task.output', taskId, chunk: line.slice(0, 2000) })
    }
  }
  const finish = (ok: boolean, note?: string) => {
    if (task.finished) return
    task.finished = true
    emitFn('task', { type: 'task.end', taskId, ok, note: note?.slice(0, 500) })
  }

  // 非命令类任务：清理（家族 adapter 的 command 回调）与迁移
  if (spec.kind === 'clean.run' || spec.kind === 'pm.clean') {
    void (async () => {
      try {
        const actions = spec.kind === 'clean.run'
          ? await familyAdapter(spec.family).cleanActions?.(String(spec.id ?? ''))
          : await pmAdapter(spec.pm).cleanActions?.()
        const action = actions?.find(item => item.id === spec.actionId)
        if (!action) throw new Error(`未找到清理项 ${spec.actionId}`)
        output(`执行：${action.label}`)
        const result = await action.command()
        output(result.note ?? (result.ok ? '完成' : '失败'))
        finish(result.ok, result.note)
      } catch (error) { finish(false, String((error as Error).message ?? error)) }
    })()
    return { taskId }
  }
  if (spec.kind === 'migrate.run') {
    void (async () => {
      try {
        output(`迁移 ${spec.family} → ${spec.target}`)
        const result = await runFamilyMigrate(String(spec.family), String(spec.id ?? ''), String(spec.target ?? ''), Boolean(spec.moveData))
        output(result.note ?? '完成')
        finish(result.ok, result.note)
      } catch (error) { finish(false, String((error as Error).message ?? error)) }
    })()
    return { taskId }
  }

  const { cmd, args } = commandFor(spec)
  if (spec.kind.startsWith('pm.')) void pmAdapter(spec.pm).available() // 触发白名单校验
  const child = spawn(cmd, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  task.child = child
  let lineBudget = MAX_LINE_BUFFER
  child.stdout?.on('data', chunk => { if (lineBudget-- > 0) output(String(chunk)) })
  child.stderr?.on('data', chunk => { if (lineBudget-- > 0) output(String(chunk)) })
  child.once('error', error => finish(false, `${cmd} 启动失败: ${String(error.message ?? error)}`))
  child.once('close', code => finish(code === 0, code === 0 ? `${task.label} 完成（exit ${code}）` : `${task.label} 失败（exit ${code}）${task.cancelled ? '，已取消' : ''}`))
  if (task.cancelled) killTask(task)
  return { taskId }
}

/** 取消任务：SIGTERM → SIGKILL；非子进程任务尽力置 cancelled 标记。 */
export function cancelTask(taskIdInput: unknown): { ok: boolean } {
  if (typeof taskIdInput !== 'string') throw new Error('taskId 参数无效')
  const task = tasks.get(taskIdInput)
  if (!task || task.finished) return { ok: false }
  task.cancelled = true
  killTask(task)
  return { ok: true }
}
