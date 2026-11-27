import { parentPort } from '@backend/parentPort'
import * as service from '@backend/dbService'
import { dbWorkbenchService } from '@backend/workbenchService'
import { createDatabaseFacade } from '@backend/facade'
import { createExtensionRuntime, readLocalExtensionZip, type ExtensionRuntime } from '@enest/workbench-extensions'
import { createWorkbenchViewHost } from '@enest/workbench-view-host'
import { setDriverRuntime } from '@backend/driverRuntime'
import type { DbDriver } from '@backend/drivers'

const port = parentPort
if (!port) throw new Error('database service requires an Electron utility parent')
const controls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
const jobs = new Map<number, Promise<void>>()
let owner: { pluginId: string; generation: number; wcId: number } | undefined
let extensions: ExtensionRuntime<DbDriver> | undefined
let viewHost: ReturnType<typeof createWorkbenchViewHost> | undefined
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
    const timeout = ['permission.authorize', 'dialog.confirm', 'files.pick', 'files.save'].includes(method) ? 86_400_000 : 5000
    const timer = setTimeout(() => { controls.delete(id); reject(new Error(`host operation timed out: ${method}`)) }, timeout)
    timer.unref()
    controls.set(id, { resolve, reject, timer })
    try { port!.postMessage({ type: 'host.request', id, method, params }) }
    catch (error) { controls.delete(id); clearTimeout(timer); reject(error as Error) }
  })
}
const facade = createDatabaseFacade({ pluginId: 'com.github.eNest.database', request: hostRequest, assertCurrent,
  authorizeView: (token, operation) => { if (!viewHost) throw new Error('database views unavailable'); return viewHost.authorize(token, operation) } },
  { ...service, dbWorkbenchService } as unknown as Parameters<typeof createDatabaseFacade>[1])
function stop(): Promise<void> {
  if (shutdown) return shutdown
  closing = true
  shutdown = Promise.allSettled([facade.shutdown(), viewHost?.dispose(), ...jobs.values()]).then(async results => {
    await extensions?.dispose()
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
    const context = message.context as { extensionRoot?: string; pageOrigin?: string; pluginId?: string }
    owner = { pluginId: message.pluginId, generation: Number(message.generation), wcId: Number(message.wcId) }
    if (typeof context.extensionRoot === 'string' && context.extensionRoot) {
      extensions = createExtensionRuntime<DbDriver>({ target: 'database', root: context.extensionRoot, owner: owner.pluginId, assertCurrent,
        host: {
          confirm: async (title, message, detail) => await hostRequest('dialog.confirm', { title, message, detail }) === true,
          readLocal: async handleId => {
            const path = await hostRequest('files.resolve', { handleId, access: 'read' })
            if (typeof path !== 'string') throw new Error('扩展压缩包未获读取授权')
            return readLocalExtensionZip(path)
          }
        } })
      setDriverRuntime(extensions)
      if (typeof context.pageOrigin === 'string') viewHost = createWorkbenchViewHost({ runtime: extensions, host: hostRequest, pageOrigin: context.pageOrigin, assertCurrent, onClose: service.dbReleaseView })
    }
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
    const method = message.method
    const params = message.args[0] as Record<string, never> | undefined
    let result: unknown
    if (method.startsWith('extensions.')) {
      if (!extensions || message.args.length > 1 || params != null && (typeof params !== 'object' || Array.isArray(params))) throw new Error('驱动扩展市场不可用或参数无效')
      if (method === 'extensions.view.open') {
        if (!viewHost) throw new Error('扩展页面不可用')
        result = await viewHost.open(params ?? {})
      } else if (method === 'extensions.view.close') {
        if (!viewHost) throw new Error('扩展页面不可用')
        result = await viewHost.close(params ?? {})
      } else result = await extensions.market(method.slice('extensions.'.length), params ?? {})
    } else result = await facade.call(method, message.args)
    assertCurrent()
    if (Buffer.byteLength(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? String(value) : value) ?? '') > 8 * 1024 * 1024) throw new Error('database result exceeds 8 MiB; narrow the query')
    port!.postMessage({ id, ok: true, data: result })
  }).catch(error => { if (!closing) port!.postMessage({ id, ok: false, error: errorText(error) }) }).finally(() => jobs.delete(id))
  jobs.set(id, task)
})
