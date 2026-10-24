import { parentPort } from '@backend/parentPort'
import * as service from '@backend/dbService'
import { dbWorkbenchService } from '@backend/workbenchService'
import { createDatabaseFacade } from '@backend/facade'

const port = parentPort
if (!port) throw new Error('database service requires an Electron utility parent')
const controls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
const jobs = new Map<number, Promise<void>>()
let owner: { pluginId: string; generation: number; wcId: number } | undefined
let sequence = 0, closing = false, shutdown: Promise<void> | undefined
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 4096)
const releaseMethods = new Set(['activity.release'])
function assertCurrent(): void { if (!owner || closing) throw new Error('database backend is closing or uninitialized') }
function hostRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!owner || closing && !releaseMethods.has(method)) return Promise.reject(new Error('database backend is closing'))
  if (controls.size >= 64) return Promise.reject(new Error('too many pending host operations'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    // Native consent and pickers are user-paced; only machine operations have a short deadline.
    const timeout = ['permission.authorize', 'files.pick', 'files.save'].includes(method) ? 86_400_000 : 5000
    const timer = setTimeout(() => { controls.delete(id); reject(new Error(`host operation timed out: ${method}`)) }, timeout)
    timer.unref()
    controls.set(id, { resolve, reject, timer })
    try { port!.postMessage({ type: 'host.request', id, method, params }) }
    catch (error) { controls.delete(id); clearTimeout(timer); reject(error as Error) }
  })
}
const facade = createDatabaseFacade({ pluginId: 'com.github.eNest.database', request: hostRequest, assertCurrent },
  { ...service, dbWorkbenchService } as unknown as Parameters<typeof createDatabaseFacade>[1])
function stop(): Promise<void> {
  if (shutdown) return shutdown
  closing = true
  shutdown = Promise.allSettled([facade.shutdown(), ...jobs.values()]).then(results => {
    const failure = results.find(result => result.status === 'rejected')
    port!.postMessage({ type: 'shutdown.complete', ok: !failure, ...(failure ? { error: errorText(failure.reason) } : {}) })
  }).finally(() => process.exit(0))
  return shutdown
}
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })

port.on('message', ({ data: raw }) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const message = raw as Record<string, unknown>
  if (message.type === 'init') {
    if (owner || message.pluginId !== 'com.github.eNest.database' || (message.context as { protocolVersion?: unknown })?.protocolVersion !== 1
      || !Number.isSafeInteger(message.generation) || Number(message.generation) < 1 || !Number.isSafeInteger(message.wcId)) return
    owner = { pluginId: message.pluginId, generation: Number(message.generation), wcId: Number(message.wcId) }
    return
  }
  if (message.type === 'host.response') {
    const pending = controls.get(Number(message.id))
    if (!pending) return
    controls.delete(Number(message.id)); clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.data)
    else pending.reject(new Error(errorText(message.error || 'host operation failed')))
    return
  }
  if (message.type === 'shutdown') { void stop(); return }
  if (!Number.isSafeInteger(message.id)) return
  const id = Number(message.id)
  if (jobs.has(id) || jobs.size >= 32) { port!.postMessage({ id, ok: false, error: 'duplicate or excessive database operations' }); return }
  const task = Promise.resolve().then(async () => {
    assertCurrent()
    if (message.pluginId !== owner!.pluginId || typeof message.method !== 'string' || !Array.isArray(message.args)) throw new Error('invalid database request owner or arguments')
    const proxy = message.proxy as Record<string, unknown> | undefined
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      if (typeof proxy?.[key] === 'string') process.env[key] = proxy[key]
      else delete process.env[key]
      delete process.env[key.toLowerCase()]
    }
    const result = await facade.call(message.method, message.args)
    assertCurrent()
    if (Buffer.byteLength(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? String(value) : value) ?? '') > 8 * 1024 * 1024) throw new Error('database result exceeds 8 MiB; narrow the query')
    port!.postMessage({ id, ok: true, data: result })
  }).catch(error => { if (!closing) port!.postMessage({ id, ok: false, error: errorText(error) }) }).finally(() => jobs.delete(id))
  jobs.set(id, task)
})
