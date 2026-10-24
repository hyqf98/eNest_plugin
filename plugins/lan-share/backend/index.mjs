import { createLanShareService } from './share-service.mjs'

const port = process.parentPort
if (!port) throw new Error('This backend requires the eNest native utility process')
const controls = new Map(), jobs = new Set()
let sequence = 0, owner, closing = false, shutdown
const errorText = error => String(error instanceof Error ? error.message : error).slice(0, 4096)
const releaseMethods = new Set(['files.close', 'activity.release'])

function hostRequest(method, params) {
  if (!owner || closing && !releaseMethods.has(method)) return Promise.reject(new Error('plugin backend is closing'))
  if (controls.size >= 64) return Promise.reject(new Error('too many pending host operations'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controls.delete(id); reject(new Error(`host operation timed out: ${method}`)) }, 5000)
    timer.unref()
    controls.set(id, { resolve, reject, timer })
    try { port.postMessage({ type: 'host.request', id, method, params }) }
    catch (error) { clearTimeout(timer); controls.delete(id); reject(error) }
  })
}

const service = createLanShareService({ hostRequest,
  emit(event, data) { if (!closing) port.postMessage({ event, data }) }
})

function stop() {
  if (shutdown) return shutdown
  closing = true
  shutdown = Promise.allSettled([service.shutdown(), ...jobs]).then(results => {
    const failed = results.find(result => result.status === 'rejected')
    port.postMessage({ type: 'shutdown.complete', ok: !failed, ...(failed ? { error: errorText(failed.reason) } : {}) })
  }).finally(() => process.exit(0))
  return shutdown
}
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })

port.on('message', ({ data: message }) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return
  if (message.type === 'init') {
    if (owner || message.pluginId !== 'com.github.eNest.lan-share' || message.context?.protocolVersion !== 1
      || !Number.isSafeInteger(message.generation) || message.generation < 1 || !Number.isSafeInteger(message.wcId)) return
    owner = { pluginId: message.pluginId, generation: message.generation, wcId: message.wcId }
    return
  }
  if (message.type === 'host.response') {
    const pending = controls.get(message.id)
    if (!pending) return
    controls.delete(message.id); clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.data)
    else pending.reject(new Error(errorText(message.error || 'host operation failed')))
    return
  }
  if (message.type === 'shutdown') { void stop(); return }
  if (!Number.isSafeInteger(message.id)) return
  const task = Promise.resolve().then(async () => {
    if (!owner || closing || message.pluginId !== owner.pluginId) throw new Error('backend owner is absent, stale or closing')
    if (jobs.size > 16) throw new Error('too many pending sharing operations')
    if (!Array.isArray(message.args)) throw new Error('invalid sharing arguments')
    const args = message.args
    if (message.method === 'share.start' && args.length === 1) return service.start(args[0])
    if (message.method === 'share.list' && args.length === 0) return service.list()
    if (['share.stop', 'share.status'].includes(message.method) && args.length === 1
      && typeof args[0] === 'string' && /^lan-[a-f0-9-]{36}$/.test(args[0])) {
      return message.method === 'share.stop' ? service.stop(args[0]) : service.status(args[0])
    }
    throw new Error('unsupported sharing method or arguments')
  }).then(data => { if (!closing) port.postMessage({ id: message.id, ok: true, data }) },
    error => { if (!closing) port.postMessage({ id: message.id, ok: false, error: errorText(error) }) })
    .finally(() => jobs.delete(task))
  jobs.add(task)
})
