/**
 * 屏幕助手主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 纯几何/编辑历史复用 editor-core.js（未改动）；canvas 绘制与标注管线逐行等价；
 * screen / record / pin / storage blobs API 调用全部复用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { bindFileInput } from '@enest/plugin-kit/file-inputs'
import { selection, EditHistory, elapsed } from '../js/editor-core.js'

const TOOL_HINTS = {
  arrow: '在图片上拖动，添加箭头。',
  rect: '拖动框选需要标出的区域。',
  text: '输入文字后，点击图片放置。',
  mosaic: '拖动框选打码区域；导出前请确认敏感信息已遮挡。',
  crop: '拖动选择保留区域，松开完成裁剪。',
}
const TABS = [
  ['capture', '截图标注'],
  ['record', '录屏'],
  ['pin', '贴图管理'],
  ['history', '原图历史'],
]
const TOOLS = [
  ['arrow', '箭头', '箭头（A）'],
  ['rect', '矩形', '矩形（R）'],
  ['text', '文字', '文字（T）'],
  ['mosaic', '马赛克', '马赛克（M）'],
  ['crop', '裁剪', '裁剪（C）'],
]

export function App() {
  const api = window.enest || window.zapi
  const kitRef = useRef(null)
  const edits = useRef(new EditHistory(40))
  const imageCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)

  const [history, setHistory] = useState([])
  const [recordings, setRecordings] = useState([])
  const [drafts, setDrafts] = useState({})
  const [pinNames, setPinNames] = useState({})
  const [activeId, setActiveId] = useState('')
  const [legacyActive, setLegacyActive] = useState(false)
  const [tab, setTab] = useState('capture')
  const [tool, setTool] = useState('arrow')
  const [query, setQuery] = useState('')
  const [statusText, setStatusText] = useState('准备就绪')
  const [imageMeta, setImageMeta] = useState('尚无截图')
  const [hasOriginal, setHasOriginal] = useState(false)
  const [editingOpen, setEditingOpen] = useState(false)
  const [editSteps, setEditSteps] = useState(0)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [historyCount, setHistoryCount] = useState(0)
  const [historySelected, setHistorySelected] = useState(0)
  const [recording, setRecording] = useState(false)
  const [recTimer, setRecTimer] = useState(null)
  const [recLabel, setRecLabel] = useState('尚未开始录制')
  const [recInfo, setRecInfo] = useState('选择区域后开始，停止时自动保存录制文件。')
  const [recAudio, setRecAudio] = useState(false)
  const [recBusy, setRecBusy] = useState(false)
  const [pins, setPins] = useState(null) // null = 未加载
  const [pinsLoaded, setPinsLoaded] = useState(false)
  const [closePinsArmed, setClosePinsArmed] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
  const [recentVersion, setRecentVersion] = useState(0)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [initialized, setInitialized] = useState(false)

  const stateRef = useRef({})
  stateRef.current = { history, recordings, drafts, pinNames, activeId, tab, tool, query, busy, editingOpen, legacyActive }
  const original = useRef(null)
  const drawStart = useRef(null)
  const pointerId = useRef(null)
  const recSession = useRef(null)
  const recStartedAt = useRef(0)
  const recTimerId = useRef(null)
  const recBusyRef = useRef(false)
  const busyRef = useRef(false)
  const hidden = useRef(false)
  const closePinsArmedRef = useRef(false)
  const clearArmedRef = useRef(false)
  const saveQueue = useRef(Promise.resolve())
  const imageRevision = useRef(0)
  const initializedRef = useRef(false)
  const pendingCode = useRef(null)
  const historySelectedRef = useRef(0)
  const queryRef = useRef('')
  const colorRef = useRef(null)
  const widthRef = useRef(null)
  const textRef = useRef(null)
  const textSizeRef = useRef(null)
  const recordAudioRef = useRef(null)

  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const stamp = () => new Date().toLocaleString('sv-SE').replaceAll(':', '-')
  const maxHistory = () => Math.max(8, Math.min(80, Number(kitRef.current?.settings.historyLimit) || 24))
  const currentItem = () => stateRef.current.history.find((item) => item.id === stateRef.current.activeId)
  const fail = (error) => {
    const text = String(error?.message || error)
    setStatusText(text)
    kitRef.current?.toast(text, 'error')
  }
  const run = (fn) => Promise.resolve().then(fn).catch(fail)
  const work = async (fn) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      return await fn()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function persist(current) {
    const s = current ?? stateRef.current
    const snapshot = structuredClone({ history: s.history, recordings: s.recordings, drafts: s.drafts, activeId: s.activeId, pinNames: s.pinNames })
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => kitRef.current.save('screen_workspace_v2', snapshot))
    saveQueue.current.catch(fail)
    return saveQueue.current
  }
  function saveDraft() {
    const id = stateRef.current.activeId
    if (!id) return
    setDrafts((prevDrafts) => {
      const next = { ...prevDrafts }
      if (edits.current.operations.length) next[id] = { operations: edits.current.operations, cursor: edits.current.cursor }
      else delete next[id]
      stateRef.current.drafts = next
      void persist({ ...stateRef.current, drafts: next })
      return next
    })
  }
  function syncControls() {
    setCanUndo(edits.current.canUndo && !busyRef.current)
    setCanRedo(edits.current.canRedo && !busyRef.current)
    setEditSteps(edits.current.cursor)
  }

  // —— canvas 绘制管线（等价原 arrow / applyOperation / renderCanvas） ——
  function arrow(ctx, op) {
    const { start, end } = op
    const angle = Math.atan2(end.y - start.y, end.x - start.x)
    const length = Math.max(14, op.lineWidth * 4)
    ctx.strokeStyle = op.color
    ctx.fillStyle = op.color
    ctx.lineWidth = op.lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(end.x, end.y)
    ctx.lineTo(end.x - length * Math.cos(angle - Math.PI / 6), end.y - length * Math.sin(angle - Math.PI / 6))
    ctx.lineTo(end.x - length * Math.cos(angle + Math.PI / 6), end.y - length * Math.sin(angle + Math.PI / 6))
    ctx.closePath(); ctx.fill()
  }
  function applyOperation(canvas, op) {
    const ctx = canvas.getContext('2d')
    if (op.type === 'crop') {
      const box = selection({ x: op.x, y: op.y }, { x: op.x + op.width, y: op.y + op.height }, canvas.width, canvas.height)
      if (!box.width || !box.height) return
      const pixels = ctx.getImageData(box.x, box.y, box.width, box.height)
      canvas.width = box.width
      canvas.height = box.height
      canvas.getContext('2d').putImageData(pixels, 0, 0)
    } else if (op.type === 'arrow') arrow(ctx, op)
    else if (op.type === 'rect') {
      ctx.strokeStyle = op.color
      ctx.lineWidth = op.lineWidth || 6
      ctx.strokeRect(op.x, op.y, op.width, op.height)
    } else if (op.type === 'text') {
      ctx.fillStyle = op.color
      ctx.font = `600 ${op.size}px -apple-system, "Segoe UI", sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(op.text, op.x, op.y)
    } else if (op.type === 'mosaic') {
      const box = selection({ x: op.x, y: op.y }, { x: op.x + op.width, y: op.y + op.height }, canvas.width, canvas.height)
      if (!box.width || !box.height) return
      const small = document.createElement('canvas')
      const block = 18
      small.width = Math.max(1, Math.ceil(box.width / block))
      small.height = Math.max(1, Math.ceil(box.height / block))
      small.getContext('2d').drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, small.width, small.height)
      ctx.save()
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(small, 0, 0, small.width, small.height, box.x, box.y, box.width, box.height)
      ctx.restore()
    }
  }
  const renderCanvas = useCallback(() => {
    if (!original.current) return
    const canvas = imageCanvasRef.current
    canvas.width = original.current.naturalWidth
    canvas.height = original.current.naturalHeight
    canvas.getContext('2d').drawImage(original.current, 0, 0)
    for (const operation of edits.current.current()) applyOperation(canvas, operation)
    const overlay = overlayCanvasRef.current
    overlay.width = canvas.width
    overlay.height = canvas.height
    setImageMeta(`${canvas.width} × ${canvas.height}${stateRef.current.legacyActive ? ' · 旧版缩略图' : ''}`)
    syncControls()
  }, [])
  const commit = (operation) => {
    if (!edits.current.push(operation)) {
      kitRef.current?.toast('当前图片已达到 40 步编辑，请先保存标注版本后继续', 'warn')
      return
    }
    renderCanvas()
    saveDraft()
  }
  function point(event) {
    const canvas = overlayCanvasRef.current
    const bounds = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)),
    }
  }
  function paintPreview(end) {
    const canvas = overlayCanvasRef.current
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!drawStart.current) return
    const color = colorRef.current?.value || '#e45d50'
    const lineWidth = Number(widthRef.current?.value || 6)
    if (stateRef.current.tool === 'arrow') arrow(ctx, { start: drawStart.current, end, color, lineWidth })
    else {
      const box = selection(drawStart.current, end, canvas.width, canvas.height)
      ctx.strokeStyle = color
      ctx.lineWidth = lineWidth
      if (stateRef.current.tool === 'crop') ctx.setLineDash([8, 6])
      if (stateRef.current.tool === 'mosaic') {
        ctx.fillStyle = 'rgba(95,112,125,.5)'
        ctx.fillRect(box.x, box.y, box.width, box.height)
      }
      ctx.strokeRect(box.x, box.y, box.width, box.height)
      ctx.setLineDash([])
    }
  }
  const cancelDraw = () => {
    drawStart.current = null
    if (pointerId.current !== null && overlayCanvasRef.current?.hasPointerCapture(pointerId.current)) {
      overlayCanvasRef.current.releasePointerCapture(pointerId.current)
    }
    pointerId.current = null
    const canvas = overlayCanvasRef.current
    canvas?.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
    void api?.ui?.setInputContext?.('workbench')
  }
  const onOverlayPointerDown = (event) => {
    if (!original.current || busyRef.current || event.button !== 0) return
    const pos = point(event)
    if (stateRef.current.tool === 'text') {
      const text = textRef.current?.value.trim()
      if (!text) {
        textRef.current?.focus()
        kitRef.current?.toast('先输入要放置的文字', 'info')
        return
      }
      commit({ type: 'text', x: pos.x, y: pos.y, text, color: colorRef.current?.value || '#e45d50', size: Math.max(12, Math.min(160, Number(textSizeRef.current?.value) || 32)) })
      return
    }
    drawStart.current = pos
    pointerId.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    void api?.ui?.setInputContext?.('overlay')
  }
  const onOverlayPointerUp = (event) => {
    if (!drawStart.current) return
    const end = point(event)
    const start = drawStart.current
    const box = selection(start, end, imageCanvasRef.current.width, imageCanvasRef.current.height)
    cancelDraw()
    const color = colorRef.current?.value || '#e45d50'
    const lineWidth = Number(widthRef.current?.value || 6)
    if (stateRef.current.tool === 'arrow' && Math.hypot(start.x - end.x, start.y - end.y) > 3) {
      commit({ type: stateRef.current.tool, start, end, color, lineWidth })
    } else if (stateRef.current.tool !== 'arrow' && box.width >= 3 && box.height >= 3) {
      commit({ type: stateRef.current.tool, ...box, color, lineWidth })
    }
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        if (image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024) reject(new Error('图片需小于 6400 万像素'))
        else resolve(image)
      }
      image.onerror = () => reject(new Error('图片无法读取'))
      image.src = dataUrl
    })
  }
  function thumbnail(image) {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 240 / image.naturalWidth, 160 / image.naturalHeight)
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.7)
  }
  async function originalData(item) {
    if (item.legacy) return item.thumb
    if (!api?.storage?.blobs?.get) throw new Error('当前宿主不支持读取原图，请更新 eNest')
    const blob = await api.storage.blobs.get(item.blobId)
    if (!blob?.dataUrl) throw new Error('原图文件已不存在，可删除此记录')
    return blob.dataUrl
  }
  async function openHistory(item) {
    const revision = ++imageRevision.current
    const image = await loadImage(await originalData(item))
    if (revision !== imageRevision.current) return
    original.current = image
    setActiveId(item.id)
    setLegacyActive(!!item.legacy)
    stateRef.current.activeId = item.id
    stateRef.current.legacyActive = !!item.legacy
    edits.current.clear()
    const draft = stateRef.current.drafts[item.id]
    if (draft && Array.isArray(draft.operations)) {
      edits.current.operations = draft.operations.filter((op) => validOperation(op)).slice(0, edits.current.limit)
      edits.current.cursor = Math.max(0, Math.min(edits.current.operations.length, Number(draft.cursor) || 0))
    }
    setHasOriginal(true)
    renderCanvas()
    setTab('capture')
    setStatusText(item.legacy ? '这是旧版缩略图；新截图会保存完整原图' : `已打开 ${item.name}`)
    void persist()
  }
  function validOperation(op) {
    if (!op || !['crop', 'arrow', 'rect', 'text', 'mosaic'].includes(op.type)) return false
    if (op.type === 'text') return Number.isFinite(op.x) && Number.isFinite(op.y) && typeof op.text === 'string' && Number.isFinite(op.size) && op.size >= 12 && op.size <= 160 && /^#[\da-f]{6}$/i.test(op.color)
    if (op.type === 'arrow') return op.start && op.end && ['x', 'y'].every((key) => Number.isFinite(op.start[key]) && Number.isFinite(op.end[key])) && Number.isFinite(op.lineWidth) && /^#[\da-f]{6}$/i.test(op.color)
    return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(op[key])) && op.width > 0 && op.height > 0 && (op.type !== 'rect' || /^#[\da-f]{6}$/i.test(op.color))
  }
  function chooseTool(value) {
    setTool(value)
    stateRef.current.tool = value
    if (value === 'text') {
      setEditingOpen(true)
      stateRef.current.editingOpen = true
    }
    document.documentElement.dataset.editing = String(stateRef.current.editingOpen)
  }
  const toggleEditor = () => {
    const open = document.documentElement.dataset.editing !== 'true'
    document.documentElement.dataset.editing = String(open)
    setEditingOpen(open)
    stateRef.current.editingOpen = open
  }

  // —— 截图 / 记录 / 删除 ——
  async function rememberImage(dataUrl, name) {
    if (!api?.storage?.blobs?.put) throw new Error('保存原图需要新版 eNest，请更新宿主后再截图')
    const image = await loadImage(dataUrl)
    const blob = await api.storage.blobs.put({ dataUrl, name })
    const item = { id: uid(), blobId: blob.id, name, ts: Date.now(), width: image.naturalWidth, height: image.naturalHeight, bytes: blob.bytes, thumb: thumbnail(image) }
    const previous = stateRef.current.history
    const next = [item, ...previous].slice(0, maxHistory())
    setHistory(next)
    stateRef.current.history = next
    try {
      await persist({ ...stateRef.current, history: next })
    } catch (error) {
      setHistory(previous)
      stateRef.current.history = previous
      await api.storage.blobs.remove(blob.id).catch(() => {})
      throw error
    }
    const retained = new Set(next.map((entry) => entry.id))
    for (const removed of previous.filter((entry) => !retained.has(entry.id))) {
      setDrafts((prev) => {
        const n = { ...prev }
        delete n[removed.id]
        stateRef.current.drafts = n
        return n
      })
      if (removed.blobId) await api.storage.blobs.remove(removed.blobId).catch(() => {})
    }
    setHistoryVersion((v) => v + 1)
    await openHistory(item)
    return item
  }
  async function capture(kind, pinAfter = false) {
    await work(async () => {
      if (!api?.screen?.capture) throw new Error('截图需在 eNest 中使用')
      setStatusText(kind === 'region' ? '请选择截图区域…' : '正在截取屏幕…')
      const bounds = kind === 'region' ? await api.screen.selectRegion() : undefined
      if (kind === 'region' && !bounds) {
        setStatusText('已取消截图')
        return
      }
      const shot = await api.screen.capture({ bounds })
      await rememberImage(shot.dataUrl, `截图 ${stamp()}`)
      if (pinAfter || kitRef.current.settings.captureAction === 'pin') await pinImage(shot.dataUrl, currentItem()?.name)
      else if (kitRef.current.settings.captureAction === 'copy') {
        await api.clipboard.writeImage(shot.dataUrl)
        setStatusText('原图已保存并复制')
      } else setStatusText('原图已保存，可标注、复制或导出')
    })
  }
  async function pinImage(dataUrl, name = '贴图') {
    if (!api?.pin?.open) throw new Error('贴图需在 eNest 中使用')
    const result = await api.pin.open({ dataUrl, title: name, width: 420 })
    setPinNames((prev) => {
      const next = { ...prev, [result.pinId]: name }
      stateRef.current.pinNames = next
      void persist({ ...stateRef.current, pinNames: next })
      return next
    })
    setStatusText('已贴到屏幕')
    kitRef.current?.toast('已创建贴图', 'success')
    await refreshPins()
  }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      if (file.size > 32 * 1024 * 1024) return reject(new Error('图片需小于 32 MB'))
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('文件读取失败'))
      reader.readAsDataURL(file)
    })
  }
  async function removeItem(item) {
    const next = stateRef.current.history.filter((entry) => entry.id !== item.id)
    setHistory(next)
    stateRef.current.history = next
    setDrafts((prev) => {
      const n = { ...prev }
      delete n[item.id]
      stateRef.current.drafts = n
      return n
    })
    if (stateRef.current.activeId === item.id) {
      setActiveId('')
      stateRef.current.activeId = ''
      original.current = null
      edits.current.clear()
      setHasOriginal(false)
      setImageMeta('尚无截图')
      syncControls()
    }
    await persist()
    if (item.blobId) await api.storage.blobs.remove(item.blobId)
    setHistoryVersion((v) => v + 1)
  }
  const filtered = () => {
    const value = queryRef.current.toLowerCase().trim()
    return stateRef.current.history.filter((item) => !value || `${item.name} ${new Date(item.ts).toLocaleString()}`.toLowerCase().includes(value))
  }

  // —— 录屏 ——
  function renderRecordingState() {
    const active = !!recSession.current
    setRecording(active)
    setRecLabel(active ? '正在录制' : '尚未开始录制')
    document.body.classList.toggle('recording', active)
    clearInterval(recTimerId.current)
    recTimerId.current = null
    if (active && !hidden.current) {
      recTimerId.current = setInterval(() => setRecTimer(elapsed(Date.now() - recStartedAt.current)), 500)
    }
  }
  const showTab = (next) => {
    setTab(next)
    stateRef.current.tab = next
    if (next === 'pin') void run(refreshPins)
    if (next === 'record') renderRecordingState()
  }
  function onQueryBridge(value) {
    queryRef.current = value
    setQuery(value)
    historySelectedRef.current = 0
    setHistorySelected(0)
    if (value.trim()) showTab('history')
  }
  function onActionBridge(action) {
    const name = typeof action === 'string' ? action : action?.action
    if (name === 'clear') {
      queryRef.current = ''
      setQuery('')
      return
    }
    if (stateRef.current.tab !== 'history') {
      if (name === 'submit' && !original.current) void run(() => capture('region'))
      return
    }
    const entries = filtered()
    if (name === 'next' || name === 'previous') {
      const next = Math.max(0, Math.min(entries.length - 1, historySelectedRef.current + (name === 'next' ? 1 : -1)))
      historySelectedRef.current = next
      setHistorySelected(next)
    }
    if (name === 'submit' && entries[historySelectedRef.current]) void run(() => work(() => openHistory(entries[historySelectedRef.current])))
  }
  async function refreshPins() {
    if (!api?.pin?.list) {
      setPins(null)
      setPinsLoaded(true)
      return
    }
    const list = await api.pin.list()
    setPins(list)
    setPinsLoaded(true)
    const ids = new Set(list.map((pin) => pin.pinId))
    setPinNames((prev) => {
      const next = {}
      for (const id of Object.keys(prev)) if (ids.has(id)) next[id] = prev[id]
      stateRef.current.pinNames = next
      return next
    })
  }
  async function startRecording() {
    if (recBusyRef.current || recSession.current) return
    if (!api?.screen?.record) throw new Error('录屏需在 eNest 中使用')
    recBusyRef.current = true
    setRecBusy(true)
    renderRecordingState()
    try {
      const bounds = await api.screen.selectRegion()
      if (!bounds) {
        setStatusText('已取消录制')
        return
      }
      const result = await api.screen.record.start({ bounds, withAudio: recordAudioRef.current?.checked === true })
      recSession.current = result.sessionId
      recStartedAt.current = Date.now()
      setRecInfo(`录制区域 ${bounds.width} × ${bounds.height}`)
      setStatusText('正在录制，可切换窗口继续工作')
    } finally {
      recBusyRef.current = false
      setRecBusy(false)
      renderRecordingState()
    }
  }
  async function stopRecording() {
    if (!recSession.current || recBusyRef.current) return
    recBusyRef.current = true
    setRecBusy(true)
    renderRecordingState()
    const id = recSession.current
    try {
      const result = await api.screen.record.stop(id)
      recSession.current = null
      const next = [{ ...result, ts: Date.now() }, ...stateRef.current.recordings].slice(0, 30)
      setRecordings(next)
      stateRef.current.recordings = next
      await persist({ ...stateRef.current, recordings: next })
      setRecInfo(`已保存：${result.path}`)
      setStatusText('录制完成，文件已保存')
    } catch (error) {
      recSession.current = null
      setRecInfo('录制未能保存，请检查权限与磁盘空间。')
      throw error
    } finally {
      recBusyRef.current = false
      setRecBusy(false)
      renderRecordingState()
    }
  }
  async function cancelRecording() {
    if (!recSession.current || recBusyRef.current) return
    recBusyRef.current = true
    setRecBusy(true)
    renderRecordingState()
    try {
      await api.screen.record.cancel(recSession.current)
      recSession.current = null
      setRecInfo('已取消，本次录制不保存。')
      setStatusText('已取消录制')
    } finally {
      recBusyRef.current = false
      setRecBusy(false)
      renderRecordingState()
    }
  }

  // —— 快捷键（等价原 keydown capture 管线） ——
  useEffect(() => {
    const handler = (event) => {
      if (event.isComposing) return
      if (event.key === 'Escape' && drawStart.current) {
        event.preventDefault()
        event.stopPropagation()
        cancelDraw()
        return
      }
      if (event.target.matches('input,textarea,select') || !original.current || busyRef.current || stateRef.current.tab !== 'capture') return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) edits.current.redo()
        else edits.current.undo()
        renderCanvas()
        saveDraft()
        return
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && document.documentElement.dataset.editing === 'true') {
        const key = event.key.toLowerCase()
        const toolKeys = { a: 'arrow', r: 'rect', t: 'text', m: 'mosaic', c: 'crop' }
        if (toolKeys[key]) {
          event.preventDefault()
          chooseTool(toolKeys[key])
        }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderCanvas])

  // —— 文件输入绑定（bindFileInput 通道复用） ——
  useEffect(() => {
    bindFileInput(document.getElementById('image-file'), { api, onError: (error) => kitRef.current?.toast(error.message, 'error') })
    bindFileInput(document.getElementById('pin-file-input'), { api, onError: (error) => kitRef.current?.toast(error.message, 'error') })
  }, [api])

  // —— kit 初始化（hooks 规则：置于一切条件 return 之前） ——
  useEffect(() => {
    const kit = PluginKit.create({
      title: '屏幕助手',
      height: 480,
      quickPlaceholder: '查找截图名称或日期…',
      defaults: { historyLimit: 24, captureAction: 'preview', withAudio: false },
      onQuery: onQueryBridge,
      onAction: onActionBridge,
    })
    kitRef.current = kit
    kit.onMode(() => {
      cancelDraw()
      renderRecordingState()
    })
    kit.onSettings(() => {
      if (!recSession.current && recordAudioRef.current) recordAudioRef.current.checked = kit.settings.withAudio === true
    })
    api?.onOut?.(() => {
      hidden.current = true
      clearInterval(recTimerId.current)
      recTimerId.current = null
      cancelDraw()
    })
    api?.onEnter?.(({ code }) => {
      hidden.current = false
      renderRecordingState()
      if (!initializedRef.current) {
        pendingCode.current = code
        return
      }
      enterCode(code)
    })
    api?.onBeforeClose?.(() => {
      clearInterval(recTimerId.current)
      return saveQueue.current
    })
    api?.onDestroy?.(() => {
      clearInterval(recTimerId.current)
      original.current = null
      if (imageCanvasRef.current) imageCanvasRef.current.width = 1
      if (overlayCanvasRef.current) overlayCanvasRef.current.width = 1
    })

    function enterCode(code) {
      if (code === 'record') showTab('record')
      else if (code === 'pin') showTab('pin')
      else if (code === 'capture') void run(() => capture('region'))
    }

    void run(async () => {
      await kit.ready
      const state = await kit.load('screen_workspace_v2', null)
      const loadedDrafts = state && typeof state === 'object' && state.drafts && typeof state.drafts === 'object' ? state.drafts : {}
      const loadedPins = state && typeof state === 'object' && state.pinNames && typeof state.pinNames === 'object' ? state.pinNames : {}
      let loadedHistory = []
      let loadedRecordings = []
      let loadedActiveId = ''
      if (state && typeof state === 'object') {
        loadedHistory = Array.isArray(state.history)
          ? state.history.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.thumb === 'string' && (typeof item.blobId === 'string' || item.legacy === true)).slice(0, 80)
          : []
        loadedRecordings = Array.isArray(state.recordings)
          ? state.recordings.filter((item) => item && typeof item.path === 'string' && Number.isFinite(item.durationMs) && Number.isFinite(item.size)).slice(0, 30)
          : []
        loadedActiveId = String(state.activeId || '')
      } else {
        const legacy = await kit.load('sa_history_v1', [])
        loadedHistory = Array.isArray(legacy)
          ? legacy.filter((item) => item && typeof item.thumb === 'string').map((item) => ({ id: item.id || uid(), name: '旧版截图', thumb: item.thumb, ts: Number(item.ts) || Date.now(), width: Number(item.w) || 0, height: Number(item.h) || 0, legacy: true }))
          : []
      }
      setHistory(loadedHistory)
      setRecordings(loadedRecordings)
      setDrafts(loadedDrafts)
      setPinNames(loadedPins)
      setActiveId(loadedActiveId)
      Object.assign(stateRef.current, { history: loadedHistory, recordings: loadedRecordings, drafts: loadedDrafts, pinNames: loadedPins, activeId: loadedActiveId })
      if (recordAudioRef.current) recordAudioRef.current.checked = kit.settings.withAudio === true
      const item = loadedHistory.find((entry) => entry.id === loadedActiveId)
      if (item) {
        try {
          await work(() => openHistory(item))
        } catch (error) {
          fail(error)
        }
      }
      initializedRef.current = true
      setInitialized(true)
      if (pendingCode.current) {
        const code = pendingCode.current
        pendingCode.current = null
        enterCode(code)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // —— 派生视图 ——
  const historyEntries = (() => {
    const value = query.toLowerCase().trim()
    return history.filter((item) => !value || `${item.name} ${new Date(item.ts).toLocaleString()}`.toLowerCase().includes(value))
  })()
  const historySelectedClamped = Math.max(0, Math.min(historyEntries.length - 1, historySelected))
  useEffect(() => {
    setHistoryCount(history.length)
  }, [history.length])
  const editDisabled = !hasOriginal || busy
  const editStateText = editSteps ? `${editSteps} 步编辑 · 原图保留` : legacyActive ? '旧版压缩缩略图' : '原始图片'

  const clearHistory = () => {
    const btn = document.getElementById('clear-history')
    if (!clearArmedRef.current) {
      clearArmedRef.current = true
      setClearArmed(true)
      return
    }
    clearArmedRef.current = false
    setClearArmed(false)
    void run(() => work(async () => {
      const removed = [...stateRef.current.history]
      setHistory([])
      setDrafts({})
      setActiveId('')
      Object.assign(stateRef.current, { history: [], drafts: {}, activeId: '' })
      original.current = null
      edits.current.clear()
      setHasOriginal(false)
      setImageMeta('尚无截图')
      await persist()
      syncControls()
      for (const item of removed) if (item.blobId) await api.storage.blobs.remove(item.blobId)
      setStatusText('已清空截图历史')
    }))
  }
  const closeAllPins = () => {
    if (!closePinsArmedRef.current) {
      closePinsArmedRef.current = true
      setClosePinsArmed(true)
      return
    }
    closePinsArmedRef.current = false
    setClosePinsArmed(false)
    void run(async () => {
      await api.pin.closeAll()
      setPinNames({})
      stateRef.current.pinNames = {}
      await persist()
      await refreshPins()
    })
  }

  return (
    <main className="screen-app">
      <header className="app-head">
        <div><h1>屏幕助手</h1></div>
        <span id="status" role="status">{statusText}</span>
        <button id="capture" className="primary" disabled={busy} onClick={() => void run(() => capture('region'))}>矩形截图</button>
        <button id="capture-full" disabled={busy} onClick={() => void run(() => capture('full'))}>全屏</button>
        <button id="import-image" className="desktop-only" disabled={busy} onClick={() => document.getElementById('image-file').click()}>打开图片</button>
        <input
          id="image-file"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={() => void run(() => work(async () => {
            const file = document.getElementById('image-file').files[0]
            document.getElementById('image-file').value = ''
            if (file) await rememberImage(await readFile(file), file.name.replace(/\.[^.]+$/, ''))
          }))}
        />
      </header>
      <nav className="tabs" aria-label="工具">
        {TABS.map(([id, text]) => (
          <button
            key={id}
            data-tab={id}
            aria-pressed={tab === id}
            onClick={() => showTab(id)}
          >
            {text}
            {id === 'record' ? <span id="record-dot" hidden={!recording}></span> : ''}
            {id === 'history' ? <span id="history-count">{historyCount}</span> : ''}
          </button>
        ))}
      </nav>
      <section id="capture-panel" className="panel" aria-label="截图标注" hidden={tab !== 'capture'}>
        <div className="editor-layout">
          <div className="editor-main">
            <div className="result-toolbar">
              <span id="image-meta" title={imageMeta}>{imageMeta}</span>
              <button id="toggle-editor" onClick={toggleEditor}>{editingOpen ? '收起标注' : '标注'}</button>
              <button
                id="copy-image"
                disabled={editDisabled}
                onClick={() => void run(async () => {
                  await api.clipboard.writeImage(imageCanvasRef.current.toDataURL('image/png'))
                  setStatusText('已复制当前图片')
                  kitRef.current?.toast('已复制图片', 'success')
                })}
              >
                复制
              </button>
              <button
                id="pin-image"
                disabled={editDisabled}
                onClick={() => void run(() => pinImage(imageCanvasRef.current.toDataURL('image/png'), currentItem()?.name))}
              >
                贴图
              </button>
              <button
                id="export-image"
                disabled={editDisabled}
                onClick={() => void run(() => kitRef.current.saveFile(`${currentItem()?.name || '截图'}.png`, imageCanvasRef.current.toDataURL('image/png')))}
              >
                导出 PNG
              </button>
            </div>
            <div id="edit-toolbar" className="edit-toolbar" aria-label="标注工具">
              <div className="tool-group">
                {TOOLS.map(([id, text, title]) => (
                  <button
                    key={id}
                    data-tool={id}
                    title={title}
                    aria-pressed={tool === id}
                    disabled={!hasOriginal || busy}
                    onClick={() => chooseTool(id)}
                  >
                    {text}
                  </button>
                ))}
              </div>
              <label className="color-control">
                颜色
                <input id="annotation-color" ref={colorRef} type="color" defaultValue="#e45d50" aria-label="标注颜色" />
              </label>
              <label className="width-control">
                粗细
                <select id="annotation-width" ref={widthRef} aria-label="标注粗细" defaultValue="6">
                  <option value="3">细</option>
                  <option value="6">中</option>
                  <option value="10">粗</option>
                </select>
              </label>
              <button id="undo" disabled={!canUndo} title="撤销（⌘/Ctrl Z）" onClick={() => {
                edits.current.undo()
                renderCanvas()
                saveDraft()
              }}>撤销</button>
              <button id="redo" disabled={!canRedo} title="重做（⌘/Ctrl Shift Z）" onClick={() => {
                edits.current.redo()
                renderCanvas()
                saveDraft()
              }}>重做</button>
            </div>
            <div id="text-options" className="text-options" hidden={tool !== 'text' || !editingOpen}>
              <label htmlFor="annotation-text">文字内容</label>
              <input id="annotation-text" ref={textRef} maxLength={200} placeholder="输入后，点击图片放置" />
              <label htmlFor="text-size">字号</label>
              <input id="text-size" ref={textSizeRef} type="number" min={12} max={160} defaultValue={32} />
            </div>
            <p id="tool-hint" className="tool-hint">{TOOL_HINTS[tool]}</p>
            <div className="canvas-stage" id="canvas-stage">
              <div id="canvas-empty" className="empty-stage" hidden={hasOriginal}>
                <span className="stage-mark" aria-hidden="true"></span>
                <h2>留住这一刻的画面</h2>
                <p>框选屏幕或打开本地图片，随后裁剪、标注、复制。</p>
                <button id="empty-capture" className="primary" disabled={busy} onClick={() => void run(() => capture('region'))}>选择截图区域</button>
              </div>
              <div id="canvas-wrap" hidden={!hasOriginal}>
                <canvas id="image-canvas" ref={imageCanvasRef} aria-label="截图预览"></canvas>
                <canvas
                  id="overlay-canvas"
                  ref={overlayCanvasRef}
                  tabIndex={0}
                  aria-label="标注画布，使用上方工具，拖动以标注或裁剪"
                  onPointerDown={onOverlayPointerDown}
                  onPointerMove={(event) => {
                    if (drawStart.current) paintPreview(point(event))
                  }}
                  onPointerUp={onOverlayPointerUp}
                  onPointerCancel={cancelDraw}
                ></canvas>
              </div>
            </div>
            <div className="editor-foot">
              <span id="edit-state">{editStateText}</span>
              <button id="reset-edits" disabled={!canUndo} className="text-button" onClick={() => {
                edits.current.clear()
                renderCanvas()
                saveDraft()
              }}>恢复原图</button>
              <button
                id="save-edit"
                disabled={!canUndo}
                onClick={() => void run(() => work(async () => {
                  const name = `${currentItem()?.name || '截图'} 标注`
                  await rememberImage(imageCanvasRef.current.toDataURL('image/png'), name)
                  setStatusText('已保存独立的标注版本')
                }))}
              >
                另存标注版本
              </button>
            </div>
          </div>
          <aside className="recent-aside">
            <div className="section-head">
              <h2>最近原图</h2>
              <button id="all-history" className="text-button" onClick={() => showTab('history')}>全部</button>
            </div>
            <div id="recent-list">
              {history.slice(0, 5).map((item) => (
                <button key={item.id} className="recent-item" title={item.name} onClick={() => void run(() => work(() => openHistory(item)))}>
                  <img src={item.thumb} alt={item.name} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{`${item.width} × ${item.height}${item.legacy ? ' · 缩略图' : ''}`}</small>
                  </span>
                </button>
              ))}
              {!history.length ? <p className="empty">截图后可在这里找回原图。</p> : ''}
            </div>
            <p className="helper">原图保存在本机，标注版本单独保存。</p>
          </aside>
        </div>
      </section>
      <section id="record-panel" className="panel" hidden={tab !== 'record'} aria-label="录屏">
        <div className="record-layout">
          <div className="record-control">
            <span className="eyebrow" id="record-label">{recLabel}</span>
            <div id="record-timer">{recSession.current ? elapsed(Date.now() - recStartedAt.current) : '00:00'}</div>
            <p id="record-info">{recInfo}</p>
            <label className="check">
              <input id="record-audio" ref={recordAudioRef} type="checkbox" disabled={recording || recBusy} />
              录入系统声音
            </label>
            <div className="record-actions">
              <button id="record-start" className="primary" disabled={recording || recBusy} onClick={() => void run(startRecording)}>选区并录制</button>
              <button id="record-stop" disabled={!recording || recBusy} onClick={() => void run(stopRecording)}>停止并保存</button>
              <button id="record-cancel" disabled={!recording || recBusy} className="danger" onClick={() => void run(cancelRecording)}>取消录制</button>
            </div>
            <p className="helper">音频支持取决于系统与权限；无法获取时宿主可能录制无声视频。</p>
          </div>
          <div className="record-history">
            <div className="section-head"><h2>录制记录</h2></div>
            <div id="record-list">
              {recordings.length ? (
                recordings.map((recording2, i) => (
                  <article className="record-row" key={i}>
                    <strong>{`${new Date(recording2.ts).toLocaleString()} · ${elapsed(recording2.durationMs)} · ${(recording2.size / 1024 / 1024).toFixed(1)} MB`}</strong>
                    <p>{recording2.path}</p>
                    <button onClick={() => void run(() => kitRef.current.copy(recording2.path))}>复制文件路径</button>
                  </article>
                ))
              ) : (
                <p className="empty">录制完成后，文件路径与时长会保留在这里。</p>
              )}
            </div>
          </div>
        </div>
      </section>
      <section id="pin-panel" className="panel" hidden={tab !== 'pin'} aria-label="贴图管理">
        <div className="pin-entries">
          <button id="pin-capture" className="pin-entry" disabled={busy} onClick={() => void run(() => capture('region', true))}>
            <strong>截图并贴</strong>
            <span>框选区域，直接贴到屏幕</span>
          </button>
          <button
            id="pin-clipboard"
            className="pin-entry"
            onClick={() => void run(async () => {
              const image = await api?.clipboard?.readImage?.()
              if (!image?.dataUrl) throw new Error('剪贴板中没有图片')
              await pinImage(image.dataUrl, '剪贴板图片')
            })}
          >
            <strong>贴剪贴板图片</strong>
            <span>使用刚刚复制的图片</span>
          </button>
          <button id="pin-file" className="pin-entry" onClick={() => document.getElementById('pin-file-input').click()}>
            <strong>贴本地图片</strong>
            <span>选择 PNG、JPEG、WebP</span>
          </button>
          <input
            id="pin-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={() => void run(async () => {
              const file = document.getElementById('pin-file-input').files[0]
              document.getElementById('pin-file-input').value = ''
              if (file) {
                const data = await readFile(file)
                await loadImage(data)
                await pinImage(data, file.name)
              }
            })}
          />
        </div>
        <div className="section-head">
          <h2>当前贴图</h2>
          <span id="pin-count">{pinsLoaded && pins ? `${pins.length} 张` : ''}</span>
          <button id="refresh-pins" onClick={() => void run(refreshPins)}>刷新</button>
          <button id="close-pins" className="danger" disabled={!pins || !pins.length} onClick={closeAllPins}>{closePinsArmed ? '确认全部关闭' : '全部关闭'}</button>
        </div>
        <div id="pin-list">
          {!pinsLoaded || !pins ? (
            <p className="empty">请在 eNest 中查看当前贴图。</p>
          ) : pins.length ? (
            pins.map((pin, index) => (
              <div className="pin-row" key={String(pin.pinId)}>
                <strong>{pinNames[pin.pinId] || `贴图 ${index + 1}`}</strong>
                <small>{String(pin.pinId).slice(0, 8)}</small>
                <button onClick={() => void run(async () => {
                  await api.pin.close(pin.pinId)
                  setPinNames((prev) => {
                    const next = { ...prev }
                    delete next[pin.pinId]
                    stateRef.current.pinNames = next
                    return next
                  })
                  await persist()
                  await refreshPins()
                })}>关闭</button>
              </div>
            ))
          ) : (
            <p className="empty">暂无贴图。创建后可在这里关闭；拖动贴图窗口可调整位置。</p>
          )}
        </div>
      </section>
      <section id="history-panel" className="panel" hidden={tab !== 'history'} aria-label="原图历史">
        <div className="history-tools">
          <label htmlFor="history-search">查找截图</label>
          <input
            id="history-search"
            placeholder="名称或日期"
            value={query}
            onChange={(e) => {
              queryRef.current = e.target.value
              setQuery(e.target.value)
              historySelectedRef.current = 0
              setHistorySelected(0)
              kitRef.current?.setQuery(e.target.value)
            }}
          />
          <button id="clear-history" className="danger" disabled={!history.length} onClick={clearHistory}>{clearArmed ? '确认清空原图' : '清空历史'}</button>
        </div>
        <div id="history-list" className="history-grid">
          {historyEntries.length ? (
            historyEntries.map((item, index) => (
              <article key={item.id} className={`history-card${historySelectedClamped === index ? ' selected' : ''}`}>
                <button className="history-preview" title={`打开 ${item.name}`} onClick={() => void run(() => work(() => openHistory(item)))}>
                  <img src={item.thumb} alt={item.name} />
                </button>
                <div className="history-card-body">
                  <input
                    defaultValue={item.name}
                    maxLength={100}
                    aria-label="截图名称"
                    key={item.name}
                    onChange={(e) => {
                      item.name = e.target.value.trim() || '未命名截图'
                      e.target.value = item.name
                      setHistory((prev) => [...prev])
                      void persist()
                    }}
                  />
                  <p>{`${new Date(item.ts).toLocaleDateString()} · ${item.width}×${item.height} · ${item.legacy ? '旧版缩略图' : `${Math.round((item.bytes || 0) / 1024)} KB 原图`}`}</p>
                  <div className="history-card-actions">
                    <button onClick={() => void run(async () => {
                      await api.clipboard.writeImage(await originalData(item))
                      kitRef.current?.toast('已复制图片', 'success')
                    })}>复制</button>
                    <button onClick={() => void run(async () => pinImage(await originalData(item), item.name))}>贴图</button>
                    <button onClick={() => void run(async () => kitRef.current.saveFile(`${item.name}.png`, await originalData(item)))}>导出</button>
                    <button onClick={() => void run(() => work(() => removeItem(item)))}>删除</button>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <p className="empty">{query ? '没有匹配的截图。' : '暂无截图。新截图会保存完整原图。'}</p>
          )}
        </div>
      </section>
      <footer>
        <span id="footer-hint">标注草稿自动保留，另存版本不覆盖原图</span>
        <span className="kbd-hints">工具快捷键：A 箭头 · R 矩形 · T 文字 · M 马赛克 · C 裁剪</span>
        <button className="text-button" data-open-settings>截图与录屏设置</button>
      </footer>
    </main>
  )
}
