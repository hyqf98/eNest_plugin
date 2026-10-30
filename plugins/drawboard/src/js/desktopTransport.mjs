const LIMIT = 16 * 1024 * 1024
const CHUNK = 96 * 1024

/** Large drawings use bounded chunks; pointer samples never cross the native bridge. */
export function createDesktopTransport(send, receive, failed = () => {}) {
  let queue = Promise.resolve(), incoming = Promise.resolve(), disposed = false
  const inbound = new Map()
  const post = value => {
    const json = JSON.stringify(value)
    if (json.length > LIMIT) return Promise.reject(new Error('当前草稿过大，无法同步桌面画布'))
    const id = crypto.randomUUID()
    const task = async () => {
      const count = Math.ceil(json.length / CHUNK)
      for (let index = 0; index < count; index++) {
        if (disposed) throw new Error('桌面画布已关闭')
        await send({ type: 'drawboard:chunk', id, index, count, text: json.slice(index * CHUNK, (index + 1) * CHUNK) })
        if (count > 1) await new Promise(resolve => setTimeout(resolve, 45))
      }
    }
    const pending = queue.then(task)
    queue = pending.catch(() => {})
    return pending
  }
  const accept = value => {
    if (disposed || value?.type !== 'drawboard:chunk') return
    const { id, index, count, text } = value
    if (typeof id !== 'string' || id.length > 80 || !Number.isInteger(count) || count < 1 || count > Math.ceil(LIMIT / CHUNK)
      || !Number.isInteger(index) || index < 0 || index >= count || typeof text !== 'string' || text.length > CHUNK) return
    let item = inbound.get(id)
    if (!item) {
      if (index !== 0 || inbound.size >= 2) return
      item = { chunks: [], count, size: 0, timer: setTimeout(() => { inbound.delete(id); failed(new Error('桌面画布同步超时')) }, 30_000) }
      inbound.set(id, item)
    }
    if (index !== item.chunks.length || count !== item.count || (item.size += text.length) > LIMIT) {
      clearTimeout(item.timer); inbound.delete(id); return
    }
    item.chunks.push(text)
    if (item.chunks.length !== count) return
    clearTimeout(item.timer); inbound.delete(id)
    try {
      const message = JSON.parse(item.chunks.join(''))
      incoming = incoming.then(() => { if (!disposed) return receive(message) }).catch(failed)
    } catch (error) { failed(error) }
  }
  return { post, accept, dispose() { disposed = true; for (const item of inbound.values()) clearTimeout(item.timer); inbound.clear() } }
}
