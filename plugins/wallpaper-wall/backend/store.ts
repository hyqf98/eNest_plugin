import { storageGet, storageSet } from '@backend/runtime'
import type {
  AppSettings,
  LibraryItem,
  RotationSettings,
  WallpaperFit,
} from '@backend/contracts'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_ROTATION_SETTINGS,
  FPS_LIMITS,
  isVideoQuality,
  isWallpaperFit,
} from '@backend/contracts'
import { asRecord, clamp, errorMessage, fail, pickBoolean, pickNumber, pickString, uniqueBy } from '@backend/util'

const SETTINGS_KEY = 'app.settings'
const LIBRARY_META_KEY = 'library.meta'
const LIBRARY_CHUNK_PREFIX = 'library.chunk.'
const LIBRARY_CHUNK_SIZE = 80
const LIBRARY_VERSION = 1
const MAX_LIBRARY_ITEMS = 2000

let settingsCache: AppSettings | undefined
let settingsLoad: Promise<AppSettings> | undefined
let settingsWrite: Promise<void> = Promise.resolve()

export async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return structuredClone(settingsCache)
  if (!settingsLoad) {
    settingsLoad = (async () => {
      let raw: unknown = null
      try {
        raw = await storageGet(SETTINGS_KEY)
      } catch {
        raw = null
      }
      settingsCache = normalizeSettings(raw)
      return structuredClone(settingsCache)
    })().finally(() => { settingsLoad = undefined })
  }
  return settingsLoad
}

export async function updateSettings(patch: unknown): Promise<AppSettings> {
  const record = asRecord(patch)
  if (!record) fail('INVALID_ARGUMENT', 'settings patch 必须是对象')
  settingsWrite = settingsWrite.then(async () => {
    const current = await loadSettings()
    const rotationPatch = asRecord(record.rotation)
    const enginePatch = asRecord(record.engineSettings)
    const merged = {
      ...current,
      ...record,
      rotation: rotationPatch ? { ...current.rotation, ...rotationPatch } : current.rotation,
      engineSettings: enginePatch ? { ...current.engineSettings, ...enginePatch } : current.engineSettings,
    }
    const next = normalizeSettings(merged)
    await storageSet(SETTINGS_KEY, next)
    settingsCache = next
  })
  await settingsWrite
  return structuredClone(await loadSettings())
}

export async function setSettings(next: AppSettings): Promise<AppSettings> {
  const normalized = normalizeSettings(next)
  settingsWrite = settingsWrite.then(async () => {
    await storageSet(SETTINGS_KEY, normalized)
    settingsCache = normalized
  })
  await settingsWrite
  return structuredClone(normalized)
}

export async function setSourceKeyRef(sourceId: string, secretRef: string | null): Promise<AppSettings> {
  const current = await loadSettings()
  const next = { ...current.sourceKeyRefs }
  if (secretRef) next[sourceId] = secretRef
  else delete next[sourceId]
  return updateSettings({ sourceKeyRefs: next })
}

export function normalizeSettings(value: unknown): AppSettings {
  const record = asRecord(value) ?? {}
  const rotationRecord = asRecord(record.rotation) ?? {}
  const engineRecord = asRecord(record.engineSettings) ?? {}
  const sourceKeyRefsRecord = asRecord(record.sourceKeyRefs) ?? {}
  const sourceKeyRefs: Record<string, string> = {}
  for (const [key, ref] of Object.entries(sourceKeyRefsRecord)) {
    if (/^[A-Za-z0-9._-]{1,64}$/.test(key) && typeof ref === 'string' && ref.length <= 1024) sourceKeyRefs[key] = ref
  }
  const enabledSources = Array.isArray(record.enabledSources)
    ? uniqueBy(record.enabledSources.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id)), id => id)
    : []
  const selectedEngineId = typeof record.selectedEngineId === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(record.selectedEngineId)
    ? record.selectedEngineId
    : DEFAULT_APP_SETTINGS.selectedEngineId
  const fit = typeof record.defaultFit === 'string' && isWallpaperFit(record.defaultFit)
    ? record.defaultFit
    : DEFAULT_APP_SETTINGS.defaultFit
  const rotation = normalizeRotation(rotationRecord)
  const fps = FPS_LIMITS.includes(Number(engineRecord.fpsLimit) as (typeof FPS_LIMITS)[number])
    ? Number(engineRecord.fpsLimit) as AppSettings['engineSettings']['fpsLimit']
    : DEFAULT_ENGINE_SETTINGS.fpsLimit
  const quality = engineRecord.quality === 'low' || engineRecord.quality === 'medium' || engineRecord.quality === 'high'
    ? engineRecord.quality
    : DEFAULT_ENGINE_SETTINGS.quality
  return {
    defaultFit: fit,
    backgroundEnabled: pickBoolean(record.backgroundEnabled, false),
    libraryPath: typeof record.libraryPath === 'string' && record.libraryPath.trim() ? record.libraryPath.trim() : null,
    enabledSources,
    sourceKeyRefs,
    rotation,
    engineSettings: {
      fpsLimit: fps,
      mute: pickBoolean(engineRecord.mute, true),
      pauseOnFullscreen: pickBoolean(engineRecord.pauseOnFullscreen, true),
      pauseOnBattery: pickBoolean(engineRecord.pauseOnBattery, true),
      pauseOnLock: pickBoolean(engineRecord.pauseOnLock, true),
      lowPower: pickBoolean(engineRecord.lowPower, false),
      quality,
      videoQuality: isVideoQuality(engineRecord.videoQuality) ? engineRecord.videoQuality : '1080p',
    },
    selectedEngineId,
  }
}

export function normalizeRotation(value: unknown): RotationSettings {
  const record = asRecord(value) ?? {}
  const fit = typeof record.fit === 'string' && isWallpaperFit(record.fit) ? record.fit : DEFAULT_ROTATION_SETTINGS.fit
  return {
    enabled: pickBoolean(record.enabled, false),
    intervalMinutes: Math.round(clamp(pickNumber(record.intervalMinutes, 60), 5, 24 * 60)),
    source: record.source === 'favorites' ? 'favorites' : 'library',
    order: record.order === 'random' ? 'random' : 'sequential',
    fit: fit as WallpaperFit,
    includeDynamic: pickBoolean(record.includeDynamic, false),
  }
}

interface LibraryMeta {
  version: number
  count: number
  chunks: number
  updatedAt: number
}

export class LibraryStore {
  private items = new Map<string, LibraryItem>()
  private loaded = false
  private loadPromise: Promise<void> | undefined
  private saveTimer: NodeJS.Timeout | undefined
  private savePromise: Promise<void> = Promise.resolve()
  private dirty = false

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      let meta: LibraryMeta | null = null
      try {
        const raw = await storageGet(LIBRARY_META_KEY)
        meta = normalizeMeta(raw)
      } catch {
        meta = null
      }
      if (!meta || meta.chunks < 1) {
        this.loaded = true
        return
      }
      const chunkIndexes = Array.from({ length: meta.chunks }, (_, index) => index)
      const chunks = await mapLimit(chunkIndexes, 4, async index => {
        try {
          return await storageGet(`${LIBRARY_CHUNK_PREFIX}${index}`)
        } catch {
          return null
        }
      })
      for (const chunk of chunks) {
        if (!Array.isArray(chunk)) continue
        for (const item of chunk) {
          const normalized = normalizeLibraryItem(item)
          if (normalized) this.items.set(normalized.id, normalized)
        }
      }
      this.loaded = true
    })().finally(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  list(): LibraryItem[] {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): LibraryItem | null {
    return this.items.get(id) ?? null
  }

  get size(): number {
    return this.items.size
  }

  totalBytes(): number {
    let total = 0
    for (const item of this.items.values()) total += item.bytes
    return total
  }

  async add(item: LibraryItem): Promise<LibraryItem> {
    await this.load()
    if (this.items.size >= MAX_LIBRARY_ITEMS && !this.items.has(item.id)) {
      fail('INVALID_ARGUMENT', `本地库最多 ${MAX_LIBRARY_ITEMS} 项，请先删除不再使用的壁纸`)
    }
    this.items.set(item.id, item)
    this.markDirty()
    await this.flush()
    return item
  }

  async remove(id: string): Promise<boolean> {
    await this.load()
    const removed = this.items.delete(id)
    if (removed) {
      this.markDirty()
      await this.flush()
    }
    return removed
  }

  async update(id: string, patch: Partial<LibraryItem>): Promise<LibraryItem | null> {
    await this.load()
    const current = this.items.get(id)
    if (!current) return null
    const next = normalizeLibraryItem({ ...current, ...patch, id: current.id })
    if (!next) return null
    this.items.set(id, next)
    this.markDirty()
    await this.flush()
    return next
  }

  private markDirty(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush().catch(() => {})
    }, 250)
    this.saveTimer.unref()
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    if (!this.dirty) return this.savePromise
    this.dirty = false
    const snapshot = this.list()
    this.savePromise = this.savePromise.then(async () => {
      const chunks: LibraryItem[][] = []
      for (let index = 0; index < snapshot.length; index += LIBRARY_CHUNK_SIZE) {
        chunks.push(snapshot.slice(index, index + LIBRARY_CHUNK_SIZE))
      }
      for (let index = 0; index < chunks.length; index += 1) {
        await storageSet(`${LIBRARY_CHUNK_PREFIX}${index}`, chunks[index])
      }
      const meta: LibraryMeta = { version: LIBRARY_VERSION, count: snapshot.length, chunks: chunks.length, updatedAt: Date.now() }
      await storageSet(LIBRARY_META_KEY, meta)
      // 旧分块保留但不再被 meta 引用；下一次写入会覆盖。避免在元数据提交前删除可回滚数据。
    }).catch(error => {
      this.dirty = true
      throw new Error(`本地库索引写入失败：${errorMessage(error)}`)
    })
    return this.savePromise
  }
}

export const libraryStore = new LibraryStore()

export function normalizeMeta(value: unknown): LibraryMeta | null {
  const record = asRecord(value)
  if (!record || record.version !== LIBRARY_VERSION) return null
  const count = Number(record.count)
  const chunks = Number(record.chunks)
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(chunks) || count < 0 || chunks < 0 || chunks > 64) return null
  return { version: LIBRARY_VERSION, count, chunks, updatedAt: pickNumber(record.updatedAt) }
}

export function normalizeLibraryItem(value: unknown): LibraryItem | null {
  const record = asRecord(value)
  if (!record) return null
  const item = asRecord(record.item)
  if (!item) return null
  const id = pickString(record.id)
  const sourceId = pickString(item.sourceId)
  const remoteId = pickString(item.remoteId)
  const mediaType = item.mediaType
  if (!id || id.length > 100 || !sourceId || !remoteId) return null
  if (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'gif' && mediaType !== 'web') return null
  const title = pickString(item.title, '未命名壁纸').slice(0, 240)
  const thumbUrl = pickString(item.thumbUrl)
  const previewUrl = pickString(item.previewUrl, thumbUrl)
  const fullUrl = pickString(item.fullUrl, previewUrl)
  const fileName = pickString(record.fileName)
  const bytes = pickNumber(record.bytes)
  const sha256 = pickString(record.sha256)
  if (!fileName || !sha256) return null
  const displayPath = pickString(record.displayPath, fileName)
  return {
    id,
    item: {
      sourceId,
      remoteId,
      title,
      mediaType,
      thumbUrl,
      previewUrl,
      fullUrl,
      width: optionalPositive(item.width),
      height: optionalPositive(item.height),
      fileSize: optionalPositive(item.fileSize),
      mime: typeof item.mime === 'string' ? item.mime.slice(0, 120) : undefined,
      author: optionalText(item.author, 240),
      authorUrl: optionalText(item.authorUrl, 2048),
      license: optionalText(item.license, 240),
      licenseUrl: optionalText(item.licenseUrl, 2048),
      sourceUrl: optionalText(item.sourceUrl, 2048),
      attribution: optionalText(item.attribution, 1024),
      color: typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : undefined,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 32) : undefined,
      durationMs: optionalPositive(item.durationMs),
      downloadAllowed: item.downloadAllowed !== false,
      exportAllowed: item.exportAllowed !== false,
      thumbHeaders: stringRecord(item.thumbHeaders),
      downloadHeaders: stringRecord(item.downloadHeaders),
    },
    fileName: fileName.slice(0, 180),
    bytes: Math.max(0, Math.round(bytes)),
    sha256: sha256.slice(0, 64),
    createdAt: Math.max(0, Math.round(pickNumber(record.createdAt, Date.now()))),
    favorite: pickBoolean(record.favorite),
    width: optionalPositive(record.width) ?? optionalPositive(item.width),
    height: optionalPositive(record.height) ?? optionalPositive(item.height),
    displayPath: displayPath.slice(0, 2048),
    mediaType,
  }
}

function optionalPositive(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, maxLength) : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (/^[A-Za-z0-9-]{1,64}$/.test(key) && typeof entry === 'string' && entry.length <= 1024) result[key] = entry
  }
  return Object.keys(result).length ? result : undefined
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await worker(items[current] as T)
    }
  })
  await Promise.all(runners)
  return results
}
