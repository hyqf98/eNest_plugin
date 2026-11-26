import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createNativeSurfaces } from '@enest/native-surfaces'
import { host } from './lib/env.js'
import { useLibrary } from './lib/library.js'
import { getThumb } from './lib/assets.js'
import { loadImageElement, releaseAll } from './lib/blobs.js'
import { loadDisplays, openAnnotate, openRegion, physicalDisplayBounds } from './lib/surfaces.js'
import { captureStill, startLongshot, startRecorder } from './lib/session.js'
import {
  canvasToBlob, dataUrlToBlob, extensionForMime, fileToDataUrl, mimeForExtension, writeBlob
} from './lib/files.js'
import { thumbFromCanvas, thumbFromImage } from './lib/media.js'
import { flushDrafts } from './lib/draft.js'
import { Rail } from './components/Rail.jsx'
import { CaptureView } from './views/CaptureView.jsx'
import { LibraryView } from './views/LibraryView.jsx'
import { Lightbox } from './views/Lightbox.jsx'
import { EditorView } from './views/EditorView.jsx'
import { ToolsView } from './views/ToolsView.jsx'
import { PinsView } from './views/PinsView.jsx'
import { SettingsDialog } from './views/SettingsDialog.jsx'

const DEFAULT_SETTINGS = {
  captureAction: 'annotate',
  imageLimit: 200,
  recordAudio: false,
  gifFps: 10,
  gifWidth: 480
}

const safeName = value => String(value || 'record').replace(/[\\/:*?"<>|]/g, '-').slice(0, 100)
const usesEditorWindow = action => action === 'annotate' || action === 'preview'

function matchesFilter(item, filter, text) {
  if (filter === 'image' && item.kind !== 'image') return false
  if (filter === 'record' && item.kind === 'image') return false
  if (!text) return true
  const date = new Date(item.createdAt).toLocaleString('zh-CN')
  return `${item.name} ${date}`.toLowerCase().includes(text)
}

export function App() {
  const kitRef = useRef(null)
  const [mode, setMode] = useState('shell')
  const [prefsReady, setPrefsReady] = useState(false)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [view, setView] = useState('capture')
  const [captureMode, setCaptureMode] = useState('image')
  const [displays, setDisplays] = useState([])
  const [displayId, setDisplayId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(null)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [lightboxId, setLightboxId] = useState(null)
  const [editorId, setEditorId] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pins, setPins] = useState(null)
  const [pinsLoading, setPinsLoading] = useState(false)
  const [toolsIncoming, setToolsIncoming] = useState(null)
  const [enterEvent, setEnterEvent] = useState(null)

  const native = useMemo(() => createNativeSurfaces(host), [])

  const notify = useCallback((text, type = 'info') => {
    const message = String(text || '')
    if (!message) return
    if (document.hidden && host.ui?.toast) {
      void host.ui.toast({ body: message, level: type }).catch(() => kitRef.current?.toast(message, type))
    } else if (kitRef.current?.toast) kitRef.current.toast(message, type)
    else console.warn(message)
  }, [])

  const library = useLibrary({
    enabled: prefsReady,
    imageLimit: settings.imageLimit,
    onError: error => notify(error?.message || error, 'error')
  })

  const display = useMemo(
    () => displays.find(entry => entry.id === displayId) || displays.find(entry => entry.primary) || displays[0] || null,
    [displays, displayId]
  )

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return library.items.filter(item => matchesFilter(item, filter, text))
  }, [library.items, filter, query])

  const lightboxItem = useMemo(() => library.items.find(item => item.id === lightboxId) || null, [library.items, lightboxId])
  const lightboxIndex = filtered.findIndex(item => item.id === lightboxId)
  const editorItem = useMemo(() => library.items.find(item => item.id === editorId) || null, [library.items, editorId])

  const settingsRef = useRef(settings)
  const modeRef = useRef(mode)
  const viewRef = useRef(view)
  const captureModeRef = useRef(captureMode)
  const settingsOpenRef = useRef(settingsOpen)
  const displayRef = useRef(display)
  const activeRef = useRef(active)
  const capturingRef = useRef(false)
  const libraryRef = useRef(library)
  const filteredRef = useRef(filtered)
  const lightboxIdRef = useRef(lightboxId)
  const editorIdRef = useRef(editorId)
  settingsRef.current = settings
  modeRef.current = mode
  viewRef.current = view
  settingsOpenRef.current = settingsOpen
  displayRef.current = display
  libraryRef.current = library
  filteredRef.current = filtered
  lightboxIdRef.current = lightboxId
  editorIdRef.current = editorId

  const selectCaptureMode = useCallback(next => {
    if (next !== 'image' && next !== 'record') return
    captureModeRef.current = next
    setCaptureMode(next)
  }, [])

  const showSession = useCallback(next => {
    activeRef.current = next
    setActive(next)
  }, [])

  /* ---------- 基础数据 ---------- */
  const getCaptureDisplay = useCallback(async () => {
    const selectedId = displayRef.current?.id
    const list = await loadDisplays()
    setDisplays(list)
    const selected = list.find(entry => entry.id === selectedId)
    if (selected) return selected
    const primary = list.find(entry => entry.primary) || list[0]
    setDisplayId(primary?.id ?? null)
    if (!primary) throw new Error('没有可用显示器')
    if (selectedId != null) throw new Error('所选显示器已断开，请重新选择后再试')
    return primary
  }, [])

  const refreshPins = useCallback(async () => {
    setPinsLoading(true)
    try {
      const list = await native.pin.list()
      setPins(list)
    } catch {
      setPins([])
    } finally {
      setPinsLoading(false)
    }
  }, [native])

  const pinImage = useCallback(async (dataUrl, title) => {
    if (!dataUrl) throw new Error('图片数据为空')
    const result = await native.pin.open({ dataUrl, title: String(title || '贴图').slice(0, 80), width: 420 })
    await refreshPins()
    notify('已贴到桌面', 'success')
    return result
  }, [native, notify, refreshPins])

  const itemDataUrl = useCallback(async item => {
    if (item.fileId) return fileToDataUrl(item.fileId, mimeForExtension(item.ext))
    if (item.legacyBlobId) {
      const blob = await host.storage.blobs.get(item.legacyBlobId)
      if (!blob?.dataUrl) throw new Error('旧版原图已不存在')
      return blob.dataUrl
    }
    if (item.thumbId) {
      const thumb = await getThumb(item.thumbId)
      if (thumb) return thumb
    }
    throw new Error('图片数据已不存在')
  }, [])

  const copyItem = useCallback(async item => {
    try {
      await host.clipboard.writeImage(await itemDataUrl(item))
      notify('已复制图片', 'success')
    } catch (error) { notify(error?.message || error, 'error') }
  }, [itemDataUrl, notify])

  const pinItem = useCallback(async item => {
    try {
      await pinImage(await itemDataUrl(item), item.name)
    } catch (error) { notify(error?.message || error, 'error') }
  }, [itemDataUrl, pinImage, notify])

  const exportItem = useCallback(async item => {
    try {
      const defaultName = safeName(`${item.name}.${item.ext || 'png'}`)
      if (item.fileId) {
        const result = await host.storage.files.export(item.fileId, { defaultName })
        if (result?.ok) notify('已导出', 'success')
        return
      }
      const result = await host.shell.saveFile({ defaultName, dataUrl: await itemDataUrl(item) })
      if (result?.ok) notify('已导出', 'success')
    } catch (error) { notify(error?.message || error, 'error') }
  }, [itemDataUrl, notify])

  // 删除是破坏性操作：提示必须反映真实结果，所以批量删除串行等待每一条落定后再汇总。
  const deleteItem = useCallback(async item => {
    const list = filteredRef.current
    const index = list.findIndex(entry => entry.id === item.id)
    try {
      await libraryRef.current.remove(item.id)
    } catch (error) { notify(error?.message || error, 'error'); return false }
    if (lightboxIdRef.current === item.id) {
      const next = list[index + 1] || list[index - 1]
      setLightboxId(next?.id || null)
    }
    if (editorIdRef.current === item.id) setEditorId(null)
    return true
  }, [notify])

  const deleteItems = useCallback(async items => {
    if (!items.length) return
    let removed = 0
    let firstError = null
    // 串行而不是并行：每条删除都要改写同一份媒体库索引，并发会互相覆盖。
    for (const item of items) {
      if (await deleteItem(item)) removed += 1
      else if (!firstError) firstError = item.name
    }
    if (removed) notify(removed === 1 ? '已删除' : `已删除 ${removed} 项`, 'success')
    if (firstError) notify(`${firstError}${items.length - removed > 1 ? ` 等 ${items.length - removed} 项` : ''}删除失败`, 'error')
  }, [deleteItem, notify])

  const saveFrame = useCallback(async (item, canvas) => {
    try {
      const blob = await canvasToBlob(canvas, 'image/png')
      const file = await writeBlob(blob, 'png')
      const thumb = thumbFromCanvas(canvas)
      const saved = await libraryRef.current.addSaved({
        kind: 'image',
        fileId: file.id,
        ext: 'png',
        thumb,
        name: `${item.name} 帧`,
        width: canvas.width,
        height: canvas.height,
        bytes: file.size,
        source: 'frame',
        originId: item.id
      })
      notify('已保存当前帧', 'success')
      return saved
    } catch (error) { notify(error?.message || error, 'error') }
  }, [notify])

  const saveGif = useCallback(async (item, result) => {
    const blob = new Blob([result.bytes], { type: 'image/gif' })
    const file = await writeBlob(blob, 'gif')
    const saved = await libraryRef.current.addSaved({
      kind: 'gif',
      fileId: file.id,
      ext: 'gif',
      thumb: result.thumb,
      name: `${item.name} GIF`,
      width: result.width,
      height: result.height,
      bytes: file.size,
      durationMs: result.durationMs,
      source: 'gif',
      originId: item.id
    })
    return saved
  }, [])

  const afterCapture = useCallback(async ({ item, shotDataUrl }, display, action) => {
    try {
      if (usesEditorWindow(action)) {
        const saved = await openAnnotate({
          display,
          shotDataUrl,
          preview: action === 'preview',
          onSaved: result => libraryRef.current.addSaved({
            kind: 'image',
            fileId: result.fileId,
            ext: 'png',
            name: `${item.name} 标注`,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            source: 'edit',
            originId: item.id
          })
        }).catch(error => {
          if (action === 'annotate') setEditorId(item.id)
          throw error
        })
        if (saved) {
          await host.clipboard.writeImage(await fileToDataUrl(saved.fileId, 'image/png'))
          notify('已复制截图', 'success')
        }
      } else if (action === 'copy') {
        await host.clipboard.writeImage(shotDataUrl)
        notify('已复制截图', 'success')
      } else if (action === 'pin') {
        await pinImage(shotDataUrl, item.name)
      } else {
        setEditorId(item.id)
      }
    } catch (error) { notify(`截图已保存：${error?.message || error}`, 'error') }
  }, [notify, pinImage])

  /* ---------- 录制 / 长截图 ---------- */
  const startCaptureSession = useCallback(async (kind, selection, displayNow, quickOrigin) => {
    let session
    let status = 'preparing'
    let startedAt = null
    let elapsedMs = 0
    const options = {
      display: displayNow,
      bounds: selection?.bounds ?? physicalDisplayBounds(displayNow),
      quickOrigin,
      library: libraryRef.current,
      onState: (state, detail) => {
        if (!['running', 'recording', 'paused', 'saving'].includes(state)) return
        const now = Date.now()
        if (Number.isFinite(detail?.elapsedMs)) elapsedMs = Math.max(0, detail.elapsedMs)
        else if (startedAt !== null) elapsedMs = Math.max(0, now - startedAt)
        status = state
        startedAt = state === 'recording' || state === 'running' ? now - elapsedMs : null
        if (session && activeRef.current?.session === session) showSession({ kind, status, startedAt, elapsedMs, session })
      }
    }
    session = kind === 'record'
      ? await startRecorder({ ...options, withAudio: (selection ? selection.withAudio : settingsRef.current.recordAudio) === true })
      : await startLongshot(options)
    showSession({ kind, status, startedAt, elapsedMs, session })
    session.done
      .then(item => {
        if (!item) return
        const label = kind === 'record' ? '录屏' : '长截图'
        if (item.interruption) notify(`${item.interruption}，${kind === 'record' ? '已录片段' : '已采集的长图'}已保存`, 'warn')
        else if (item.limitReached) notify('已达到长度上限，长截图已保存', 'info')
        else notify(`${label}已保存`, 'success')
        if (kind === 'longshot') setEditorId(item.id)
      })
      .catch(error => notify(error?.message || error, 'error'))
      .finally(() => { if (activeRef.current?.session === session) showSession(null) })
  }, [notify, showSession])

  const withCaptureDisplay = useCallback(async operation => {
    if (activeRef.current) { notify('已有录制或长截图进行中', 'info'); return }
    if (capturingRef.current) return
    capturingRef.current = true
    setBusy(true)
    try {
      await operation(await getCaptureDisplay())
    } catch (error) {
      notify(error?.message || error, 'error')
    } finally {
      capturingRef.current = false
      setBusy(false)
    }
  }, [getCaptureDisplay, notify])

  const takeStill = useCallback(async (displayNow, bounds, action = settingsRef.current.captureAction, quickHidden = false) => {
    if (!quickHidden) await host.ui.dismissQuick()
    const shot = await captureStill({ display: displayNow, bounds, library: libraryRef.current })
    const completion = afterCapture(shot, displayNow, action)
    if (!usesEditorWindow(action)) await completion
  }, [afterCapture])

  const runCapture = useCallback((action, options = {}) => {
    return withCaptureDisplay(async displayNow => {
      selectCaptureMode(action === 'record' || action === 'record-full' ? 'record' : 'image')
      setView('capture')
      if (action === 'full') return takeStill(displayNow, undefined, options.after)
      if (action === 'record-full') return startCaptureSession('record', null, displayNow, modeRef.current === 'quick' ? 'visible' : null)
      let quickHidden = false
      const result = await openRegion({
        display: displayNow,
        prefer: action,
        ...(action === 'record' ? { withAudio: settingsRef.current.recordAudio === true } : {}),
        beforeShow: async () => { quickHidden = await host.ui.dismissQuick() }
      })
      if (!result) return
      if (action === 'image') return takeStill(displayNow, result.bounds, options.after, quickHidden)
      return startCaptureSession(action, result, displayNow, quickHidden ? 'dismissed' : null)
    })
  }, [selectCaptureMode, startCaptureSession, takeStill, withCaptureDisplay])

  const stopActive = useCallback(async () => {
    const current = activeRef.current
    if (!current) return
    try { await current.session.stop() } catch (error) { notify(error?.message || error, 'error') }
  }, [notify])

  /* ---------- 导入 / 打开方式 ---------- */
  const importImageToEditor = useCallback(async ({ dataUrl, name }) => {
    const blob = dataUrlToBlob(dataUrl)
    const ext = extensionForMime(blob.type)
    if (!blob.type.startsWith('image/') || mimeForExtension(ext) !== blob.type) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片')
    const url = URL.createObjectURL(blob)
    try {
      const image = await loadImageElement(url)
      const file = await writeBlob(blob, ext)
      const thumb = thumbFromImage(image, { maxEdge: 320, topCrop: image.naturalHeight > image.naturalWidth * 2.2 })
      const saved = await libraryRef.current.addSaved({
        kind: 'image',
        fileId: file.id,
        ext,
        thumb,
        name: name || '导入图片',
        width: image.naturalWidth,
        height: image.naturalHeight,
        bytes: file.size,
        source: 'import'
      })
      setView('library')
      setEditorId(saved.id)
    } finally {
      URL.revokeObjectURL(url)
    }
  }, [])

  const openToolsImages = useCallback(images => {
    setToolsIncoming({ seq: Date.now(), images })
    setView('tools')
    setLightboxId(null)
    setEditorId(null)
  }, [])

  const openHandles = useCallback(async payload => {
    const handles = Array.isArray(payload?.handles) ? payload.handles : []
    if (!handles.length) { notify('没有可读取的文件', 'error'); return }
    const images = []
    for (const handle of handles) {
      try {
        const dataUrl = await host.localFiles.read({ handleId: handle.id, encoding: 'dataUrl' })
        images.push({ dataUrl, name: handle.name || '图片' })
      } catch (error) {
        notify(`${handle.name || '文件'}：${error?.message || error}`, 'error')
      }
    }
    if (!images.length) return
    if (images.length === 1) await importImageToEditor(images[0])
    else openToolsImages(images)
  }, [importImageToEditor, notify, openToolsImages])

  const handleEnterNow = useCallback(async event => {
    const code = event?.code || ''
    if (code === 'open-file') { await openHandles(event.payload); return }
    const images = Array.isArray(event?.input?.images)
      ? event.input.images.map(image => ({ dataUrl: image.dataUrl, name: image.name || '图片' }))
      : []
    if (code === 'capture') return runCapture('image')
    if (['full', 'longshot', 'record', 'record-full'].includes(code)) return runCapture(code)
    if (code === 'pin') { setView('pins'); void refreshPins(); return }
    if (code === 'tools') { setView('tools'); if (images.length) openToolsImages(images); return }
    if (code === 'library') { setView('library'); return }
    if (images.length) {
      if (images.length === 1) await importImageToEditor(images[0])
      else openToolsImages(images)
      return
    }
    setView('capture')
  }, [importImageToEditor, openHandles, openToolsImages, refreshPins, runCapture])

  /* ---------- 贴图 ---------- */
  const closePin = useCallback(async pinId => {
    await native.pin.close(pinId).catch(() => {})
    await refreshPins()
  }, [native, refreshPins])

  const closeAllPins = useCallback(async () => {
    await native.pin.closeAll().catch(() => {})
    await refreshPins()
  }, [native, refreshPins])

  const pinFromClipboard = useCallback(async () => {
    try {
      const image = await host.clipboard.readImage()
      if (!image?.dataUrl) throw new Error('剪贴板中没有图片')
      await pinImage(image.dataUrl, '剪贴板图片')
    } catch (error) { notify(error?.message || error, 'error') }
  }, [notify, pinImage])

  const pinFromFile = useCallback(async () => {
    try {
      const handles = await host.localFiles.pick({ kind: 'file', multiple: false, access: 'read' })
      const handle = handles?.[0]
      if (!handle) return
      const dataUrl = await host.localFiles.read({ handleId: handle.id, encoding: 'dataUrl' })
      await pinImage(dataUrl, handle.name)
    } catch (error) { notify(error?.message || error, 'error') }
  }, [notify, pinImage])

  /* ---------- 导航 / 设置 ---------- */
  const changeQuery = useCallback(value => {
    setQuery(value)
    kitRef.current?.setQuery(value)
  }, [])

  const go = useCallback(next => {
    setView(next)
    setLightboxId(null)
    setEditorId(null)
    if (next === 'pins') void refreshPins()
  }, [refreshPins])

  const updateSetting = useCallback((key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    void kitRef.current?.setPref?.(key, value)
  }, [])

  const navigateLightbox = useCallback(delta => {
    const list = filteredRef.current
    const index = list.findIndex(item => item.id === lightboxIdRef.current)
    if (index < 0) return
    const next = list[index + delta]
    if (next) setLightboxId(next.id)
  }, [])

  const handleQuickAction = useCallback(action => {
    if (action === 'clear') { setQuery(''); return }
    if (settingsOpenRef.current || editorIdRef.current) return
    if (action === 'next' || action === 'previous') { navigateLightbox(action === 'next' ? 1 : -1); return }
    if (action === 'submit' && !lightboxIdRef.current) {
      if (viewRef.current === 'capture') { void runCapture(captureModeRef.current); return }
      if (viewRef.current !== 'library') return
      const first = filteredRef.current[0]
      if (first) setLightboxId(first.id)
    }
  }, [navigateLightbox, runCapture])

  useEffect(() => {
    const kit = window.PluginKit?.create?.({
      title: '屏幕助手',
      quickPlaceholder: '搜索媒体库中的截图或录屏…',
      prefs: true,
      defaults: DEFAULT_SETTINGS,
      onQuery: value => {
        setQuery(value)
        if (modeRef.current === 'quick' && value.trim()) setView('library')
      },
      onAction: handleQuickAction
    })
    if (!kit) { setPrefsReady(true); return undefined }
    kitRef.current = kit
    setMode(kit.mode)
    kit.onMode(next => setMode(next))
    kit.onSettings(next => setSettings(prev => ({ ...prev, ...next })))
    void kit.ready.then(() => {
      const stored = kit.settings || {}
      const merged = { ...DEFAULT_SETTINGS, ...stored }
      if (!stored.imageLimit && stored.historyLimit) merged.imageLimit = Number(stored.historyLimit) || 200
      if (stored.recordAudio === undefined && stored.withAudio !== undefined) merged.recordAudio = stored.withAudio === true
      setSettings(merged)
      setPrefsReady(true)
    }).catch(() => setPrefsReady(true))

    const disposers = []
    disposers.push(host.onEnter?.(event => { setEnterEvent(event) }))
    disposers.push(host.onBeforeClose?.(async () => {
      const current = activeRef.current
      if (current?.session) {
        try { await current.session.stop() } catch { /* best effort */ }
        await Promise.race([
          current.session.done.catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 2500))
        ])
      }
      await libraryRef.current.flush().catch(() => {})
      await flushDrafts().catch(() => {})
    }))
    disposers.push(host.onDestroy?.(() => { releaseAll() }))
    return () => {
      for (const dispose of disposers) { try { dispose?.() } catch { /* ignore */ } }
      kit.destroy?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let alive = true
    loadDisplays().then(list => {
      if (!alive) return
      setDisplays(list)
      setDisplayId(prev => (list.some(item => item.id === prev) ? prev : (list.find(item => item.primary) || list[0])?.id ?? null))
    }).catch(error => notify(error?.message || error, 'error'))
    return () => { alive = false }
  }, [notify])

  useEffect(() => {
    if (!enterEvent) return
    if (!prefsReady || !library.ready) return
    const event = enterEvent
    setEnterEvent(null)
    void handleEnterNow(event).catch(error => notify(error?.message || error, 'error'))
  }, [enterEvent, prefsReady, library.ready, handleEnterNow, notify])

  useEffect(() => {
    if (view === 'pins') void refreshPins()
  }, [view, refreshPins])

  useEffect(() => {
    if (lightboxId && lightboxIndex < 0) setLightboxId(null)
  }, [lightboxId, lightboxIndex])

  const loading = !prefsReady || !library.ready

  return (
    <main className="sa-app">
      <Rail
        view={view}
        onChange={go}
        onSettings={() => setSettingsOpen(true)}
        pinCount={pins?.length || 0}
        libraryCount={library.items.length}
      />
      <div className="sa-main">
        {loading ? (
          <div className="sa-empty"><span className="sa-spinner" /> 正在加载…</div>
        ) : (
          <>
            {view === 'capture' ? (
              <CaptureView
                displays={displays}
                displayId={displayId}
                onDisplayChange={setDisplayId}
                settings={settings}
                captureMode={captureMode}
                onCaptureModeChange={selectCaptureMode}
                onToggleAudio={checked => updateSetting('recordAudio', checked === true)}
                recent={library.items}
                ensureThumb={library.ensureThumb}
                busy={busy}
                active={active}
                onStop={() => { void stopActive() }}
                onAction={runCapture}
                onOpenItem={item => { setFilter('all'); changeQuery(''); setView('library'); setLightboxId(item.id) }}
                onOpenLibrary={() => setView('library')}
                onCaptureAction={value => updateSetting('captureAction', value)}
                quick={mode === 'quick'}
              />
            ) : null}
            {view === 'library' ? (
              <LibraryView
                items={library.items}
                loading={!library.ready}
                filter={filter}
                onFilter={setFilter}
                query={query}
                onQuery={changeQuery}
                onBack={mode === 'quick' ? () => { changeQuery(''); go('capture') } : undefined}
                onOpen={item => setLightboxId(item.id)}
                onEdit={item => { setLightboxId(null); setEditorId(item.id) }}
                onExport={item => { void exportItem(item) }}
                onDelete={deleteItems}
                ensureThumb={library.ensureThumb}
                totalBytes={library.totalBytes}
                onCapture={() => { void runCapture('image') }}
                onClearSearch={() => changeQuery('')}
              />
            ) : null}
            {view === 'tools' ? (
              <ToolsView
                incoming={toolsIncoming}
                library={library}
                onPinImage={pinImage}
                toast={notify}
              />
            ) : null}
            {view === 'pins' ? (
              <PinsView
                pins={pins}
                loading={pinsLoading}
                onRefresh={() => { void refreshPins() }}
                onClosePin={pinId => { void closePin(pinId) }}
                onCloseAll={() => { void closeAllPins() }}
                onPinCapture={() => { void runCapture('image', { after: 'pin' }) }}
                onPinClipboard={() => { void pinFromClipboard() }}
                onPinFile={() => { void pinFromFile() }}
              />
            ) : null}
          </>
        )}

        {editorItem ? (
          <EditorView
            item={editorItem}
            library={library}
            onClose={() => setEditorId(null)}
            onSaved={saved => { if (saved) setEditorId(saved.id) }}
            onPinImage={pinImage}
            toast={notify}
          />
        ) : null}

        {lightboxItem && lightboxIndex >= 0 ? createPortal(
          <Lightbox
            items={filtered}
            item={lightboxItem}
            index={lightboxIndex}
            onClose={() => setLightboxId(null)}
            onNavigate={navigateLightbox}
            onEdit={item => { setLightboxId(null); setEditorId(item.id) }}
            onExport={item => { void exportItem(item) }}
            onCopy={item => { void copyItem(item) }}
            onPin={item => { void pinItem(item) }}
            onDelete={item => { void deleteItems([item]) }}
            onSaveFrame={saveFrame}
            onSaveGif={saveGif}
            gifDefaults={settings}
            toast={notify}
          />,
          document.body
        ) : null}
      </div>

      {settingsOpen && <SettingsDialog
        initialSection={captureMode}
        settings={settings}
        onChange={updateSetting}
        onClose={() => setSettingsOpen(false)}
      />}
    </main>
  )
}
