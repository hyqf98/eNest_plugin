import type {
  SourceListEntry,
  SourcePage,
  SourceQuery,
  WallpaperItem,
} from '@backend/contracts'
import { resolveSecret } from '@backend/runtime'
import { loadSettings, updateSettings } from '@backend/store'
import { RateLimitError, TtlCache } from '@backend/net'
import { errorMessage, fail, WallpaperError } from '@backend/util'
import type { ResolvedAsset, SourceAdapter, SourceContext } from './types'
import { wallhavenSource } from './wallhaven'
import { nasaApodSource } from './nasa'
import { nasaImagesSource } from './nasa-images'
import { nasaVideosSource } from './nasa-videos'
import { bingSource } from './bing'
import { picsumSource } from './picsum'
import { wikimediaSource } from './wikimedia'
import { openverseSource } from './openverse'
import { articSource } from './artic'
import { metSource } from './met'
import { unsplashSource } from './unsplash'
import { pexelsSource } from './pexels'
import { pixabaySource } from './pixabay'
import { giphySource } from './giphy'
import { alphaCodersSource } from './alphacoders'

const builtinAdapters: SourceAdapter[] = [
  wallhavenSource,
  nasaApodSource,
  nasaImagesSource,
  nasaVideosSource,
  bingSource,
  picsumSource,
  wikimediaSource,
  openverseSource,
  articSource,
  metSource,
  unsplashSource,
  pexelsSource,
  pixabaySource,
  giphySource,
  alphaCodersSource,
]

const scripts = new Map<string, SourceAdapter>()
const pageCache = new TtlCache<SourcePage>(120, 24 * 60 * 60 * 1000)
const inFlight = new Map<string, Promise<SourcePage>>()
const controllers = new Map<string, AbortController>()
const keyCache = new Map<string, { value: string | null; expiresAt: number }>()

export function adapters(): SourceAdapter[] {
  return [...builtinAdapters, ...scripts.values()]
}

export function adapterById(id: string): SourceAdapter {
  const adapter = adapters().find(entry => entry.descriptor.id === id)
  if (!adapter) fail('SOURCE_UNKNOWN', `未知数据源：${id}`)
  return adapter
}

export async function listSources(): Promise<SourceListEntry[]> {
  const settings = await loadSettings()
  return adapters().map(adapter => {
    const descriptor = adapter.descriptor
    const enabled = settings.enabledSources.length
      ? settings.enabledSources.includes(descriptor.id)
      : descriptor.enabledByDefault
    const hasKey = Boolean(settings.sourceKeyRefs[descriptor.id])
    return {
      ...descriptor,
      enabled,
      hasKey,
      available: !descriptor.requiresKey || hasKey,
      unavailableReason: descriptor.requiresKey && !hasKey ? '需要 API Key' : undefined,
    }
  })
}

export async function setSourceEnabled(sourceId: string, enabled: boolean): Promise<SourceListEntry[]> {
  const adapter = adapterById(sourceId)
  const settings = await loadSettings()
  const current = settings.enabledSources.length
    ? settings.enabledSources
    : adapters().filter(entry => entry.descriptor.enabledByDefault).map(entry => entry.descriptor.id)
  const next = enabled
    ? [...new Set([...current, adapter.descriptor.id])]
    : current.filter(id => id !== adapter.descriptor.id)
  await updateSettings({ enabledSources: next })
  return listSources()
}

export async function searchSource(query: SourceQuery): Promise<SourcePage> {
  const adapter = adapterById(query.sourceId)
  const settings = await loadSettings()
  const enabled = settings.enabledSources.length
    ? settings.enabledSources.includes(query.sourceId)
    : adapter.descriptor.enabledByDefault
  if (!enabled) fail('SOURCE_DISABLED', `数据源 ${adapter.descriptor.name} 已停用`)
  const cacheKey = JSON.stringify({
    sourceId: query.sourceId,
    query: query.query ?? '',
    page: query.page ?? 1,
    perPage: query.perPage ?? null,
    filters: query.filters ?? {},
  })
  const cached = pageCache.get(cacheKey)
  if (cached) return cached
  const running = inFlight.get(cacheKey)
  if (running) return running
  controllers.get(query.sourceId)?.abort()
  const controller = new AbortController()
  controllers.set(query.sourceId, controller)
  const key = await sourceKey(query.sourceId)
  const context: SourceContext = {
    signal: controller.signal,
    key,
    log: () => {},
  }
  const promise = (async () => {
    try {
      const page = await adapter.search(query, context)
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
      pageCache.set(cacheKey, page)
      return page
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      if (error instanceof RateLimitError) fail('SOURCE_RATE_LIMITED', `${adapter.descriptor.name}：${error.message}`)
      if (error instanceof WallpaperError) throw error
      const raw = errorMessage(error)
      const match = /^([A-Z][A-Z_]{2,}):\s*([\s\S]*)$/.exec(raw)
      if (match && match[1] === 'SOURCE_KEY_REQUIRED') fail('SOURCE_KEY_REQUIRED', match[2] || raw)
      fail('SOURCE_REQUEST_FAILED', `${adapter.descriptor.name}：${raw}`)
    } finally {
      inFlight.delete(cacheKey)
      if (controllers.get(query.sourceId) === controller) controllers.delete(query.sourceId)
    }
  })()
  inFlight.set(cacheKey, promise)
  return promise
}

export function cancelSearch(sourceId?: string): void {
  if (sourceId) {
    controllers.get(sourceId)?.abort()
    controllers.delete(sourceId)
    return
  }
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
}

export async function detailSource(sourceId: string, remoteId: string): Promise<WallpaperItem | null> {
  const adapter = adapterById(sourceId)
  if (!adapter.detail) return null
  const key = await sourceKey(sourceId)
  const context: SourceContext = { signal: AbortSignal.timeout(20_000), key, log: () => {} }
  try {
    return await adapter.detail(remoteId, context)
  } catch (error) {
    fail('SOURCE_REQUEST_FAILED', `${adapter.descriptor.name}：${errorMessage(error)}`)
  }
}

export async function resolveAsset(item: WallpaperItem): Promise<ResolvedAsset> {
  const adapter = adapterById(item.sourceId)
  if (!adapter.resolve) return { url: item.fullUrl }
  const key = await sourceKey(item.sourceId)
  const context: SourceContext = { signal: AbortSignal.timeout(30_000), key, log: () => {} }
  try {
    return await adapter.resolve(item, context)
  } catch (error) {
    fail('SOURCE_REQUEST_FAILED', `${adapter.descriptor.name}：${errorMessage(error)}`)
  }
}

export async function sourceKey(sourceId: string): Promise<string | null> {
  const settings = await loadSettings()
  const ref = settings.sourceKeyRefs[sourceId]
  if (!ref) return null
  const cached = keyCache.get(sourceId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  let value: string | null = null
  try {
    value = await resolveSecret(ref)
  } catch {
    value = null
  }
  keyCache.set(sourceId, { value, expiresAt: Date.now() + 5 * 60 * 1000 })
  return value
}

export function invalidateSourceKey(sourceId: string): void {
  keyCache.delete(sourceId)
}

export async function registerScriptAdapter(adapter: SourceAdapter): Promise<void> {
  if (adapters().some(entry => entry.descriptor.id === adapter.descriptor.id)) {
    fail('SCRIPT_INVALID', `数据源 ID 冲突：${adapter.descriptor.id}`)
  }
  scripts.set(adapter.descriptor.id, adapter)
  const settings = await loadSettings()
  if (!settings.enabledSources.length) {
    const defaults = adapters().filter(entry => entry.descriptor.enabledByDefault).map(entry => entry.descriptor.id)
    await updateSettings({ enabledSources: defaults })
  }
}

export async function unregisterScriptAdapter(sourceId: string): Promise<void> {
  scripts.delete(sourceId)
}

export function scriptAdapters(): SourceAdapter[] {
  return [...scripts.values()]
}

export function shutdownSources(): void {
  cancelSearch()
  keyCache.clear()
  pageCache.clear()
}
