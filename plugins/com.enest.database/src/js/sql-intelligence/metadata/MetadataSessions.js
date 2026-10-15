let instanceSequence = 0

export class StaleMetadataError extends Error {
  constructor() { super('补全元数据请求已失效'); this.code = 'STALE_METADATA' }
}

/** One serial queue per metadata scope, never a user query/transaction session. */
export class MetadataSessions {
  constructor({ open, close, toConfig }) {
    this.open = open
    this.close = close
    this.toConfig = toConfig
    this.entries = new Map()
    this.closing = new Set()
    this.instanceId = `${Date.now().toString(36)}-${++instanceSequence}`
    this.sequence = 0
  }

  run(key, scope, isCurrent, action) {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { tail: Promise.resolve(), sessionKey: null, retired: false }
      this.entries.set(key, entry)
    }
    const valid = () => !entry.retired && isCurrent()
    const task = entry.tail.catch(() => {}).then(async () => {
      if (!valid()) throw new StaleMetadataError()
      if (!entry.sessionKey) {
        if (typeof this.open !== 'function' || typeof this.close !== 'function') throw new Error('元数据会话接口不可用')
        const overrides = { database: scope.database, readOnly: true, createIfMissing: false }
        const input = this.toConfig ? this.toConfig(scope.connection, overrides) : { ...scope.connection, ...overrides }
        const config = { ...input, ...overrides, options: { ...input?.options, schema: scope.schema, readOnly: true, createIfMissing: false } }
        const preferred = `db-nav:catalog:intelligence:${this.instanceId}:${++this.sequence}:${scope.surface}`
        const opened = await this.open({ config, sessionKey: preferred })
        entry.sessionKey = typeof opened === 'string' ? opened : opened?.sessionKey || opened?.key || preferred
      }
      if (!valid()) throw new StaleMetadataError()
      const result = await action({ sessionKey: entry.sessionKey, scope, isCurrent: valid })
      if (!valid()) throw new StaleMetadataError()
      return result
    })
    entry.tail = task.catch(() => {})
    return task
  }

  retire(key) {
    const entry = this.entries.get(key)
    if (!entry) return Promise.resolve()
    entry.retired = true
    this.entries.delete(key)
    // Closing waits for the one active read; queued stale reads never reach the driver.
    const closing = entry.tail.catch(() => {}).then(async () => {
      if (entry.sessionKey) await this.close(entry.sessionKey)
    })
    this.closing.add(closing)
    void closing.finally(() => this.closing.delete(closing)).catch(() => {})
    return closing
  }

  dispose() {
    const closing = [...this.entries.keys()].map(key => this.retire(key))
    return Promise.allSettled([...this.closing, ...closing])
  }
}
