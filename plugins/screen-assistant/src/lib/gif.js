/** WebM → GIF：主线程解码抽帧，Worker 量化编码。 */
import { thumbFromCanvas } from './media.js'

export function loadVideoFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      reject(error)
    }
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.onloadedmetadata = () => {
      if (settled) return
      settled = true
      resolve({ video, url })
    }
    video.onerror = () => fail(new Error('视频无法解码'))
    setTimeout(() => fail(new Error('视频加载超时')), 20000)
    video.src = url
  })
}

function disposeVideo(video, url) {
  try { video.pause() } catch { /* ignore */ }
  video.removeAttribute('src')
  video.load()
  URL.revokeObjectURL(url)
}

/**
 * options: { startMs, endMs, fps, width, speed, signal, onProgress }
 * 返回 { bytes, width, height, frames, durationMs, thumb }。
 */
export async function convertToGif(blob, options = {}) {
  const fps = Math.min(24, Math.max(4, Math.round(Number(options.fps) || 10)))
  const speed = Math.min(4, Math.max(0.25, Number(options.speed) || 1))
  const { video, url } = await loadVideoFromBlob(blob)
  const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0
  const start = Math.max(0, Math.min(durationMs || 0, Math.round(Number(options.startMs) || 0)))
  const end = Math.max(start + 100, Math.min(durationMs || start + 1000, Math.round(Number(options.endMs) || durationMs || start + 1000)))
  const targetWidth = Math.max(64, Math.min(video.videoWidth || 640, Math.round(Number(options.width) || 480)))
  const targetHeight = Math.max(1, Math.round(targetWidth * (video.videoHeight || 360) / (video.videoWidth || 640)))
  if (targetHeight > 1600) throw new Error('GIF 高度过大，请减小宽度')

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('GIF 画布不可用')

  const worker = new Worker(new URL('./gif.worker.js', import.meta.url), { type: 'module' })
  const ack = { pending: 0 }
  const waiters = []
  let firstThumb = ''
  let workerError = null

  const message = new Promise((resolve, reject) => {
    worker.onmessage = event => {
      const data = event.data
      if (data?.type === 'ready') { waiters.shift()?.resolve(); return }
      if (data?.type === 'frame-ack') {
        ack.pending = Math.max(0, ack.pending - 1)
        if (ack.pending < 2 && video.paused && !video.ended) void video.play().catch(() => {})
        return
      }
      if (data?.type === 'progress') { options.onProgress?.({ phase: 'encoding', frames: data.frames }); return }
      if (data?.type === 'done') { resolve(data); return }
      if (data?.type === 'error') {
        workerError = new Error(data.message || 'GIF 编码失败')
        reject(workerError)
        waiters.splice(0).forEach(item => item.reject(workerError))
      }
    }
    worker.onerror = event => {
      workerError = new Error(event.message || 'GIF 编码线程异常')
      reject(workerError)
    }
  })
  message.catch(() => {})

  const init = new Promise((resolve, reject) => { waiters.push({ resolve, reject }) })
  worker.postMessage({ type: 'init', width: targetWidth, height: targetHeight, fps })

  const abort = () => {
    try { video.pause() } catch { /* ignore */ }
    worker.terminate()
    disposeVideo(video, url)
  }
  const checkAbort = () => {
    if (options.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true })
    if (workerError) throw workerError
  }

  try {
    await init
    video.currentTime = start / 1000
    await new Promise((resolve, reject) => {
      const done = () => { video.onseeked = null; resolve() }
      video.onseeked = done
      setTimeout(() => { video.onseeked = null; resolve() }, 1500)
    })
    video.playbackRate = speed
    await video.play()
    const stepMedia = (1 / fps) * speed
    let nextAt = start / 1000
    const endSeconds = end / 1000
    options.onProgress?.({ phase: 'decoding', ratio: 0 })

    await new Promise((resolve, reject) => {
      let stopped = false
      const stop = () => {
        if (stopped) return
        stopped = true
        video.pause()
        const onEnd = () => resolve()
        if (ack.pending === 0) onEnd()
        else {
          const timer = setInterval(() => {
            if (ack.pending === 0) { clearInterval(timer); onEnd() }
            if (workerError) { clearInterval(timer); reject(workerError) }
          }, 50)
        }
      }
      const tick = () => {
        if (stopped) return
        try { checkAbort() } catch (error) { stop(); reject(error); return }
        const time = video.currentTime
        if (time >= nextAt) {
          ctx.drawImage(video, 0, 0, targetWidth, targetHeight)
          if (!firstThumb) {
            try { firstThumb = thumbFromCanvas(canvas, { maxEdge: 320 }) } catch { firstThumb = '' }
          }
          const image = ctx.getImageData(0, 0, targetWidth, targetHeight)
          ack.pending += 1
          worker.postMessage({ type: 'frame', buffer: image.data.buffer }, [image.data.buffer])
          if (ack.pending >= 5) video.pause()
          nextAt += stepMedia
          const ratio = Math.max(0, Math.min(1, (time - start / 1000) / Math.max(0.001, endSeconds - start / 1000)))
          options.onProgress?.({ phase: 'decoding', ratio })
        }
        if (time >= endSeconds || video.ended) { stop(); return }
        if (ack.pending >= 5) {
          setTimeout(() => { if (!video.ended) void video.play().catch(() => {}) }, 60)
          setTimeout(tick, 80)
          return
        }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick)
        else setTimeout(tick, Math.max(8, Math.round(1000 / (fps * 2))))
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick)
      else setTimeout(tick, 20)
    })

    checkAbort()
    worker.postMessage({ type: 'finish' })
    const done = await message
    if (workerError) throw workerError
    const bytes = new Uint8Array(done.bytes)
    return {
      bytes,
      width: targetWidth,
      height: targetHeight,
      frames: done.frames,
      durationMs: Math.round(done.frames * 1000 / fps),
      thumb: firstThumb
    }
  } finally {
    abort()
  }
}
