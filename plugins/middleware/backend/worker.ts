import { isAbsolute } from 'node:path'
import { createMiddlewareService, type MiddlewareRuntime } from '@backend/mwService'
import { mwWorkbenchPermission } from '@backend/workbench'
import type { BackendMessagePort } from '@backend/parentPort'
import type { MwConnectionConfig, MwWorkbenchRequest } from '@backend/contracts/mw-workbench'

interface WorkerOptions extends Pick<MiddlewareRuntime, 'getDriver' | 'descriptors'> {
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

/** One utility process, one immutable runtime owner, one plugin-owned session service. */
export function createMiddlewareBackend(options: WorkerOptions) {
  const owner = options.pluginId ?? 'com.github.eNest.middleware'
  let initialized = false, closed = false, sequence = 0
  let shutdownPromise: Promise<void> | undefined
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
      const timer = setTimeout(() => { controls.delete(id); reject(new Error('Middleware host control timed out')) }, 25000)
      timer.unref()
      controls.set(id, { resolve, reject, timer, method })
      try { post({ type: 'host.request', id, method, params }) }
      catch (error) { controls.delete(id); clearTimeout(timer); reject(error as Error) }
    })
  }
  const service = createMiddlewareService({ ...options,
    acquire: async (token, reason) => { await host('activity.acquire', { token, reason }); assertCurrent() },
    release: async token => { await host('activity.release', { token }) },
    emit: (event, data) => {
      if (closed || !initialized) return
      try { post({ event, data }) }
      catch { post({ event: 'mw.error', data: { sessionKey: data.sessionKey, tailId: data.tailId, error: 'Middleware event exceeds 8 MiB; narrow the stream' } }) }
    }
  })
  async function resolveConfig(value: unknown): Promise<MwConnectionConfig> {
    const config = { ...object(value) } as unknown as MwConnectionConfig
    if (!['kafka', 'rabbitmq', 'mqtt', 'rocketmq'].includes(config.kind)) throw new Error('Unknown middleware kind')
    if (config.ephemeralSecret !== undefined && typeof config.ephemeralSecret !== 'string') throw new Error('Invalid temporary credential')
    const resolveRef = async (ref: string) => {
      const secret = await host('secret.resolve', { ref: text(ref, 512) })
      assertCurrent()
      if (typeof secret !== 'string') throw new Error('Middleware credential is missing; save it again')
      return secret
    }
    if (!config.ephemeralSecret && config.secretRef) config.ephemeralSecret = await resolveRef(config.secretRef)
    delete config.secretRef
    if (config.emqx !== undefined) {
      const emqx = { ...object(config.emqx) } as unknown as NonNullable<MwConnectionConfig['emqx']>
      delete emqx.ephemeralSecret
      if (emqx.enabled && emqx.apiSecretRef) emqx.ephemeralSecret = await resolveRef(emqx.apiSecretRef)
      delete emqx.apiSecretRef
      config.emqx = emqx
    }
    return config
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
      } catch { void shutdown() }
      return
    }
    if (!Number.isSafeInteger(message.id) || Number(message.id) < 1) return
    const id = Number(message.id)
    try {
      assertCurrent()
      if (message.pluginId !== owner || pending.has(id) || pending.size >= 32) throw new Error('Middleware request owner/budget mismatch')
      if (message.method !== 'workbench' || !Array.isArray(message.args) || message.args.length !== 1 || bytes(message.args) > 4 * 1024 * 1024) throw new Error('Invalid middleware backend request')
      const proxy = message.proxy && typeof message.proxy === 'object' ? message.proxy as Record<string, unknown> : {}
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
        if (typeof proxy[key] === 'string') process.env[key] = proxy[key]
        else delete process.env[key]
      }
      const request = workbench(message.args[0]).then(data => { if (!closed) post({ id, ok: true, data }) }).catch(error => {
        if (!closed) post({ id, ok: false, error: errorText(error) })
      }).finally(() => pending.delete(id))
      pending.set(id, request)
    } catch (error) { post({ id, ok: false, error: errorText(error) }) }
  })
  return { shutdown, get state() { return { initialized, closed, pending: pending.size, controls: controls.size } } }
}
