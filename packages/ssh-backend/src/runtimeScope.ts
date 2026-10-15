import { acquirePluginActivity } from './hostBridge'

const scopes = new Map<string, PluginRuntimeScope>()
export class PluginRuntimeScope {
  private controller = new AbortController()
  private disposers = new Set<() => void>()
  private activityCountValue = 0
  constructor(readonly owner: { pluginId: string; generation: number; wcId: number }) {}
  get signal(): AbortSignal { return this.controller.signal }
  get activityCount(): number { return this.activityCountValue }
  isCurrent(): boolean { return scopes.get(this.owner.pluginId) === this && !this.signal.aborted }
  acquireActivity(reason: string): () => void {
    if (!this.isCurrent()) throw new Error('Plugin backend is closing')
    this.activityCountValue++
    const releaseHost = acquirePluginActivity(this.owner.pluginId, `scope:${reason}`, reason)
    let released = false
    return () => { if (!released) { released = true; this.activityCountValue--; releaseHost() } }
  }
  addDisposer(dispose: () => void): () => void {
    if (!this.isCurrent()) { dispose(); return () => {} }
    this.disposers.add(dispose)
    return () => { this.disposers.delete(dispose) }
  }
  markClosing(): void {
    if (this.signal.aborted) return
    this.controller.abort(new Error('Plugin backend closed'))
    for (const dispose of this.disposers) { try { dispose() } catch {} }
    this.disposers.clear()
  }
  async dispose(): Promise<void> { this.markClosing(); if (scopes.get(this.owner.pluginId) === this) scopes.delete(this.owner.pluginId) }
}
export function createRuntimeScope(owner: { pluginId: string; generation: number; wcId: number }): PluginRuntimeScope {
  if (scopes.has(owner.pluginId)) throw new Error('Plugin backend already initialized')
  const scope = new PluginRuntimeScope(owner); scopes.set(owner.pluginId, scope); return scope
}
export const getRuntimeScope = (pluginId: string): PluginRuntimeScope | undefined => scopes.get(pluginId)
