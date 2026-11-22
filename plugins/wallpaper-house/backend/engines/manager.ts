import type {
  DynamicSpec,
  EngineInstallResult,
  EngineListItem,
  EngineSettings,
  EngineStatus,
  WallpaperCapabilities,
} from '@backend/contracts'
import { DEFAULT_ENGINE_SETTINGS, isVideoQuality } from '@backend/contracts'
import { postEvent } from '@backend/runtime'
import { loadSettings, updateSettings } from '@backend/store'
import { errorMessage, fail } from '@backend/util'
import { staticWallpaperService } from '../wallpaper'
import { BuiltinEngine } from './builtin'
import { engineDescriptors } from './registry'
import type { EngineAdapter, EngineInstallContext } from './types'
import { supportedOnPlatform } from './types'

class EngineManager {
  private readonly adapters = new Map<string, EngineAdapter>()
  private active: EngineAdapter | null = null
  private selectedId = 'builtin-light'
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    for (const descriptor of engineDescriptors) {
      this.adapters.set(descriptor.id, new BuiltinEngine(descriptor))
    }
    const settings = await loadSettings()
    this.selectedId = this.adapters.has(settings.selectedEngineId) ? settings.selectedEngineId : 'builtin-light'
  }

  async list(): Promise<EngineListItem[]> {
    await this.initialize()
    const entries: EngineListItem[] = []
    for (const descriptor of engineDescriptors) {
      const adapter = this.adapters.get(descriptor.id)
      if (!adapter) continue
      const supported = supportedOnPlatform(descriptor)
      let detection
      try {
        detection = supported ? await adapter.detect() : { supported: false, installed: false, detected: false, reason: `仅支持 ${descriptor.platforms.join(', ')}` }
      } catch (error) {
        detection = { supported, installed: false, detected: false, reason: errorMessage(error) }
      }
      const status = this.active === adapter ? adapter.status() : { state: 'stopped' as const, engineId: descriptor.id }
      entries.push({
        descriptor,
        detection,
        capabilities: adapter.capabilities(),
        active: this.active === adapter,
        selected: this.selectedId === descriptor.id,
        status,
        installedVersion: detection.version,
        canInstall: Boolean(detection.supported && !detection.installed && adapter.install && descriptor.distribution !== 'bundled' && descriptor.distribution !== 'external'),
        canUninstall: Boolean(detection.supported && detection.installed && descriptor.distribution !== 'bundled' && descriptor.distribution !== 'external' && adapter.uninstall),
      })
    }
    return entries
  }

  async capabilities(): Promise<WallpaperCapabilities> {
    await this.initialize()
    const settings = await loadSettings()
    const engines = await this.list()
    return {
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      arch: process.arch,
      session: process.platform === 'linux' ? staticWallpaperService.capabilities().session : process.platform === 'darwin' ? 'macOS' : 'Windows',
      static: staticWallpaperService.capabilities(),
      displays: await staticWallpaperService.listDisplays().catch(() => []),
      engines,
      activeEngineId: this.active?.descriptor.id ?? settings.selectedEngineId,
      engineStatus: this.status(),
    }
  }

  async select(engineId: string): Promise<EngineListItem[]> {
    await this.initialize()
    const adapter = this.adapters.get(engineId)
    if (!adapter) fail('ENGINE_UNKNOWN', `未知引擎：${engineId}`)
    const detection = await adapter.detect()
    if (!detection.supported) fail('ENGINE_UNSUPPORTED', detection.reason || '当前平台不支持此引擎')
    if (this.active && this.active !== adapter) await this.active.stop()
    this.active = null
    this.selectedId = engineId
    await updateSettings({ selectedEngineId: engineId })
    postEvent('engine.selected', { engineId })
    return this.list()
  }

  async start(spec: DynamicSpec): Promise<EngineStatus> {
    await this.initialize()
    const settings = await loadSettings()
    const selectedId = this.selectedId || settings.selectedEngineId
    const selected = this.adapters.get(selectedId)
    if (!selected) fail('ENGINE_UNKNOWN', `未知引擎：${selectedId}`)
    if (this.active && this.active !== selected) await this.active.stop()
    const engineSettings = normalizeSettings(spec.settings, settings.engineSettings)
    const effectiveSpec: DynamicSpec = { ...spec, settings: engineSettings }
    try {
      const session = await selected.start(effectiveSpec)
      this.active = selected
      const status = session.status
      postEvent('engine.status', status)
      return status
    } catch (error) {
      const original = errorMessage(error)
      if (selectedId === 'builtin-light') fail('ENGINE_START_FAILED', original)
      const fallback = this.adapters.get('builtin-light')
      if (!fallback) fail('ENGINE_START_FAILED', original)
      try {
        const detection = await fallback.detect()
        if (!detection.installed) fail('ENGINE_NOT_INSTALLED', '内置引擎 helper 不可用，无法回退')
        const session = await fallback.start(effectiveSpec)
        this.active = fallback
        const status: EngineStatus = { ...session.status, message: `${selected.descriptor.name} 启动失败，已回退内置引擎：${original}` }
        postEvent('engine.status', status)
        return status
      } catch (fallbackError) {
        fail('ENGINE_START_FAILED', `${selected.descriptor.name} 启动失败：${original}；内置引擎回退也失败：${errorMessage(fallbackError)}`)
      }
    }
  }

  async stop(): Promise<EngineStatus> {
    if (this.active) {
      await this.active.stop()
      this.active = null
    }
    const status: EngineStatus = { state: 'stopped', engineId: this.selectedId }
    postEvent('engine.status', status)
    return status
  }

  status(): EngineStatus {
    return this.active?.status() ?? { state: 'stopped', engineId: this.selectedId }
  }

  async applySettings(patch: EngineSettings): Promise<EngineStatus> {
    const settings = await loadSettings()
    const next = normalizeSettings({ ...settings.engineSettings, ...patch }, DEFAULT_ENGINE_SETTINGS)
    await updateSettings({ engineSettings: next })
    if (this.active) await this.active.applySettings(next)
    return this.status()
  }

  async install(engineId: string): Promise<EngineInstallResult> {
    await this.initialize()
    const adapter = this.adapters.get(engineId)
    if (!adapter) fail('ENGINE_UNKNOWN', `未知引擎：${engineId}`)
    if (!adapter.install) fail('ENGINE_UNSUPPORTED', `${adapter.descriptor.name} 不支持自动安装`)
    const context: EngineInstallContext = {
      onProgress: progress => postEvent('engine.install', progress),
    }
    const result = await adapter.install(context)
    postEvent('engine.install', { engineId, phase: 'done', percent: 100, message: result.message })
    return result
  }

  async uninstall(engineId: string): Promise<void> {
    await this.initialize()
    const adapter = this.adapters.get(engineId)
    if (!adapter) fail('ENGINE_UNKNOWN', `未知引擎：${engineId}`)
    if (adapter.descriptor.distribution === 'bundled' || adapter.descriptor.distribution === 'external') {
      fail('ENGINE_UNSUPPORTED', `${adapter.descriptor.name} 不是由插件安装的，不能自动卸载`)
    }
    if (this.active === adapter) await this.stop()
    await adapter.uninstall?.()
    if (this.selectedId === engineId) {
      this.selectedId = 'builtin-light'
      await updateSettings({ selectedEngineId: 'builtin-light' })
    }
  }

  async diagnostics(engineId: string) {
    await this.initialize()
    const adapter = this.adapters.get(engineId)
    if (!adapter) fail('ENGINE_UNKNOWN', `未知引擎：${engineId}`)
    return adapter.diagnostics()
  }

  async dispose(): Promise<void> {
    if (this.active) await this.active.stop().catch(() => {})
    this.active = null
    for (const adapter of this.adapters.values()) await adapter.dispose?.().catch(() => {})
    this.adapters.clear()
    this.initialized = false
  }

  activeEngineId(): string {
    return this.active?.descriptor.id ?? this.selectedId
  }
}

function normalizeSettings(value: unknown, fallback: EngineSettings): EngineSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const fps = Number(record.fpsLimit)
  return {
    fpsLimit: fps === 24 || fps === 30 || fps === 60 ? fps : fallback.fpsLimit,
    mute: typeof record.mute === 'boolean' ? record.mute : fallback.mute,
    pauseOnFullscreen: typeof record.pauseOnFullscreen === 'boolean' ? record.pauseOnFullscreen : fallback.pauseOnFullscreen,
    pauseOnBattery: typeof record.pauseOnBattery === 'boolean' ? record.pauseOnBattery : fallback.pauseOnBattery,
    pauseOnLock: typeof record.pauseOnLock === 'boolean' ? record.pauseOnLock : fallback.pauseOnLock,
    lowPower: typeof record.lowPower === 'boolean' ? record.lowPower : fallback.lowPower,
    quality: record.quality === 'low' || record.quality === 'medium' || record.quality === 'high' ? record.quality : fallback.quality,
    videoQuality: isVideoQuality(record.videoQuality) ? record.videoQuality : fallback.videoQuality,
  }
}

export const engineManager = new EngineManager()
