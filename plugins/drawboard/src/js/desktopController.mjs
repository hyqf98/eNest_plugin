import { createDesktopTransport } from './desktopTransport.mjs'

export const DESKTOP_SETTING = 'desktopFloatingTools'
const POSITION_KEY = 'drawboard.desktop.position'
/** 悬浮球形态的工具窗口尺寸（收起态）；展开时以球为圆心呈花瓣环铺开，窗口比环略大。 */
const BALL_SIZE = { width: 64, height: 64 }
/**
 * 花瓣环直径：12 个动作沿圆周均分（每 30°），环半径 82px。
 * 窗口取环的外接方形，四周只留阴影余量（比之前的 312 收紧一圈，
 * 中间空白更少）；球心在两种形态下都落在窗口中心。
 */
const BLOOM_SIZE = { width: 252, height: 252 }
export const BLOOM_RADIUS = 82
export const DESKTOP_TOOLS = [
  ['select', '选择'], ['pen', '钢笔'], ['highlighter', '荧光笔'], ['eraser', '橡皮'],
  ['rect', '矩形'], ['ellipse', '椭圆'], ['line', '直线'], ['arrow', '箭头'], ['text', '文字'], ['image', '贴图'],
]

export function createDesktopController(api, model) {
  const surfaces = new Map(), acknowledged = new Map()
  const readyWindows = new Set(), readyWaiters = new Map()
  let generation = 0, opening, canvasId, toolsId, revision = 0, drawing = false, disposed = false, syncing
  let tool = 'pen', documentSignature = '', syncTimer, closing = false, queue = Promise.resolve(), lastError = ''
  let expanded = false, toolsBounds = null
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
  /**
   * 悬浮球 ↔ 花瓣环：窗口以**球心为不动点**扩缩。
   *
   * 两种形态下球心都必须落在同一个屏幕坐标：
   *   收起 64×64 → 球心 = 窗口左上 + 32
   *   展开 252×252 → 球心 = 窗口左上 + 126
   * 所以扩缩时窗口左上角要反向平移 (252-64)/2 = 94px，球在屏幕上才不动。
   *
   * 顺序也很重要：**先把窗口改到位，再让渲染层开始播花开动画**。
   * 反过来的话花瓣会先画在 64×64 的窗口里被裁掉，等原生 resize 到达时
   * 再"啪"地一下整块跳出来——这就是之前看到的跳变。
   */
  const setExpanded = async value => {
    if (!toolsId || expanded === Boolean(value)) return
    const next = Boolean(value)
    const size = next ? BLOOM_SIZE : BALL_SIZE
    if (!toolsBounds) toolsBounds = { width: BALL_SIZE.width, height: BALL_SIZE.height, x: 94, y: 94 }
    // 当前窗口中心（= 球心）在屏幕上的位置，扩缩后仍要落在这里。
    const centerX = toolsBounds.x + toolsBounds.width / 2
    const centerY = toolsBounds.y + toolsBounds.height / 2
    const bounds = {
      width: size.width, height: size.height,
      x: Math.round(centerX - size.width / 2), y: Math.round(centerY - size.height / 2),
    }
    expanded = next
    toolsBounds = bounds
    // 先落窗口，再放动画：ack 到达渲染层时视图已经是最终大小，花瓣在完整画布里盛开。
    await api.auxiliary.send(toolsId, { type: 'expand-ack', value: next }, { bounds })
  }
  const stop = async () => {
    generation++
    closing = true
    clearTimeout(syncTimer)
    const ids = [...surfaces.keys()]
    canvasId = toolsId = undefined
    for (const transport of surfaces.values()) transport.dispose()
    surfaces.clear(); drawing = false; expanded = false; toolsBounds = null; documentSignature = ''; acknowledged.clear(); sentImages.clear()
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
    if (data.type === 'expand' && id === toolsId) { await setExpanded(data.value === true); return }
    if (data.type === 'move' && id === toolsId) {
      // 拖动：按指针位移平移工具窗口。只接受有限的小增量——不接受绝对值，
      // 也不接受把窗口甩到屏幕外的请求（宿主 boundedWindowBounds 会再夹一次）。
      const dx = Number(data.dx), dy = Number(data.dy)
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 4000 || Math.abs(dy) > 4000) return
      if (!toolsBounds) return
      const next = { ...toolsBounds, x: Math.round(toolsBounds.x + dx), y: Math.round(toolsBounds.y + dy) }
      toolsBounds = next
      await api.auxiliary.send(toolsId, { type: 'moved' }, { bounds: next })
      return
    }
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
      // 持久化的是球窗口左上角（球心 = 该点 + BALL_SIZE/2），两种形态共用同一锚点。
      const anchor = position && typeof position === 'object' ? position : null
      const ballBounds = {
        width: BALL_SIZE.width, height: BALL_SIZE.height,
        ...(anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ? { x: anchor.x, y: anchor.y } : {}),
      }
      const tools = await api.auxiliary.open({ entry: 'assets/vendor/drawboard-desktop/tools.html', title: '画板工具',
        transparent: true, alwaysOnTop: true, focus: false, parentWindowId: canvasId,
        bounds: ballBounds, data: toolsState() })
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
  /** 主页面重载（MCP 调度、热重载）会重建控制器，而宿主侧悬浮球/画布窗口仍存活。
      按 entry 收养既有窗口并重新握手，否则点击球的消息落入空 surfaces 表被静默丢弃。 */
  const adopt = async () => {
    if (disposed || toolsId) return
    try {
      const existing = await api.auxiliary.list()
      if (disposed || toolsId || !Array.isArray(existing)) return
      const canvas = existing.find(item => item.entry.endsWith('/canvas.html'))
      const tools = existing.find(item => item.entry.endsWith('/tools.html'))
      if (!canvas || !tools) return
      canvasId = canvas.windowId; addSurface(canvasId)
      toolsId = tools.windowId; addSurface(toolsId)
      // 收养后窗口端可能已停止 hello 轮询：主动补发状态并请求 ready 回执。
      await send(canvasId, { type: 'resync' })
      await send(toolsId, toolsState())
      status()
    } catch { /* 无辅助窗口或宿主不支持：保持未开状态 */ }
  }
  void adopt()
  const onChanged = event => {
    if (event.windowId === toolsId) {
      toolsBounds = { ...event.state.bounds }
      // 只持久化「收起球」形态：球心在扩缩时保持不动，存球左上角即可还原位置，
      // 不再需要把花瓣环的几何换算回面板尺寸。
      const ball = expanded
        ? { ...toolsBounds, x: Math.round(toolsBounds.x + toolsBounds.width / 2 - BALL_SIZE.width / 2), y: Math.round(toolsBounds.y + toolsBounds.height / 2 - BALL_SIZE.height / 2), width: BALL_SIZE.width, height: BALL_SIZE.height }
        : { ...toolsBounds }
      void api.storage.set(POSITION_KEY, ball).then(() => api.storage.flush()).catch(fail)
    }
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
