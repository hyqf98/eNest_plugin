/** 完整截图 / 长截图 / 录屏会话：连接悬浮层与媒体库。 */
import { base64ToBytes, StreamSink } from './files.js'
import { stampName } from './format.js'
import { thumbFromDataUrl } from './media.js'
import { captureDisplay, closeWindow, openBar, openFrame, openRegion, setFrameState } from './surfaces.js'

function safeError(error) {
  return new Error(String(error?.message || error || '操作失败'))
}

async function writeDataUrl(dataUrl, extension) {
  const sink = new StreamSink(extension)
  try {
    await sink.write(base64ToBytes(dataUrl))
    return await sink.finish()
  } catch (error) {
    await sink.abort()
    throw error
  }
}

/** 全屏截图：直接走宿主原生 capture，不入选区覆盖层。 */
export async function captureFullscreen({ display, library }) {
  const shot = await captureDisplay({ displayId: display.id })
  const file = await writeDataUrl(shot.dataUrl, 'png')
  const thumb = await thumbFromDataUrl(shot.dataUrl).catch(() => '')
  const item = await library.addSaved({
    kind: 'image',
    fileId: file.id,
    ext: 'png',
    thumb,
    name: stampName('全屏截图'),
    width: shot.width,
    height: shot.height,
    bytes: file.size,
    source: 'fullscreen'
  })
  return item
}

/**
 * 区域会话：返回图片条目，或 { action:'longshot'|'record', bounds, withAudio, region }。
 * 调用方拿到 longshot/record 后必须先打开 frame/bar，再 region.proceed()。
 */
export async function openRegionSession({ display, withAudio = false, prefer = 'image' }) {
  let sink = null
  const region = await openRegion({
    display,
    withAudio,
    prefer,
    onImageStart: () => { sink = new StreamSink('png'); return sink },
    onImageChunk: async (target, bytes) => { await target.write(bytes) },
    onImageEnd: async (target, meta) => {
      const file = await target.finish()
      return { fileId: file.id, bytes: file.size, thumb: meta.thumb, width: meta.width, height: meta.height }
    }
  })
  let result
  try {
    result = await region.done
  } catch (error) {
    await sink?.abort().catch(() => {})
    throw safeError(error)
  }
  if (!result) {
    await sink?.abort().catch(() => {})
    return null
  }
  if (result.action === 'image' && result.fallback) {
    try {
      const shot = await captureDisplay({ displayId: display.id, bounds: result.bounds })
      const file = await writeDataUrl(shot.dataUrl, 'png')
      const thumb = await thumbFromDataUrl(shot.dataUrl, { topCrop: false }).catch(() => '')
      return { action: 'image', fileId: file.id, bytes: file.size, thumb, width: shot.width, height: shot.height }
    } catch (error) {
      throw safeError(error)
    }
  }
  if (result.action === 'image') return result
  return { ...result, region }
}

export function imageFromRegionResult(result) {
  return {
    kind: 'image',
    fileId: result.fileId,
    ext: 'png',
    thumb: result.thumb,
    name: stampName('截图'),
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    source: 'capture'
  }
}

/** 长截图：frame 显示范围，bar 取流拼接并回传 PNG 分片。 */
export async function startLongshot({ display, bounds, library, onProgress, onState }) {
  let frameId = ''
  let finished = false
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const sink = new StreamSink('png')
  let chain = Promise.resolve()
  let bar = null

  const cleanup = async (keepFile = false) => {
    if (!keepFile) await sink.abort().catch(() => {})
    if (bar?.windowId) await closeWindow(bar.windowId).catch(() => {})
    if (frameId) await closeWindow(frameId).catch(() => {})
  }

  const fail = async error => {
    if (finished) return
    finished = true
    await cleanup(false)
    onState?.('error', error)
    rejectDone(safeError(error))
  }

  const finish = async item => {
    if (finished) return
    finished = true
    await cleanup(true)
    onState?.('done', item)
    resolveDone(item)
  }

  try {
    frameId = await openFrame({ display, bounds, recording: false })
    bar = await openBar({
      mode: 'longshot',
      display,
      bounds,
      onMessage: message => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'image-chunk') {
          chain = chain.then(async () => {
            await sink.write(message.bytes)
            await bar?.send({ type: 'ack', sequence: message.seq })
          }).catch(error => { void fail(error) })
          return
        }
        if (message.type === 'image-end') {
          chain = chain.then(async () => {
            const file = await sink.finish()
            const item = await library.addSaved({
              kind: 'image',
              fileId: file.id,
              ext: 'png',
              thumb: message.thumb,
              name: stampName('长截图'),
              width: message.width,
              height: message.height,
              bytes: file.size,
              source: 'longshot'
            })
            await bar?.send({ type: 'saved', ok: true })
            await finish(item)
          }).catch(error => { void fail(error) })
          return
        }
        if (message.type === 'progress') {
          onProgress?.(message)
          onState?.('progress', message)
          return
        }
        if (message.type === 'started') { onState?.('running'); return }
        if (message.type === 'failed') { void fail(new Error(message.message || '长截图失败')); return }
        if (message.type === 'cancel') { void finish(null); return }
        if (message.type === 'closed') { if (!finished) void finish(null) }
      }
    })
    onState?.('preparing')
  } catch (error) {
    await cleanup(false)
    throw safeError(error)
  }

  return {
    done,
    stop: () => bar?.send({ type: 'stop' }),
    cancel: async () => { await bar?.send({ type: 'cancel' }); await finish(null) },
    close: () => cleanup(false)
  }
}

/** 录屏：frame 显示范围，bar 取流/编码并回传 WebM 分片。 */
export async function startRecorder({ display, bounds, withAudio = false, library, onState }) {
  let frameId = ''
  let finished = false
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const sink = new StreamSink('webm')
  let chain = Promise.resolve()
  let bar = null

  const cleanup = async (keepFile = false) => {
    if (!keepFile) await sink.abort().catch(() => {})
    if (bar?.windowId) await closeWindow(bar.windowId).catch(() => {})
    if (frameId) await closeWindow(frameId).catch(() => {})
  }

  const fail = async error => {
    if (finished) return
    finished = true
    await cleanup(false)
    onState?.('error', error)
    rejectDone(safeError(error))
  }

  const finish = async item => {
    if (finished) return
    finished = true
    await cleanup(true)
    onState?.('done', item)
    resolveDone(item)
  }

  try {
    frameId = await openFrame({ display, bounds, recording: true })
    bar = await openBar({
      mode: 'record',
      display,
      bounds,
      withAudio,
      onMessage: message => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'started') {
          if (frameId) setFrameState(frameId, true)
          onState?.('recording')
          return
        }
        if (message.type === 'chunk') {
          chain = chain.then(async () => {
            await sink.write(message.bytes)
            await bar?.send({ type: 'ack', sequence: message.sequence })
          }).catch(error => { void fail(error) })
          return
        }
        if (message.type === 'stopped') {
          chain = chain.then(async () => {
            try {
              const file = await sink.finish()
              const item = await library.addSaved({
                kind: 'video',
                fileId: file.id,
                ext: 'webm',
                thumb: message.thumb,
                name: stampName('录屏'),
                width: message.width,
                height: message.height,
                bytes: file.size,
                durationMs: message.durationMs,
                source: 'record'
              })
              await bar?.send({ type: 'saved', ok: true })
              await finish(item)
            } catch (error) {
              await bar?.send({ type: 'saved', ok: false }).catch(() => {})
              throw error
            }
          }).catch(error => { void fail(error) })
          return
        }
        if (message.type === 'failed') { void fail(new Error(message.message || '录制失败')); return }
        if (message.type === 'cancel') { void finish(null); return }
        if (message.type === 'closed') { if (!finished) void finish(null) }
        if (message.type === 'progress') onState?.('progress', message)
      }
    })
    onState?.('preparing')
  } catch (error) {
    await cleanup(false)
    throw safeError(error)
  }

  return {
    done,
    stop: () => bar?.send({ type: 'stop' }),
    cancel: async () => { await bar?.send({ type: 'cancel' }); await finish(null) },
    close: () => cleanup(false)
  }
}
