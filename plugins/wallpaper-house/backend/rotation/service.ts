import type { LibraryItem, RotationSettings, RotationState } from '@backend/contracts'
import { DEFAULT_ROTATION_SETTINGS, isWallpaperFit } from '@backend/contracts'
import { postEvent, storageGet, storageSet } from '@backend/runtime'
import { libraryStore, loadSettings, updateSettings } from '@backend/store'
import { clamp, errorMessage } from '@backend/util'
import { engineManager } from '../engines/manager'
import { staticWallpaperService } from '../wallpaper'

const STATE_KEY = 'rotation.state'

class RotationService {
  private timer: NodeJS.Timeout | null = null
  private state: RotationState = { running: false, appliedCount: 0 }
  private index = 0

  async initialize(): Promise<void> {
    try {
      const raw = await storageGet(STATE_KEY)
      if (raw && typeof raw === 'object') {
        const record = raw as Record<string, unknown>
        this.index = Number.isSafeInteger(record.index) ? Number(record.index) : 0
        this.state.appliedCount = Number.isSafeInteger(record.appliedCount) ? Number(record.appliedCount) : 0
        this.state.nextAt = Number.isFinite(Number(record.nextAt)) ? Number(record.nextAt) : undefined
        this.state.currentLibraryId = typeof record.currentLibraryId === 'string' ? record.currentLibraryId : undefined
      }
    } catch {
      // 状态是可选的。
    }
  }

  async start(): Promise<RotationState> {
    const settings = await loadSettings()
    if (!settings.rotation.enabled) return this.stop()
    this.state.running = true
    this.state.message = undefined
    this.schedule(settings.rotation)
    this.emit()
    return this.state
  }

  async stop(): Promise<RotationState> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.state.running = false
    this.state.nextAt = undefined
    this.emit()
    return this.state
  }

  stateValue(): RotationState {
    return this.state
  }

  async update(patch: Partial<RotationSettings>): Promise<RotationState> {
    const settings = await loadSettings()
    const next = normalizeRotation({ ...settings.rotation, ...patch })
    await updateSettings({ rotation: next })
    if (next.enabled) {
      this.state.running = true
      this.schedule(next)
    } else {
      await this.stop()
    }
    this.emit()
    return this.state
  }

  async next(manual = false): Promise<RotationState> {
    const settings = await loadSettings()
    if (!settings.rotation.enabled && !manual) return this.state
    await libraryStore.load()
    const all = libraryStore.list()
    const items = settings.rotation.source === 'favorites' ? all.filter(item => item.favorite) : all
    if (!items.length) {
      this.state.message = settings.rotation.source === 'favorites' ? '收藏中还没有壁纸' : '本地库还没有壁纸'
      this.state.running = settings.rotation.enabled
      this.emit()
      return this.state
    }
    const item = pickNext(items, settings.rotation, this.index, this.state.currentLibraryId)
    this.index = Math.max(0, items.findIndex(entry => entry.id === item.id))
    this.state.currentLibraryId = item.id
    this.state.lastAppliedAt = Date.now()
    this.state.appliedCount += 1
    this.state.message = undefined
    try {
      if (settings.rotation.includeDynamic && (item.mediaType === 'video' || item.mediaType === 'gif')) {
        await engineManager.start({ libraryId: item.id, settings: settings.engineSettings })
      } else {
        await staticWallpaperService.setStatic({ libraryId: item.id, fit: settings.rotation.fit })
      }
    } catch (error) {
      this.state.message = `轮换应用失败：${errorMessage(error)}`
    }
    if (settings.rotation.enabled) this.schedule(settings.rotation)
    this.emit()
    await this.persist()
    return this.state
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  private schedule(rotation: RotationSettings): void {
    if (this.timer) clearTimeout(this.timer)
    const interval = clamp(rotation.intervalMinutes, 5, 24 * 60) * 60_000
    const now = Date.now()
    const nextAt = this.state.nextAt && this.state.nextAt > now ? this.state.nextAt : now + interval
    this.state.nextAt = nextAt
    this.timer = setTimeout(() => {
      this.timer = null
      void this.next().catch(() => {})
    }, Math.max(1_000, nextAt - now))
  }

  private emit(): void {
    postEvent('rotation.state', this.state)
  }

  private async persist(): Promise<void> {
    await storageSet(STATE_KEY, {
      index: this.index,
      appliedCount: this.state.appliedCount,
      nextAt: this.state.nextAt,
      currentLibraryId: this.state.currentLibraryId,
    }).catch(() => {})
  }
}

function normalizeRotation(value: unknown): RotationSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_ROTATION_SETTINGS.enabled,
    intervalMinutes: Math.round(clamp(Number(record.intervalMinutes) || DEFAULT_ROTATION_SETTINGS.intervalMinutes, 5, 24 * 60)),
    source: record.source === 'favorites' ? 'favorites' : 'library',
    order: record.order === 'random' ? 'random' : 'sequential',
    fit: typeof record.fit === 'string' && isWallpaperFit(record.fit) ? record.fit : 'fill',
    includeDynamic: typeof record.includeDynamic === 'boolean' ? record.includeDynamic : false,
  }
}

function pickNext(items: LibraryItem[], rotation: RotationSettings, index: number, currentId: string | undefined): LibraryItem {
  if (rotation.order === 'random') {
    const candidates = items.length > 1 ? items.filter(item => item.id !== currentId) : items
    return candidates[Math.floor(Math.random() * candidates.length)] ?? items[0] as LibraryItem
  }
  const start = Number.isSafeInteger(index) ? clamp(index + 1, 0, items.length - 1) : 0
  const candidate = items[start]
  if (candidate && candidate.id !== currentId) return candidate
  return items[(start + 1) % items.length] ?? items[0] as LibraryItem
}

export const rotationService = new RotationService()
