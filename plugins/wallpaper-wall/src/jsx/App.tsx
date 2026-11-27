import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  DiagnosticsReport,
  DownloadProgress,
  EngineSettings,
  LibraryFolderResult,
  LibraryListResult,
  RotationSettings,
  SourceFacets,
  SourceFilterValue,
  SourceListEntry,
  SourceScriptInfo,
  WallpaperCapabilities,
  WallpaperFit,
} from '../shared/contracts'
import {
  DEFAULT_ROTATION_SETTINGS,
  formatBytes,
  isWallpaperFit,
  parseWallpaperError,
} from '../shared/contracts'
import * as api from '../js/api'
import { useI18n } from '../i18n'
import { Button, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle, Input, TooltipProvider } from '../ui'
import {
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Icon,
  Spinner,
} from './common'
import { defaultFilters, FacetBar } from './FacetBar'
import { DetailSheet } from './DetailSheet'
import { EnginesView } from './EnginesView'
import { SettingsView } from './SettingsView'
import { WallpaperGrid } from './WallpaperGrid'
import type { GridItem } from './WallpaperCard'

type Nav = 'discover' | 'library' | 'favorites' | 'engines' | 'settings'
type ConfirmState =
  | { kind: 'remove'; entry: GridItem }
  | { kind: 'script'; script: SourceScriptInfo }
  | null

export function App() {
  const { t } = useI18n()
  const [nav, setNav] = useState<Nav>('discover')
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)
  const [bootError, setBootError] = useState('')
  const [booting, setBooting] = useState(true)
  const [sources, setSources] = useState<SourceListEntry[]>([])
  const [activeSourceId, setActiveSourceId] = useState('')
  const [facets, setFacets] = useState<SourceFacets>({ items: [] })
  const [filters, setFilters] = useState<Record<string, SourceFilterValue>>({})
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<GridItem[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [settingsState, setSettingsState] = useState<AppSettings | null>(null)
  const [libraryData, setLibraryData] = useState<LibraryListResult | null>(null)
  const [capabilities, setCapabilities] = useState<WallpaperCapabilities | null>(null)
  const [rotationSettings, setRotationSettings] = useState<RotationSettings>(DEFAULT_ROTATION_SETTINGS)
  const [scripts, setScripts] = useState<SourceScriptInfo[]>([])
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null)
  const [engineDiagnostics, setEngineDiagnostics] = useState<{ engineId: string; lines: string[] } | null>(null)
  const [detail, setDetail] = useState<GridItem | null>(null)
  const [busyKey, setBusyKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({})
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [importUrlOpen, setImportUrlOpen] = useState(false)
  const [importUrl, setImportUrl] = useState('')
  const searchField = useRef<HTMLInputElement>(null)
  const searchRequest = useRef(0)
  const downloadWaiters = useRef(new Map<string, { resolve: (libraryId: string) => void; reject: (error: Error) => void }>())

  const notify = useCallback(async (body: string, level: 'info' | 'success' | 'error' = 'info') => {
    try { await api.host.toast(body, level) } catch { /* 提示失败不影响业务 */ }
  }, [])

  useEffect(() => {
    const apiObject = window.enest || window.zapi
    Promise.resolve(apiObject?.storage?.get?.('ui.railCollapsed')).then(value => setRailCollapsed(value === true)).catch(() => {})
  }, [])

  useEffect(() => {
    const apiObject = window.enest || window.zapi
    if (!apiObject?.settings?.onChange) return
    return apiObject.settings.onChange(event => {
      if (event.key !== 'defaultFit' || typeof event.value !== 'string' || !isWallpaperFit(event.value)) return
      setSettingsState(current => current ? { ...current, defaultFit: event.value as WallpaperFit } : current)
      void api.settings.update({ defaultFit: event.value }).catch(() => {})
    })
  }, [])

  const toggleRail = useCallback(() => {
    setRailCollapsed(current => {
      const next = !current
      const apiObject = window.enest || window.zapi
      void Promise.resolve(apiObject?.storage?.set?.('ui.railCollapsed', next)).catch(() => {})
      return next
    })
  }, [])

  const humanError = useCallback((error: unknown) => {
    const parsed = parseWallpaperError(error)
    if (parsed.code === 'SOURCE_KEY_REQUIRED') return t('error.sourceKeyRequired')
    if (parsed.code === 'LIBRARY_NOT_CONFIGURED') return t('error.libraryNotConfigured')
    return parsed.message || t('error.unknown')
  }, [t])

  const applySource = useCallback((source: SourceListEntry) => {
    setActiveSourceId(source.id)
    setFacets(source.facets)
    setFilters(defaultFilters(source.facets))
    setQuery('')
    setItems([])
    setPage(1)
    setHasMore(false)
    setSearchError('')
  }, [])

  const loadInitial = useCallback(async () => {
    setBooting(true)
    setBootError('')
    try {
      const [sourceList, settingsValue] = await Promise.all([
        api.sources.list(),
        api.settings.get(),
      ])
      const [libraryValue, caps, rotationValue, scriptList] = await Promise.all([
        api.library.list().catch(() => null),
        api.wallpaper.capabilities().catch(() => null),
        api.rotation.get().catch(() => null),
        api.scripts.list().catch(() => []),
      ])
      setSources(sourceList)
      setLibraryData(libraryValue)
      setCapabilities(caps)
      if (rotationValue) setRotationSettings(rotationValue.settings)
      setScripts(scriptList)
      let effective = settingsValue
      try {
        const hostEnabled = await window.enest?.settings.get('backgroundEnabled')
        if (typeof hostEnabled === 'boolean' && hostEnabled !== settingsValue.backgroundEnabled) {
          effective = await api.settings.update({ backgroundEnabled: hostEnabled })
        }
        const hostFit = await window.enest?.settings.get('defaultFit')
        if (typeof hostFit === 'string' && isWallpaperFit(hostFit) && hostFit !== settingsValue.defaultFit) {
          effective = await api.settings.update({ defaultFit: hostFit })
        }
      } catch {
        // 宿主设置不可用时沿用后端设置。
      }
      setSettingsState(effective)
      if (effective.backgroundEnabled) {
        await api.background.start().catch(() => null)
      }
      const first = sourceList.find(source => source.enabled && (!source.requiresKey || source.hasKey)) ?? sourceList.find(source => source.enabled) ?? sourceList[0]
      if (first) applySource(first)
    } catch (error) {
      setBootError(humanError(error))
    } finally {
      setBooting(false)
    }
  }, [applySource, humanError])

  useEffect(() => { void loadInitial() }, [loadInitial])

  const refreshLibrary = useCallback(async () => {
    try { setLibraryData(await api.library.list()) } catch (error) { void notify(humanError(error), 'error') }
  }, [humanError, notify])

  const refreshSources = useCallback(async () => {
    try { setSources(await api.sources.list()) } catch (error) { void notify(humanError(error), 'error') }
  }, [humanError, notify])

  const refreshCapabilities = useCallback(async () => {
    try { setCapabilities(await api.wallpaper.capabilities()) } catch (error) { void notify(humanError(error), 'error') }
  }, [humanError, notify])

  const refreshBackground = useCallback(async () => {
    try {
      const background = await api.background.status()
      setSettingsState(background.settings)
    } catch { /* 后端未就绪时保持现有状态 */ }
  }, [])

  const refreshScripts = useCallback(async () => {
    try { setScripts(await api.scripts.list()) } catch (error) { void notify(humanError(error), 'error') }
  }, [humanError, notify])

  const refreshDiagnostics = useCallback(async () => {
    try { setDiagnostics(await api.background.diagnostics()) } catch (error) { void notify(humanError(error), 'error') }
  }, [humanError, notify])

  const loadPage = useCallback(async (nextPage: number, replace: boolean) => {
    if (!activeSourceId) return
    const source = sources.find(entry => entry.id === activeSourceId)
    if (source?.requiresKey && !source.hasKey) {
      setItems([])
      setHasMore(false)
      setSearchError('')
      setSearchLoading(false)
      return
    }
    const requestId = ++searchRequest.current
    setSearchLoading(true)
    if (replace) setSearchError('')
    try {
      const result = await api.sources.search({
        sourceId: activeSourceId,
        query: query.trim() || undefined,
        page: nextPage,
        perPage: 24,
        filters,
        requestId: String(requestId),
      })
      if (requestId !== searchRequest.current) return
      const next = result.items.map(item => ({ key: `${item.sourceId}:${item.remoteId}`, item }))
      setItems(current => replace ? next : dedupeGrid([...current, ...next]))
      setPage(result.page)
      setHasMore(result.hasMore)
      if (result.facets?.items.length) setFacets(result.facets)
    } catch (error) {
      if (requestId !== searchRequest.current) return
      setSearchError(humanError(error))
      if (replace) setItems([])
    } finally {
      if (requestId === searchRequest.current) setSearchLoading(false)
    }
  }, [activeSourceId, filters, humanError, query, sources])

  const refreshAll = useCallback(() => {
    setReloadSeq(value => value + 1)
    void refreshSources()
    if (nav === 'discover') void loadPage(1, true)
    if (nav === 'library' || nav === 'favorites') void refreshLibrary()
    if (nav === 'engines') void refreshCapabilities()
    if (nav === 'settings') {
      void api.settings.get().then(setSettingsState).catch(() => {})
      void refreshBackground()
      void refreshScripts()
      void refreshDiagnostics()
    }
  }, [loadPage, nav, refreshBackground, refreshCapabilities, refreshDiagnostics, refreshLibrary, refreshScripts, refreshSources])

  useEffect(() => {
    if (nav !== 'discover' || !activeSourceId) return
    const timer = window.setTimeout(() => { void loadPage(1, true) }, 280)
    return () => window.clearTimeout(timer)
  }, [activeSourceId, filters, loadPage, nav, query])

  useEffect(() => {
    if (nav !== 'discover' || !activeSourceId) return
    return () => { void api.sources.cancel(activeSourceId).catch(() => {}) }
  }, [activeSourceId, nav])

  useEffect(() => {
    if (nav === 'library' || nav === 'favorites') void refreshLibrary()
    if (nav === 'engines') void refreshCapabilities()
    if (nav === 'settings') {
      void api.settings.get().then(setSettingsState).catch(() => {})
      void refreshBackground()
      void refreshScripts()
      void refreshDiagnostics()
    }
  }, [nav, refreshBackground, refreshCapabilities, refreshDiagnostics, refreshLibrary, refreshScripts])

  useEffect(() => {
    let off: (() => void) | undefined
    try {
      off = api.onBackendEvent(payload => {
        if (payload.event === 'download.progress') {
          const progress = payload.data as DownloadProgress
          setDownloads(current => ({ ...current, [progress.jobId]: progress }))
          if (progress.phase === 'done' && progress.libraryId) {
            downloadWaiters.current.get(progress.jobId)?.resolve(progress.libraryId)
            downloadWaiters.current.delete(progress.jobId)
            void api.flushStorage()
            void refreshLibrary()
          } else if (progress.phase === 'failed' || progress.phase === 'cancelled') {
            downloadWaiters.current.get(progress.jobId)?.reject(new Error(progress.message || '下载失败'))
            downloadWaiters.current.delete(progress.jobId)
          }
        }
        if (payload.event === 'engine.status') {
          void refreshCapabilities()
          void refreshBackground()
        }
      })
    } catch {
      // 后端不可用时由 bootError 呈现。
    }
    return () => off?.()
  }, [notify, refreshBackground, refreshCapabilities, refreshLibrary, t])

  useEffect(() => {
    const apiObject = window.enest || window.zapi
    if (!apiObject?.launch) return
    void apiObject.launch.registerHandlers({
      command: async request => {
        if (request.code !== 'resident') throw new Error('unknown wallpaper-wall feature')
        const resident = request.reason === 'resident-restore' || request.reason === 'resident-setting'
        if (resident && request.enabled === false) {
          await api.background.stop()
          void refreshBackground()
          return { type: 'done' }
        }
        await api.background.start()
        void refreshBackground()
        return { type: 'done' }
      },
    }).catch(error => {
      console.error('[wallpaper-wall] resident handler registration failed', error)
    })
  }, [refreshBackground])

  useEffect(() => {
    const apiObject = window.enest || window.zapi
    if (!apiObject) return
    if (apiObject.getEnterCode() === 'settings') setNav('settings')
    return apiObject.onEnter(event => {
      if (event.code === 'settings') setNav('settings')
    })
  }, [])

  const waitForDownload = useCallback((jobId: string) => new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (downloadWaiters.current.delete(jobId)) reject(new Error('下载等待超时'))
    }, 300_000)
    const wrappedResolve = (libraryId: string) => { window.clearTimeout(timer); resolve(libraryId) }
    const wrappedReject = (error: Error) => { window.clearTimeout(timer); reject(error) }
    downloadWaiters.current.set(jobId, { resolve: wrappedResolve, reject: wrappedReject })
  }), [])

  const ensureDownloaded = useCallback(async (entry: GridItem): Promise<string> => {
    if (entry.library) return entry.library.id
    const started = await api.library.download(entry.item)
    setDownloads(current => ({
      ...current,
      [started.jobId]: { jobId: started.jobId, sourceId: entry.item.sourceId, remoteId: entry.item.remoteId, title: entry.item.title, phase: 'queued' },
    }))
    void notify(t('message.downloadStarted'), 'info')
    const libraryId = await waitForDownload(started.jobId)
    void notify(t('message.downloadDone'), 'success')
    return libraryId
  }, [notify, t, waitForDownload])

  const handleSetStatic = useCallback(async (entry: GridItem, fit: WallpaperFit, displayIds: string[]) => {
    setBusyKey(entry.key)
    try {
      const libraryId = await ensureDownloaded(entry)
      const result = await api.wallpaper.setStatic(libraryId, fit, displayIds.length ? displayIds : undefined)
      void notify(result.message ? `${t('message.wallpaperApplied')}: ${result.message}` : t('message.wallpaperApplied'), 'success')
      void refreshBackground()
      void refreshCapabilities()
    } catch (error) {
      void notify(`${t('message.wallpaperFailed')}: ${humanError(error)}`, 'error')
    } finally {
      setBusyKey('')
    }
  }, [ensureDownloaded, humanError, notify, refreshBackground, refreshCapabilities, t])

  const handleSetDynamic = useCallback(async (entry: GridItem) => {
    setBusyKey(entry.key)
    try {
      const libraryId = await ensureDownloaded(entry)
      const status = await api.engines.start(libraryId)
      void notify(status.message || t('message.dynamicStarted'), status.message ? 'info' : 'success')
      void refreshBackground()
      void refreshCapabilities()
    } catch (error) {
      void notify(`${t('message.wallpaperFailed')}: ${humanError(error)}`, 'error')
    } finally {
      setBusyKey('')
    }
  }, [ensureDownloaded, humanError, notify, refreshBackground, refreshCapabilities, t])

  const handleDownload = useCallback(async (entry: GridItem) => {
    setBusyKey(entry.key)
    try {
      await ensureDownloaded(entry)
      await refreshLibrary()
    } catch (error) {
      void notify(`${t('message.downloadFailed')}: ${humanError(error)}`, 'error')
    } finally {
      setBusyKey('')
    }
  }, [ensureDownloaded, humanError, notify, refreshLibrary, t])

  const handleFavorite = useCallback(async (entry: GridItem, favorite: boolean) => {
    if (!entry.library) return
    try {
      await api.library.favorite(entry.library.id, favorite)
      await api.flushStorage()
      await refreshLibrary()
      setDetail(current => {
        if (!current?.library || current.library.id !== entry.library?.id) return current
        return { ...current, library: { ...current.library, favorite } }
      })
    } catch (error) {
      void notify(humanError(error), 'error')
    }
  }, [humanError, notify, refreshLibrary])

  const confirmRemove = useCallback(async (entry: GridItem) => {
    setConfirm({ kind: 'remove', entry })
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!confirm) return
    setBusy(true)
    try {
      if (confirm.kind === 'remove') {
        await api.library.remove(confirm.entry.library?.id ?? '', true)
        await api.flushStorage()
        await refreshLibrary()
        setDetail(null)
        void notify(t('message.removed'), 'success')
      } else if (confirm.kind === 'script') {
        await api.scripts.uninstall(confirm.script.id)
        await refreshScripts()
        await refreshSources()
        void notify(t('message.removed'), 'success')
      }
      setConfirm(null)
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally {
      setBusy(false)
    }
  }, [confirm, humanError, notify, refreshCapabilities, refreshLibrary, refreshScripts, refreshSources, t])

  const handleOpenExternal = useCallback(async (url: string) => {
    try { await api.host.openExternal(url) } catch (error) { void notify(humanError(error), 'error') }
  }, [humanError, notify])

  const handlePickFolder = useCallback(async () => {
    setBusy(true)
    try {
      const handleId = await api.host.pickDirectory()
      if (!handleId) return
      await api.library.setFolder(handleId)
      await api.flushStorage()
      await refreshLibrary()
      void notify(t('message.folderSet'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshLibrary, t])

  const handleUseDefaultFolder = useCallback(async () => {
    setBusy(true)
    try {
      await api.library.useDefaultFolder()
      await api.flushStorage()
      await refreshLibrary()
      void notify(t('message.folderSet'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshLibrary, t])

  const handleImportLocal = useCallback(async () => {
    setBusy(true)
    try {
      const file = await api.host.pickFile(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm'])
      if (!file) return
      await api.library.importLocal(file.handleId, file.name.replace(/\.[^.]+$/, ''))
      await api.flushStorage()
      await refreshLibrary()
      void notify(t('message.imported'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshLibrary, t])

  const handleImportUrl = useCallback(async () => {
    if (!importUrl.trim()) return
    setBusy(true)
    try {
      await api.library.importUrl(importUrl.trim())
      await api.flushStorage()
      await refreshLibrary()
      setImportUrlOpen(false)
      setImportUrl('')
      void notify(t('message.imported'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, importUrl, notify, refreshLibrary, t])

  const handleSaveKey = useCallback(async (sourceId: string, value: string) => {
    if (!value.trim()) return
    setBusy(true)
    try {
      // 键名前缀沿用插件改名前的名字：保险库里按它存着已保存的数据源 Key，改了就找不回
      const ref = await api.host.saveKey(`wallpaper-house.${sourceId}`, value.trim())
      const current = await api.settings.get()
      const sourceKeyRefs = { ...current.sourceKeyRefs, [sourceId]: ref }
      setSettingsState(await api.settings.update({ sourceKeyRefs }))
      await api.flushStorage()
      await refreshSources()
      void notify(t('message.sourceKeySaved'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshSources, t])

  const handleRemoveKey = useCallback(async (sourceId: string) => {
    setBusy(true)
    try {
      const current = settingsState ?? await api.settings.get()
      const ref = current.sourceKeyRefs[sourceId]
      if (ref) await api.host.removeKey(ref)
      const sourceKeyRefs = { ...current.sourceKeyRefs }
      delete sourceKeyRefs[sourceId]
      setSettingsState(await api.settings.update({ sourceKeyRefs }))
      await api.flushStorage()
      await refreshSources()
      void notify(t('message.sourceKeyRemoved'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshSources, settingsState, t])

  const handleToggleSource = useCallback(async (sourceId: string, enabled: boolean) => {
    setBusy(true)
    try {
      const next = await api.sources.setEnabled(sourceId, enabled)
      setSources(next)
      if (!next.some(source => source.id === activeSourceId && source.enabled)) {
        const first = next.find(source => source.enabled)
        if (first) applySource(first)
      }
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [activeSourceId, applySource, humanError, notify])

  const handleToggleBackground = useCallback(async (enabled: boolean) => {
    setBusy(true)
    try {
      if (enabled) {
        await api.call('system.hello')
        setSettingsState(await api.settings.update({ backgroundEnabled: true }))
        await api.host.setResidentSetting(true)
        await api.background.start()
        void notify(t('message.residentEnabled'), 'success')
      } else {
        await api.background.stop()
        setSettingsState(await api.settings.update({ backgroundEnabled: false }))
        await api.host.setResidentSetting(false)
        void notify(t('message.residentDisabled'), 'info')
      }
    } catch (error) {
      const parsed = parseWallpaperError(error)
      void notify(parsed.code === 'PERMISSION_REQUIRED' || /permission|consent/i.test(parsed.message) ? t('message.permissionNeeded') : humanError(error), 'error')
      if (enabled) {
        await api.settings.update({ backgroundEnabled: false }).catch(() => {})
        await api.host.setResidentSetting(false).catch(() => {})
      }
      await refreshBackground()
    } finally { setBusy(false) }
  }, [humanError, notify, refreshBackground, t])

  const handleUpdateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    try {
      const next = await api.settings.update(patch)
      await api.flushStorage()
      setSettingsState(next)
      if (patch.defaultFit) await Promise.resolve(window.enest?.settings.set?.('defaultFit', patch.defaultFit)).catch(() => {})
      if (patch.engineSettings) await api.engines.applySettings(patch.engineSettings).catch(() => {})
    } catch (error) {
      void notify(humanError(error), 'error')
    }
  }, [humanError, notify])

  const handleUpdateRotation = useCallback(async (patch: Partial<RotationSettings>) => {
    try {
      const result = await api.rotation.update(patch)
      await api.flushStorage()
      setRotationSettings(result.settings)
      void notify(t('message.rotationUpdated'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    }
  }, [humanError, notify, t])

  const handleNextRotation = useCallback(async () => {
    setBusy(true)
    try {
      await api.rotation.next()
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify])

  const handleStopEngine = useCallback(async () => {
    setBusy(true)
    try {
      await api.engines.stop()
      await refreshCapabilities()
      void notify(t('message.engineStopped'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshCapabilities, t])

  const handleApplyEngineSettings = useCallback(async (patch: Partial<EngineSettings>) => {
    try {
      await api.engines.applySettings(patch)
      const current = settingsState ?? await api.settings.get()
      const next = await api.settings.update({ engineSettings: { ...current.engineSettings, ...patch } })
      setSettingsState(next)
    } catch (error) {
      void notify(humanError(error), 'error')
    }
  }, [humanError, notify, settingsState])

  const handleEngineDiagnostics = useCallback(async (engineId: string) => {
    try {
      const result = await api.engines.diagnostics(engineId)
      setEngineDiagnostics({ engineId, lines: result.lines })
    } catch (error) {
      void notify(humanError(error), 'error')
    }
  }, [humanError, notify])

  const handleInstallScriptFile = useCallback(async () => {
    setBusy(true)
    try {
      const file = await api.host.pickFile(['.js', '.mjs', '.cjs'])
      if (!file) return
      await api.scripts.installFromFile(file.handleId)
      await refreshScripts()
      await refreshSources()
      void notify(t('message.imported'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshScripts, refreshSources, t])

  const handleInstallScriptUrl = useCallback(async (url: string) => {
    if (!url) return
    setBusy(true)
    try {
      await api.scripts.installFromUrl(url)
      await refreshScripts()
      await refreshSources()
      void notify(t('message.imported'), 'success')
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshScripts, refreshSources, t])

  const handleToggleScript = useCallback(async (id: string, enabled: boolean) => {
    setBusy(true)
    try {
      await api.scripts.setEnabled(id, enabled)
      await refreshScripts()
      await refreshSources()
    } catch (error) {
      void notify(humanError(error), 'error')
    } finally { setBusy(false) }
  }, [humanError, notify, refreshScripts, refreshSources])

  const libraryGrid = useMemo(() => (libraryData?.items ?? []).map(item => ({ key: `library:${item.id}`, item: item.item, library: item })), [libraryData])
  const favoriteGrid = useMemo(() => libraryGrid.filter(entry => entry.library?.favorite), [libraryGrid])
  const activeSource = sources.find(source => source.id === activeSourceId)
  const sourceNames = useMemo(() => Object.fromEntries(sources.map(source => [source.id, source.name])), [sources])
  const folder: LibraryFolderResult | null = libraryData?.folder ?? (settingsState?.libraryPath ? { path: settingsState.libraryPath, exists: true, writable: true } : null)
  const settingsWithEngine = settingsState ? { ...settingsState, engineSettings: settingsState.engineSettings } : null
  const fits = capabilities?.static.fits ?? (['fill', 'fit', 'stretch', 'center', 'tile', 'span'] as WallpaperFit[])
  const activeDownloads = Object.values(downloads).filter(progress => progress.phase !== 'done' && progress.phase !== 'failed' && progress.phase !== 'cancelled')
  const activeDownload = activeDownloads.at(-1)
  const quickSet = useCallback((entry: GridItem) => { void handleSetStatic(entry, settingsState?.defaultFit ?? 'fill', []) }, [handleSetStatic, settingsState?.defaultFit])

  if (booting) {
    return <div className="wh-boot"><Spinner label={t('state.loading')} /></div>
  }

  if (bootError) {
    return (
      <div className="wh-boot">
        <ErrorBox message={bootError} onRetry={() => { void loadInitial() }} retryLabel={t('action.retry')} />
      </div>
    )
  }

  return (
    <TooltipProvider>
    <div className={`wh-app${railCollapsed ? ' rail-collapsed' : ''}`}>
      <nav className="wh-rail" aria-label={t('app.name')}>
        <div className="wh-rail-nav">
          {([
            ['discover', 'nav.discover', 'search'],
            ['library', 'nav.library', 'folder'],
            ['favorites', 'nav.favorites', 'star'],
            ['engines', 'nav.engines', 'engine'],
            ['settings', 'nav.settings', 'settings'],
          ] as const).map(([id, label, icon]) => (
            <button key={id} type="button" className={`wh-rail-item${nav === id ? ' active' : ''}`} onClick={() => setNav(id)} aria-label={t(label)} aria-current={nav === id ? 'page' : undefined}>
              <Icon name={icon} />
              <span>{t(label)}</span>
            </button>
          ))}
        </div>
        <div className="wh-rail-foot">
          <div className="wh-rail-actions">
            <button type="button" className="wh-rail-action" onClick={refreshAll} title={t('action.refresh')} aria-label={t('action.refresh')}><Icon name="refresh" /></button>
            <button type="button" className="wh-rail-action" onClick={toggleRail} aria-expanded={!railCollapsed} aria-label={railCollapsed ? t('action.expand') : t('action.collapse')} title={railCollapsed ? t('action.expand') : t('action.collapse')}>
              <Icon name={railCollapsed ? 'chevron-right' : 'chevron-left'} />
            </button>
          </div>
        </div>
      </nav>

      <div className="wh-main">
        <header className="wh-topbar">
          <div className="wh-topbar-title">
            <h1 className="wh-page-title">{nav === 'discover' ? t('discover.title') : nav === 'library' ? t('library.title') : nav === 'favorites' ? t('favorites.title') : nav === 'engines' ? t('engines.title') : t('settings.title')}</h1>
          </div>
          <div className="wh-topbar-actions">
            {nav === 'discover' && activeSource?.supportsSearch ? (
              <div className="wh-search">
                <Icon name="search" size={14} />
                <input ref={searchField} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('placeholder.search')} aria-label={t('action.search')} />
                {query ? <button type="button" className="wh-search-clear" onClick={() => { setQuery(''); searchField.current?.focus() }} aria-label={t('action.clearSearch')}><Icon name="close" size={12} /></button> : null}
              </div>
            ) : null}
            {nav === 'library' ? (
              <>
                <Button size="sm" variant="ghost" onClick={handlePickFolder} disabled={busy}><Icon name="folder" />{t('action.chooseFolder')}</Button>
                <Button size="sm" variant="ghost" onClick={handleImportLocal} disabled={busy}><Icon name="upload" />{t('action.importFile')}</Button>
                <Button size="sm" variant="ghost" onClick={() => setImportUrlOpen(true)} disabled={busy}><Icon name="link" />{t('action.importUrl')}</Button>
              </>
            ) : null}
            {activeDownload ? <div className="wh-download-pill"><Spinner /><span>{activeDownload.title}</span><b>{activeDownload.percent ?? 0}%</b></div> : null}
          </div>
        </header>
        {nav === 'discover' ? (
          <div className="wh-source-bar" role="tablist" aria-label={t('label.sources')}>
            {sources.filter(source => source.enabled).map(source => (
              <button
                key={source.id}
                type="button"
                role="tab"
                aria-selected={source.id === activeSourceId}
                className={`wh-source-chip${source.id === activeSourceId ? ' active' : ''}${source.requiresKey && !source.hasKey ? ' locked' : ''}`}
                onClick={() => applySource(source)}
                title={source.description}
              >
                {source.name}
                {source.requiresKey && !source.hasKey ? <Icon name="info" size={11} /> : null}
              </button>
            ))}
          </div>
        ) : null}

        <main className="wh-main-content" key={reloadSeq}>
        {nav === 'discover' ? (
          <div className="wh-view wh-discover">
            {!sources.some(source => source.enabled) ? (
              <EmptyState title={t('discover.noSources')} body={t('discover.enableSource')} action={<Button onClick={() => setNav('settings')}>{t('settings.sources')}</Button>} />
            ) : activeSource?.requiresKey && !activeSource.hasKey ? (
              <EmptyState title={t('hint.keyNeeded')} body={t('error.sourceKeyRequired')} action={<Button onClick={() => setNav('settings')}>{t('settings.sources')}</Button>} />
            ) : (
              <>
                <FacetBar facets={facets} values={filters} t={t} onChange={(key, value) => setFilters(current => ({ ...current, [key]: value }))} onReset={() => setFilters(defaultFilters(facets))} />
                {activeSource?.notices?.length ? <div className="wh-notices">{activeSource.notices.map(notice => <p key={notice}><Icon name="info" size={13} />{notice}</p>)}</div> : null}
                {searchError && items.length ? <ErrorBox message={searchError} onRetry={() => { void loadPage(1, true) }} retryLabel={t('action.retry')} /> : null}
                <WallpaperGrid
                  items={items}
                  sourceNames={sourceNames}
                  t={t}
                  loading={searchLoading}
                  error={!items.length ? searchError : undefined}
                  hasMore={hasMore}
                  onLoadMore={() => { if (!searchLoading && hasMore) void loadPage(page + 1, false) }}
                  onOpen={setDetail}
                  onSet={quickSet}
                  onDownload={handleDownload}
                  emptyTitle={t('discover.noMatches')}
                  emptyBody={t(activeSource?.supportsSearch || facets.items.length ? 'discover.trySearch' : 'discover.trySource')}
                  emptyAction={searchError ? <Button onClick={() => { void loadPage(1, true) }}>{t('action.retry')}</Button> : undefined}
                />
              </>
            )}
          </div>
        ) : null}

        {nav === 'library' ? (
          <div className="wh-view">
            <div className="wh-library-head">
              <div>
                <p>{libraryData?.items.length ?? 0} {t('unit.items')} · {formatBytes(libraryData?.totalBytes ?? 0)}</p>
                <code className="wh-path">{folder?.path || t('state.notConfigured')}</code>
              </div>
            </div>
            {folder?.path && folder.writable === false ? <ErrorBox message={folder.message || t('error.libraryNotWritable')} /> : null}
            <WallpaperGrid
              items={libraryGrid}
              sourceNames={sourceNames}
              t={t}
              loading={false}
              hasMore={false}
              onLoadMore={() => {}}
              onOpen={setDetail}
              onSet={quickSet}
              onFavorite={handleFavorite}
              onRemove={confirmRemove}
              emptyTitle={t('library.empty')}
              emptyBody={!folder?.path ? t('library.chooseFolderHint') : folder.writable === false ? undefined : t('library.emptyHint')}
            />
          </div>
        ) : null}

        {nav === 'favorites' ? (
          <div className="wh-view">
            <WallpaperGrid
              items={favoriteGrid}
              sourceNames={sourceNames}
              t={t}
              loading={false}
              hasMore={false}
              onLoadMore={() => {}}
              onOpen={setDetail}
              onSet={quickSet}
              onFavorite={handleFavorite}
              onRemove={confirmRemove}
              emptyTitle={t('favorites.empty')}
              emptyBody={t('favorites.emptyHint')}
            />
          </div>
        ) : null}

        {nav === 'engines' ? (
          <EnginesView
            capabilities={capabilities}
            settings={settingsWithEngine?.engineSettings ?? null}
            diagnostics={engineDiagnostics}
            t={t}
            onStop={handleStopEngine}
            onDiagnostics={handleEngineDiagnostics}
            onCloseDiagnostics={() => setEngineDiagnostics(null)}
            onApplySettings={handleApplyEngineSettings}
          />
        ) : null}

        {nav === 'settings' ? (
          <SettingsView
            settings={settingsState}
            folder={folder}
            sources={sources}
            rotation={rotationSettings}
            capabilities={capabilities}
            scripts={scripts}
            diagnostics={diagnostics}
            busy={busy}
            t={t}
            onUpdate={handleUpdateSettings}
            onPickFolder={handlePickFolder}
            onUseDefaultFolder={handleUseDefaultFolder}
            onSaveKey={handleSaveKey}
            onRemoveKey={handleRemoveKey}
            onToggleSource={handleToggleSource}
            onToggleBackground={handleToggleBackground}
            onUpdateRotation={handleUpdateRotation}
            onNextRotation={handleNextRotation}
            onInstallScriptFile={handleInstallScriptFile}
            onInstallScriptUrl={handleInstallScriptUrl}
            onToggleScript={handleToggleScript}
            onRemoveScript={id => {
              const script = scripts.find(entry => entry.id === id)
              if (script) setConfirm({ kind: 'script', script })
            }}
            onRefreshDiagnostics={refreshDiagnostics}
            onOpenExternal={handleOpenExternal}
          />
        ) : null}
        </main>
      </div>

      <DetailSheet
        entry={detail}
        sourceName={detail ? sourceNames[detail.item.sourceId] : undefined}
        t={t}
        displays={capabilities?.displays ?? []}
        fits={fits}
        defaultFit={settingsState?.defaultFit ?? 'fill'}
        busy={Boolean(detail && busyKey === detail.key)}
        onClose={() => setDetail(null)}
        onSetStatic={handleSetStatic}
        onSetDynamic={handleSetDynamic}
        onDownload={handleDownload}
        onFavorite={handleFavorite}
        onRemove={confirmRemove}
        onOpenSource={handleOpenExternal}
      />

      <ConfirmDialog
        open={Boolean(confirm)}
        title={t('dialog.deleteTitle')}
        body={t('dialog.deleteBody')}
        confirmLabel={t('action.remove')}
        cancelLabel={t('action.cancel')}
        danger
        busy={busy}
        onConfirm={() => { void handleConfirm() }}
        onClose={() => setConfirm(null)}
      >
        {confirm?.kind === 'remove' ? <p className="wh-hint">{confirm.entry.item.title}</p> : null}
        {confirm?.kind === 'script' ? <p className="wh-hint">{confirm.script.name}</p> : null}
      </ConfirmDialog>

      <Dialog open={importUrlOpen} onOpenChange={setImportUrlOpen}>
        <DialogOverlay />
        <DialogContent className="wh-dialog">
          <DialogTitle>{t('action.importUrl')}</DialogTitle>
          <DialogDescription>{t('label.source')}</DialogDescription>
          <Input value={importUrl} onChange={event => setImportUrl(event.target.value)} placeholder="https://…" aria-label={t('action.importUrl')} />
          <div className="wh-dialog-actions">
            <Button onClick={() => setImportUrlOpen(false)}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={() => { void handleImportUrl() }} disabled={busy || !importUrl.trim()}>{t('action.confirm')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  )
}

function dedupeGrid(items: GridItem[]): GridItem[] {
  const seen = new Set<string>()
  const result: GridItem[] = []
  for (const item of items) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    result.push(item)
  }
  return result
}
