import { createDesktopTransport } from './desktopTransport.mjs'

export const DESKTOP_SETTING = 'desktopFloatingTools'
const POSITION_KEY = 'drawboard.desktop.position'
export const DESKTOP_TOOLS = [
  ['select', '选择'], ['pen', '钢笔'], ['highlighter', '荧光笔'], ['eraser', '橡皮'],
  ['rect', '矩形'], ['ellipse', '椭圆'], ['line', '直线'], ['arrow', '箭头'], ['text', '文字'], ['image', '贴图'],
]

export function createDesktopController(api, model) {
  const surfaces = new Map(), acknowledged = new Map()
  const readyWindows = new Set(), readyWaiters = new Map()
  let generation = 0, opening, canvasId, toolsId, revision = 0, drawing = false, disposed = false, syncing
  let tool = 'pen', documentSignature = '', syncTimer, closing = false, queue = Promise.resolve(), lastError = ''
  const sentImages = new Map()
  const waitReady = id => readyWindows.has(id) ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { readyWaiters.delete(id); reject(new Error('桌面画布界面启动超时')) }, 20_000)
    readyWaiters.set(id, { resolve: () => { clearTimeout(timer); resolve() }, reject: () => { clearTimeout(timer); reject(new Error('桌面画布启动已取消')) } })
  })
  const serial = task => { const next = queue.then(task); queue = next.catch(() => {}); return next }
  const status = error => { if (error) lastError = error.message; model.current.status({ open: Boolean(toolsId), drawing, error: lastError }) }
  const send = (id, value) => surfaces.get(id)?.post(value) ?? Promise.resolve()
  const toolsState = () => ({ type: 'tools', drawing, tool, settings: model.current.settings(), error: lastError })
  const fail = error => { status(error); void send(toolsId, { ...toolsState(), error: error.message }).catch(() => {}) }
  const snapshot = async force => {
    if (!canvasId || disposed) return
    const data = model.current.document()
    const signature = JSON.stringify([data.draftId, data.objects, data.settings])
    if (!force && signature === documentSignature) return
    const version = ++revision
    const images = Object.fromEntries(Object.entries(data.images || {}).filter(([key, source]) => force || sentImages.get(key) !== source))
    await send(canvasId, { type: 'snapshot', ...data, images, revision: version, tool, drawing, error: lastError })
    documentSignature = signature
    for (const [key, source] of Object.entries(images)) sentImages.set(key, source)
    for (const key of sentImages.keys()) if (!data.imageKeys.includes(key)) sentImages.delete(key)
    await send(toolsId, toolsState())
  }
  const sync = () => {
    clearTimeout(syncTimer)
    if (!canvasId || disposed) return
    syncTimer = setTimeout(() => {
      if (syncing) { sync(); return }
      syncing = serial(() => snapshot(false)).catch(fail).finally(() => { syncing = null })
    }, 120)
  }
  const setDrawing = async value => {
    if (!canvasId) return
    await api.auxiliary.send(canvasId, { type: 'desktop-mode', drawing: Boolean(value) },
      { interaction: value ? 'capture' : 'passthrough', ...(value ? { focus: true } : {}) })
    drawing = Boolean(value)
    await send(toolsId, toolsState())
    status()
  }
  const stop = async () => {
    generation++
    closing = true
    clearTimeout(syncTimer)
    const ids = [...surfaces.keys()]
    canvasId = toolsId = undefined
    for (const transport of surfaces.values()) transport.dispose()
    surfaces.clear(); drawing = false; documentSignature = ''; acknowledged.clear(); sentImages.clear()
    for (const waiter of readyWaiters.values()) waiter.reject()
    readyWaiters.clear(); readyWindows.clear()
    await Promise.all(ids.map(id => api.auxiliary.close(id).catch(() => {})))
    closing = false
    status()
  }
  const receive = async (id, data) => {
    if (!surfaces.has(id) || !data || typeof data !== 'object') return
    if (data.type === 'ready' || data.type === 'resync') {
      if (data.type === 'ready' && readyWindows.has(id)) { await send(id, { type: 'ready-ack' }); return }
      if (id === canvasId) await snapshot(true)
      else await send(id, toolsState())
      await send(id, { type: 'ready-ack' })
      readyWindows.add(id); readyWaiters.get(id)?.resolve(); readyWaiters.delete(id)
      return
    }
    if (data.type === 'operate') { await setDrawing(false); return }
    if (data.type === 'tool-current' && id === canvasId && DESKTOP_TOOLS.some(([key]) => key === data.tool)) {
      tool = data.tool; await send(toolsId, toolsState()); return
    }
    if (data.type === 'tool' && DESKTOP_TOOLS.some(([key]) => key === data.tool)) {
      tool = data.tool
      if (tool === 'image') {
        // Capture belongs to the toolbar gesture, not to a later file-dialog completion.
        await setDrawing(true)
        try {
          const imported = await model.current.importImage()
          tool = 'select'; await snapshot(false)
          await send(canvasId, { type: 'tool', tool })
          if (!imported) await setDrawing(false)
        } catch (error) { await setDrawing(false); throw error }
        return
      }
      await send(canvasId, { type: 'tool', tool })
      await setDrawing(true)
      return
    }
    if (data.type === 'settings') {
      const patch = {}
      if (typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color)) patch.color = data.color
      const sizes = { strokeWidth: [.5, 12], highlightWidth: [4, 40], eraserSize: [6, 80] }
      const key = Object.hasOwn(sizes, data.sizeKey) ? data.sizeKey : 'strokeWidth'
      if (Number.isFinite(data.width)) patch[key] = Math.max(sizes[key][0], Math.min(sizes[key][1], data.width))
      model.current.settingsChange(patch); await snapshot(false); return
    }
    if (data.type === 'undo' || data.type === 'redo' || data.type === 'clear') {
      model.current[data.type](); await model.current.flush(); lastError = ''; await snapshot(false); await send(toolsId, toolsState()); return
    }
    if (data.type === 'close') { await stop(); await api.settings.set(DESKTOP_SETTING, false); return }
    if (data.type === 'export') { await model.current.export(); return }
    if (data.type === 'patch' && id === canvasId) {
      if (typeof data.requestId !== 'string' || data.requestId.length > 80) return
      if (acknowledged.has(data.requestId)) { await send(id, acknowledged.get(data.requestId)); return }
      const current = model.current.document()
      if (data.revision !== revision || data.draftId !== current.draftId || documentSignature !== JSON.stringify([current.draftId, current.objects, current.settings])) {
        await snapshot(true); return
      }
      if (!Array.isArray(data.upsert) || !Array.isArray(data.remove) || !Array.isArray(data.order) || data.order.length > 10_000) throw new Error('桌面草稿数据超出限制')
      const objects = new Map(current.objects.map(item => [item.id, item]))
      for (const key of data.remove) objects.delete(key)
      for (const item of data.upsert) {
        if (!item || typeof item.id !== 'string' || item.id.length > 100 || !['ink', 'erase', 'shape', 'text', 'image'].includes(item.kind)) throw new Error('桌面草稿对象无效')
        objects.set(item.id, item)
      }
      if (new Set(data.order).size !== objects.size || data.order.length !== objects.size || data.order.some(key => !objects.has(key))) throw new Error('桌面草稿顺序无效')
      const patched = data.order.map(key => objects.get(key))
      const expected = JSON.stringify(patched)
      await model.current.apply(patched)
      lastError = ''
      revision++
      const next = model.current.document()
      if (next.draftId !== current.draftId || JSON.stringify(next.objects) !== expected) { await snapshot(true); return }
      documentSignature = JSON.stringify([next.draftId, next.objects, next.settings])
      const ack = { type: 'ack', requestId: data.requestId, revision }
      acknowledged.set(data.requestId, ack)
      if (acknowledged.size > 64) acknowledged.delete(acknowledged.keys().next().value)
      await send(id, ack)
      await send(toolsId, toolsState())
    }
  }
  const addSurface = id => {
    surfaces.set(id, createDesktopTransport(data => api.auxiliary.send(id, data), data => serial(() => receive(id, data)), error => {
      if (!surfaces.has(id) || disposed) return
      fail(error)
      if (id === canvasId) void send(id, { type: 'error', message: error.message }).catch(() => {})
    }))
  }
  const open = async ({ draw = false, signal } = {}) => {
    if (disposed) throw new Error('桌面画布已关闭')
    if (opening) { await opening; if (draw) await setDrawing(true); return }
    if (toolsId) { if (draw) await setDrawing(true); return }
    const epoch = ++generation
    const valid = () => { if (disposed || signal?.isAborted?.() || epoch !== generation) throw new Error('桌面画布启动已取消') }
    opening = (async () => {
      const position = await api.storage.get(POSITION_KEY)
      valid()
      const canvas = await api.auxiliary.open({ entry: 'assets/vendor/drawboard-desktop/canvas.html', placement: 'display',
        transparent: true, alwaysOnTop: true, focus: false, interaction: 'passthrough', data: {} })
      canvasId = canvas.windowId; addSurface(canvasId); valid()
      const tools = await api.auxiliary.open({ entry: 'assets/vendor/drawboard-desktop/tools.html', title: '画板工具',
        transparent: true, alwaysOnTop: true, focus: false, parentWindowId: canvasId,
        bounds: { width: 610, height: 144, ...(position && typeof position === 'object' ? { x: position.x, y: position.y } : {}) }, data: toolsState() })
      toolsId = tools.windowId; addSurface(toolsId); valid()
      await Promise.all([waitReady(canvasId), waitReady(toolsId)])
      valid()
      if (draw) await setDrawing(true)
      status()
    })().catch(async error => { await stop(); fail(error); throw error }).finally(() => { opening = null })
    return opening
  }
  const onMessage = event => { surfaces.get(event.windowId)?.accept(event.data) }
  const onClosed = event => {
    if (!closing && surfaces.has(event.windowId)) void stop().then(() => api.settings.set(DESKTOP_SETTING, false)).catch(fail)
  }
  const onChanged = event => {
    if (event.windowId === toolsId) void api.storage.set(POSITION_KEY, event.state.bounds).then(() => api.storage.flush()).catch(fail)
    if (event.windowId === canvasId && event.state.interaction === 'passthrough' && drawing) {
      drawing = false; void send(toolsId, toolsState()).catch(fail); status()
    }
  }
  api.on('auxiliary.message', onMessage); api.on('auxiliary.closed', onClosed); api.on('auxiliary.changed', onChanged)
  return { open, stop, sync, async dispose() {
    disposed = true
    api.off('auxiliary.message', onMessage); api.off('auxiliary.closed', onClosed); api.off('auxiliary.changed', onChanged)
    await stop()
  } }
}
