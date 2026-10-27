/**
 * App —— 画板主组件：文档/视口/选择状态编排、撤销重做、键盘与粘贴、右键菜单、复制导出
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PluginKit from '@enest/plugin-kit'
import { bindFileInput } from '@enest/plugin-kit/file-inputs'
import { CanvasStage } from './CanvasStage.jsx'
import { Toolbar } from './Toolbar.jsx'
import { DraftTabs } from './DraftTabs.jsx'
import { DraftPanel } from './DraftPanel.jsx'
import { openCascadeMenu } from './CascadeMenu.jsx'
import { MenuColorPicker, MenuSlider } from './MenuWidgets.jsx'
import { TextEditOverlay } from './TextEditOverlay.jsx'
import { SettingsDialog, SettingsFab } from './SettingsDialog.jsx'
import { TooltipProvider } from '../ui/index.jsx'
import { contentBBox, cloneObjects, makeText, makeShape, uid } from '../js/objects.mjs'
import { makeViewport, fitToContent, ZOOM_STEP } from '../js/viewport.mjs'
import { THEMES, normalizeSettings } from '../js/theme.mjs'
import { composeExport } from '../js/render.mjs'
import { createPersistence, makeDraft, putImageBlob, getImageBlob } from '../js/store.mjs'

const UNDO_LIMIT = 50
const TOOLS_FOR_MENU = [
  ['select', '选择 (V)'],
  ['pen', '钢笔 (P)'],
  ['highlighter', '荧光笔 (H)'],
  ['eraser', '橡皮 (E)'],
  { sep: true },
  ['rect', '矩形 (R)'],
  ['ellipse', '椭圆 (O)'],
  ['line', '直线 (L)'],
  ['arrow', '箭头 (A)'],
  ['text', '文字 (T)'],
  ['image', '贴图 (I)'],
]

/** 菜单工具项小图标 path（CascadeMenu icon() 内联为 SVG） */
const MENU_ICONS = {
  select: 'M12 3.5l7 8-3.4.7-1.1 3.9-2.5-2.8-3.9 1.1 1.3-3.6-2.9-2.6 5.5-4.7z',
  pen: 'M20.2 3.8l-.1-.1c.6.6.4 1.6-.4 2.4L9.8 16.2l-2.6.7.7-2.6L17.8 5.4c.8-.8 1.8-1.9 2.4-1.6zM4.5 20.3l2.7-2.7',
  highlighter: 'M11 3.2l3.8 3.8-5.5 7.5H5.8v-3L11 3.2zM4 20.5h16',
  eraser: 'M9 13.5l6.2-6.2a1.6 1.6 0 0 1 2.3 0l1.7 1.7a1.6 1.6 0 0 1 0 2.3l-5.5 5.5H9.6L5 13.7l4-.2z',
  rect: 'M4.5 7c3.5-1.3 11.5-1.3 15 0s-1 9.5-2.6 11.2-9.4 1.7-12.4.6S1.9 8 4.5 7z',
  ellipse: 'M12 6c4.6 0 8.4 2.6 8.4 6s-3.8 6-8.4 6-8.4-2.6-8.4-6 3.8-6 8.4-6z',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5M12.5 5H19v6.5',
  text: 'M5 5.5h14M12 5.5V19M9 19h6',
  image: 'M3.5 5.5h17v13h-17zM3.5 15.5l5-4.5 4 3.5 3-2.5 5 4',
}

export function App() {
  const kitRef = useRef(null)
  const persistRef = useRef(null)
  const fileInputRef = useRef(null)
  const binderRef = useRef(null)
  const lastPointerRef = useRef({ x: 0, y: 0 })  // 最近指针位置（⌘V 贴图落点）

  const [ready, setReady] = useState(false)
  const [drafts, setDrafts] = useState([])
  const [activeId, setActiveId] = useState(null)
  const objectsRef = useRef([])           // 当前草稿对象（可变，渲染直读）
  const [, forceObjects] = useState(0)    // 对象变更的 React 通知
  const [objectsTick, setObjectsTick] = useState(0) // 传给 CanvasStage 触发拖动中实时重绘（橡皮/移动）
  const [vp, setVp] = useState(makeViewport())
  const vpRef = useRef(vp); vpRef.current = vp
  const [selection, setSelection] = useState([])
  const [tool, setTool] = useState('pen')
  const toolRef = useRef(tool); toolRef.current = tool
  const [settings, setSettings] = useState(normalizeSettings(null))
  const settingsRef = useRef(settings); settingsRef.current = settings
  const [spaceDown, setSpaceDown] = useState(false)
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [images, setImages] = useState(new Map())  // blobId -> HTMLImageElement
  const imagesRef = useRef(images); imagesRef.current = images

  const undoRef = useRef([])              // { objects, selection }
  const redoRef = useRef([])
  const [undoTick, setUndoTick] = useState(0)
  const clipRef = useRef([])              // 内部剪贴板（对象深拷贝）

  const theme = useMemo(() => THEMES[settings.theme] || THEMES.paper, [settings.theme])

  const activeDraft = drafts.find((d) => d.id === activeId)

  /* ---------- 文档变更 ---------- */

  const notifyObjects = useCallback(() => { forceObjects((n) => n + 1); setObjectsTick((n) => n + 1) }, [])

  const persistNow = useCallback((nextDrafts, nextActiveId) => {
    persistRef.current?.saveData({
      version: 1,
      activeId: nextActiveId,
      drafts: nextDrafts.map((d) => ({ ...d, viewport: d.id === nextActiveId ? vpRef.current : d.viewport })),
    })
  }, [])

  const snapshot = useCallback(() => {
    undoRef.current.push({ objects: JSON.parse(JSON.stringify(objectsRef.current)), selection: [...selection] })
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift()
    redoRef.current = []
    setUndoTick((n) => n + 1)
  }, [selection])

  const commitObjects = useCallback((mutator, { snapshot: snap = true } = {}) => {
    if (snap) snapshot()
    const objects = objectsRef.current
    const result = mutator(objects)
    const next = Array.isArray(result) ? result : objects
    objectsRef.current = next
    notifyObjects()
  }, [snapshot, notifyObjects])

  const syncDraftDoc = useCallback(() => {
    setDrafts((prev) => {
      const next = prev.map((d) => (d.id === activeId ? { ...d, objects: objectsRef.current, updatedAt: Date.now() } : d))
      persistNow(next, activeId)
      return next
    })
  }, [activeId, persistNow])

  const addObject = useCallback((obj) => {
    commitObjects((objects) => { objects.push({ ...obj, id: obj.id || uid(), _born: performance.now() }) })
    syncDraftDoc()
    setSelection([])
  }, [commitObjects, syncDraftDoc])

  /* ---------- 撤销/重做 ---------- */

  const undo = useCallback(() => {
    const snap = undoRef.current.pop()
    if (!snap) return
    redoRef.current.push({ objects: JSON.parse(JSON.stringify(objectsRef.current)), selection: [...selection] })
    objectsRef.current = JSON.parse(JSON.stringify(snap.objects))
    setSelection(snap.selection || [])
    notifyObjects(); syncDraftDoc(); setUndoTick((n) => n + 1)
  }, [selection, notifyObjects, syncDraftDoc])

  const redo = useCallback(() => {
    const snap = redoRef.current.pop()
    if (!snap) return
    undoRef.current.push({ objects: JSON.parse(JSON.stringify(objectsRef.current)), selection: [...selection] })
    objectsRef.current = JSON.parse(JSON.stringify(snap.objects))
    setSelection(snap.selection || [])
    notifyObjects(); syncDraftDoc(); setUndoTick((n) => n + 1)
  }, [selection, notifyObjects, syncDraftDoc])

  /* ---------- 选择操作 ---------- */

  const deleteSelection = useCallback(() => {
    if (!selection.length) return
    commitObjects((objects) => {
      for (let i = objects.length - 1; i >= 0; i--) if (selection.includes(objects[i].id)) objects.splice(i, 1)
    })
    setSelection([]); syncDraftDoc()
  }, [selection, commitObjects, syncDraftDoc])

  const duplicateSelection = useCallback(() => {
    if (!selection.length) return
    const picked = objectsRef.current.filter((o) => selection.includes(o.id))
    const copies = cloneObjects(picked, 14, 14)
    const born = performance.now()
    commitObjects((objects) => { objects.push(...copies.map((c) => ({ ...c, _born: born }))) })
    setSelection(copies.map((c) => c.id)); syncDraftDoc()
  }, [selection, commitObjects, syncDraftDoc])

  const copySelection = useCallback(() => {
    clipRef.current = JSON.parse(JSON.stringify(objectsRef.current.filter((o) => selection.includes(o.id))))
    kitRef.current?.toast(selection.length ? `已复制 ${selection.length} 项` : '')
  }, [selection])

  const pasteInternal = useCallback((dx = 14) => {
    if (!clipRef.current.length) return
    const copies = cloneObjects(clipRef.current, dx, dx)
    const born = performance.now()
    commitObjects((objects) => { objects.push(...copies.map((c) => ({ ...c, _born: born }))) })
    setSelection(copies.map((c) => c.id)); syncDraftDoc()
  }, [commitObjects, syncDraftDoc])

  const zOrder = useCallback((mode) => {
    if (!selection.length) return
    commitObjects((objects) => {
      const picked = objects.filter((o) => selection.includes(o.id))
      const rest = objects.filter((o) => !selection.includes(o.id))
      objectsRef.current = mode === 'top' ? [...rest, ...picked] : [...picked, ...rest]
      return objectsRef.current
    })
    syncDraftDoc()
  }, [selection, commitObjects, syncDraftDoc])

  const clearDraft = useCallback(() => {
    if (!objectsRef.current.length) return
    commitObjects((objects) => { objects.length = 0 })
    setSelection([]); syncDraftDoc()
  }, [commitObjects, syncDraftDoc])

  /* ---------- 贴图 ---------- */

  const importImageDataUrl = useCallback(async (dataUrl, atScreen) => {
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('图片无法解析'))
        el.src = dataUrl
      })
      const blobId = await putImageBlob(kitRef.current, dataUrl)
      const maxW = 640
      const scale = Math.min(1, maxW / img.naturalWidth)
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale
      // 落点：传了屏幕坐标（⌘V 粘贴）就贴到鼠标处，否则画布中心
      const center = atScreen
        ? { x: (atScreen.x - vpRef.current.x) / vpRef.current.zoom, y: (atScreen.y - vpRef.current.y) / vpRef.current.zoom }
        : { x: (0 - vpRef.current.x) / vpRef.current.zoom, y: (0 - vpRef.current.y) / vpRef.current.zoom }
      const obj = { id: uid(), kind: 'image', x: center.x - w / 2, y: center.y - h / 2, w, h, blobId, dataUrl: blobId ? undefined : dataUrl }
      if (blobId) setImages((prev) => new Map(prev).set(blobId, img))
      else setImages((prev) => new Map(prev).set(`inline:${obj.id}`, img))
      addObject(obj)
      kitRef.current?.toast('已贴入图片')
    } catch (error) {
      kitRef.current?.toast(error.message || '图片导入失败', 'error')
    }
  }, [addObject])

  /* ---------- 粘贴（剪贴板图片 → 贴图） ---------- */

  useEffect(() => {
    const onPaste = (e) => {
      const editingActive = !!editing
      if (editingActive) return
      const items = e.clipboardData?.items || []
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (!file) return
          const reader = new FileReader()
          // 贴到当前鼠标位置（跟踪最近一次指针位置）
          reader.onload = () => void importImageDataUrl(String(reader.result), { x: lastPointerRef.current.x, y: lastPointerRef.current.y })
          reader.readAsDataURL(file)
          return
        }
      }
      // 内部剪贴板（纯画板对象）优先于文本
      const text = e.clipboardData?.getData?.('text/plain') || ''
      if (clipRef.current.length) { e.preventDefault(); pasteInternal() }
      else if (text) return // 普通文本不处理（避免抢占输入框）
    }
    document.addEventListener('paste', onPaste)
    const trackPointer = (e) => { lastPointerRef.current = { x: e.clientX, y: e.clientY } }
    window.addEventListener('pointermove', trackPointer)
    return () => { document.removeEventListener('paste', onPaste); window.removeEventListener('pointermove', trackPointer) }
  }, [editing, importImageDataUrl, pasteInternal])

  /* ---------- 拖入文件 ---------- */

  useEffect(() => {
    const onDrop = async (e) => {
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
      if (!files.length) return
      e.preventDefault()
      for (const file of files.slice(0, 3)) {
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.readAsDataURL(file)
        })
        await importImageDataUrl(dataUrl)
      }
    }
    const onDragOver = (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault()
    }
    document.addEventListener('drop', onDrop)
    document.addEventListener('dragover', onDragOver)
    return () => { document.removeEventListener('drop', onDrop); document.removeEventListener('dragover', onDragOver) }
  }, [importImageDataUrl])

  /* ---------- 键盘 ---------- */

  useEffect(() => {
    const isTyping = (e) => {
      const el = e.target
      return el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
    }
    const onKeyDown = (e) => {
      if (isTyping(e)) return
      const mod = e.metaKey || e.ctrlKey
      if (e.code === 'Space') { setSpaceDown(true); e.preventDefault(); return }
      if (mod && (e.key.toLowerCase() === 'z' || (e.ctrlKey && e.key.toLowerCase() === 'y'))) { e.preventDefault(); (e.shiftKey || e.key.toLowerCase() === 'y') ? redo() : undo(); return }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return }
      if (mod && e.key.toLowerCase() === 'c') { if (selection.length) { e.preventDefault(); copySelection() } return }
      if (mod && e.key.toLowerCase() === 'v') { if (clipRef.current.length) { e.preventDefault(); pasteInternal() } return }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(objectsRef.current.filter((o) => o.kind !== 'erase').map((o) => o.id)); return }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return }
      if (e.key === 'Escape') { setSelection([]); setEditing(null); return }
      if (e.key.startsWith('Arrow') && selection.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 2
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        commitObjects((objects) => {
          for (const o of objects) if (selection.includes(o.id)) {
            if (o.kind === 'ink') { for (const p of o.points) { p.x += dx; p.y += dy } }
            else {
              o.x += dx; o.y += dy
              if (o.x2 != null) o.x2 += dx
              if (o.y2 != null) o.y2 += dy
            }
          }
        }, { snapshot: true })
        syncDraftDoc()
        return
      }
      if (!mod) {
        const map = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', t: 'text', i: 'image' }
        const next = map[e.key]
        if (next === 'image') { pickImage(); return }
        if (next) { setTool(next); return }
      }
    }
    const onKeyUp = (e) => { if (e.code === 'Space') setSpaceDown(false) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  })

  /* ---------- 右键菜单（多级 CascadeMenu） ---------- */

  const pickImage = useCallback(() => fileInputRef.current?.click(), [])

  const onCanvasContextMenu = useCallback((e) => {
    e.preventDefault()
    if (!ready) return
    const icon = (d, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
    const hasSelection = selection.length > 0
    const items = []
    if (hasSelection) {
      items.push(
        { key: 'copy', label: `复制 ${selection.length} 项`, hint: '⌘C' },
        { key: 'dup', label: '原位复制', hint: '⌘D' },
      )
      if (selection.length === 1) items.push({ key: 'zorder', label: '层级', children: [{ key: 'top', label: '置于顶层' }, { key: 'bottom', label: '置于底层' }] })
      items.push({ sep: true }, { key: 'del', label: '删除', hint: 'Del', danger: true }, { sep: true })
    }
    // 工具（分组挂子菜单；当前工具打勾）
    items.push({ key: 'tools', label: '工具', icon: icon(MENU_ICONS.select), children: [
      { key: 'select', label: '选择', hint: 'V', icon: icon(MENU_ICONS.select) },
      { key: 'pen', label: '钢笔', hint: 'P', icon: icon(MENU_ICONS.pen) },
      { key: 'highlighter', label: '荧光笔', hint: 'H', icon: icon(MENU_ICONS.highlighter) },
      { key: 'eraser', label: '橡皮', hint: 'E', icon: icon(MENU_ICONS.eraser) },
    ] })
    items.push({ key: 'shapes', label: '图形', icon: icon(MENU_ICONS.rect), children: [
      { key: 'rect', label: '矩形', hint: 'R', icon: icon(MENU_ICONS.rect) },
      { key: 'ellipse', label: '椭圆', hint: 'O', icon: icon(MENU_ICONS.ellipse) },
      { key: 'line', label: '直线', hint: 'L', icon: icon(MENU_ICONS.line) },
      { key: 'arrow', label: '箭头', hint: 'A', icon: icon(MENU_ICONS.arrow) },
    ] })
    items.push(
      { key: 'text', label: '文字', hint: 'T', icon: icon(MENU_ICONS.text) },
      { key: 'insert', label: '插入', hint: 'I', icon: icon(MENU_ICONS.image), children: [
        { key: 'pickImage', label: '图片…（⌘V 可直接粘贴到鼠标处）', icon: icon(MENU_ICONS.image) },
      ] },
      { key: 'colorMenu', label: '颜色', icon: `<span class="db-menu-color-dot" style="background:${settingsRef.current.color || theme.ink}"></span>`, children: [
        { key: 'palette', label: '选择墨色', widget: () => <MenuColorPicker palette={theme.palette} current={settingsRef.current.color || theme.ink} onPick={(c) => setSettings((s) => ({ ...s, color: c === theme.ink ? null : c }))} /> },
        { key: 'paletteAuto', label: '跟随主题墨色', hint: '自动', onClick: () => setSettings((s) => ({ ...s, color: null })) },
      ] },
      { key: 'brushMenu', label: '画笔', icon: icon(MENU_ICONS.pen), children: [
        { key: 'penWidth', label: '钢笔粗细', widget: () => <MenuSlider label="钢笔粗细" value={settingsRef.current.strokeWidth} min={0.5} max={12} step={0.5} onChange={(v) => setSettings((s) => ({ ...s, strokeWidth: v }))} format={(v) => `${v}px`} /> },
        { key: 'hlWidth', label: '荧光笔粗细', widget: () => <MenuSlider label="荧光笔粗细" value={settingsRef.current.highlightWidth} min={8} max={36} step={2} onChange={(v) => setSettings((s) => ({ ...s, highlightWidth: v }))} format={(v) => `${v}px`} /> },
        { key: 'eraserWidth', label: '橡皮大小', widget: () => <MenuSlider label="橡皮大小" value={settingsRef.current.eraserSize} min={8} max={64} step={2} onChange={(v) => setSettings((s) => ({ ...s, eraserSize: v }))} format={(v) => `${v}px`} /> },
      ] },
      { sep: true },
      { key: 'canvas', label: '画布', icon: icon(MENU_ICONS.image), children: [
        { key: 'copyPng', label: '复制画布 PNG' },
        { key: 'exportPng', label: '导出 PNG（白底）' },
        { key: 'exportPngT', label: '导出 PNG（透明底）' },
        { key: 'exportJpg', label: '导出 JPG' },
      ] },
      { sep: true },
      { key: 'clear', label: '清空画布', danger: true },
    )
    // 当前工具打勾
    const markActive = (list) => { for (const it of list) { if (it.children) markActive(it.children); else if (TOOLS_FOR_MENU.some((t) => !t.sep && t[0] === it.key && toolRef.current === t[0])) it.label = `✓ ${it.label}` } }
    markActive(items)

    openCascadeMenu(e.clientX, e.clientY, items, (key) => {
      if (key === 'copy') copySelection()
      else if (key === 'dup') duplicateSelection()
      else if (key === 'del') deleteSelection()
      else if (key === 'top') zOrder('top')
      else if (key === 'bottom') zOrder('bottom')
      else if (key === 'pickImage') pickImage()
      else if (key === 'copyPng') void copyPng()
      else if (key === 'exportPng') void exportImage('png')
      else if (key === 'exportPngT') void exportImage('pngT')
      else if (key === 'exportJpg') void exportImage('jpg')
      else if (key === 'clear') clearDraft()
      else if (TOOLS_FOR_MENU.some((entry) => !entry.sep && entry[0] === key)) setTool(key)
    })
  }, [ready, selection, tool, copySelection, duplicateSelection, deleteSelection, zOrder, pickImage, clearDraft])

  /* ---------- 复制/导出 ---------- */

  const copyPng = useCallback(async () => {
    if (!objectsRef.current.length) { kitRef.current?.toast('画布是空的', 'error'); return }
    setBusy(true)
    try {
      const composed = composeExport(objectsRef.current, { images: imagesRef.current, roughness: settingsRef.current.roughness, transparent: false, paper: theme.paper })
      if (!composed) return
      const dataUrl = composed.canvas.toDataURL('image/png')
      const api = window.enest
      if (api?.clipboard?.writeImage) {
        const ok = await api.clipboard.writeImage(dataUrl)
        kitRef.current?.toast(ok ? '画布已复制为 PNG' : '复制失败：未授权剪贴板图片写入', ok ? 'info' : 'error')
      } else {
        kitRef.current?.toast('当前宿主不支持写剪贴板图片', 'error')
      }
    } finally { setBusy(false) }
  }, [theme])

  const exportImage = useCallback(async (format = 'png') => {
    if (!objectsRef.current.length) { kitRef.current?.toast('画布是空的', 'error'); return }
    setBusy(true)
    try {
      const transparent = format === 'pngT'
      const composed = composeExport(objectsRef.current, { images: imagesRef.current, roughness: settingsRef.current.roughness, transparent, paper: theme.paper })
      if (!composed) return
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      if (format === 'jpg') {
        const jpgCanvas = document.createElement('canvas')
        jpgCanvas.width = composed.canvas.width; jpgCanvas.height = composed.canvas.height
        const jctx = jpgCanvas.getContext('2d')
        jctx.fillStyle = theme.paper
        jctx.fillRect(0, 0, jpgCanvas.width, jpgCanvas.height)
        jctx.drawImage(composed.canvas, 0, 0)
        await kitRef.current?.saveFile(`drawboard-${stamp}.jpg`, jpgCanvas.toDataURL('image/jpeg', 0.92))
      } else {
        await kitRef.current?.saveFile(`drawboard-${stamp}.png`, composed.canvas.toDataURL('image/png'))
      }
      kitRef.current?.toast('已导出')
    } catch (error) {
      kitRef.current?.toast(error?.message || '导出失败', 'error')
    } finally { setBusy(false) }
  }, [theme])

  /* ---------- 文字编辑 ---------- */

  const startTextEdit = useCallback((existing, world) => {
    if (existing) {
      setEditing({ existing: JSON.parse(JSON.stringify(existing)), world: { x: existing.x, y: existing.y } })
    } else {
      setEditing({ world, draftText: '', size: Math.max(settingsRef.current.strokeWidth * 9, 20) })
    }
  }, [])

  const commitTextEdit = useCallback((value) => {
    const session = editing
    setEditing(null)
    if (!session) return
    const text = value.trim() === '' ? '' : value
    if (session.existing) {
      if (!text) {
        commitObjects((objects) => {
          const idx = objects.findIndex((o) => o.id === session.existing.id)
          if (idx >= 0) objects.splice(idx, 1)
        })
      } else {
        commitObjects((objects) => {
          const obj = objects.find((o) => o.id === session.existing.id)
          if (obj) obj.text = text
        })
      }
      syncDraftDoc()
    } else if (text) {
      const obj = makeText(session.world.x, session.world.y, { color: settingsRef.current.color || theme.ink, size: session.size || 24, text })
      addObject(obj)
    }
  }, [editing, commitObjects, syncDraftDoc, addObject, theme])

  /* ---------- 草稿管理 ---------- */

  const switchDraft = useCallback((id) => {
    const target = drafts.find((d) => d.id === id)
    if (!target || id === activeId) return
    // 当前草稿回写
    const withCurrent = drafts.map((d) => (d.id === activeId ? { ...d, objects: JSON.parse(JSON.stringify(objectsRef.current)), viewport: vpRef.current } : d))
    const next = withCurrent.map((d) => ({ ...d }))
    setDrafts(next)
    persistRef.current?.saveData({ version: 1, activeId: id, drafts: next })
    objectsRef.current = JSON.parse(JSON.stringify(target.objects || []))
    undoRef.current = []; redoRef.current = []; setUndoTick((n) => n + 1)
    setSelection([])
    setActiveId(id)
    setVp(target.viewport || vpRef.current)
    notifyObjects()
  }, [drafts, activeId, notifyObjects])

  const createDraft = useCallback(() => {
    const draft = makeDraft(`草稿 ${drafts.length + 1}`)
    const next = [...drafts.map((d) => (d.id === activeId ? { ...d, objects: JSON.parse(JSON.stringify(objectsRef.current)), viewport: vpRef.current } : d)), draft]
    setDrafts(next)
    persistRef.current?.saveData({ version: 1, activeId: draft.id, drafts: next })
    objectsRef.current = []
    setActiveId(draft.id)
    undoRef.current = []; redoRef.current = []; setUndoTick((n) => n + 1)
    setSelection([]); notifyObjects()
  }, [drafts, activeId, notifyObjects])

  const duplicateDraft = useCallback((id) => {
    const src = drafts.find((d) => d.id === id)
    if (!src) return
    const copy = { ...JSON.parse(JSON.stringify(src)), id: `d${Date.now().toString(36)}`, name: `${src.name} 副本`, createdAt: Date.now(), updatedAt: Date.now() }
    const next = [...drafts, copy]
    setDrafts(next)
    persistRef.current?.saveData({ version: 1, activeId, drafts: next })
  }, [drafts, activeId])

  const renameDraft = useCallback((id, name) => {
    setDrafts((prev) => {
      const next = prev.map((d) => (d.id === id ? { ...d, name } : d))
      persistRef.current?.saveData({ version: 1, activeId, drafts: next })
      return next
    })
  }, [activeId])

  const deleteDraft = useCallback((id) => {
    if (drafts.length <= 1) { kitRef.current?.toast('至少保留一个草稿', 'error'); return }
    setDrafts((prev) => {
      const next = prev.filter((d) => d.id !== id)
      const nextActive = id === activeId ? next[0].id : activeId
      if (id === activeId) {
        setActiveId(nextActive)
        objectsRef.current = JSON.parse(JSON.stringify(next[0].objects || []))
        setSelection([]); notifyObjects()
      }
      persistRef.current?.saveData({ version: 1, activeId: nextActive, drafts: next })
      return next
    })
  }, [drafts, activeId, notifyObjects])

  /* ---------- 初始化 ---------- */

  useEffect(() => {
    let disposed = false
    const kit = PluginKit.create({ title: '画板', quickPlaceholder: '打开画板开始涂画' })
    kitRef.current = kit
    const persist = createPersistence(kit)
    persistRef.current = persist

    void (async () => {
      const [loadedSettings, data] = await Promise.all([persist.loadSettings(), persist.loadData()])
      if (disposed) return
      setSettings(loadedSettings)
      let nextDrafts
      let nextActive
      if (data) {
        nextDrafts = data.drafts
        nextActive = data.drafts.some((d) => d.id === data.activeId) ? data.activeId : data.drafts[0].id
      } else {
        const draft = makeDraft('草稿 1')
        nextDrafts = [draft]
        nextActive = draft.id
      }
      const active = nextDrafts.find((d) => d.id === nextActive)
      objectsRef.current = JSON.parse(JSON.stringify(active?.objects || []))
      setDrafts(nextDrafts)
      setActiveId(nextActive)
      // 恢复贴图位图
      const blobIds = [...new Set(objectsRef.current.filter((o) => o.kind === 'image' && o.blobId).map((o) => o.blobId))]
      const map = new Map()
      await Promise.all(blobIds.map(async (bid) => {
        const dataUrl = await getImageBlob(kit, bid)
        if (!dataUrl) return
        const img = await new Promise((resolve) => { const el = new Image(); el.onload = () => resolve(el); el.src = dataUrl })
        map.set(bid, img)
      }))
      // 内联 dataUrl 的贴图（无 blobs 退化）
      for (const o of objectsRef.current) {
        if (o.kind === 'image' && o.dataUrl && !map.get(o.blobId)) {
          const img = await new Promise((resolve) => { const el = new Image(); el.onload = () => resolve(el); el.src = o.dataUrl })
          map.set(o.blobId || `inline:${o.id}`, img)
        }
      }
      if (disposed) return
      setImages(map)
      setVp(active?.viewport || makeViewport())
      setReady(true)
      notifyObjects()
    })()

    const flushOnHide = () => { void persist.flush().catch(error => kit.toast(`保存失败：${error.message}`, 'error')) }
    const offBeforeClose = kit.api?.onBeforeClose?.(() => persist.flush())
    const offBeforeSuspend = kit.api?.onBeforeSuspend?.(() => persist.flush())
    const offSaveRequested = kit.api?.onSaveRequested?.(() => persist.flush())
    window.addEventListener('beforeunload', flushOnHide)
    return () => {
      disposed = true
      flushOnHide()
      window.removeEventListener('beforeunload', flushOnHide)
      offBeforeClose?.()
      offBeforeSuspend?.()
      offSaveRequested?.()
      kit.destroy()
    }
  }, [notifyObjects])

  /* ---------- 设置持久化 ---------- */

  useEffect(() => {
    if (!ready) return
    persistRef.current?.saveSettings(settings)
  }, [settings, ready])

  /* ---------- 贴图文件选择 ---------- */

  useEffect(() => {
    const input = fileInputRef.current
    if (!input || binderRef.current) return
    binderRef.current = bindFileInput(input, { onError: (e) => kitRef.current?.toast(e.message, 'error') })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file || !file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = () => void importImageDataUrl(String(reader.result))
      reader.readAsDataURL(file)
      input.value = ''
    })
  }, [importImageDataUrl])

  /* ---------- 缩放按钮（状态栏） ---------- */

  const zoomBy = (factor) => setVp((prev) => ({ ...prev, zoom: Math.min(4, Math.max(0.2, prev.zoom * factor)) }))
  const focusContent = () => {
    const bbox = contentBBox(objectsRef.current, 24)
    if (bbox) setVp((prev) => fitToContent(prev, bbox, window.innerWidth, window.innerHeight - 90))
  }

  /* ---------- 演示内容（市场截图场景注入，日常不触发） ---------- */

  useEffect(() => {
    if (!ready) return
    window.__drawboardDemo = () => {
      const ink = (pts, color, size, highlighter = false) => objectsRef.current.push({ id: uid(), kind: 'ink', points: pts, color, size, highlighter })
      // 手写标题墨迹（模拟「画板」二字笔势的简化点列）
      const wave = (x0, y0, w, amp, n, color, size) => {
        const pts = []
        for (let i = 0; i <= n; i++) {
          const t = i / n
          pts.push({ x: x0 + w * t, y: y0 + Math.sin(t * Math.PI * 2.2) * amp, p: 0.5 + Math.sin(t * Math.PI) * 0.4 })
        }
        ink(pts, color, size)
      }
      wave(-260, -150, 200, 26, 34, '#1e1e1e', 5)
      wave(-40, -160, 180, 20, 30, '#1d5c8a', 5)
      // 荧光笔强调
      wave(-270, -60, 460, 6, 40, theme.highlighter, 18, true)
      // rough 图形
      objectsRef.current.push({ id: uid(), kind: 'shape', type: 'rect', x: -280, y: 10, w: 230, h: 130, color: '#a61e1e', stroke: 2.5, seed: 42, fill: 'none' })
      objectsRef.current.push({ id: uid(), kind: 'shape', type: 'ellipse', x: 0, y: 10, w: 200, h: 130, color: '#2f9e44', stroke: 2.5, seed: 77, fill: 'none' })
      objectsRef.current.push({ id: uid(), kind: 'shape', type: 'arrow', x: 240, y: 130, x2: 380, y2: 30, color: '#1971c2', stroke: 3, seed: 99, fill: 'none' })
      // 手写体文字
      objectsRef.current.push({ id: uid(), kind: 'text', x: -265, y: 40, text: '随手记灵感', size: 26, color: '#a61e1e' })
      objectsRef.current.push({ id: uid(), kind: 'text', x: 20, y: 46, text: '涂画 · 圈重点', size: 24, color: '#2f9e44' })
      objectsRef.current.push({ id: uid(), kind: 'text', x: 240, y: 150, text: '从这里开始', size: 20, color: '#1971c2' })
      objectsRef.current.push({ id: uid(), kind: 'text', x: -270, y: 210, text: '滚轮缩放 · 空格平移 · 右键换工具', size: 18, color: theme.ink })
      notifyObjects()
      syncDraftDoc()
      // 视口对准内容：初始视口原点在屏幕左上角，把内容平移到画面中央
      const el = document.querySelector('.db-stage')
      if (el) {
        const r = el.getBoundingClientRect()
        setVp((prev) => ({ ...prev, x: r.width / 2 - 40, y: r.height / 2 - 30 }))
      }
    }
    return () => { delete window.__drawboardDemo }
  }, [ready, theme, notifyObjects, syncDraftDoc])

  if (!ready) {
    return <div className="db-app db-loading">画板准备中…</div>
  }

  return (
    <TooltipProvider>
      <div className="db-app" data-paper-theme={theme.id}>
        <Toolbar
          theme={theme}
          settings={settings}
          onOpenColorPicker={(ev) => {
            const r = ev.currentTarget.getBoundingClientRect()
            openCascadeMenu(r.left, r.bottom + 6, [
              { key: 'palette', label: '选择墨色', widget: () => <MenuColorPicker palette={theme.palette} current={settingsRef.current.color || theme.ink} onPick={(c) => setSettings((s) => ({ ...s, color: c === theme.ink ? null : c }))} /> },
              { key: 'paletteAuto', label: '跟随主题墨色', hint: '自动' },
            ], (key) => { if (key === 'paletteAuto') setSettings((s) => ({ ...s, color: null })) })
          }}
          canUndo={undoRef.current.length > 0} canRedo={redoRef.current.length > 0}
          onUndo={undo} onRedo={redo}
        />
        <DraftTabs
          drafts={drafts}
          activeId={activeId}
          onSelect={switchDraft}
          onCreate={createDraft}
          onRename={renameDraft}
          onDelete={deleteDraft}
        />
        <div className="db-body">
          <DraftPanel
            open={draftsOpen}
            drafts={drafts}
            activeId={activeId}
            onSelect={switchDraft}
            onCreate={createDraft}
            onRename={renameDraft}
            onDuplicate={duplicateDraft}
            onDelete={deleteDraft}
            onClose={() => setDraftsOpen(false)}
          />
          <div className="db-stage-wrap">
            <CanvasStage
              objectsRef={objectsRef}
              objectsTick={objectsTick}
              images={images}
              vp={vp} setVp={setVp}
              tool={tool} settings={settings} theme={theme}
              selection={selection} setSelection={setSelection}
              onCommitObjects={commitObjects}
              onAddObject={addObject}
              onTextEdit={startTextEdit}
              onContextMenu={onCanvasContextMenu}
              spaceDown={spaceDown}
            />
            {editing && (
              <TextEditOverlay
                editing={editing}
                vp={vp}
                color={settings.color}
                theme={theme}
                onCommit={commitTextEdit}
                onCancel={() => setEditing(null)}
              />
            )}
            <SettingsFab onClick={() => setSettingsOpen(true)} />
          </div>
        </div>
        <div className="db-status">
          <span>{objectsRef.current.filter((o) => o.kind !== 'erase').length} 项 · 已选 {selection.length}</span>
          <span className="db-status-zoom">
            <button type="button" className="db-zoom-btn" aria-label="缩小" onClick={() => zoomBy(1 / ZOOM_STEP)}>−</button>
            <span className="db-zoom-value">{Math.round(vp.zoom * 100)}%</span>
            <button type="button" className="db-zoom-btn" aria-label="放大" onClick={() => zoomBy(ZOOM_STEP)}>+</button>
            <button type="button" className="db-zoom-btn db-fit" aria-label="适配内容" title="适配全部内容" onClick={focusContent}>⤢</button>
          </span>
        </div>
        <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={settings} setSettings={setSettings} />
        <span data-undo-tick={undoTick} hidden />
      </div>
    </TooltipProvider>
  )
}
