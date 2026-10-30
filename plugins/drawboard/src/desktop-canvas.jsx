import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasStage } from './jsx/CanvasStage.jsx'
import { TextEditOverlay } from './jsx/TextEditOverlay.jsx'
import { createDesktopTransport } from './js/desktopTransport.mjs'
import { makeText, uid } from './js/objects.mjs'
import { THEMES, normalizeSettings } from './js/theme.mjs'
import './css/main.css'
import './css/desktop.css'
import './js/desktopFont.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
const clean = objects => objects.map(({ _born, _w, _measured, ...object }) => object)

function DesktopCanvas() {
  const objects = useRef([]), baseline = useRef(null), bridge = useRef(null)
  const pending = useRef(null), gesture = useRef(false), patchTimer = useRef(null)
  const [tick, setTick] = useState(0), [instance, setInstance] = useState(0)
  const [vp, setVp] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 })
  const [settings, setSettings] = useState(normalizeSettings(null))
  const [tool, setTool] = useState('pen'), [drawing, setDrawing] = useState(false)
  const [selection, setSelection] = useState([]), [editing, setEditing] = useState(null)
  const [images, setImages] = useState(new Map()), imageCache = useRef(new Map())
  const [waiting, setWaiting] = useState(true), [error, setError] = useState('')
  const [space, setSpace] = useState(false), latest = useRef({})
  const theme = THEMES[settings.theme] || THEMES.paper
  const changed = () => setTick(value => value + 1)
  const post = data => bridge.current?.post(data).catch(error => setError(error.message))
  const cancelGesture = () => {
    gesture.current = false; latest.current.editing = null; setEditing(null); setSpace(false); setSelection([])
    if (!pending.current && baseline.current) objects.current = clone(baseline.current.objects)
    setInstance(value => value + 1); changed()
  }
  const operate = () => { cancelGesture(); setDrawing(false); void post({ type: 'operate' }) }
  const finish = () => {
    gesture.current = false
    const base = baseline.current
    if (!base || pending.current) return
    const next = clean(objects.current), previous = new Map(base.objects.map(item => [item.id, JSON.stringify(item)]))
    const upsert = next.filter(item => previous.get(item.id) !== JSON.stringify(item))
    const ids = new Set(next.map(item => item.id)), remove = base.objects.filter(item => !ids.has(item.id)).map(item => item.id)
    if (!upsert.length && !remove.length && next.every((item, index) => item.id === base.objects[index]?.id)) return
    const requestId = crypto.randomUUID()
    pending.current = { requestId, objects: clone(next) }; setWaiting(true)
    clearTimeout(patchTimer.current)
    patchTimer.current = setTimeout(() => {
      setError('保存未确认，已暂停绘制。请稍后重新选择工具。')
      operate(); void post({ type: 'resync' })
    }, 12_000)
    void post({ type: 'patch', requestId, draftId: base.draftId, revision: base.revision, upsert, remove, order: next.map(item => item.id) })
  }
  const mutate = mutator => { if (!pending.current) { const result = mutator(objects.current); if (Array.isArray(result)) objects.current = result; changed() } }
  const add = (object, options = {}) => {
    if (pending.current) return
    const item = { ...object, id: object.id || uid() }
    objects.current.push(item); changed()
    if (options.select) { setSelection([item.id]); setTool('select'); void post({ type: 'tool-current', tool: 'select' }) }
  }
  const commitText = value => {
    const session = latest.current.editing
    if (!session || pending.current) return
    latest.current.editing = null; setEditing(null)
    if (session.existing) mutate(items => items.flatMap(item => item.id === session.existing.id ? (value.trim() ? [{ ...item, text: value }] : []) : [item]))
    else if (value.trim()) add(makeText(session.world.x, session.world.y, { text: value, color: settings.color || theme.ink, size: session.size || 24 }))
    finish()
  }
  latest.current = { operate, cancelGesture, finish, selection, drawing, editing }

  useEffect(() => {
    const api = window.enestAux
    if (!api) { setError('桌面画布需要从 eNest 启动'); return }
    let disposed = false, imageEpoch = 0, readyTimer
    const transport = createDesktopTransport(data => api.post(data), async data => {
      if (disposed) return
      if (data.type === 'ready-ack') { clearInterval(readyTimer); return }
      if (data.type === 'snapshot') {
        clearTimeout(patchTimer.current)
        const interrupted = gesture.current || Boolean(pending.current)
        gesture.current = false; pending.current = null
        baseline.current = { draftId: data.draftId, revision: data.revision, objects: clone(clean(data.objects)) }
        objects.current = clone(baseline.current.objects)
        setSettings(normalizeSettings(data.settings)); setTool(data.tool === 'image' ? 'select' : data.tool)
        setDrawing(Boolean(data.drawing)); setWaiting(false); setSelection([]); setEditing(null)
        setInstance(value => value + 1); changed()
        setError(data.error || (interrupted ? '草稿已在画板中更新，本次未完成绘制已取消。' : ''))
        const epoch = ++imageEpoch
        const wanted = new Set(data.imageKeys || [])
        for (const [key, source] of Object.entries(data.images || {})) {
          if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(source)) continue
          if (imageCache.current.get(key)?.src === source) continue
          const image = await new Promise(resolve => {
            const element = new Image(); element.onload = () => resolve(element); element.onerror = () => resolve(null); element.src = source
          })
          if (disposed || epoch !== imageEpoch) return
          if (image) imageCache.current.set(key, image)
        }
        for (const key of imageCache.current.keys()) if (!wanted.has(key)) imageCache.current.delete(key)
        if (!disposed && epoch === imageEpoch) setImages(new Map(imageCache.current))
      } else if (data.type === 'ack' && pending.current?.requestId === data.requestId) {
        clearTimeout(patchTimer.current)
        baseline.current = { ...baseline.current, revision: data.revision, objects: pending.current.objects }
        pending.current = null; setWaiting(false); setError('')
      } else if (data.type === 'tool') {
        latest.current.cancelGesture(); setTool(data.tool); setDrawing(true)
      } else if (data.type === 'error') {
        setError(data.message || '桌面草稿未保存'); latest.current.operate()
        void transport.post({ type: 'resync' }).catch(() => {})
      }
    }, error => { if (!disposed) { setError(error.message); latest.current.operate() } })
    bridge.current = transport
    const off = api.onMessage(data => {
      if (data?.type === 'desktop-mode') {
        if (!data.drawing) latest.current.cancelGesture()
        setDrawing(Boolean(data.drawing))
      } else if (data?.type === 'enest:surface-changed' && data.state?.interaction === 'passthrough') {
        latest.current.cancelGesture(); setDrawing(false)
      } else transport.accept(data)
    })
    void api.getContext().then(() => {
      if (disposed) return
      const ready = () => void transport.post({ type: 'ready' }).catch(error => setError(error.message))
      ready(); readyTimer = setInterval(ready, 1500)
    }).catch(error => setError(error.message))
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); latest.current.operate(); return }
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || /INPUT|TEXTAREA/.test(event.target.tagName))) return
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault(); latest.current.cancelGesture()
        void transport.post({ type: event.shiftKey ? 'redo' : 'undo' }).catch(error => setError(error.message)); return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && latest.current.selection.length && !pending.current) {
        event.preventDefault()
        objects.current = objects.current.filter(item => !latest.current.selection.includes(item.id))
        setSelection([]); changed(); latest.current.finish()
      }
      if (event.code === 'Space') { event.preventDefault(); setSpace(true) }
    }
    const keyup = event => { if (event.code === 'Space') setSpace(false) }
    const blur = () => { if (gesture.current && !pending.current) latest.current.cancelGesture(); setSpace(false) }
    window.addEventListener('keydown', keyboard); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur)
    return () => {
      disposed = true; imageEpoch++; clearInterval(readyTimer); clearTimeout(patchTimer.current)
      off(); transport.dispose(); bridge.current = null
      window.removeEventListener('keydown', keyboard); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur)
    }
  }, [])

  return <div className="db-desktop-canvas" data-drawing={drawing && !waiting}>
    <CanvasStage key={instance} objectsRef={objects} objectsTick={tick} images={images} vp={vp} setVp={setVp}
      tool={tool} settings={settings} theme={theme} selection={selection} setSelection={setSelection}
      transparent spaceDown={space} onCommitObjects={mutate} onAddObject={add}
      onGestureStart={() => { gesture.current = true }} onGestureEnd={finish}
      onTextEdit={(existing, world) => setEditing({ existing: existing ? clone(existing) : undefined,
        world: existing ? { x: existing.x, y: existing.y } : world, size: Math.max(settings.strokeWidth * 9, 20) })}
      onContextMenu={event => { event.preventDefault(); operate() }} />
    {editing && drawing && <TextEditOverlay editing={editing} vp={vp} color={settings.color} theme={theme} onCommit={commitText} onCancel={operate} />}
    {(error || drawing) && <div className="db-desktop-hint" role="status">{error || (waiting ? '正在保存笔画…' : 'Esc 或右键返回桌面操作')}</div>}
  </div>
}

createRoot(document.getElementById('root')).render(<DesktopCanvas />)
