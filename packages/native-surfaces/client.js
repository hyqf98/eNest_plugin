const clients = new WeakMap()
const ASSETS = 'assets/vendor/native-surfaces/'
const defer = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Plugin-owned presentation and recording policy; the host transports only opaque messages. */
export function createNativeSurfaces(host) {
  if (!host || typeof host !== 'object') return host
  if (clients.has(host)) return clients.get(host)
  const facade = Object.create(host), handlers = new Map(), early = new Map(), recordings = new Map(), finished = new Map()
  let opening = 0, selection = null
  const check = () => { if (!host.auxiliary?.open) throw new Error('此功能需要 eNest 0.2.3 的辅助窗口能力') }
  const receive = event => {
    const handler = handlers.get(event?.windowId)
    if (handler) handler(event)
    else if (opening && early.size < 24) {
      const queued = early.get(event?.windowId) || []
      if (queued.length < 4) queued.push(event)
      early.set(event?.windowId, queued)
    }
  }
  host.on?.('auxiliary.message', event => receive({ ...event, type: 'auxiliary.message' }))
  host.on?.('auxiliary.closed', event => receive({ ...event, type: 'auxiliary.closed' }))
  const open = async (options, handler) => {
    check(); opening++
    try {
      const result = await host.auxiliary.open(options)
      if (handler) handlers.set(result.windowId, handler)
      for (const event of early.get(result.windowId) || []) handler?.(event)
      early.delete(result.windowId)
      return result.windowId
    } finally { if (!--opening) early.clear() }
  }
  const close = async id => { handlers.delete(id); try { return await host.auxiliary.close(id) } catch { return false } }
  const capture = options => host.screen.capture({ ...options, displayId: options?.displayId ?? options?.bounds?.displayId })
  const selectRegion = async () => {
    check()
    if (selection) { selection.resolve(null); if (selection.id) await close(selection.id) }
    const result = defer(), token = { ...result, id: null }
    selection = token
    try {
      const shot = await capture()
      if (selection !== token) return null
      token.id = await open({ entry: ASSETS + 'region.html', placement: 'display', displayId: shot.displayId,
        transparent: true, alwaysOnTop: true, movable: false,
        data: { dataUrl: shot.dataUrl, width: shot.width, height: shot.height, displayId: shot.displayId } }, event => {
        if (event.type === 'auxiliary.closed' || event.data?.type === 'cancel') result.resolve(null)
        else if (event.data?.type === 'confirm') {
          const b = event.data.bounds
          if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 3 && b.height > 3) result.resolve({ ...b, displayId: shot.displayId })
        }
      })
      return await result.promise
    } finally { if (token.id) await close(token.id); if (selection === token) selection = null }
  }
  const pin = {
    async open(input) {
      check()
      const dataUrl = String(input?.dataUrl || '')
      if (dataUrl.length > 32 * 1024 * 1024 || !/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(dataUrl)) throw new Error('贴图仅支持不超过 32 MB 的图片')
      const width = Math.max(80, Math.min(2048, Number(input.width) || 360))
      const windowId = await open({ entry: ASSETS + 'pin.html', title: input.title || '贴图', transparent: true, alwaysOnTop: true,
        resizable: true, movable: true, bounds: { x: input.x, y: input.y, width, height: Math.round(width * .75) }, data: { dataUrl, title: input.title || '贴图' } })
      return { pinId: windowId }
    },
    async list() { check(); return (await host.auxiliary.list()).filter(value => value.entry === ASSETS + 'pin.html').map(value => ({ pinId: value.windowId })) },
    async close(id) { const own = await pin.list(); return own.some(value => value.pinId === id) ? close(id) : false },
    async closeAll() { const own = await pin.list(); await Promise.all(own.map(value => close(value.pinId))); return own.length }
  }
  const abortRecording = (record, error = new Error('录制已取消')) => {
    if (record.done) return record.cleanup || Promise.resolve()
    record.done = true
    record.error = error
    clearTimeout(record.timer)
    recordings.delete(record.id)
    record.ready.reject(error); record.result.reject(error)
    record.cleanup = (async () => {
      if (record.windowId) await close(record.windowId)
      if (record.streamId) { try { await host.files.stream.abort(record.streamId) } catch {} }
    })()
    return record.cleanup
  }
  const record = {
    async start(options = {}) {
      check()
      if (!host.files?.stream) throw new Error('此版本不支持有界文件流')
      if (!['list', 'get', 'remove', 'export'].every(method => typeof host.storage?.files?.[method] === 'function')) throw new Error('此版本缺少私有录制文件管理，请升级 eNest 后录制')
      if (recordings.size) throw new Error('已有录制正在进行')
      const id = crypto.randomUUID(), state = { id, ready: defer(), result: defer(), done: false, startedAt: 0, windowId: null, streamId: null, timer: null }
      recordings.set(id, state)
      state.timer = setTimeout(() => { void abortRecording(state, new Error('等待录制确认超时')) }, 120_000)
      try {
        state.streamId = (await host.files.stream.open({ extension: 'webm' })).streamId
        if (state.done) { await host.files.stream.abort(state.streamId); throw state.error || new Error('录制已取消') }
        const displayId = options.displayId ?? options.bounds?.displayId
        state.windowId = await open({ entry: ASSETS + 'recorder.html', title: '开始录制', bounds: { width: 340, height: 180 }, alwaysOnTop: true,
          capture: { displayId, withAudio: options.withAudio === true }, data: { crop: options.bounds ?? null, withAudio: options.withAudio === true } }, event => {
          if (state.done) return
          const message = event.data
          if (event.type === 'auxiliary.closed') { void abortRecording(state, new Error('录制窗口已关闭')); return }
          if (message?.type === 'started') {
            if (state.startedAt) return
            state.startedAt = Date.now(); clearTimeout(state.timer)
            state.ready.resolve()
            void host.auxiliary.send(event.windowId, { type: 'ack-start' }, { visible: false }).catch(error => abortRecording(state, error))
          } else if (message?.type === 'chunk') {
            void host.files.stream.write(state.streamId, message.sequence, message.bytes).then(() => {
              if (!state.done) return host.auxiliary.send(event.windowId, { type: 'ack', sequence: message.sequence })
            }).catch(error => abortRecording(state, error))
          } else if (message?.type === 'stopped') {
            const stoppedAt = Date.now()
            void host.files.stream.finish(state.streamId).then(async result => {
              if (state.done) return
              state.done = true; clearTimeout(state.timer); recordings.delete(id)
              const saved = { id: result.id, path: result.path, size: result.size, durationMs: Math.max(0, stoppedAt - state.startedAt) }
              if (!state.stopping) {
                finished.set(id, saved)
                while (finished.size > 8) finished.delete(finished.keys().next().value)
              }
              state.result.resolve(saved)
              if (state.windowId) await close(state.windowId)
            }).catch(error => abortRecording(state, error))
          } else if (message?.type === 'failed' || message?.type === 'cancel') void abortRecording(state, new Error(String(message.message || '录制已取消')))
        })
        if (state.done) { await close(state.windowId); throw state.error || new Error('录制已取消') }
        await state.ready.promise
        return { sessionId: id }
      } catch (error) { await abortRecording(state, error); throw error }
    },
    async stop(id) {
      if (finished.has(id)) { const saved = finished.get(id); finished.delete(id); return saved }
      const state = recordings.get(id)
      if (!state || !state.startedAt) throw new Error('录制会话不可用')
      if (!state.stopping) {
        state.stopping = true
        state.timer = setTimeout(() => { void abortRecording(state, new Error('录制收尾超时')) }, 10_000)
        try { await host.auxiliary.send(state.windowId, { type: 'stop' }) }
        catch (error) { await abortRecording(state, error); throw error }
      }
      return state.result.promise
    },
    async cancel(id) { const state = recordings.get(id); if (!state) return false; await abortRecording(state); return true }
  }
  Object.defineProperties(facade, { pin: { value: pin }, screen: { value: { ...host.screen, capture, selectRegion, record } } })
  clients.set(host, facade)
  return facade
}
