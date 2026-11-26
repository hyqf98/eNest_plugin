/** 完整截图 / 长截图 / 录屏会话：连接悬浮层与媒体库。 */
import { base64ToBytes, StreamSink } from './files.js'
import { stampName } from './format.js'
import { thumbFromDataUrl } from './media.js'
import { captureDisplay, closeWindow, loadDisplays, openBar, openFrame, setFrameState } from './surfaces.js'

function safeError(error) {
  return new Error(String(error?.message || error || '操作失败'))
}

const positiveInteger = value => Number.isSafeInteger(value) && value > 0

function reportTiming(message, onState) {
  if (Number.isSafeInteger(message.elapsedMs) && message.elapsedMs >= 0) onState?.(message.type, { elapsedMs: message.elapsedMs })
}

function sessionControls(bar, done, settling, finish) {
  return {
    done,
    stop: async () => {
      if (!settling() && !await bar.send({ type: 'stop' }) && !settling()) throw new Error('停止命令未送达，请在悬浮控制条点击「停止」以保存')
    },
    cancel: async () => {
      if (settling()) return
      await Promise.all([bar.send({ type: 'cancel' }), finish(null)])
    },
    close: () => settling() ? done : finish(null)
  }
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

export async function captureStill({ display, bounds, library }) {
  if (bounds) {
    const current = (await loadDisplays()).find(entry => entry.id === display.id)
    if (!current || current.scaleFactor !== display.scaleFactor ||
      ['x', 'y', 'width', 'height'].some(axis => current.bounds[axis] !== display.bounds[axis])) {
      throw new Error('显示器已变化，请重新框选')
    }
  }
  const shot = await captureDisplay({ displayId: display.id, bounds })
  const file = await writeDataUrl(shot.dataUrl, 'png')
  const thumb = await thumbFromDataUrl(shot.dataUrl).catch(() => '')
  const item = await library.addSaved({
    kind: 'image',
    fileId: file.id,
    ext: 'png',
    thumb,
    name: stampName(bounds ? '截图' : '全屏截图'),
    width: shot.width,
    height: shot.height,
    bytes: file.size,
    source: bounds ? 'capture' : 'fullscreen'
  })
  return { item, shotDataUrl: shot.dataUrl }
}

/** 长截图：frame 显示范围，bar 取流拼接并回传 PNG 分片。 */
export async function startLongshot({ display, bounds, library, onProgress, onState, quickOrigin }) {
  let frameId = ''
  let finished = false
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  void done.catch(() => {})
  const sink = new StreamSink('png')
  let chain = Promise.resolve()
  let bar = null
  let header = null
  let receivedBytes = 0
  let nextSequence = 0
  let finalizing = false

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
    await cleanup(Boolean(item))
    onState?.('done', item)
    resolveDone(item)
  }

  try {
    frameId = await openFrame({ display, bounds, recording: false })
    const opening = openBar({
      mode: 'longshot',
      quickOrigin,
      display,
      bounds,
      onMessage: message => {
        if (finished || finalizing || !message || typeof message !== 'object') return
        if (message.type === 'image-start') {
          if (header || ![message.bytes, message.width, message.height].every(positiveInteger)) { void fail(new Error('长截图数据无效')); return }
          header = { bytes: message.bytes, width: message.width, height: message.height, thumb: message.thumb }
          return
        }
        if (message.type === 'image-chunk') {
          const size = message.bytes?.byteLength
          if (!header || message.seq !== nextSequence || !positiveInteger(size) || receivedBytes + size > header.bytes) {
            void fail(new Error('长截图分片不完整，文件未保存')); return
          }
          nextSequence++
          receivedBytes += size
          chain = chain.then(async () => {
            if (finished) return
            await sink.write(message.bytes)
            if (!await (await opening).send({ type: 'ack', sequence: message.seq })) throw new Error('长截图传输中断，文件未保存')
          }).catch(error => { void fail(error) })
          return
        }
        if (message.type === 'image-end') {
          if (!header || receivedBytes !== header.bytes || message.width !== header.width || message.height !== header.height) {
            void fail(new Error('长截图未完整传输，文件未保存')); return
          }
          finalizing = true
          chain = chain.then(async () => {
            if (finished) return
            if (sink.bytes !== header.bytes) throw new Error('长截图未完整写入')
            const file = await sink.finish()
            const item = await library.addSaved({
              kind: 'image',
              fileId: file.id,
              ext: 'png',
              thumb: header.thumb,
              name: stampName('长截图'),
              width: message.width,
              height: message.height,
              bytes: file.size,
              source: 'longshot'
            })
            await bar?.send({ type: 'saved', ok: true })
            await finish(message.interruption ? { ...item, interruption: message.interruption } : message.limitReached ? { ...item, limitReached: true } : item)
          }).catch(error => { void fail(error) })
          return
        }
        if (message.type === 'progress') {
          onProgress?.(message)
          onState?.('progress', message)
          return
        }
        if (message.type === 'started') { onState?.('running'); return }
        if (message.type === 'saving') { reportTiming(message, onState); return }
        if (message.type === 'failed') { void fail(new Error(message.message || '长截图失败')); return }
        if (message.type === 'cancel') { void finish(null); return }
        if (message.type === 'closed') void fail(new Error('长截图控制条已提前关闭，未能保存长图'))
      }
    })
    bar = await opening
    if (finished) await closeWindow(bar.windowId)
    else onState?.('preparing')
  } catch (error) {
    await cleanup(false)
    throw safeError(error)
  }

  return sessionControls(bar, done, () => finished || finalizing, finish)
}

/** 录屏：frame 显示范围，bar 取流/编码并回传 WebM 分片。 */
export async function startRecorder({ display, bounds, withAudio = false, library, onState, quickOrigin }) {
  let frameId = ''
  let finished = false
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  void done.catch(() => {})
  const sink = new StreamSink('webm')
  let chain = Promise.resolve()
  let bar = null
  let nextSequence = 0
  let finalizing = false

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
    await cleanup(Boolean(item))
    onState?.('done', item)
    resolveDone(item)
  }

  try {
    frameId = await openFrame({ display, bounds, recording: false })
    const opening = openBar({
      mode: 'record',
      quickOrigin,
      display,
      bounds,
      withAudio: withAudio === true,
      onMessage: message => {
        if (finished || finalizing || !message || typeof message !== 'object') return
        if (message.type === 'started') {
          if (frameId) setFrameState(frameId, true)
          onState?.('recording')
          return
        }
        if (['paused', 'recording', 'saving'].includes(message.type)) { reportTiming(message, onState); return }
        if (message.type === 'chunk') {
          if (message.sequence !== nextSequence || !positiveInteger(message.bytes?.byteLength)) {
            void fail(new Error('录屏分片不完整，文件未保存')); return
          }
          nextSequence++
          chain = chain.then(async () => {
            if (finished) return
            await sink.write(message.bytes)
            if (!await (await opening).send({ type: 'ack', sequence: message.sequence })) throw new Error('录屏分片传输中断，文件未保存')
          }).catch(error => { void fail(error) })
          return
        }
        if (message.type === 'stopped') {
          finalizing = true
          chain = chain.then(async () => {
            if (finished) return
            try {
              if (!positiveInteger(sink.bytes) || message.bytes !== sink.bytes || message.chunks !== nextSequence) throw new Error('录屏分片未完整写入，文件未保存')
              if (message.audio !== (withAudio === true)) throw new Error('录屏音轨与所选设置不符，未能保存录屏')
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
              await finish(message.interruption ? { ...item, interruption: message.interruption } : item)
            } catch (error) {
              await bar?.send({ type: 'saved', ok: false }).catch(() => {})
              throw error
            }
          }).catch(error => { void fail(error) })
          return
        }
        if (message.type === 'failed') { void fail(new Error(message.message || '录制失败')); return }
        if (message.type === 'cancel') { void finish(null); return }
        if (message.type === 'closed') { void fail(new Error('录屏控制条已提前关闭，未能生成完整的录屏文件')); return }
        if (message.type === 'progress') onState?.('progress', message)
      }
    })
    bar = await opening
    if (finished) await closeWindow(bar.windowId)
    else onState?.('preparing')
  } catch (error) {
    await cleanup(false)
    throw safeError(error)
  }

  return sessionControls(bar, done, () => finished || finalizing, finish)
}
