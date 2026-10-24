import { randomUUID } from 'node:crypto'
import type { LocalFileHandle, LocalFilePickOptions } from './contracts'

type Reply = { type: 'host.response'; id: number; ok: boolean; data?: unknown; error?: string }
let send: ((message: unknown) => void) | undefined
let owner = ''
let sequence = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const eventNames = new Set(['ssh.data', 'ssh.exit', 'ssh.error', 'ssh.auth', 'ssh.metrics', 'ssh.transfer'])

export function configureHostBridge(pluginId: string, post: (message: unknown) => void): void { owner = pluginId; send = post }
export function receiveHostReply(reply: Reply): void {
  if (reply.type !== 'host.response' || !Number.isSafeInteger(reply.id) || typeof reply.ok !== 'boolean') return
  const request = pending.get(reply.id)
  if (!request) return
  pending.delete(reply.id); clearTimeout(request.timer)
  if (reply.ok) request.resolve(reply.data); else request.reject(new Error(String(reply.error || 'Host operation failed').slice(0, 4096)))
}
export function disposeHostBridge(): void {
  send = undefined
  owner = ''
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Plugin backend closed')) }
  pending.clear()
}
export function hostCall<T>(pluginId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!send || pluginId !== owner) return Promise.reject(new Error('Invalid backend owner'))
  if (pending.size >= 64) return Promise.reject(new Error('Host request limit reached'))
  return new Promise<T>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host operation timed out')) }, 120_000)
    pending.set(id, { resolve: value => resolve(value as T), reject, timer })
    try {
      const message = { type: 'host.request', id, method, params }
      if (Buffer.byteLength(JSON.stringify(message)) > 4 * 1024 * 1024) throw new Error('Host request exceeds 4 MiB')
      send!(message)
    } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
  })
}
export const resolveSecret = (id: string, ref: string): Promise<string | null> => hostCall(id, 'secret.resolve', { ref })
export const authorizePluginPermission = async (id: string, permission: string, summary: string): Promise<void> => { await hostCall(id, 'permission.authorize', { permission, summary }) }
export const resolveLocalFileHandle = (id: string, handleId: string, access: 'read' | 'write' = 'read'): Promise<string> => hostCall(id, 'files.resolve', { handleId, access })
export const resolveLocalDirectoryTarget = (id: string, handleId: string, name: string): Promise<string> => hostCall(id, 'files.directoryTarget', { handleId, name })
export const pickLocalFiles = (id: string, options?: LocalFilePickOptions): Promise<LocalFileHandle[]> => hostCall(id, 'files.pick', { options })
export const createExportDirectory = (id: string): Promise<string> => hostCall(id, 'files.exportDirectory')
export const createLocalExport = (id: string, paths: string[]): Promise<{ exportId: string }> => hostCall(id, 'files.export', { paths })
export const getPluginStorageValue = (id: string, key: string): Promise<unknown> => hostCall(id, 'storage.get', { key })
export const setPluginStorageValue = async (id: string, key: string, value: unknown): Promise<void> => { await hostCall(id, 'storage.set', { key, value }) }
export const pluginHost = { sendEvent(id: string, data: { type: string; [key: string]: unknown }): void {
  if (id !== owner || !send || !eventNames.has(data.type)) return
  const message = { event: data.type, data }
  if (Buffer.byteLength(JSON.stringify(message)) <= 8 * 1024 * 1024) send(message)
} }
export const logInfo = (source: string, message: string): void => { void hostCall(owner, 'log.write', { level: 'info', source, message }).catch(() => {}) }
export const logWarn = (source: string, message: string): void => { void hostCall(owner, 'log.write', { level: 'warn', source, message }).catch(() => {}) }
export function acquirePluginActivity(id: string, _key: string, reason: string): () => void {
  const token = randomUUID()
  let released = false, acquired = false
  const release = (): void => { void hostCall(id, 'activity.release', { token }).catch(() => {}) }
  // Releasing before the asynchronous acquire reply must not leave a late lease behind.
  void hostCall(id, 'activity.acquire', { token, reason }).then(() => {
    acquired = true
    if (released) release()
  }, () => {})
  return () => { if (!released) { released = true; if (acquired) release() } }
}
