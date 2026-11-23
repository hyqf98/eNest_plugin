/* GIF 编码 Worker：gifenc 量化 + 逐帧写入，主线程只负责解码/抽帧。 */
import { GIFEncoder, applyPalette, quantize } from 'gifenc'

let encoder = null
let width = 0
let height = 0
let delay = 100
let frames = 0

self.onmessage = event => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'init') {
    width = Math.max(1, Math.round(message.width) || 1)
    height = Math.max(1, Math.round(message.height) || 1)
    delay = Math.max(20, Math.round(1000 / Math.max(1, Number(message.fps) || 10)))
    encoder = GIFEncoder()
    frames = 0
    self.postMessage({ type: 'ready' })
    return
  }
  if (message.type === 'frame') {
    if (!encoder) return
    try {
      const rgba = new Uint8ClampedArray(message.buffer)
      const palette = quantize(rgba, 256)
      const index = applyPalette(rgba, palette)
      encoder.writeFrame(index, width, height, { palette, delay })
      frames += 1
      self.postMessage({ type: 'frame-ack' })
      if (frames % 5 === 0) self.postMessage({ type: 'progress', frames })
    } catch (error) {
      self.postMessage({ type: 'error', message: String(error?.message || error) })
    }
    return
  }
  if (message.type === 'finish') {
    if (!encoder) { self.postMessage({ type: 'error', message: '编码器未初始化' }); return }
    try {
      encoder.finish()
      const bytes = encoder.bytes()
      self.postMessage({ type: 'done', bytes: bytes.buffer, frames }, [bytes.buffer])
    } catch (error) {
      self.postMessage({ type: 'error', message: String(error?.message || error) })
    }
  }
}
