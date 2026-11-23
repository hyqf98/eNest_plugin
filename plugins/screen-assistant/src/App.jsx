import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createNativeSurfaces } from '@enest/native-surfaces'
import { host } from './lib/env.js'
import { useLibrary } from './lib/library.js'
import { getThumb } from './lib/assets.js'
import { loadImageElement, releaseAll } from './lib/blobs.js'
import { loadDisplays, physicalDisplayBounds } from './lib/surfaces.js'
import {
  captureFullscreen, imageFromRegionResult, openRegionSession, startLongshot, startRecorder
} from './lib/session.js'
import {
  canvasToBlob, dataUrlToBlob, fileToDataUrl, mimeForExtension, writeBlob
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
  captureAction: 'preview',
  imageLimit: 200,
  recordAudio: false,
  gifFps: 10,
  gifWidth: 480
}

const safeName = value => String(value || 'record').replace(/[\\/:*?"<>|]/g, '-').slice(0, 100)

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
    if (kitRef.current?.toast) kitRef.current.toast(message, type)
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
  const queryRef = useRef(query)
  const displayRef = useRef(display)
  const activeRef = useRef(active)
  const libraryRef = useRef(library)
  const filteredRef = useRef(filtered)
  const lightboxIdRef = useRef(lightboxId)
  const editorIdRef = useRef(editorId)
  settingsRef.current = settings
  modeRef.current = mode
  viewRef.current = view
  queryRef.current = query
  displayRef.current = display
  activeRef.current = active
  libraryRef.current = library
  filteredRef.current = filtered
  lightboxIdRef.current = lightboxId
  editorIdRef.current = editorId

  const enterRef = useRef(null)

  /* ---------- 基础数据 ---------- */
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

  const deleteItem = useCallback(async item => {
    const list = filteredRef.current
    const index = list.findIndex(entry => entry.id === item.id)
    try {
      await libraryRef.current.remove(item.id)
    } catch (error) { notify(error?.message || error, 'error'); return }
    if (lightboxIdRef.current === item.id) {
      const next = list[index + 1] || list[index - 1]
      setLightboxId(next?.id || null)
    }
    if (editorIdRef.current === item.id) setEditorId(null)
    notify('已删除', 'success')
  }, [notify])

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

  const afterCapture = useCallback(async (item, override) => {
    if (!item) return
    const action = override || settingsRef.current.captureAction
    try {
      if (action === 'copy') {
        await host.clipboard.writeImage(await itemDataUrl(item))
        notify('已复制截图', 'success')
      } else if (action === 'pin') {
        await pinImage(await itemDataUrl(item), item.name)
      } else {
        setEditorId(item.id)
      }
    } catch (error) { notify(error?.message || error, 'error') }
  }, [itemDataUrl, notify, pinImage])

  /* ---------- 录制 / 长截图 ---------- */
  const startLongshotFlow = useCallback(async (result, displayNow) => {
    let session
    try {
      session = await startLongshot({
        display: displayNow,
        bounds: result.bounds,
        library: libraryRef.current,
        onState: state => {
          if (state === 'running') setActive(prev => (prev ? { ...prev, startedAt: Date.now() } : prev))
        }
      })
    } catch (error) {
      void result.region?.proceed()
      throw error
    }
    void result.region?.proceed()
    setActive({ kind: 'longshot', startedAt: Date.now(), session })
    session.done
      .then(item => {
        if (item) {
          notify('长截图已保存', 'success')
          setEditorId(item.id)
        }
      })
      .catch(error => notify(error?.message || error, 'error'))
      .finally(() => setActive(null))
  }, [notify])

  const startRecordFlow = useCallback(async (result, displayNow) => {
    const bounds = result?.bounds || physicalDisplayBounds(displayNow)
    let session
    try {
      session = await startRecorder({
        display: displayNow,
        bounds,
        withAudio: settingsRef.current.recordAudio,
        library: libraryRef.current,
        onState: state => {
          if (state === 'recording') {
            setActive(prev => (prev ? { ...prev, startedAt: Date.now() } : prev))
          }
        }
      })
    } catch (error) {
      void result?.region?.proceed()
      throw error
    }
    void result?.region?.proceed()
    setActive({ kind: 'record', startedAt: Date.now(), session })
    session.done
      .then(item => { if (item) notify('录屏已保存', 'success') })
      .catch(error => notify(error?.message || error, 'error'))
      .finally(() => setActive(null))
  }, [notify])

  const runRegion = useCallback(async (prefer = 'image', options = {}) => {
    if (activeRef.current) { notify('已有录制或长截图进行中', 'info'); return }
    const displayNow = displayRef.current
    if (!displayNow) { notify('没有可用显示器', 'error'); return }
    setView('capture')
    setBusy(true)
    try {
      const result = await openRegionSession({
        display: displayNow,
        withAudio: settingsRef.current.recordAudio,
        prefer
      })
      if (!result) return
      if (result.action === 'image') {
        const item = await libraryRef.current.addSaved(imageFromRegionResult(result))
        await afterCapture(item, options.after)
        return
      }
      if (result.action === 'longshot') { await startLongshotFlow(result, displayNow); return }
      await startRecordFlow(result, displayNow)
    } catch (error) {
      notify(error?.message || error, 'error')
    } finally {
      setBusy(false)
    }
  }, [afterCapture, notify, startLongshotFlow, startRecordFlow])

  const captureFull = useCallback(async () => {
    const displayNow = displayRef.current
    if (!displayNow) { notify('没有可用显示器', 'error'); return }
    setBusy(true)
    try {
      const item = await captureFullscreen({ display: displayNow, library: libraryRef.current })
      await afterCapture(item)
    } catch (error) {
      notify(error?.message || error, 'error')
    } finally {
      setBusy(false)
    }
  }, [afterCapture, notify])

  const recordFull = useCallback(async () => {
    if (activeRef.current) { notify('已有录制或长截图进行中', 'info'); return }
    const displayNow = displayRef.current
    if (!displayNow) { notify('没有可用显示器', 'error'); return }
    setBusy(true)
    try {
      await startRecordFlow(null, displayNow)
    } catch (error) {
      notify(error?.message || error, 'error')
    } finally {
      setBusy(false)
    }
  }, [notify, startRecordFlow])

  const stopActive = useCallback(async () => {
    const current = activeRef.current
    if (!current) return
    try { await current.session.stop() } catch (error) { notify(error?.message || error, 'error') }
  }, [notify])

  /* ---------- 导入 / 打开方式 ---------- */
  const importImageToEditor = useCallback(async ({ dataUrl, name }) => {
    const blob = dataUrlToBlob(dataUrl)
    const mime = blob.type || 'image/png'
    const ext = mimeForExtension(mime)
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
    if (code === 'capture') { setView('capture'); await runRegion('image'); return }
    if (code === 'full') { setView('capture'); await captureFull(); return }
    if (code === 'longshot') { setView('capture'); await runRegion('longshot'); return }
    if (code === 'record') { setView('capture'); await runRegion('record'); return }
    if (code === 'record-full') { setView('capture'); await recordFull(); return }
    if (code === 'pin') { setView('pins'); void refreshPins(); return }
    if (code === 'tools') { setView('tools'); if (images.length) openToolsImages(images); return }
    if (code === 'library') { setView('library'); return }
    if (images.length) {
      if (images.length === 1) await importImageToEditor(images[0])
      else openToolsImages(images)
      return
    }
    setView('capture')
  }, [captureFull, importImageToEditor, openHandles, openToolsImages, recordFull, refreshPins, runRegion])
  enterRef.current = handleEnterNow

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

  const toggleAudio = useCallback(() => {
    updateSetting('recordAudio', !settingsRef.current.recordAudio)
  }, [updateSetting])

  const navigateLightbox = useCallback(delta => {
    const list = filteredRef.current
    const index = list.findIndex(item => item.id === lightboxIdRef.current)
    if (index < 0) return
    const next = list[index + delta]
    if (next) setLightboxId(next.id)
  }, [])

  const handleQuickAction = useCallback(action => {
    if (action === 'clear') { setQuery(''); return }
    if (action === 'next' || action === 'previous') { navigateLightbox(action === 'next' ? 1 : -1); return }
    if (action === 'submit') {
      if (viewRef.current === 'capture') { void runRegion('image'); return }
      const first = filteredRef.current[0]
      if (first) setLightboxId(first.id)
    }
  }, [navigateLightbox, runRegion])

  useEffect(() => {
    const kit = window.PluginKit?.create?.({
      title: '屏幕助手',
      height: 620,
      quickPlaceholder: '截图、录屏或图片工具…',
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
      setDisplayId(prev => (prev && list.some(item => item.id === prev) ? prev : (list.find(item => item.primary) || list[0])?.id || null))
    }).catch(error => notify(error?.message || error, 'error'))
    return () => { alive = false }
  }, [notify])

  useEffect(() => {
    if (!enterEvent) return
    if (!prefsReady || !displays.length) return
    const event = enterEvent
    setEnterEvent(null)
    void handleEnterNow(event)
  }, [enterEvent, prefsReady, displays.length, handleEnterNow])

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
                onToggleAudio={toggleAudio}
                recent={library.items}
                ensureThumb={library.ensureThumb}
                busy={busy}
                active={active ? { kind: active.kind, startedAt: active.startedAt } : null}
                onStop={() => { void stopActive() }}
                onAction={action => {
                  if (action === 'region') void runRegion('image')
                  else if (action === 'full') void captureFull()
                  else if (action === 'longshot') void runRegion('longshot')
                  else if (action === 'record') void runRegion('record')
                  else if (action === 'record-full') void recordFull()
                }}
                onOpenItem={item => { setFilter('all'); setQuery(''); setView('library'); setLightboxId(item.id) }}
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
                onQuery={setQuery}
                onOpen={item => setLightboxId(item.id)}
                onEdit={item => { setLightboxId(null); setEditorId(item.id) }}
                onExport={item => { void exportItem(item) }}
                ensureThumb={library.ensureThumb}
                totalBytes={library.totalBytes}
                onCapture={() => { setView('capture'); void runRegion('image') }}
                onClearSearch={() => setQuery('')}
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
                onPinCapture={() => { void runRegion('image', { after: 'pin' }) }}
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
            onDelete={item => { void deleteItem(item) }}
            onSaveFrame={saveFrame}
            onSaveGif={saveGif}
            gifDefaults={settings}
            toast={notify}
          />,
          document.body
        ) : null}
      </div>

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={updateSetting}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  )
}
