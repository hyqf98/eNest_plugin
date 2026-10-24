/** Pomodoro domain types belong to this plugin, not to the shell SDK. */
export interface FocusTimerOptions {
  focusMin: number
  breakMin: number
  longBreakMin: number
  longBreakEvery: number
  autoStart: boolean
  task: string
  notify: boolean
}
export type FocusTimerPhase = 'focus' | 'break' | 'longBreak'
export interface FocusTimerState {
  status: 'idle' | 'running' | 'paused'
  phase: FocusTimerPhase
  remainingMs: number
  deadline: number | null
  startedAt: number | null
  cycle: number
  options: FocusTimerOptions
}
export interface FocusTimerRecord {
  id: string
  phase: FocusTimerPhase
  task: string
  startedAt: number
  endedAt: number
  durationMs: number
  outcome: 'completed' | 'skipped' | 'stopped'
  counted: boolean
}
export interface FocusTimerSnapshot { state: FocusTimerState; records: FocusTimerRecord[] }
export interface FocusTimerRecordPatch { task?: string; durationMs?: number; counted?: boolean; deleted?: boolean }
