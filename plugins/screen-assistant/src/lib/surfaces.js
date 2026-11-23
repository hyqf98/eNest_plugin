/** 插件自有辅助窗口：选区、范围框、录制/长截图控制条。 */
import { host } from './env.js'

const handlers = new Map()
let installed = false

function ensureEvents() {
  if (installed) return
  installed = true
  host.on?.('auxiliary.message', event => {
    if (!event?.windowId) return
    handlers.get(event.windowId)?.(event.data)
  })
  host.on?.('auxiliary.closed', event => {
    if (!event?.windowId) return
    const handler = handlers.get(event.windowId)
    handlers.delete(event.windowId)
    handler?.({ __closed: true })
  })
}

function attach(windowId, handler) {
  ensureEvents()
  handlers.set(windowId, handler)
  return () => handlers.delete(windowId)
}

export async function send(windowId, data) {
  if (!windowId) return false
  try { await host.auxiliary.send(windowId, data); return true } catch { return false }
}

export async function closeWindow(windowId) {
  handlers.delete(windowId)
  if (!windowId) return false
  return host.auxiliary.close(windowId).catch(() => false)
}

export async function loadDisplays() {
  return host.screen.displays()
}

export async function captureDisplay({ displayId, bounds } = {}) {
  return host.screen.capture({ ...(displayId ? { displayId } : {}), ...(bounds ? { bounds } : {}) })
}

export function physicalDisplayBounds(display) {
  const scale = Number(display?.scaleFactor) || 1
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.round((display?.bounds?.width || 0) * scale)),
    height: Math.max(1, Math.round((display?.bounds?.height || 0) * scale))
  }
}

/** 控制条位置：优先选区右下外侧，放不下再依次上方/右侧/左侧，最后才重叠。 */
export function barPosition(display, bounds) {
  const scale = Number(display?.scaleFactor) || 1
  const area = display?.workArea || display?.bounds || { x: 0, y: 0, width: 1280, height: 800 }
  const origin = display?.bounds || { x: area.x, y: area.y }
  const sel = {
    x: origin.x + (bounds?.x || 0) / scale,
    y: origin.y + (bounds?.y || 0) / scale,
    width: Math.max(1, (bounds?.width || 0) / scale),
    height: Math.max(1, (bounds?.height || 0) / scale)
  }
  const width = 344, height = 56, gap = 10, margin = 6
  const clampX = x => Math.max(area.x + margin, Math.min(area.x + area.width - width - margin, x))
  const clampY = y => Math.max(area.y + margin, Math.min(area.y + area.height - height - margin, y))
  const fits = ({ x, y }) => x >= area.x + margin && y >= area.y + margin && x + width <= area.x + area.width - margin && y + height <= area.y + area.height - margin
  const candidates = [
    { x: sel.x + sel.width - width, y: sel.y + sel.height + gap },
    { x: sel.x + sel.width - width, y: sel.y - height - gap },
    { x: sel.x + sel.width + gap, y: sel.y + sel.height - height },
    { x: sel.x - width - gap, y: sel.y + sel.height - height },
    { x: sel.x + sel.width - width - gap, y: sel.y + sel.height - height - gap }
  ]
  for (const candidate of candidates) if (fits(candidate)) return { ...candidate, width, height }
  const last = candidates[candidates.length - 1]
  return { x: clampX(last.x), y: clampY(last.y), width, height }
}

/** 选区覆盖层。图片走分片回传；长截图/录屏只回动作，窗口保持到 proceed()。 */
export async function openRegion({ display, withAudio = false, actions = ['image', 'longshot', 'record'], prefer = 'image', onImageStart, onImageChunk, onImageEnd }) {
  ensureEvents()
  const shot = await captureDisplay({ displayId: display.id })
  const data = { shot: shot.dataUrl, display, withAudio, actions, prefer }
  const base = {
    entry: 'assets/vendor/screen-assistant/region.html',
    title: '选择区域',
    placement: 'display',
    displayId: display.id,
    transparent: true,
    alwaysOnTop: true,
    interaction: 'capture',
    contentProtection: true,
    data
  }
  let opened
  try {
    opened = await host.auxiliary.open({ ...base, capture: { displayId: display.id, withAudio: false } })
  } catch {
    opened = await host.auxiliary.open(base)
  }
  const windowId = opened.windowId
  let finished = false
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  let image = null
  let imagePending = false
  let chain = Promise.resolve()

  const detach = attach(windowId, message => {
    if (!message || typeof message !== 'object') return
    if (message.__closed) {
      // The selection surface closes right after image-end; let the pending
      // write finish instead of treating the close as a cancellation.
      if (imagePending) {
        setTimeout(() => {
          if (finished || !imagePending) return
          imagePending = false
          finished = true
          void image?.sink?.abort?.()
          resolveDone(null)
        }, 10000)
        return
      }
      if (!finished) { finished = true; resolveDone(null) }
      return
    }
    if (message.type === 'image-start') {
      imagePending = true
      try {
        image = { sink: onImageStart?.(message) ?? null, meta: message }
      } catch (error) {
        imagePending = false
        finished = true
        rejectDone(error)
        void closeWindow(windowId)
      }
      return
    }
    if (message.type === 'image-chunk') {
      chain = chain.then(async () => {
        if (!image?.sink) throw new Error('截图数据未初始化')
        await onImageChunk?.(image.sink, message.bytes, message)
        await send(windowId, { type: 'ack', seq: message.seq })
      }).catch(error => {
        if (finished) return
        finished = true
        rejectDone(error)
        void closeWindow(windowId)
      })
      return
    }
    if (message.type === 'image-end') {
      chain = chain.then(async () => {
        if (!image?.sink) throw new Error('截图数据未初始化')
        const saved = await onImageEnd?.(image.sink, message)
        imagePending = false
        await send(windowId, { type: 'saved', ok: true })
        if (finished) return
        finished = true
        resolveDone({ action: 'image', ...saved, bounds: message.bounds, width: message.width, height: message.height })
        detach()
      }).catch(async error => {
        imagePending = false
        await send(windowId, { type: 'saved', ok: false }).catch(() => {})
        if (finished) return
        finished = true
        rejectDone(error)
        void closeWindow(windowId)
      })
      return
    }
    if (message.type === 'fallback') {
      if (finished) return
      finished = true
      resolveDone({ action: 'image', fallback: true, bounds: message.bounds })
      detach()
      void closeWindow(windowId)
      return
    }
    if (message.type === 'action') {
      if (finished) return
      finished = true
      // Keep the selection surface open until the caller has opened the
      // frame/bar; closing first would end the interaction lease used to
      // create capture windows safely.
      resolveDone({ action: message.action, bounds: message.bounds, withAudio: message.withAudio === true })
      detach()
      return
    }
    if (message.type === 'cancel') {
      if (finished) return
      finished = true
      resolveDone(null)
      detach()
      void closeWindow(windowId)
    }
  })

  return {
    windowId,
    done,
    proceed: () => send(windowId, { type: 'proceed' }),
    cancel: () => closeWindow(windowId)
  }
}

/** 纯视觉范围框；失败时返回空串（录制仍可继续）。 */
export async function openFrame({ display, bounds, recording = false }) {
  try {
    const result = await host.auxiliary.open({
      entry: 'assets/vendor/screen-assistant/frame.html',
      title: '录制范围',
      placement: 'display',
      displayId: display.id,
      transparent: true,
      alwaysOnTop: true,
      interaction: 'passthrough',
      focus: false,
      contentProtection: true,
      data: { bounds, recording }
    })
    ensureEvents()
    handlers.set(result.windowId, message => {
      if (message?.__closed) handlers.delete(result.windowId)
    })
    return result.windowId
  } catch {
    return ''
  }
}

export function setFrameState(windowId, recording) {
  void send(windowId, { type: 'state', recording })
}

/** 录制 / 长截图控制条（capture 窗口，必须由真实点击启动取流）。 */
export async function openBar({ mode, display, bounds, withAudio = false, onMessage }) {
  ensureEvents()
  const position = barPosition(display, bounds)
  const result = await host.auxiliary.open({
    entry: 'assets/vendor/screen-assistant/bar.html',
    title: mode === 'record' ? '录屏控制' : '长截图控制',
    bounds: position,
    transparent: true,
    alwaysOnTop: true,
    contentProtection: true,
    movable: true,
    focus: true,
    capture: { displayId: display.id, withAudio },
    data: { mode, bounds, withAudio, display }
  })
  const windowId = result.windowId
  attach(windowId, message => {
    if (message?.__closed) onMessage?.({ type: 'closed' })
    else onMessage?.(message)
  })
  return {
    windowId,
    send: data => send(windowId, data),
    close: () => closeWindow(windowId),
    position
  }
}
