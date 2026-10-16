/**
 * A serialized lane per runtime session key. Closing invalidates old readers immediately,
 * and reopening waits until the old open/close pair settles before touching the same key.
 */
export class SessionCoordinator {
  constructor({ open, close }) {
    this.open = open
    this.close = close
    this.lanes = new Map()
  }
  lane(key) {
    if (!this.lanes.has(key)) this.lanes.set(key, { generation: 0, sequence: Promise.resolve(), pending: null, ready: null, fingerprint: null })
    return this.lanes.get(key)
  }
  ensure(key, configuration) {
    const lane = this.lane(key)
    const fingerprint = JSON.stringify(configuration)
    if (lane.fingerprint !== null && lane.fingerprint !== fingerprint) void this.invalidate(key)
    if (lane.ready && lane.fingerprint === fingerprint) return Promise.resolve(lane.ready)
    if (lane.pending?.generation === lane.generation && lane.fingerprint === fingerprint) return lane.pending.promise
    lane.fingerprint = fingerprint
    const generation = lane.generation
    const pending = { generation, promise: null }
    const operation = lane.sequence.then(async () => {
      if (generation !== lane.generation) throw new Error('连接请求已失效，请重新连接')
      const result = await this.open(key, configuration)
      if (generation !== lane.generation) {
        // This lane still owns the key. A later open cannot start before cleanup completes.
        await this.close(key).catch(() => {})
        throw new Error('连接配置已变化，已关闭旧会话')
      }
      lane.ready = result
      return result
    })
    pending.promise = operation.finally(() => { if (lane.pending === pending) lane.pending = null })
    lane.pending = pending
    lane.sequence = pending.promise.catch(() => {})
    return pending.promise
  }
  invalidate(key) {
    const lane = this.lane(key)
    lane.generation++
    lane.ready = null
    lane.fingerprint = null
    const closing = lane.sequence.then(() => this.close(key)).catch(() => {})
    lane.sequence = closing
    return closing
  }
}
