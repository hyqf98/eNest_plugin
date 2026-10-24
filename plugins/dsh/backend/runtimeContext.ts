import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { DshWorkbenchEvent } from '@backend/contracts/dsh-workbench'

export interface BackendMessagePort {
  on(event: 'message', listener: (message: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
export interface BackendContext {
  protocolVersion: 1
  appDataPath: string
  packagePath: string
  appExecPath: string
}
interface RuntimeOwner { pluginId: string; generation: number; wcId: number }
type Disposer = () => void | Promise<void>
type HostMethod = 'activity.acquire' | 'activity.release' | 'process.track' | 'process.untrack' | 'endpoint.allow' | 'endpoint.revoke' | 'network.resolveProxy'
interface PendingControl {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const controls = new Map<number, PendingControl>()
let sequence = 0
let port: BackendMessagePort | undefined
let context: BackendContext | undefined
let scope: PluginRuntimeScope | undefined

export class PluginRuntimeScope {
  private controller = new AbortController()
  private disposers = new Set<Disposer>()
  private closing = false
  private completion?: Promise<void>

  constructor(readonly owner: RuntimeOwner) {}
  get signal(): AbortSignal { return this.controller.signal }
  get isClosing(): boolean { return this.closing }
  isCurrent(): boolean { return scope === this && !this.closing }
  addDisposer(dispose: Disposer): () => void {
    if (this.closing) { void Promise.resolve().then(dispose).catch(() => {}); return () => {} }
    this.disposers.add(dispose)
    return () => { this.disposers.delete(dispose) }
  }
  markClosing(): void {
    if (this.closing) return
    this.closing = true
    this.controller.abort(new Error('plugin backend is closing'))
  }
  dispose(): Promise<void> {
    if (this.completion) return this.completion
    this.markClosing()
    const releases = [...this.disposers]
    this.disposers.clear()
    this.completion = Promise.allSettled(releases.map(dispose => Promise.resolve().then(dispose))).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new Error(failures.map(result => String(result.reason)).join('; '))
    })
    return this.completion
  }
}

export function initializeRuntime(messagePort: BackendMessagePort, raw: Record<string, unknown>): void {
  if (scope) throw new Error('backend is already initialized')
  const next = raw.context as Partial<BackendContext> | undefined
  if (raw.pluginId !== 'com.github.eNest.dsh' || !Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1 || !Number.isSafeInteger(raw.wcId)) {
    throw new Error('invalid backend runtime owner')
  }
  if (next?.protocolVersion !== 1 || ![next.appDataPath, next.packagePath, next.appExecPath].every(value => typeof value === 'string' && isAbsolute(value))) {
    throw new Error('DSH requires a host with native backend control protocol v1; update eNest')
  }
  port = messagePort
  context = Object.freeze({ protocolVersion: 1, appDataPath: next.appDataPath!, packagePath: next.packagePath!, appExecPath: next.appExecPath! })
  scope = new PluginRuntimeScope({ pluginId: String(raw.pluginId), generation: Number(raw.generation), wcId: Number(raw.wcId) })
}

export function backendContext(): BackendContext {
  if (!context) throw new Error('plugin backend is not initialized')
  return context
}
export function getRuntimeScope(pluginId: string): PluginRuntimeScope | undefined { return scope?.owner.pluginId === pluginId ? scope : undefined }
export function currentRuntimeScope(): PluginRuntimeScope {
  if (!scope || !scope.isCurrent()) throw new Error('plugin backend is closing or not initialized')
  return scope
}

export function postBackendMessage(message: unknown): void {
  if (!port) throw new Error('plugin backend is not initialized')
  if (Buffer.byteLength(JSON.stringify(message) ?? '') > 8 * 1024 * 1024) throw new Error('DSH backend result exceeds 8 MiB; narrow the request')
  port.postMessage(message)
}

export function receiveHostResponse(raw: Record<string, unknown>): void {
  const pending = controls.get(Number(raw.id))
  if (!pending) return
  controls.delete(Number(raw.id))
  clearTimeout(pending.timer)
  if (raw.ok === true) pending.resolve(raw.data)
  else pending.reject(new Error(String(raw.error || 'host control failed').slice(0, 4096)))
}

export function hostRequest(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
  if (!scope || scope.isClosing && !['activity.release', 'process.untrack', 'endpoint.revoke'].includes(method)) {
    return Promise.reject(new Error('plugin backend is closing'))
  }
  if (controls.size >= 128) return Promise.reject(new Error('too many backend control requests'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controls.delete(id); reject(new Error(`host control timed out: ${method}`)) }, 5000)
    timer.unref()
    controls.set(id, { resolve, reject, timer })
    try { postBackendMessage({ type: 'host.request', id, method, params }) }
    catch (error) { controls.delete(id); clearTimeout(timer); reject(error) }
  })
}

export async function acquireActivity(reason: string): Promise<() => void> {
  const token = randomUUID()
  let released = false
  const release = () => {
    if (released) return
    released = true
    void hostRequest('activity.release', { token }).catch(() => {})
  }
  try {
    await hostRequest('activity.acquire', { token, reason: reason.slice(0, 160) })
    if (!scope?.isCurrent()) throw new Error('plugin backend is closing')
    return release
  } catch (error) { release(); throw error }
}

type ProcessRelease = (() => void) & { ready: Promise<void> }
export function registerPluginProcess(registration: {
  pluginId: string
  generation?: number
  kind: 'runtime'
  child: ChildProcess
  getPid(): number | undefined
  stop(): void | Promise<void>
}): ProcessRelease {
  const owner = currentRuntimeScope()
  if (registration.pluginId !== owner.owner.pluginId || registration.generation !== owner.owner.generation) throw new Error('runtime process owner mismatch')
  let released = false
  let trackedPid: number | undefined
  let releaseActivity: (() => void) | undefined
  const release = (() => {
    if (released) return
    released = true
    releaseActivity?.()
    if (trackedPid) void hostRequest('process.untrack', { pid: trackedPid }).catch(() => {})
  }) as ProcessRelease
  const tracking = new Promise<void>((resolve, reject) => {
    const started = () => {
      registration.child.removeListener('error', failed)
      const pid = registration.getPid()
      if (!pid || released) { resolve(); return }
      void hostRequest('process.track', { pid }).then(() => {
        trackedPid = pid
        if (released) void hostRequest('process.untrack', { pid }).catch(() => {})
        resolve()
      }, error => {
        // A short-lived probe can exit before its tracking acknowledgement.
        if (released || registration.child.exitCode !== null || registration.child.signalCode !== null) resolve()
        else reject(error)
      })
    }
    const failed = (error: Error) => { registration.child.removeListener('spawn', started); reject(error) }
    registration.child.once('spawn', started)
    registration.child.once('error', failed)
  })
  release.ready = Promise.all([
    tracking,
    acquireActivity('dsh-runtime').then(value => { releaseActivity = value; if (released) value() })
  ]).then(() => undefined)
  void release.ready.catch(() => { void Promise.resolve(registration.stop()).catch(() => {}) })
  return release
}

export async function allowPluginEndpoint(pluginId: string, url: string, kind: 'subFrame', pid?: number): Promise<() => void> {
  const owner = currentRuntimeScope()
  if (owner.owner.pluginId !== pluginId || !Number.isSafeInteger(pid) || !pid) throw new Error('invalid runtime endpoint owner')
  const token = randomUUID()
  let revoked = false
  const revoke = () => {
    if (revoked) return
    revoked = true
    void hostRequest('endpoint.revoke', { token }).catch(() => {})
  }
  try {
    await hostRequest('endpoint.allow', { token, url, kind, pid })
    if (!owner.isCurrent()) throw new Error('plugin backend is closing')
    return revoke
  } catch (error) { revoke(); throw error }
}

export function emitDshEvent(pluginId: string, event: DshWorkbenchEvent): void {
  if (getRuntimeScope(pluginId)?.isCurrent()) postBackendMessage({ event: 'dsh.event', data: event })
}
export function logWarn(category: string, message: string): void { console.warn(`[${category}] ${message}`) }

export async function disposeRuntime(): Promise<void> { await scope?.dispose() }
