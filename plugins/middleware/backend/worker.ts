import { isAbsolute } from 'node:path'
import { createExtensionRuntime, readLocalExtensionZip } from '@enest/workbench-extensions'
import { createWorkbenchViewHost } from '@enest/workbench-view-host'
import { createMiddlewareService, type MiddlewareRuntime } from '@backend/mwService'
import { mwWorkbenchPermission } from '@backend/workbench'
import type { BackendMessagePort } from '@backend/parentPort'
import type { MwConnectionConfig, MwDriverDescriptor, MwWorkbenchRequest } from '@backend/contracts/mw-workbench'
import type { MwDriver } from '@backend/types'

interface WorkerOptions extends Partial<Pick<MiddlewareRuntime, 'getDriver' | 'descriptors'>> {
  port: BackendMessagePort
  pluginId?: string
  onShutdown?(ok: boolean): void
}
interface PendingControl { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: string }
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 4096)
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item) ?? '')
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected middleware parameters')
  return value as Record<string, unknown>
}
function text(value: unknown, limit = 1024): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid middleware argument')
  return value
}

function slot(root: Record<string, unknown>, path: string, create = false) {
  const parts = path.split('.')
  if (parts.length > 5 || parts.some(part => !/^[a-zA-Z][\w-]{0,63}$/.test(part) || ['constructor', 'prototype'].includes(part))) throw new Error('Invalid middleware credential path')
  const key = parts.pop()!
  let parent = root
  for (const part of parts) {
    if (!Object.hasOwn(parent, part)) { if (!create) return; parent[part] = {} }
    parent = object(parent[part])
  }
  return { parent, key }
}

/** One utility process, one immutable runtime owner, one plugin-owned session service. */
export function createMiddlewareBackend(options: WorkerOptions) {
  const owner = options.pluginId ?? 'com.github.eNest.middleware'
  let initialized = false, closed = false, sequence = 0
  let shutdownPromise: Promise<void> | undefined
  let extensions: ReturnType<typeof createExtensionRuntime> | undefined
  let viewHost: ReturnType<typeof createWorkbenchViewHost> | undefined
  const controls = new Map<number, PendingControl>(), pending = new Map<number, Promise<unknown>>()
  const assertCurrent = () => { if (!initialized || closed) throw new Error('Middleware backend is not initialized or is closing') }
  function post(message: unknown): void {
    if (bytes(message) > 8 * 1024 * 1024) throw new Error('Middleware response exceeds 8 MiB; narrow the query')
    options.port.postMessage(message)
  }
  function host(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== 'activity.release') assertCurrent()
    if (controls.size >= 64) return Promise.reject(new Error('Middleware control request limit reached'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { controls.delete(id); reject(new Error('Middleware host control timed out')) }, method === 'dialog.confirm' || method === 'files.pick' ? 300000 : 25000)
      timer.unref()
      controls.set(id, { resolve, reject, timer, method })
      try { post({ type: 'host.request', id, method, params }) }
      catch (error) { controls.delete(id); clearTimeout(timer); reject(error as Error) }
    })
  }
  async function acquireDriver(kind: string): Promise<{ provider: MwDriver; release(): void }> {
    if (options.getDriver) return { provider: await options.getDriver(kind), release: () => {} }
    const lease = await extensions?.acquire(kind)
    if (!lease) throw new Error('驱动未安装或未启用，请打开驱动市场')
    const provider = lease.provider as MwDriver
    if (!provider || provider.kind !== kind || typeof provider.open !== 'function' || typeof provider.close !== 'function' || typeof provider.test !== 'function') {
      lease.release()
      throw new Error('扩展不符合中间件驱动契约')
    }
    return { provider, release: () => lease.release() }
  }
  async function descriptors(): Promise<MwDriverDescriptor[]> {
    if (options.descriptors) return options.descriptors()
    const manifests = await extensions?.descriptors() ?? []
    const result = await Promise.allSettled(manifests.map(async manifest => {
      const { provider, release } = await acquireDriver(manifest.id)
      try {
        const { kind, label, transport, defaultPort, messageQueryModes, capabilities, connectionFields, pageColumns, metricsSpec, sendFields } = provider
        const { ui, completionRules, settings } = manifest.descriptor as Partial<MwDriverDescriptor>
        return { kind, label, transport, defaultPort, messageQueryModes, capabilities, connectionFields, pageColumns, metricsSpec, sendFields, ui, completionRules, settings, views: manifest.views }
      } finally { release() }
    }))
    return result.flatMap(item => item.status === 'fulfilled' ? [item.value as MwDriverDescriptor] : [])
  }
  const service = createMiddlewareService({
    getDriver: async kind => { throw new Error(`Middleware driver requires a lease: ${kind}`) }, acquireDriver, descriptors,
    acquire: async (token, reason) => { await host('activity.acquire', { token, reason }); assertCurrent() },
    release: async token => { await host('activity.release', { token }) },
    emit: (event, data) => {
      if (closed || !initialized) return
      try { post({ event, data }) }
      catch { post({ event: 'mw.error', data: { sessionKey: data.sessionKey, tailId: data.tailId, error: 'Middleware event exceeds 8 MiB; narrow the stream' } }) }
    }
  })
  async function resolveConfig(value: unknown): Promise<MwConnectionConfig> {
    const config = structuredClone(object(value))
    const kind = text(config.kind, 80)
    const descriptor = (await descriptors()).find(entry => entry.kind === kind)
    if (!descriptor) throw new Error('驱动未安装或未启用，请打开驱动市场')
    const resolveRef = async (ref: string) => {
      const secret = await host('secret.resolve', { ref: text(ref, 512) })
      assertCurrent()
      if (typeof secret !== 'string') throw new Error('Middleware credential is missing; save it again')
      return secret
    }
    const paths = new Map([['secretRef', 'ephemeralSecret']])
    for (const field of descriptor.connectionFields ?? []) {
      if (field.type === 'password' && field.secretRefPath && field.ephemeralSecretPath) paths.set(field.secretRefPath, field.ephemeralSecretPath)
    }
    for (const [refPath, temporaryPath] of paths) {
      const reference = slot(config, refPath)
      const temporary = slot(config, temporaryPath)
      const ref = reference?.parent[reference.key], secret = temporary?.parent[temporary.key]
      if (secret !== undefined && typeof secret !== 'string') throw new Error('Invalid temporary credential')
      if (!secret && ref !== undefined) {
        if (typeof ref !== 'string') throw new Error('Invalid credential reference')
        const target = slot(config, temporaryPath, true)!
        target.parent[target.key] = await resolveRef(ref)
      }
      if (reference) delete reference.parent[reference.key]
    }
    return config as unknown as MwConnectionConfig
  }
  async function workbench(raw: unknown): Promise<unknown> {
    assertCurrent()
    const value = object(raw), action = text(value.action, 80)
    const permission = mwWorkbenchPermission(action), input = { ...object(value.input ?? {}) }
    if (input.sessionKey !== undefined) text(input.sessionKey, 128)
    if (input.tailId !== undefined) text(input.tailId, 128)
    const allowed = await host('permission.authorize', { permission, summary: `中间件操作：${action}` })
    assertCurrent()
    if (allowed !== true) throw new Error('permission denied')
    if (action === 'test' || action === 'session.open') input.config = await resolveConfig(input.config)
    assertCurrent()
    try { return await service.mwWorkbenchService(owner, { action, input } as MwWorkbenchRequest) }
    catch (error) {
      if (action === 'session.close' || action === 'tail.stop') void shutdown()
      throw error
    }
  }
  async function dispatch(method: string, raw: unknown) {
    if (method === 'workbench') return workbench(raw)
    if (!extensions) throw new Error('驱动市场需要支持扩展的 eNest 宿主')
    const input = raw === undefined ? {} : object(raw)
    const action = method.slice('extensions.'.length)
    if (action === 'view.open' || action === 'view.close') {
      if (!viewHost) throw new Error('当前宿主不支持扩展视图')
      return action === 'view.open'
        ? viewHost.open({ id: text(input.id, 80), viewId: text(input.viewId, 80) })
        : viewHost.close({ token: text(input.token, 256) })
    }
    return extensions.market(action, input)
  }
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    closed = true
    for (const [id, control] of controls) {
      if (control.method === 'activity.release') continue
      controls.delete(id); clearTimeout(control.timer); control.reject(new Error('Middleware backend is closing'))
    }
    shutdownPromise = (async () => {
      let failure: unknown
      try { await service.releaseMwSessions(owner) } catch (error) { failure = error }
      await Promise.allSettled([...pending.values()])
      try { await viewHost?.dispose() } catch (error) { failure ??= error }
      try { await extensions?.dispose() } catch (error) { failure ??= error }
      for (const control of controls.values()) { clearTimeout(control.timer); control.reject(new Error('Middleware backend closed')) }
      controls.clear()
      post({ type: 'shutdown.complete', ok: !failure, ...(failure ? { error: errorText(failure) } : {}) })
      options.onShutdown?.(!failure)
    })()
    return shutdownPromise
  }
  options.port.on('message', ({ data: raw }) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const message = raw as Record<string, unknown>
    if (message.type === 'host.response') {
      const control = controls.get(Number(message.id))
      if (!control) return
      controls.delete(Number(message.id)); clearTimeout(control.timer)
      if (message.ok === true) control.resolve(message.data)
      else control.reject(new Error(errorText(message.error ?? 'Middleware host control failed')))
      return
    }
    if (message.type === 'shutdown') { void shutdown(); return }
    if (message.type === 'init') {
      try {
        if (initialized || closed) throw new Error('Middleware backend cannot be reinitialized')
        const context = object(message.context)
        if (message.pluginId !== owner || !Number.isSafeInteger(message.generation) || Number(message.generation) < 1 || !Number.isSafeInteger(message.wcId)) throw new Error('Invalid middleware runtime owner')
        if (context.protocolVersion !== 1 || ![context.appDataPath, context.packagePath, context.appExecPath].every(path => typeof path === 'string' && isAbsolute(path))) throw new Error('Middleware requires backend control protocol v1')
        initialized = true
        if (typeof context.extensionRoot === 'string' && isAbsolute(context.extensionRoot)) {
          extensions = createExtensionRuntime({ target: 'middleware', root: context.extensionRoot, owner, assertCurrent, host: {
            confirm: async (title, message, detail) => await host('dialog.confirm', { title, message, detail }) === true,
            readLocal: async handleId => readLocalExtensionZip(text(await host('files.resolve', { handleId, access: 'read' }), 4096))
          } })
          if (typeof context.pageOrigin === 'string') viewHost = createWorkbenchViewHost({ runtime: extensions, host, pageOrigin: context.pageOrigin, assertCurrent })
        }
      } catch { void shutdown() }
      return
    }
    if (!Number.isSafeInteger(message.id) || Number(message.id) < 1) return
    const id = Number(message.id)
    try {
      assertCurrent()
      if (message.pluginId !== owner || pending.has(id) || pending.size >= 32) throw new Error('Middleware request owner/budget mismatch')
      const method = text(message.method, 80)
      if ((method !== 'workbench' && !/^extensions\.[a-zA-Z.]+$/.test(method)) || !Array.isArray(message.args) || message.args.length > 1 || method === 'workbench' && message.args.length !== 1 || bytes(message.args) > 4 * 1024 * 1024) throw new Error('Invalid middleware backend request')
      const proxy = message.proxy && typeof message.proxy === 'object' ? message.proxy as Record<string, unknown> : {}
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
        if (typeof proxy[key] === 'string') process.env[key] = proxy[key]
        else delete process.env[key]
      }
      const request = dispatch(method, message.args[0]).then(data => { if (!closed) post({ id, ok: true, data }) }).catch(error => {
        if (!closed) post({ id, ok: false, error: errorText(error) })
      }).finally(() => pending.delete(id))
      pending.set(id, request)
    } catch (error) { post({ id, ok: false, error: errorText(error) }) }
  })
  return { shutdown, get state() { return { initialized, closed, pending: pending.size, controls: controls.size } } }
}
