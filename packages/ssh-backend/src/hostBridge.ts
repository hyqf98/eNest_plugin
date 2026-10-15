import { randomUUID } from 'node:crypto'
import type { LocalFileHandle, LocalFilePickOptions } from './contracts'

type Reply = { hostResult: number; ok: boolean; data?: unknown; error?: string }
let send: (message: unknown) => void
let owner = ''
let sequence = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

export function configureHostBridge(pluginId: string, post: (message: unknown) => void): void { owner = pluginId; send = post }
export function receiveHostReply(reply: Reply): void {
  const request = pending.get(reply.hostResult)
  if (!request) return
  pending.delete(reply.hostResult); clearTimeout(request.timer)
  if (reply.ok) request.resolve(reply.data); else request.reject(new Error(reply.error || 'Host operation failed'))
}
export function disposeHostBridge(): void {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Plugin backend closed')) }
  pending.clear()
}
export function hostCall<T>(pluginId: string, method: string, args: unknown[] = []): Promise<T> {
  if (!send || pluginId !== owner) return Promise.reject(new Error('Invalid backend owner'))
  if (pending.size >= 256) return Promise.reject(new Error('Host request limit reached'))
  return new Promise<T>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host operation timed out')) }, 120_000)
    pending.set(id, { resolve: value => resolve(value as T), reject, timer })
    try { send({ hostCall: id, method, args }) }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
  })
}
export const resolveSecret = (id: string, secretRef: string): Promise<string | null> => hostCall(id, 'secret.resolve', [secretRef])
export const authorizePluginPermission = (id: string, permission: string, reason: string): Promise<void> => hostCall(id, 'permission.authorize', [permission, reason])
export const resolveLocalFileHandle = (id: string, handle: string, access: 'read' | 'write' = 'read'): Promise<string> => hostCall(id, 'files.resolve', [handle, access])
export const resolveLocalDirectoryTarget = (id: string, handle: string, name: string): Promise<string> => hostCall(id, 'files.directoryTarget', [handle, name])
export const pickLocalFiles = (id: string, options?: LocalFilePickOptions): Promise<LocalFileHandle[]> => hostCall(id, 'files.pick', [options])
export const createExportDirectory = (id: string): Promise<string> => hostCall(id, 'files.exportDirectory')
export const createLocalExport = (id: string, paths: string[]): Promise<{ exportId: string }> => hostCall(id, 'files.export', [paths])
export const getPluginStorageValue = (id: string, key: string): Promise<unknown> => hostCall(id, 'storage.get', [key])
export const setPluginStorageValue = (id: string, key: string, value: unknown): Promise<void> => hostCall(id, 'storage.set', [key, value])
export const pluginHost = { sendEvent(id: string, event: unknown): void { if (id === owner && send) send({ hostEvent: 'event', args: [event] }) } }
export const logInfo = (source: string, message: string): void => { void hostCall(owner, 'log', ['info', source, message]).catch(() => {}) }
export const logWarn = (source: string, message: string): void => { void hostCall(owner, 'log', ['warn', source, message]).catch(() => {}) }
export function acquirePluginActivity(id: string, key: string, reason: string): () => void {
  const token = randomUUID()
  void hostCall(id, 'activity.acquire', [token, key, reason]).catch(() => {})
  let released = false
  return () => { if (!released) { released = true; void hostCall(id, 'activity.release', [token]).catch(() => {}) } }
}
