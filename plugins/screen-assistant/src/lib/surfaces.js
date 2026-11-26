/** 插件自有辅助窗口：选区、范围框、录制/长截图控制条。 */
import { host } from './env.js'
import { StreamSink } from './files.js'

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

async function openDisplayOverlay(options) {
  try { return await host.auxiliary.open({ ...options, alwaysOnTop: true }) }
  catch (error) {
    if (!String(error?.message || error).includes('permission denied: pin.create')) throw error
    return host.auxiliary.open(options)
  }
}

export async function loadDisplays() {
  return host.screen.displays()
}

export async function captureDisplay({ displayId, bounds } = {}) {
  return host.screen.capture({ ...(displayId != null ? { displayId } : {}), ...(bounds ? { bounds } : {}) })
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
  const area = display.workArea || display.bounds
  const pixels = physicalDisplayBounds(display)
  const logical = display.bounds
  const left = logical.x + bounds.x * logical.width / pixels.width
  const top = logical.y + bounds.y * logical.height / pixels.height
  const right = logical.x + (bounds.x + bounds.width) * logical.width / pixels.width
  const bottom = logical.y + (bounds.y + bounds.height) * logical.height / pixels.height
  const width = Math.min(344, area.width), height = Math.min(60, area.height), gap = 10
  const marginX = Math.min(6, Math.floor((area.width - width) / 2))
  const marginY = Math.min(6, Math.floor((area.height - height) / 2))
  const clampX = x => Math.max(area.x + marginX, Math.min(area.x + area.width - width - marginX, Math.round(x)))
  const clampY = y => Math.max(area.y + marginY, Math.min(area.y + area.height - height - marginY, Math.round(y)))
  const fits = ({ x, y }) => x === clampX(x) && y === clampY(y)
  const candidates = [
    { x: clampX(right - width), y: Math.ceil(bottom + gap) },
    { x: clampX(right - width), y: Math.floor(top - height - gap) },
    { x: Math.ceil(right + gap), y: clampY(bottom - height) },
    { x: Math.floor(left - width - gap), y: clampY(bottom - height) }
  ]
  const position = candidates.find(fits) || { x: clampX(right - width - gap), y: clampY(bottom - height - gap) }
  return { ...position, width, height }
}

export async function openRegion({ display, withAudio = false, prefer = 'image', beforeShow }) {
  if (!['image', 'longshot', 'record'].includes(prefer)) throw new Error('选区动作无效')
  ensureEvents()
  const recording = prefer === 'record'
  const { windowId } = await openDisplayOverlay({
    entry: 'assets/vendor/screen-assistant/region.html',
    title: '选择区域',
    placement: 'display',
    displayId: display.id,
    transparent: true,
    visible: false,
    interaction: 'capture',
    contentProtection: true,
    data: { display, action: prefer, ...(recording ? { withAudio: withAudio === true } : {}) }
  })
  let readyTimer
  try {
    return await new Promise((resolve, reject) => {
      let ready = false
      readyTimer = setTimeout(() => reject(new Error('选区窗口未就绪，请重试')), 8000)
      attach(windowId, message => {
        if (message?.__closed || message?.type === 'cancel') { resolve(null); return }
        if (message?.type === 'failed') { reject(new Error(message.message || '选区不可用')); return }
        if (message?.type === 'ready' && !ready) {
          ready = true
          Promise.resolve().then(beforeShow).then(() => {
            if (handlers.has(windowId)) return host.auxiliary.send(windowId, { type: 'present' }, { visible: true, focus: true })
          }).then(() => clearTimeout(readyTimer)).catch(reject)
          return
        }
        if (!ready || message?.type !== 'action') return
        if (message.action !== prefer || (recording ? typeof message.withAudio !== 'boolean' : Object.hasOwn(message, 'withAudio'))) {
          reject(new Error('选区操作与当前模式不符')); return
        }
        const { bounds } = message
        const full = physicalDisplayBounds(display)
        if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)
          || bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1
          || bounds.x + bounds.width > full.width || bounds.y + bounds.height > full.height) {
          reject(new Error('选区已失效，请重新框选')); return
        }
        const { x, y, width, height } = bounds
        resolve({ action: prefer, bounds: { x, y, width, height }, ...(recording ? { withAudio: message.withAudio } : {}) })
      })
      host.auxiliary.send(windowId, { type: 'attached' }).catch(reject)
    })
  } finally {
    clearTimeout(readyTimer)
    handlers.delete(windowId)
    await host.auxiliary.close(windowId)
  }
}

/** 纯视觉范围框；失败时返回空串（录制仍可继续）。 */
export async function openFrame({ display, bounds, recording = false }) {
  const full = physicalDisplayBounds(display)
  if (bounds.x === 0 && bounds.y === 0 && bounds.width === full.width && bounds.height === full.height) return ''
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
export async function openBar({ mode, display, bounds, withAudio = false, quickOrigin = null, onMessage }) {
  if (mode !== 'record' && mode !== 'longshot') throw new Error('控制条模式无效')
  ensureEvents()
  const position = barPosition(display, bounds)
  const audio = mode === 'record' ? { withAudio: withAudio === true } : {}
  const options = {
    entry: 'assets/vendor/screen-assistant/bar.html',
    title: mode === 'record' ? '录屏控制' : '长截图控制',
    bounds: position,
    transparent: true,
    alwaysOnTop: true,
    contentProtection: true,
    movable: true,
    focus: true,
    capture: { displayId: display.id, ...audio },
    data: { mode, bounds, display, ...audio }
  }
  const createBar = async () => {
    const { windowId } = await host.auxiliary.open(options)
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
  let bar
  try {
    bar = await createBar()
  } catch (error) {
    if (quickOrigin !== 'dismissed' || !String(error?.message || error).includes('Capture requires a visible plugin')
      || host.getLaunchMode() !== 'quick') throw error
    let leftShell = false
    const stopWatching = host.onOut(() => { if (host.getLaunchMode() === 'shell') leftShell = true })
    const hideTemporaryShell = () => !leftShell && host.getLaunchMode() === 'shell' ? host.ui.hide() : Promise.resolve(false)
    try {
      if (!await host.ui.openInShell()) throw error
      try {
        bar = await createBar()
      } catch (openingError) {
        await hideTemporaryShell().catch(() => false)
        throw openingError
      }
      if (!await hideTemporaryShell()) throw new Error('窗口已切换，请重新开始采集')
      return bar
    } catch (handoffError) {
      if (bar) await bar.close()
      throw handoffError
    } finally { stopWatching() }
  }
  if (quickOrigin === 'visible' || quickOrigin === 'dismissed') {
    try { await host.ui.dismissQuick() }
    catch (error) { await bar.close(); throw error }
  }
  return bar
}

export async function openAnnotate({ display, shotDataUrl, preview = false, onSaved }) {
  ensureEvents()
  const area = display.workArea || display.bounds
  const width = Math.floor(Math.min(960, area.width * 0.75))
  const height = Math.floor(Math.min(660, area.height * 0.75))
  const opened = await host.auxiliary.open({
    entry: 'assets/vendor/screen-assistant/annotate.html',
    title: preview ? '截图预览' : '截图标注',
    placement: 'window',
    displayId: display.id,
    bounds: { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height },
    movable: true,
    resizable: true,
    visible: false,
    contentProtection: true,
    data: { shot: shotDataUrl, preview }
  })
  const windowId = opened.windowId
  let sink = null
  let phase = 'loading'
  let expectedBytes = 0
  let receivedBytes = 0
  let nextSequence = 0
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  let chain = Promise.resolve()

  const settle = value => {
    if (phase === 'done') return
    phase = 'done'
    resolveDone(value)
  }
  const fail = error => {
    if (phase === 'done') return
    phase = 'done'
    rejectDone(error)
  }

  const startupTimer = setTimeout(() => fail(new Error('图片编辑窗未能就绪，请从媒体库打开原图')), 12_000)
  const detach = attach(windowId, message => {
    if (!message || typeof message !== 'object' || phase === 'done') return
    if (message.type === 'cancel') { settle(null); return }
    if (message.__closed) {
      if (phase === 'editing') settle(null)
      else if (phase !== 'finishing') fail(new Error(phase === 'loading' ? '图片编辑窗未能启动' : '标注保存中断，原图仍在媒体库'))
      return
    }
    if (message.type === 'failed') {
      if (phase !== 'finishing') fail(new Error(message.message || '图片编辑窗不可用'))
      return
    }
    if (message.type === 'ready' && phase === 'loading') {
      phase = 'editing'
      void host.auxiliary.send(windowId, { type: 'present' }, { visible: true, focus: true })
        .then(() => clearTimeout(startupTimer), fail)
      return
    }
    if (message.type === 'saving' && phase === 'editing') { phase = 'saving'; return }
    if (message.type === 'image-start') {
      if (phase !== 'saving' || !Number.isSafeInteger(message.bytes) || message.bytes <= 0) { fail(new Error('标注图片数据无效')); return }
      phase = 'writing'
      expectedBytes = message.bytes
      sink = new StreamSink('png')
      return
    }
    if (message.type === 'image-chunk') {
      const length = message.bytes?.byteLength
      if (phase !== 'writing' || message.seq !== nextSequence || !Number.isSafeInteger(length) || length <= 0 || receivedBytes + length > expectedBytes) {
        fail(new Error('标注图片分片不完整')); return
      }
      receivedBytes += length
      nextSequence++
      chain = chain.then(async () => {
        await sink.write(message.bytes)
        await host.auxiliary.send(windowId, { type: 'ack', seq: message.seq })
      }).catch(fail)
      return
    }
    if (message.type === 'image-end') {
      if (phase !== 'writing' || receivedBytes !== expectedBytes) { fail(new Error('标注图片传输不完整')); return }
      phase = 'finishing'
      chain = chain.then(async () => {
        if (phase !== 'finishing') return
        const file = await sink.finish()
        sink = null
        await send(windowId, { type: 'saved', ok: true })
        settle({ fileId: file.id, bytes: file.size, width: message.width, height: message.height })
      }).catch(fail)
    }
  })

  let result
  void host.auxiliary.send(windowId, { type: 'attached' }).catch(fail)
  try {
    result = await done
  } finally {
    clearTimeout(startupTimer)
    detach()
    await Promise.all([closeWindow(windowId), sink?.abort().catch(() => {})])
  }
  if (result && onSaved) await onSaved(result)
  return result
}
