import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  EngineInstallOutcome,
  EngineInstallStart,
  SourceFilters,
  WallpaperItem,
} from './contracts'
import { MEDIA_TYPES, WALLPAPER_FITS, isVideoQuality, selectVideoVariant } from './contracts'
import {
  beginShutdown,
  currentScope,
  initializeRuntime,
  installSignalHandlers,
  isClosing,
  logMessage,
  onShutdown,
  parentPort,
  postEvent,
  receiveHostResponse,
} from './runtime'
import { ensurePluginPaths, helperTarget, resolveExistingHelper } from './paths'
import { libraryStore, loadSettings, updateSettings } from './store'
import { createVideoSession, releaseVideoSession } from './mediaProxy'
import { asRecord, errorMessage, fail, isHttpUrl, optionalString, requireBoolean, requireString } from './util'
import { listSources, searchSource, cancelSearch, detailSource, setSourceEnabled, invalidateSourceKey, resolveAsset } from './sources/registry'
import {
  cancelDownload,
  importLocalWallpaper,
  importUrlWallpaper,
  libraryPreview,
  libraryThumbnail,
  listLibrary,
  removeLibraryItem,
  setFavorite,
  setLibraryFolder,
  sourcePreview,
  sourceThumbnail,
  startDownload,
  shutdownDownloads,
  useDefaultLibraryFolder,
} from './library/service'
import { loadInstalledScripts, installSourceScript, listSourceScripts, setSourceScriptEnabled, uninstallSourceScript } from './source-scripts/runner'
import { staticWallpaperService } from './wallpaper'
import { engineManager } from './engines/manager'
import { rotationService } from './rotation/service'

const port = parentPort()
let ready: Promise<void> | undefined

port.on('message', ({ data }) => {
  if (!data || typeof data !== 'object') return
  const message = data as Record<string, unknown>
  if (message.type === 'init') {
    try {
      initializeRuntime(message as never)
      ready = initializeServices()
    } catch (error) {
      port.postMessage({ id: 0, ok: false, error: errorMessage(error) })
    }
    return
  }
  if (message.type === 'host.response') {
    receiveHostResponse(message as never)
    return
  }
  if (message.type === 'shutdown') {
    void beginShutdown()
    return
  }
  if (!Number.isSafeInteger(message.id)) return
  if (typeof message.method !== 'string') {
    port.postMessage({ id: message.id, ok: false, error: 'invalid backend method' })
    return
  }
  void handleRequest(message.id as number, message.method, message.args)
})

installSignalHandlers()
onShutdown(async () => {
  shutdownDownloads()
  await rotationService.dispose().catch(() => {})
  await engineManager.dispose().catch(() => {})
  await staticWallpaperService.dispose().catch(() => {})
  await libraryStore.flush().catch(() => {})
})

async function initializeServices(): Promise<void> {
  await ensurePluginPaths()
  await loadSettings()
  await libraryStore.load()
  await loadInstalledScripts().catch(error => {
    void logMessage('warn', 'source-scripts', `加载源脚本失败：${errorMessage(error)}`)
  })
  await rotationService.initialize()
  await engineManager.initialize()
  const settings = await loadSettings()
  if (settings.backgroundEnabled) await rotationService.start().catch(() => {})
}

async function handleRequest(id: number, method: string, rawArgs: unknown): Promise<void> {
  try {
    if (isClosing()) fail('INTERNAL', '后端正在关闭')
    const scope = currentScope()
    if (!ready) fail('INTERNAL', '后端尚未初始化')
    await ready
    const args = Array.isArray(rawArgs) ? rawArgs : []
    const data = await dispatch(method, args)
    if (!scope.isCurrent()) return
    port.postMessage({ id, ok: true, data })
  } catch (error) {
    port.postMessage({ id, ok: false, error: errorMessage(error) })
  }
}

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'system.hello':
      return {
        pluginId: currentScope().pluginId,
        platform: process.platform,
        arch: process.arch,
        helperTarget: helperTarget(),
        node: process.version,
      }

    case 'settings.get':
      return loadSettings()

    case 'settings.update': {
      const patch = asRecord(args[0]) ?? {}
      const settings = await updateSettings(patch)
      const keyRefs = asRecord(patch.sourceKeyRefs)
      if (keyRefs) for (const sourceId of Object.keys(keyRefs)) invalidateSourceKey(sourceId)
      if (patch.backgroundEnabled === false) {
        await rotationService.stop()
        await engineManager.stop()
      } else if (patch.backgroundEnabled === true) {
        await rotationService.start()
      }
      return settings
    }

    case 'background.start': {
      const settings = await loadSettings()
      if (settings.rotation.enabled) await rotationService.start()
      return backgroundStatus(settings)
    }

    case 'background.stop':
      await rotationService.stop()
      await engineManager.stop()
      return backgroundStatus(await loadSettings())

    case 'background.status':
      return backgroundStatus(await loadSettings())

    case 'sources.list':
      return listSources()

    case 'sources.search': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'sources.search 需要参数对象')
      const sourceId = requireString(params.sourceId, 'sourceId', 80)
      cancelSearch(sourceId)
      return searchSource({
        sourceId,
        query: optionalString(params.query, 'query', 512),
        page: Number.isSafeInteger(params.page) ? Number(params.page) : 1,
        perPage: Number.isSafeInteger(params.perPage) ? Number(params.perPage) : 24,
        filters: normalizeFilters(params.filters),
        requestId: optionalString(params.requestId, 'requestId', 80) ?? 'search',
      })
    }

    case 'sources.cancel':
      cancelSearch(optionalString(asRecord(args[0])?.sourceId, 'sourceId', 80))
      return { ok: true }

    case 'sources.detail': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'sources.detail 需要参数对象')
      return detailSource(requireString(params.sourceId, 'sourceId', 80), requireString(params.remoteId, 'remoteId', 160))
    }

    case 'sources.setEnabled': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'sources.setEnabled 需要参数对象')
      return setSourceEnabled(requireString(params.sourceId, 'sourceId', 80), requireBoolean(params.enabled, 'enabled'))
    }

    case 'thumbs.get': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'thumbs.get 需要参数对象')
      const url = requireString(params.url, 'url', 8192)
      if (!isHttpUrl(url)) fail('INVALID_ARGUMENT', '缩略图 URL 必须是 http(s)')
      return sourceThumbnail({
        sourceId: optionalString(params.sourceId, 'sourceId', 80) ?? 'unknown',
        remoteId: optionalString(params.remoteId, 'remoteId', 160) ?? '',
        title: '',
        mediaType: 'image',
        thumbUrl: url,
        previewUrl: url,
        fullUrl: url,
        downloadAllowed: false,
        exportAllowed: false,
        thumbHeaders: normalizeHeaders(params.headers),
      })
    }

    case 'media.video': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'media.video 需要参数对象')
      if (typeof params.libraryId === 'string' && params.libraryId) {
        await libraryStore.load()
        const libraryItem = libraryStore.get(params.libraryId)
        if (!libraryItem) fail('LIBRARY_FILE_MISSING', '本地视频不存在')
        const settings = await loadSettings()
        if (!settings.libraryPath) fail('LIBRARY_NOT_CONFIGURED', '请先设置壁纸库目录')
        const filePath = join(settings.libraryPath, libraryItem.fileName)
        if (!existsSync(filePath)) fail('LIBRARY_FILE_MISSING', '本地视频文件已丢失')
        const session = await createVideoSession({ filePath })
        return { ...session, poster: libraryItem.item.thumbUrl || undefined }
      }
      const item = normalizeWallpaperItem(params.item)
      if (!item || item.mediaType !== 'video') fail('INVALID_ARGUMENT', 'media.video 需要视频项目或 libraryId')
      const appSettings = await loadSettings()
      let url = selectVideoVariant(item, appSettings.engineSettings.videoQuality)
      let headers = { ...item.downloadHeaders }
      if (!item.variants?.length) {
        const asset = await resolveAsset(item)
        url = asset.url
        headers = { ...headers, ...asset.headers }
      }
      const session = await createVideoSession({ url, headers })
      return { ...session, poster: item.previewUrl || item.thumbUrl }
    }

    case 'media.releaseVideo': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'media.releaseVideo 需要参数对象')
      releaseVideoSession(requireString(params.token, 'token', 160))
      return { ok: true }
    }

    case 'media.preview': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'media.preview 需要参数对象')
      if (typeof params.libraryId === 'string' && params.libraryId) return libraryPreview(params.libraryId)
      const item = normalizeWallpaperItem(params.item)
      if (!item) fail('INVALID_ARGUMENT', 'media.preview 需要 item 或 libraryId')
      return sourcePreview(item)
    }

    case 'scripts.list':
      return listSourceScripts()

    case 'scripts.install': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'scripts.install 需要参数对象')
      return installSourceScript({
        source: params.source === 'url' ? 'url' : 'file',
        handleId: optionalString(params.handleId, 'handleId', 256),
        url: optionalString(params.url, 'url', 8192),
      })
    }

    case 'scripts.uninstall': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'scripts.uninstall 需要参数对象')
      await uninstallSourceScript(requireString(params.id, 'id', 80))
      return { ok: true }
    }

    case 'scripts.setEnabled': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'scripts.setEnabled 需要参数对象')
      await setSourceScriptEnabled(requireString(params.id, 'id', 80), requireBoolean(params.enabled, 'enabled'))
      return { ok: true }
    }

    case 'library.list':
      return listLibrary()

    case 'library.folder.set': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'library.folder.set 需要参数对象')
      return setLibraryFolder(requireString(params.handleId, 'handleId', 256))
    }

    case 'library.folder.useDefault':
      return useDefaultLibraryFolder()

    case 'library.download': {
      const item = normalizeWallpaperItem(asRecord(args[0])?.item)
      if (!item) fail('INVALID_ARGUMENT', 'library.download 需要有效的壁纸项目')
      return startDownload(item)
    }

    case 'library.cancel': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'library.cancel 需要参数对象')
      return { ok: cancelDownload(requireString(params.jobId, 'jobId', 120)) }
    }

    case 'library.importLocal': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'library.importLocal 需要参数对象')
      return importLocalWallpaper({
        handleId: requireString(params.handleId, 'handleId', 256),
        title: optionalString(params.title, 'title', 240),
        mediaType: normalizeMediaType(params.mediaType),
      })
    }

    case 'library.importUrl': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'library.importUrl 需要参数对象')
      return importUrlWallpaper({
        url: requireString(params.url, 'url', 8192),
        title: optionalString(params.title, 'title', 240),
        mediaType: normalizeMediaType(params.mediaType),
        author: optionalString(params.author, 'author', 240),
        license: optionalString(params.license, 'license', 240),
        sourceUrl: optionalString(params.sourceUrl, 'sourceUrl', 8192),
      })
    }

    case 'library.remove': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'library.remove 需要参数对象')
      return { ok: await removeLibraryItem(requireString(params.id, 'id', 100), params.deleteFile !== false) }
    }

    case 'library.favorite': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'library.favorite 需要参数对象')
      return setFavorite(requireString(params.id, 'id', 100), requireBoolean(params.favorite, 'favorite'))
    }

    case 'library.thumb': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'library.thumb 需要参数对象')
      return libraryThumbnail(requireString(params.id, 'id', 100))
    }

    case 'library.preview': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'library.preview 需要参数对象')
      return libraryPreview(requireString(params.id, 'id', 100))
    }

    case 'wallpaper.capabilities':
      return engineManager.capabilities()

    case 'wallpaper.listDisplays':
      return staticWallpaperService.listDisplays()

    case 'wallpaper.setStatic': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'wallpaper.setStatic 需要参数对象')
      const fit = typeof params.fit === 'string' && (WALLPAPER_FITS as readonly string[]).includes(params.fit) ? params.fit as AppSettings['defaultFit'] : undefined
      return staticWallpaperService.setStatic({
        libraryId: optionalString(params.libraryId, 'libraryId', 100),
        path: optionalString(params.path, 'path', 4096),
        fit,
        displayIds: Array.isArray(params.displayIds) ? params.displayIds.filter((id): id is string => typeof id === 'string').slice(0, 8) : undefined,
      })
    }

    case 'wallpaper.current':
      return staticWallpaperService.current()

    case 'engines.list':
      return engineManager.list()

    case 'engines.select': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'engines.select 需要参数对象')
      return engineManager.select(requireString(params.engineId, 'engineId', 80))
    }

    case 'engines.install': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'engines.install 需要参数对象')
      const engineId = requireString(params.engineId, 'engineId', 80)
      void engineManager.install(engineId).then(result => {
        postEvent('engine.install.outcome', { engineId, ok: true, action: 'install', result } satisfies EngineInstallOutcome)
      }).catch(error => {
        postEvent('engine.install.outcome', { engineId, ok: false, action: 'install', error: errorMessage(error) } satisfies EngineInstallOutcome)
      })
      return { accepted: true, engineId } satisfies EngineInstallStart
    }

    case 'engines.uninstall': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'engines.uninstall 需要参数对象')
      const engineId = requireString(params.engineId, 'engineId', 80)
      void engineManager.uninstall(engineId).then(() => {
        postEvent('engine.install.outcome', { engineId, ok: true, action: 'uninstall' } satisfies EngineInstallOutcome)
      }).catch(error => {
        postEvent('engine.install.outcome', { engineId, ok: false, action: 'uninstall', error: errorMessage(error) } satisfies EngineInstallOutcome)
      })
      return { accepted: true, engineId } satisfies EngineInstallStart
    }

    case 'engines.start': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'engines.start 需要参数对象')
      const settings = await loadSettings()
      return engineManager.start({
        libraryId: optionalString(params.libraryId, 'libraryId', 100),
        url: optionalString(params.url, 'url', 8192),
        settings: settings.engineSettings,
      })
    }

    case 'engines.stop':
      return engineManager.stop()

    case 'engines.status':
      return engineManager.status()

    case 'engines.settings': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'engines.settings 需要参数对象')
      const input = asRecord(params.settings)
      if (!input) fail('INVALID_ARGUMENT', 'engines.settings 缺少 settings 对象')
      const current = (await loadSettings()).engineSettings
      const fps = Number(input.fpsLimit)
      return engineManager.applySettings({
        fpsLimit: fps === 24 || fps === 30 || fps === 60 ? fps : current.fpsLimit,
        mute: typeof input.mute === 'boolean' ? input.mute : current.mute,
        pauseOnFullscreen: typeof input.pauseOnFullscreen === 'boolean' ? input.pauseOnFullscreen : current.pauseOnFullscreen,
        pauseOnBattery: typeof input.pauseOnBattery === 'boolean' ? input.pauseOnBattery : current.pauseOnBattery,
        pauseOnLock: typeof input.pauseOnLock === 'boolean' ? input.pauseOnLock : current.pauseOnLock,
        lowPower: typeof input.lowPower === 'boolean' ? input.lowPower : current.lowPower,
        quality: input.quality === 'low' || input.quality === 'medium' || input.quality === 'high' ? input.quality : current.quality,
        videoQuality: isVideoQuality(input.videoQuality) ? input.videoQuality : current.videoQuality,
      })
    }

    case 'engines.diagnostics': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'engines.diagnostics 需要参数对象')
      return engineManager.diagnostics(requireString(params.engineId, 'engineId', 80))
    }

    case 'rotation.get': {
      const settings = await loadSettings()
      return { settings: settings.rotation, state: rotationService.stateValue() }
    }

    case 'rotation.update': {
      const params = asRecord(args[0])
      if (!params) fail('INVALID_ARGUMENT', 'rotation.update 需要参数对象')
      const patch = asRecord(params.patch) ?? {}
      const state = await rotationService.update(patch)
      return { settings: (await loadSettings()).rotation, state }
    }

    case 'rotation.next':
      return rotationService.next(true)

    case 'diagnostics': {
      const settings = await loadSettings()
      const target = helperTarget()
      const helper = target ? resolveExistingHelper(target) : null
      const engines = await engineManager.list()
      return {
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        arch: process.arch,
        node: process.version,
        session: process.platform === 'linux' ? staticWallpaperService.capabilities().session : process.platform === 'darwin' ? 'macOS' : 'Windows',
        dataRoot: currentScope().context.appDataPath,
        helperTarget: target ?? 'unsupported',
        helperInstalled: Boolean(helper),
        helperPath: helper ?? undefined,
        libraryPath: settings.libraryPath,
        libraryCount: libraryStore.size,
        engines: engines.map(engine => ({
          id: engine.descriptor.id,
          installed: engine.detection.installed,
          detected: engine.detection.detected,
          reason: engine.detection.reason,
        })),
        notes: [
          '动态壁纸仅在 eNest 运行期间保持；退出 eNest 会停止内置 helper。',
          'GNOME/KDE Wayland 的动态桌面层不由内置引擎提供，请使用静态壁纸。',
        ],
      }
    }

    default:
      fail('INVALID_ARGUMENT', `未知后端方法：${method}`)
  }
}

function backgroundStatus(settings: AppSettings) {
  return {
    enabled: settings.backgroundEnabled,
    rotation: rotationService.stateValue(),
    engine: engineManager.status(),
    settings,
    libraryPath: settings.libraryPath,
  }
}

function normalizeWallpaperItem(value: unknown): WallpaperItem | null {
  const record = asRecord(value)
  if (!record) return null
  const mediaType = normalizeMediaType(record.mediaType)
  if (!mediaType) return null
  const sourceId = typeof record.sourceId === 'string' ? record.sourceId.slice(0, 80) : ''
  const remoteId = typeof record.remoteId === 'string' ? record.remoteId.slice(0, 160) : ''
  const fullUrl = typeof record.fullUrl === 'string' && isHttpUrl(record.fullUrl) ? record.fullUrl : ''
  if (!sourceId || !remoteId || !fullUrl) return null
  const thumbUrl = typeof record.thumbUrl === 'string' && isHttpUrl(record.thumbUrl) ? record.thumbUrl : fullUrl
  return {
    sourceId,
    remoteId,
    title: typeof record.title === 'string' ? record.title.slice(0, 240) : remoteId,
    mediaType,
    thumbUrl,
    previewUrl: typeof record.previewUrl === 'string' && isHttpUrl(record.previewUrl) ? record.previewUrl : thumbUrl,
    fullUrl,
    width: positive(record.width),
    height: positive(record.height),
    fileSize: positive(record.fileSize),
    mime: typeof record.mime === 'string' ? record.mime.slice(0, 120) : undefined,
    author: optionalString(record.author, 'author', 240),
    authorUrl: optionalString(record.authorUrl, 'authorUrl', 2048),
    license: optionalString(record.license, 'license', 240),
    licenseUrl: optionalString(record.licenseUrl, 'licenseUrl', 2048),
    sourceUrl: optionalString(record.sourceUrl, 'sourceUrl', 2048),
    attribution: optionalString(record.attribution, 'attribution', 1024),
    color: typeof record.color === 'string' && /^#[0-9a-f]{6}$/i.test(record.color) ? record.color : undefined,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 32) : undefined,
    durationMs: positive(record.durationMs),
    downloadAllowed: record.downloadAllowed !== false,
    exportAllowed: record.exportAllowed === true,
    thumbHeaders: normalizeHeaders(record.thumbHeaders),
    downloadHeaders: normalizeHeaders(record.downloadHeaders),
    variants: normalizeVariants(record.variants),
    meta: asRecord(record.meta) as WallpaperItem['meta'],
  }
}

function normalizeMediaType(value: unknown): WallpaperItem['mediaType'] | undefined {
  return typeof value === 'string' && (MEDIA_TYPES as readonly string[]).includes(value) ? value as WallpaperItem['mediaType'] : undefined
}

function normalizeVariants(value: unknown): WallpaperItem['variants'] {
  if (!Array.isArray(value)) return undefined
  const variants = value
    .map(item => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter(item => typeof item.url === 'string' && isHttpUrl(item.url))
    .slice(0, 24)
    .map(item => ({
      url: item.url as string,
      width: positive(item.width),
      height: positive(item.height),
      fileSize: positive(item.fileSize),
      mime: typeof item.mime === 'string' ? item.mime.slice(0, 120) : undefined,
      label: typeof item.label === 'string' ? item.label.slice(0, 80) : undefined,
    }))
  return variants.length ? variants : undefined
}

function normalizeFilters(value: unknown): SourceFilters {
  const record = asRecord(value)
  const result: SourceFilters = {}
  if (!record) return result
  for (const [key, entry] of Object.entries(record)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      result[key] = entry
      continue
    }
    if (Array.isArray(entry)) {
      const values = entry.filter((item): item is string => typeof item === 'string').slice(0, 32)
      result[key] = values
    }
  }
  return result
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (/^[A-Za-z0-9-]{1,64}$/.test(key) && typeof entry === 'string' && entry.length <= 2048) result[key] = entry
  }
  return Object.keys(result).length ? result : undefined
}

function positive(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined
}
