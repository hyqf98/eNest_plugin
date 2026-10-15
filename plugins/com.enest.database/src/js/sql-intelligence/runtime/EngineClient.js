export const analysisTaskKey = (method, request, channel = method === 'signature' ? 'signature' : 'completion') => JSON.stringify([request.connectionId, request.consoleId, request.documentId, method, channel])
const cancelled = method => method === 'signature' ? null : { items: [], diagnostics: [], requiredTables: [], isIncomplete: false, stale: true, cancelled: true }

/** One active parser, a bounded latest-wins queue, and no host API in the Worker. */
export class EngineClient {
  constructor({ createWorker, timeoutMs = 2500, maxPending = 32, loadEngine } = {}) {
    this.createWorker = createWorker || (() => new Worker(new URL('./engineWorker.js', import.meta.url), { type: 'module' }))
    this.loadEngine = loadEngine || (() => import('@db/sql-intelligence/completionEngine.js'))
    this.unavailable = !createWorker && typeof Worker === 'undefined'
    this.timeoutMs = timeoutMs; this.maxPending = Math.max(1, maxPending)
    this.pending = new Map(); this.sequence = 0; this.worker = null; this.active = null; this.disposed = false
  }

  run(method, request, options, { key = analysisTaskKey(method, request), signal } = {}) {
    this.cancel(key)
    if (this.disposed || signal?.aborted) return Promise.resolve(cancelled(method))
    if (request.sql.length > 200_000) return Promise.resolve(method === 'signature' ? null : { ...cancelled(method), cancelled: false, reason: '大文档已暂停自动分析，请拆分查询' })
    if (this.pending.size >= this.maxPending) this._cancel([...this.pending.values()].find(task => task !== this.active) || this.active)
    const id = ++this.sequence
    const promise = new Promise((resolve, reject) => {
      const task = { id, key, method, request, options, resolve, reject, signal, timer: null }
      task.abort = () => this._cancel(task)
      signal?.addEventListener('abort', task.abort, { once: true })
      this.pending.set(id, task)
    })
    this._schedule()
    return promise
  }

  cancel(key) {
    for (const task of this.pending.values()) if (task.key === key) this._cancel(task)
  }

  _cancel(task) {
    if (!task || !this.pending.has(task.id)) return
    // Synchronous parsing cannot consume a cancel message. Terminating its isolated
    // Worker actually stops it; other documents remain in our undispatched queue.
    if (task === this.active) this._resetWorker()
    this._finish(task, cancelled(task.method))
  }

  _schedule() {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this._dispatch() })
  }

  _dispatch() {
    if (this.disposed || this.active || !this.pending.size) return
    const task = this.pending.values().next().value
    this.active = task
    if (this.unavailable) {
      this.enginePromise ||= this.loadEngine()
      void this.enginePromise.then(engine => {
        if (!this.pending.has(task.id)) return
        const result = task.method === 'signature' ? engine.signatureHelp(task.request, task.options) : engine.buildCompletion(task.request, task.options)
        this._finish(task, result)
      }).catch(error => this._finish(task, null, error))
      return
    }
    try {
      if (!this.worker) {
        const worker = this.worker = this.createWorker()
        worker.onmessage = ({ data }) => {
          if (worker !== this.worker || this.active?.id !== data.id) return
          this._finish(this.active, data.result, data.error ? new Error(data.error) : null)
        }
        worker.onerror = () => {
          if (worker !== this.worker) return
          const failed = this.active
          this.unavailable = true; this._resetWorker()
          this._finish(failed, null, new Error('SQL 分析线程加载失败，请重试'))
        }
      }
      task.timer = setTimeout(() => {
        if (this.active !== task) return
        this._resetWorker()
        this._finish(task, null, new Error('SQL 分析超时，请简化当前语句后重试'))
      }, this.timeoutMs)
      this.worker.postMessage({ id: task.id, method: task.method, request: task.request, options: task.options })
    } catch (error) {
      const startupFailed = !this.worker
      this._resetWorker()
      if (startupFailed) { this.unavailable = true; this.active = null; this._schedule(); return }
      this._finish(task, null, error)
    }
  }

  _finish(task, result, error) {
    if (!task || !this.pending.has(task.id)) return
    clearTimeout(task.timer); task.signal?.removeEventListener('abort', task.abort)
    this.pending.delete(task.id)
    if (this.active === task) this.active = null
    if (error) task.reject(error); else task.resolve(result)
    this._schedule()
  }

  _resetWorker() { this.worker?.terminate(); this.worker = null }

  dispose() {
    this.disposed = true; this._resetWorker()
    for (const task of [...this.pending.values()]) this._finish(task, cancelled(task.method))
    this.active = null
  }
}
