/**
 * 任务状态到展示文案与色调的纯映射，供下载管理与我的游戏复用。
 * 不依赖 React 与后端，方便单测。
 */

import type { Task, TaskState } from '../shared/contracts'
import { STATE_LABELS } from '../shared/contracts'

export type TaskTone = 'neutral' | 'accent' | 'ok' | 'danger' | 'warn'

/** 状态徽标的色调（与默认主题语义色一一对应） */
export function taskTone(state: TaskState): TaskTone {
  switch (state) {
    case 'resolving':
    case 'downloading':
    case 'installing':
      return 'accent'
    case 'failed':
    case 'install_failed':
      return 'danger'
    case 'login_expired':
      return 'warn'
    case 'complete':
      return 'ok'
    default:
      return 'neutral'
  }
}

export function taskLabel(state: TaskState): string {
  return STATE_LABELS[state]
}

/** 进度百分比文本；解压中没有有意义进度时按 100 处理 */
export function taskPercent(task: Pick<Task, 'totalBytes' | 'completedBytes' | 'state'>): number {
  if (task.state === 'installing') return 100
  if (task.state === 'complete') return 100
  if (task.totalBytes <= 0) return 0
  return (task.completedBytes / task.totalBytes) * 100
}

/** 进度条色调：失败危险、完成成功、其余强调色 */
export function taskProgressTone(state: TaskState): 'accent' | 'ok' | 'danger' | undefined {
  if (state === 'complete' || state === 'installing') return 'ok'
  if (state === 'failed' || state === 'install_failed') return 'danger'
  return 'accent'
}

/** 从分享链接里自动解析提取码（?pwd=xxx） */
export function parseAccessCode(url: string): string {
  const match = /[?&]pwd=([A-Za-z0-9]{1,8})/.exec(url)
  return match ? match[1] : ''
}
