/**
 * 任务对象的转换与进度事件：把存储记录变成页面用的 Task，并按约 1 秒一次节流推送。
 * 速度与剩余时间用近 5 秒的滑动窗口估计，只对进行中的任务保留运行态。
 */

import { EVENTS, LIMITS, type Task, type TaskFile, type TaskState } from '../contracts.ts'
import { postEvent } from '../runtime.ts'
import type { StoredTask } from '../store.ts'

const EMIT_INTERVAL_MS = 1000
/** 速度采样窗口 */
const SPEED_WINDOW_MS = 5000

/** 进行中任务的运行态 */
interface LiveState {
  samples: Array<{ at: number; bytes: number }>
  speed: number
  etaSeconds: number
  /** 最近一次有字节进展的时刻 */
  progressAt: number
}

const live = new Map<string, LiveState>()

/** 任务开始运行时建立运行态 */
export function beginLive(taskId: string, completed: number): void {
  live.set(taskId, { samples: [{ at: Date.now(), bytes: completed }], speed: 0, etaSeconds: 0, progressAt: Date.now() })
}

/** 有字节进展时更新采样；total 用于估算剩余时间 */
export function noteProgress(taskId: string, completed: number, total: number): void {
  const state = live.get(taskId)
  if (!state) return
  const now = Date.now()
  state.progressAt = now
  state.samples.push({ at: now, bytes: completed })
  while (state.samples.length > 2 && now - state.samples[0].at > SPEED_WINDOW_MS) state.samples.shift()
  const first = state.samples[0]
  const elapsed = (now - first.at) / 1000
  state.speed = elapsed > 0.2 ? Math.max(0, (completed - first.bytes) / elapsed) : 0
  state.etaSeconds = state.speed > 0 && total > completed ? Math.round((total - completed) / state.speed) : 0
}

/** 任务结束（任何状态）时清掉运行态 */
export function endLive(taskId: string): void {
  live.delete(taskId)
}

/** 安装阶段也刷新"最近进展"，避免解压时被误判为卡死 */
export function touchProgress(taskId: string): void {
  const state = live.get(taskId)
  if (state) state.progressAt = Date.now()
}

function coverTokenOf(cover: string): string {
  if (cover.startsWith('img:') || cover.startsWith('cover:')) return cover
  return `img:${Buffer.from(cover, 'utf8').toString('base64url')}`
}

function sumOf(task: StoredTask, pick: (file: { size: number; downloaded: number }) => number): number {
  let sum = 0
  for (const file of task.files) sum += pick(file)
  return sum
}

function statusTextOf(task: StoredTask): string {
  switch (task.state) {
    case 'resolving': return '正在解析下载地址'
    case 'installing': return '正在解压安装'
    case 'login_expired': return '天翼云登录已过期，重新登录后可继续'
    case 'downloading': {
      const done = task.files.filter(file => file.state === 'done').length
      return `正在下载 ${done}/${task.files.length}`
    }
    default: return ''
  }
}

/** 把存储记录变成页面用的任务对象 */
export function toTask(task: StoredTask): Task {
  const total = sumOf(task, file => file.size)
  const completed = sumOf(task, file => file.downloaded)
  const state = live.get(task.id)
  const files: TaskFile[] = task.files.map(file => ({
    name: file.name,
    size: file.size,
    downloaded: file.downloaded,
    state: (['pending', 'downloading', 'done', 'failed', 'skipped'].includes(file.state) ? file.state : 'pending') as TaskFile['state'],
  }))
  return {
    id: task.id,
    itemId: task.itemId,
    title: task.title,
    coverToken: task.cover ? coverTokenOf(task.cover) : '',
    kind: (task.kind as Task['kind']) || 'game',
    state: (task.state as TaskState) || 'queued',
    statusText: statusTextOf(task),
    files,
    totalBytes: total,
    completedBytes: completed,
    speed: state?.speed ?? 0,
    etaSeconds: state?.etaSeconds ?? 0,
    error: task.error,
    installError: task.installError,
    downloadDir: task.downloadDir,
    installDir: task.installDir,
    autoInstall: task.autoInstall,
    removePackage: task.removePackage,
    // 已安装 = 完成且定位到了可执行文件。只下载没解压、或解压后没找到 exe 时为 false
    installed: task.state === 'complete' && Boolean(task.exePath),
    stalled: state ? Date.now() - state.progressAt > LIMITS.stallMs : false,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
  }
}

export function activeCounts(tasks: StoredTask[]): { active: number } {
  let active = 0
  for (const task of tasks) if (['queued', 'resolving', 'downloading', 'installing'].includes(task.state)) active++
  return { active }
}

/** 每个任务一个节流器：合并 1 秒内的多次更新，保证最后一次一定会发出 */
const emitters = new Map<string, { timer?: NodeJS.Timeout; pending?: StoredTask }>()

/**
 * 进度更新：约每秒一次，合并同一秒内的多次字节进展。
 * onFlush 在每次真正推送前调用（任务服务用它把进度落盘）——否则页面刷新一次进度就跳回旧值。
 */
export function emitTask(task: StoredTask, onFlush?: (task: StoredTask) => void | Promise<void>): void {
  let entry = emitters.get(task.id)
  if (!entry) {
    entry = {}
    emitters.set(task.id, entry)
  }
  entry.pending = task
  if (entry.timer) return
  entry.timer = setTimeout(() => {
    const current = emitters.get(task.id)
    if (!current) return
    current.timer = undefined
    const snapshot = current.pending
    current.pending = undefined
    if (!snapshot) return
    void onFlush?.(snapshot)
    postEvent(EVENTS.taskUpdated, toTask(snapshot))
  }, EMIT_INTERVAL_MS)
}

/**
 * 状态变更：立即推送。不节流，否则很快完成的任务从排队直接跳到完成，
 * 页面在收到 finished 之前看不到任何中间状态。事件里带最新的进度，所以待发的进度事件可以丢掉。
 */
export function emitState(task: StoredTask): void {
  const entry = emitters.get(task.id)
  if (entry?.timer) clearTimeout(entry.timer)
  emitters.delete(task.id)
  postEvent(EVENTS.taskUpdated, toTask(task))
}

/** 立即发出最终状态并清掉节流器（任务结束时用） */
export function emitFinished(task: StoredTask, tasks: StoredTask[]): void {
  const entry = emitters.get(task.id)
  if (entry?.timer) clearTimeout(entry.timer)
  emitters.delete(task.id)
  postEvent(EVENTS.taskFinished, { task: toTask(task), counts: activeCounts(tasks) })
}

/** 关闭时丢弃所有待发的进度事件 */
export function clearEmitters(): void {
  for (const entry of emitters.values()) if (entry.timer) clearTimeout(entry.timer)
  emitters.clear()
  live.clear()
}
