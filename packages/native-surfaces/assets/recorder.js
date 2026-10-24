const api = window.enestAux, context = await api.getContext(), video = document.getElementById('video')
const startButton = document.getElementById('start'), status = document.getElementById('status')
let raw = null, output = null, recorder = null, canvas = null, raf = 0, videoFrame = 0, stopped = false, failed = false, sequence = 0, pendingBytes = 0, chunks = Promise.resolve()
const acknowledgements = new Map()
function release() {
  cancelAnimationFrame(raf)
  if (videoFrame && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrame)
  raw?.getTracks().forEach(track => track.stop()); output?.getTracks().forEach(track => track.stop())
  raw = null; output = null
  if (canvas) { canvas.width = 1; canvas.height = 1; canvas = null }
  video.srcObject = null
}
function fail(error) {
  if (failed) return
  failed = true; stopped = true
  try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch {}
  release()
  for (const pending of acknowledgements.values()) { clearTimeout(pending.timer); pending.reject(error) }
  acknowledgements.clear()
  void api.post({ type: 'failed', message: String(error?.message || error) }).catch(() => {})
}
function stop() {
  if (stopped) return
  stopped = true
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); else void api.post({ type: 'cancel' }) } catch (error) { fail(error) }
  release()
}
api.onMessage(message => {
  if (message?.type === 'stop') stop()
  else if (message?.type === 'ack') {
    const pending = acknowledgements.get(message.sequence)
    if (pending) { acknowledgements.delete(message.sequence); clearTimeout(pending.timer); pending.resolve() }
  }
})
function write(bytes) {
  const id = sequence++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { acknowledgements.delete(id); reject(new Error('文件写入确认超时')) }, 10_000)
    acknowledgements.set(id, { resolve, reject, timer })
    void api.post({ type: 'chunk', sequence: id, bytes }).catch(error => { clearTimeout(timer); acknowledgements.delete(id); reject(error) })
  })
}
startButton.onclick = async () => {
  startButton.disabled = true
  status.textContent = '正在准备屏幕捕获…'
  try {
    // getDisplayMedia must run from this real click, never a synthetic host activation.
    raw = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 4096 }, height: { max: 4096 }, frameRate: { max: 30 } }, audio: context.capture?.withAudio === true })
    if (stopped) { release(); return }
    video.srcObject = raw; await video.play()
    if (stopped) { release(); return }
    const sourceWidth = Math.round(context.display.width * context.display.scaleFactor), sourceHeight = Math.round(context.display.height * context.display.scaleFactor)
    const bounds = context.data.crop || { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
    const x = Math.max(0, Math.min(sourceWidth - 1, bounds.x | 0)), y = Math.max(0, Math.min(sourceHeight - 1, bounds.y | 0))
    const width = Math.max(1, Math.min(sourceWidth - x, bounds.width | 0)), height = Math.max(1, Math.min(sourceHeight - y, bounds.height | 0))
    if (width * height > 40_000_000) throw new Error('录制区域超出像素限制')
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    const drawing = canvas.getContext('2d')
    if (!drawing) throw new Error('录制画布不可用')
    const tick = () => {
      if (stopped) return
      drawing.drawImage(video, x * video.videoWidth / sourceWidth, y * video.videoHeight / sourceHeight, width * video.videoWidth / sourceWidth, height * video.videoHeight / sourceHeight, 0, 0, width, height)
      if (video.requestVideoFrameCallback) videoFrame = video.requestVideoFrameCallback(tick)
      else raf = requestAnimationFrame(tick)
    }
    tick(); output = canvas.captureStream(30)
    for (const track of raw.getAudioTracks()) output.addTrack(track)
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm'
    recorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: 4_000_000 })
    recorder.ondataavailable = event => {
      if (failed || !event.data?.size) return
      const blob = event.data
      if (pendingBytes + blob.size > 8 * 1024 * 1024) { fail(new Error('录制缓冲区超出限制')); return }
      pendingBytes += blob.size
      if (pendingBytes >= 2 * 1024 * 1024 && recorder.state === 'recording') recorder.pause()
      chunks = chunks.then(async () => {
        if (failed) return
        const bytes = await blob.arrayBuffer()
        for (let offset = 0; offset < bytes.byteLength && !failed; offset += 512 * 1024) await write(bytes.slice(offset, offset + 512 * 1024))
      }).catch(fail).finally(() => {
        pendingBytes -= blob.size
        if (!stopped && pendingBytes < 1024 * 1024 && recorder.state === 'paused') recorder.resume()
      })
    }
    recorder.onerror = event => fail(event.error || new Error('录制失败'))
    recorder.onstop = () => { stopped = true; release(); void chunks.then(() => { if (!failed) return api.post({ type: 'stopped' }) }).catch(fail) }
    for (const track of raw.getVideoTracks()) track.addEventListener('ended', stop, { once: true })
    recorder.start(250)
    await api.post({ type: 'started' })
  } catch (error) { fail(error) }
}
document.getElementById('cancel').onclick = () => { stop(); void api.post({ type: 'cancel' }) }
addEventListener('keydown', event => { if (event.key === 'Escape') { stop(); void api.post({ type: 'cancel' }) } })
addEventListener('pagehide', () => { stopped = true; release() }, { once: true })
