import type {
  AppSettings,
  BackgroundStatus,
  DiagnosticsReport,
  DownloadProgress,
  EngineInstallOutcome,
  EngineInstallProgress,
  EngineListItem,
  EngineSettings,
  LibraryFolderResult,
  LibraryItem,
  LibraryListResult,
  MediaPreviewResult,
  VideoPreviewResult,
  RotationSettings,
  RotationState,
  SourceListEntry,
  SourcePage,
  SourceScriptInfo,
  ThumbResult,
  WallpaperCapabilities,
  WallpaperFit,
  WallpaperItem,
} from '../shared/contracts'

type BackendEvent = { event: string; data: unknown }
type Listener = (payload: BackendEvent) => void

export function getApi() {
  const enest = window.enest || window.zapi
  if (!enest?.backend?.call) throw new Error('壁纸屋需要 eNest 宿主后端支持（backend.node）')
  return enest
}

export async function flushStorage(): Promise<void> {
  try { await getApi().storage.flush() } catch { /* 宿主不支持显式提交时不影响业务 */ }
}

export async function call<T>(method: string, args: unknown[] = [], timeoutMs = 60_000): Promise<T> {
  return getApi().backend.call<T>(method, args, { timeoutMs })
}

export function onBackendEvent(listener: Listener): () => void {
  const api = getApi()
  const wrapped = (data: unknown) => listener(data as BackendEvent)
  api.on('backend.event', wrapped)
  return () => api.off('backend.event', wrapped)
}

export const settings = {
  get: () => call<AppSettings>('settings.get'),
  update: (patch: Partial<AppSettings>) => call<AppSettings>('settings.update', [patch]),
}

export const sources = {
  list: () => call<SourceListEntry[]>('sources.list'),
  search: (request: { sourceId: string; query?: string; page?: number; perPage?: number; filters?: Record<string, unknown>; requestId: string }) =>
    call<SourcePage>('sources.search', [request], 45_000),
  cancel: (sourceId: string) => call<{ ok: boolean }>('sources.cancel', [{ sourceId }], 5_000),
  setEnabled: (sourceId: string, enabled: boolean) => call<SourceListEntry[]>('sources.setEnabled', [{ sourceId, enabled }]),
}

export const thumbs = {
  get: (url: string, headers?: Record<string, string>) =>
    call<ThumbResult>('thumbs.get', [{ url, headers }], 30_000),
}

export const media = {
  preview: (item: WallpaperItem) => call<MediaPreviewResult>('media.preview', [{ item }], 45_000),
  libraryPreview: (libraryId: string) => call<MediaPreviewResult>('media.preview', [{ libraryId }], 45_000),
  video: (input: { item?: WallpaperItem; libraryId?: string }) => call<VideoPreviewResult>('media.video', [input], 60_000),
  releaseVideo: (token: string) => call<{ ok: boolean }>('media.releaseVideo', [{ token }], 5_000),
}

export const library = {
  list: () => call<LibraryListResult>('library.list', [], 30_000),
  download: (item: WallpaperItem) => call<{ jobId: string }>('library.download', [{ item }], 15_000),
  cancel: (jobId: string) => call<{ ok: boolean }>('library.cancel', [{ jobId }], 5_000),
  remove: (id: string, deleteFile: boolean) => call<{ ok: boolean }>('library.remove', [{ id, deleteFile }]),
  favorite: (id: string, favorite: boolean) => call<LibraryItem | null>('library.favorite', [{ id, favorite }]),
  thumbnail: (id: string) => call<ThumbResult>('library.thumb', [{ id }], 30_000),
  preview: (id: string) => call<MediaPreviewResult>('library.preview', [{ id }], 45_000),
  importLocal: (handleId: string, title?: string) => call<LibraryItem>('library.importLocal', [{ handleId, title }], 120_000),
  importUrl: (url: string, title?: string) => call<LibraryItem>('library.importUrl', [{ url, title }], 120_000),
  setFolder: (handleId: string) => call<LibraryFolderResult>('library.folder.set', [{ handleId }], 30_000),
  useDefaultFolder: () => call<LibraryFolderResult>('library.folder.useDefault', [], 30_000),
}

export const wallpaper = {
  capabilities: () => call<WallpaperCapabilities>('wallpaper.capabilities', [], 60_000),
  setStatic: (libraryId: string, fit: WallpaperFit, displayIds?: string[]) =>
    call<{ ok: boolean; applied: Array<{ displayId: string; path: string }>; message?: string }>('wallpaper.setStatic', [{ libraryId, fit, displayIds }], 60_000),
  current: () => call<Array<{ displayId: string; path: string }>>('wallpaper.current', [], 30_000),
}

export const engines = {
  list: () => call<EngineListItem[]>('engines.list', [], 60_000),
  select: (engineId: string) => call<EngineListItem[]>('engines.select', [{ engineId }], 30_000),
  install: (engineId: string) => call<{ accepted: boolean; engineId: string }>('engines.install', [{ engineId }], 10_000),
  uninstall: (engineId: string) => call<{ accepted: boolean; engineId: string }>('engines.uninstall', [{ engineId }], 10_000),
  start: (libraryId?: string, url?: string) => call<{ state: string; message?: string }>('engines.start', [{ libraryId, url }], 60_000),
  stop: () => call<{ state: string }>('engines.stop', [], 30_000),
  status: () => call<{ state: string }>('engines.status', [], 10_000),
  applySettings: (patch: Partial<EngineSettings>) => call<{ state: string }>('engines.settings', [{ settings: patch }], 20_000),
  diagnostics: (engineId: string) => call<{ lines: string[] }>('engines.diagnostics', [{ engineId }], 30_000),
}

export const rotation = {
  get: () => call<{ settings: RotationSettings; state: RotationState }>('rotation.get'),
  update: (patch: Partial<RotationSettings>) => call<{ settings: RotationSettings; state: RotationState }>('rotation.update', [{ patch }]),
  next: () => call<RotationState>('rotation.next', [], 60_000),
}

export const background = {
  start: () => call<BackgroundStatus>('background.start', [], 30_000),
  stop: () => call<BackgroundStatus>('background.stop', [], 30_000),
  status: () => call<BackgroundStatus>('background.status', [], 30_000),
  diagnostics: () => call<DiagnosticsReport>('diagnostics', [], 60_000),
}

export const scripts = {
  list: () => call<SourceScriptInfo[]>('scripts.list'),
  installFromFile: (handleId: string) => call<SourceScriptInfo>('scripts.install', [{ source: 'file', handleId }], 60_000),
  installFromUrl: (url: string) => call<SourceScriptInfo>('scripts.install', [{ source: 'url', url }], 60_000),
  uninstall: (id: string) => call<{ ok: boolean }>('scripts.uninstall', [{ id }]),
  setEnabled: (id: string, enabled: boolean) => call<{ ok: boolean }>('scripts.setEnabled', [{ id, enabled }]),
}

export const host = {
  async pickDirectory(): Promise<string | null> {
    const handles = await getApi().localFiles.pick({ kind: 'directory', access: 'write' })
    return handles[0]?.id ?? null
  },
  async pickFile(extensions: string[] = []): Promise<{ handleId: string; name: string } | null> {
    const handles = await getApi().localFiles.pick({ kind: 'file', access: 'read' })
    const handle = handles[0]
    if (!handle) return null
    if (extensions.length) {
      const lower = handle.name.toLowerCase()
      if (!extensions.some(extension => lower.endsWith(extension))) throw new Error(`请选择 ${extensions.join(' / ')} 文件`)
    }
    return { handleId: handle.id, name: handle.name }
  },
  async readText(handleId: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
    return getApi().localFiles.read({ handleId, encoding: 'text', maxBytes })
  },
  async saveKey(key: string, value: string): Promise<string> {
    const result = await getApi().vault.set(key, value)
    return result.secretRef
  },
  async removeKey(ref: string): Promise<boolean> {
    return getApi().vault.remove(ref)
  },
  async openExternal(url: string): Promise<boolean> {
    return getApi().shell.openExternal(url)
  },
  async toast(body: string, level: 'info' | 'success' | 'error' = 'info'): Promise<boolean> {
    return getApi().ui.toast({ body, level })
  },
  async setResidentSetting(enabled: boolean): Promise<boolean> {
    return getApi().settings.set('backgroundEnabled', enabled)
  },
}

export function subscribeDownload(listener: (progress: DownloadProgress) => void): () => void {
  return onBackendEvent(payload => {
    if (payload.event === 'download.progress') listener(payload.data as DownloadProgress)
  })
}

export function subscribeInstall(listener: (progress: EngineInstallProgress) => void): () => void {
  return onBackendEvent(payload => {
    if (payload.event === 'engine.install') listener(payload.data as EngineInstallProgress)
  })
}

export function subscribeInstallOutcome(listener: (outcome: EngineInstallOutcome) => void): () => void {
  return onBackendEvent(payload => {
    if (payload.event === 'engine.install.outcome') listener(payload.data as EngineInstallOutcome)
  })
}
