/**
 * 任务队列：限制同时运行的下载任务数，其余排队；支持暂停、移除与整体关闭。
 * 每个运行中的任务持有一个 AbortController，暂停/移除/关闭时中止它。
 */

export interface QueueEntry {
  id: string
  /** 任务体：收到取消信号，完成时 resolve，失败时 reject */
  run: (signal: AbortSignal) => Promise<void>
  onSettled?: (outcome: 'done' | 'paused' | 'removed' | 'shutdown' | 'failed', error?: unknown) => void
  /** 运行中才有 */
  controller?: AbortController
  paused?: boolean
  /** 已结束（无论成败），不再参与调度 */
  finished?: boolean
  /** settle 已执行过 */
  settled?: boolean
}

/**
 * 下载任务队列。并发上限可在运行时调整（设置页改了"同时下载任务数"后立即生效）。
 * 同一 id 重复 add 会先移除旧的再排新的。
 */
export class DownloadQueue {
  private readonly entries = new Map<string, QueueEntry>()
  private limitValue: number
  private running = 0
  private closed = false
  private readonly idleListeners = new Set<() => void>()

  constructor(limit: number) {
    this.limitValue = clampLimit(limit)
  }

  /** 并发上限（1–5） */
  get limit(): number { return this.limitValue }

  setLimit(value: number): void {
    this.limitValue = clampLimit(value)
    this.pump()
  }

  add(id: string, run: (signal: AbortSignal) => Promise<void>, onSettled?: QueueEntry['onSettled']): void {
    if (this.closed) {
      onSettled?.('shutdown')
      return
    }
    this.remove(id, 'removed')
    this.entries.set(id, { id, run, onSettled })
    this.pump()
  }

  /** 暂停：中止正在运行的任务并标记为暂停；排队中的任务只打标记 */
  pause(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.finished) return false
    entry.paused = true
    entry.controller?.abort()
    this.pump()
    return true
  }

  /** 移除：中止并从队列删除；运行中的任务等它真正结束后才腾出并发名额 */
  remove(id: string, reason: 'removed' | 'shutdown' = 'removed'): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.finished) return false
    entry.finished = true
    this.entries.delete(id)
    if (!entry.controller) {
      // 还在排队：直接结束
      entry.settled = true
      entry.onSettled?.(reason)
      this.pump()
      return true
    }
    entry.controller.abort()
    entry.onSettled?.(reason)
    this.pump()
    return true
  }

  isPaused(id: string): boolean {
    return this.entries.get(id)?.paused === true
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  activeCount(): number { return this.running }
  pendingCount(): number { return this.entries.size - this.running }
  isIdle(): boolean { return this.entries.size === 0 }
  runningIds(): string[] {
    const ids: string[] = []
    for (const [id, entry] of this.entries) if (entry.controller) ids.push(id)
    return ids
  }

  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener)
    return () => { this.idleListeners.delete(listener) }
  }

  /** 整体关闭：中止全部任务，之后不能再 add */
  shutdown(): void {
    this.closed = true
    for (const id of [...this.entries.keys()]) this.remove(id, 'shutdown')
  }

  /** 取出可运行的下一个任务 */
  private next(): QueueEntry | null {
    for (const entry of this.entries.values()) {
      if (!entry.controller && !entry.paused && !entry.finished) return entry
    }
    return null
  }

  private pump(): void {
    while (this.running < this.limitValue) {
      const entry = this.next()
      if (!entry) break
      this.start(entry)
    }
    if (this.entries.size === 0) for (const listener of this.idleListeners) listener()
  }

  private start(entry: QueueEntry): void {
    const controller = new AbortController()
    entry.controller = controller
    this.running++
    entry.run(controller.signal).then(
      () => this.settle(entry, 'done'),
      (error: unknown) => {
        // remove() 已把它从队列删掉并通知过，这里只收尾计数
        if (this.entries.get(entry.id) !== entry) { this.finish(entry); return }
        if (entry.paused) this.settle(entry, 'paused', error)
        else this.settle(entry, 'failed', error)
      },
    )
  }

  private settle(entry: QueueEntry, outcome: 'done' | 'paused' | 'removed' | 'shutdown' | 'failed', error?: unknown): void {
    if (entry.settled) return
    this.finish(entry)
    entry.onSettled?.(outcome, error)
    this.pump()
  }

  /** 只做计数收尾，不触发 onSettled */
  private finish(entry: QueueEntry): void {
    if (entry.settled) return
    entry.settled = true
    entry.finished = true
    entry.paused = false
    this.running = Math.max(0, this.running - 1)
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
  }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 3
  return Math.min(5, Math.max(1, Math.floor(value)))
}
