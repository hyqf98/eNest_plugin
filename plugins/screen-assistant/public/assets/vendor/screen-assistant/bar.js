/* 录制 / 长截图控制条：自身持有 capture 流，页面只负责写私有文件。 */
const api = window.enestAux
const context = await api.getContext()
const data = context.data || {}
const mode = data.mode === 'longshot' ? 'longshot' : 'record'
const display = context.display || { width: 0, height: 0, scaleFactor: 1 }
const bounds = data.bounds || { x: 0, y: 0, width: 1, height: 1 }
const withAudio = data.withAudio === true

const bar = document.getElementById('bar')
const label = document.getElementById('label')
const sub = document.getElementById('sub')
const preview = document.getElementById('preview')
const video = document.getElementById('video')
const crop = document.getElementById('crop')
const buttons = {
  start: document.getElementById('start'),
  pause: document.getElementById('pause'),
  resume: document.getElementById('resume'),
  stop: document.getElementById('stop'),
  cancel: document.getElementById('cancel')
}

const CHUNK = 512 * 1024
const sourceWidth = Math.round((display.width || 0) * (display.scaleFactor || 1))
const sourceHeight = Math.round((display.height || 0) * (display.scaleFactor || 1))
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const cropX = clamp(Math.round(bounds.x), 0, Math.max(0, sourceWidth - 1))
const cropY = clamp(Math.round(bounds.y), 0, Math.max(0, sourceHeight - 1))
const cropW = Math.max(1, Math.min(sourceWidth - cropX || bounds.width, Math.round(bounds.width)))
const cropH = Math.max(1, Math.min(sourceHeight - cropY || bounds.height, Math.round(bounds.height)))
const maxHeight = Math.max(240, Math.min(16000, Math.floor(32_000_000 / Math.max(1, cropW))))

let stream = null
let output = null
let recorder = null
let raf = 0
let videoFrame = 0
let timerId = 0
let startedAt = 0
let pausedAt = 0
let pausedTotal = 0
let manualPaused = false
let stopping = false
let audioLost = false
let sequence = 0
let pendingBytes = 0
let writeChain = Promise.resolve()
const acks = new Map()
let savedResolve = null
let recorderStopped = null
let longshot = null
let loopId = 0

function setState(name, nextLabel, nextSub) {
  bar.dataset.state = name
  if (nextLabel !== undefined) label.textContent = nextLabel
  if (nextSub !== undefined) sub.textContent = nextSub
}

function controls(names) {
  for (const [key, element] of Object.entries(buttons)) element.hidden = !names.includes(key)
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function videoRect() {
  const vw = video.videoWidth || 1
  const vh = video.videoHeight || 1
  const sx = vw / (sourceWidth || vw)
  const sy = vh / (sourceHeight || vh)
  return { x: cropX * sx, y: cropY * sy, w: cropW * sx, h: cropH * sy }
}

function waitAck(sequenceId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { acks.delete(sequenceId); reject(new Error('文件写入确认超时')) }, 12000)
    acks.set(sequenceId, () => { clearTimeout(timer); resolve() })
  })
}

function waitSaved() {
  return new Promise(resolve => {
    const timer = setTimeout(() => { savedResolve = null; resolve(null) }, 15000)
    savedResolve = message => { clearTimeout(timer); savedResolve = null; resolve(message) }
  })
}

function releaseStream() {
  clearInterval(timerId)
  clearInterval(loopId)
  timerId = 0
  loopId = 0
  if (videoFrame && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(videoFrame) } catch { /* ignore */ } }
  videoFrame = 0
  cancelAnimationFrame(raf)
  raf = 0
  if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null }
  if (output) { output.getTracks().forEach(track => track.stop()); output = null }
  video.srcObject = null
}

function fail(error) {
  if (bar.dataset.state === 'saved') return
  stopping = true
  releaseStream()
  const text = String(error?.message || error || '操作失败')
  setState('error', '操作失败', text.slice(0, 40))
  controls(['cancel'])
  void api.post({ type: 'failed', message: text }).catch(() => {})
}

async function getStream(audio) {
  return navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: 4096 }, height: { max: 4096 }, frameRate: { max: 30 } },
    audio
  })
}

async function ensureStream() {
  if (stream) return
  try {
    stream = await getStream(withAudio)
  } catch (error) {
    if (!withAudio) throw error
    audioLost = true
    stream = await getStream(false)
  }
  video.srcObject = stream
  await video.play()
  if (!video.videoWidth) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('未收到屏幕画面')), 8000)
      video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
}

function chooseMime(hasAudio) {
  const candidates = hasAudio
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']
  return candidates.find(value => MediaRecorder.isTypeSupported(value)) || 'video/webm'
}

function elapsedNow() {
  if (!startedAt) return 0
  const paused = pausedTotal + (manualPaused && pausedAt ? Date.now() - pausedAt : 0)
  return Math.max(0, Date.now() - startedAt - paused)
}

function startTimer() {
  clearInterval(timerId)
  timerId = setInterval(() => {
    if (!stopping && startedAt) sub.textContent = `${formatClock(elapsedNow())}${audioLost ? ' · 无声' : ''}`
  }, 250)
}

function thumbOfCrop() {
  const canvas = document.createElement('canvas')
  const maxEdge = 320
  const scale = Math.min(1, maxEdge / Math.max(cropW, cropH))
  canvas.width = Math.max(1, Math.round(cropW * scale))
  canvas.height = Math.max(1, Math.round(cropH * scale))
  canvas.getContext('2d').drawImage(crop, 0, 0, cropW, cropH, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.72)
}

async function writeBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.slice(offset, offset + CHUNK)
    const id = sequence++
    await api.post({ type: 'chunk', sequence: id, bytes: slice.buffer })
    await waitAck(id)
  }
  pendingBytes = Math.max(0, pendingBytes - blob.size)
  if (!stopping && !manualPaused && pendingBytes < 1024 * 1024 && recorder?.state === 'paused') {
    try { recorder.resume() } catch { /* ignore */ }
  }
}

/* ---------- 录屏 ---------- */
function renderLoop() {
  if (stopping) return
  try {
    const rect = videoRect()
    crop.getContext('2d').drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, cropW, cropH)
  } catch { /* frame not ready */ }
  if (video.requestVideoFrameCallback) videoFrame = video.requestVideoFrameCallback(renderLoop)
  else raf = requestAnimationFrame(renderLoop)
}

async function countdown() {
  for (const value of [3, 2, 1]) {
    if (stopping) return
    setState('countdown', String(value), '准备录制')
    await new Promise(resolve => setTimeout(resolve, 700))
  }
}

async function startRecording() {
  if (stopping) return
  setState('preparing', '录屏', '正在准备…')
  controls(['cancel'])
  try {
    await ensureStream()
    crop.width = cropW
    crop.height = cropH
    renderLoop()
    output = crop.captureStream(30)
    for (const track of stream.getAudioTracks()) output.addTrack(track)
    const hasAudio = output.getAudioTracks().length > 0
    const bitrate = Math.max(2_500_000, Math.min(10_000_000, Math.round(cropW * cropH * 2.4)))
    recorder = new MediaRecorder(output, { mimeType: chooseMime(hasAudio), videoBitsPerSecond: bitrate })
    recorder.onerror = event => fail(event.error || new Error('录制失败'))
    recorder.onstop = () => { if (recorderStopped) { const resolve = recorderStopped; recorderStopped = null; resolve() } }
    recorder.ondataavailable = event => {
      const blob = event.data
      if (!blob?.size || stopping) return
      pendingBytes += blob.size
      writeChain = writeChain.then(() => writeBlob(blob)).catch(error => fail(error))
      if (pendingBytes > 8 * 1024 * 1024 && recorder.state === 'recording') {
        try { recorder.pause() } catch { /* ignore */ }
      }
    }
    await countdown()
    if (stopping) return
    recorder.start(250)
    startedAt = Date.now()
    pausedTotal = 0
    manualPaused = false
    setState('recording', '正在录制', `00:00${audioLost ? ' · 无声' : ''}`)
    controls(['pause', 'stop', 'cancel'])
    startTimer()
    await api.post({ type: 'started' })
  } catch (error) {
    fail(error)
  }
}

async function stopRecording(save) {
  if (stopping) return
  stopping = true
  clearInterval(timerId)
  clearInterval(loopId)
  setState('saving', save ? '正在保存…' : '正在取消…', '')
  controls([])
  try {
    if (recorder && recorder.state !== 'inactive') {
      const done = new Promise(resolve => { recorderStopped = resolve })
      recorder.stop()
      await done
    }
    await writeChain.catch(() => {})
    if (!save) {
      await api.post({ type: 'cancel' }).catch(() => {})
      await api.close()
      return
    }
    const durationMs = elapsedNow()
    const thumb = thumbOfCrop()
    const savedPromise = waitSaved()
    await api.post({
      type: 'stopped',
      durationMs,
      width: cropW,
      height: cropH,
      bytes: pendingBytes,
      thumb,
      audio: output?.getAudioTracks().length > 0
    })
    const saved = await savedPromise
    if (saved?.ok !== false) {
      setState('saved', '已保存', formatClock(durationMs))
      controls([])
      setTimeout(() => { void api.close() }, 900)
    } else {
      setState('error', '保存失败', '文件未能写入')
      controls(['cancel'])
    }
  } catch (error) {
    fail(error)
  } finally {
    releaseStream()
  }
}

function togglePause(paused) {
  if (!recorder || stopping) return
  try {
    if (paused) {
      recorder.pause()
      manualPaused = true
      pausedAt = Date.now()
      setState('paused', '已暂停', formatClock(elapsedNow()))
      controls(['resume', 'stop', 'cancel'])
    } else {
      if (pausedAt) pausedTotal += Date.now() - pausedAt
      pausedAt = 0
      manualPaused = false
      if (pendingBytes < 1024 * 1024) recorder.resume()
      setState('recording', '正在录制', formatClock(elapsedNow()))
      controls(['pause', 'stop', 'cancel'])
      startTimer()
    }
  } catch (error) {
    fail(error)
  }
}

/* ---------- 长截图 ---------- */
const signatureCanvas = document.createElement('canvas')
const signatureCtx = signatureCanvas.getContext('2d', { willReadFrequently: true })

function signature() {
  const sigHeight = clamp(cropH, 32, 512)
  if (signatureCanvas.width !== 64 || signatureCanvas.height !== sigHeight) {
    signatureCanvas.width = 64
    signatureCanvas.height = sigHeight
  }
  signatureCtx.drawImage(crop, 0, 0, cropW, cropH, 0, 0, 64, sigHeight)
  const pixels = signatureCtx.getImageData(0, 0, 64, sigHeight).data
  const rows = new Float32Array(sigHeight)
  for (let y = 0; y < sigHeight; y += 1) {
    let sum = 0
    for (let x = 0; x < 64; x += 1) {
      const index = (y * 64 + x) * 4
      sum += pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114
    }
    rows[y] = sum / 64
  }
  return rows
}

function matchShift(previous, current) {
  const height = current.length
  const top = Math.max(2, Math.floor(height * 0.06))
  const maxShift = Math.floor(height * 0.8)
  const minCount = Math.max(8, Math.floor((height - top) * 0.35))
  let best = { shift: 0, score: Infinity }
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    let sum = 0
    let count = 0
    for (let i = top; i < height; i += 1) {
      const j = i + shift
      if (j < 0 || j >= height) continue
      sum += Math.abs(current[i] - previous[j])
      count += 1
    }
    if (count < minCount) continue
    const score = sum / count
    if (score < best.score) best = { shift, score }
  }
  if (!Number.isFinite(best.score) || best.score > 11) return null
  let mean = 0
  for (const value of current) mean += value
  mean /= height
  let variance = 0
  for (const value of current) variance += (value - mean) ** 2
  variance /= height
  if (variance < 3) return null
  return best.shift * (cropH / height)
}

function appendRows(startRow, count) {
  const state = longshot
  if (!state || count < 1) return
  const remaining = maxHeight - state.totalH
  const rows = Math.min(count, remaining)
  if (rows < 1) return
  const strip = document.createElement('canvas')
  strip.width = cropW
  strip.height = rows
  strip.getContext('2d').drawImage(crop, 0, startRow, cropW, rows, 0, 0, cropW, rows)
  state.strips.push(strip)
  state.totalH += rows
  if (state.totalH >= maxHeight) void stopLongshot(true)
}

function drawMiniPreview() {
  if (preview.hidden) return
  const ctx = preview.getContext('2d')
  const width = preview.width
  const height = preview.height
  const scale = Math.max(width / cropW, height / cropH)
  const sw = width / scale
  const sh = height / scale
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, width, height)
  try { ctx.drawImage(crop, (cropW - sw) / 2, (cropH - sh) / 2, sw, sh, 0, 0, width, height) } catch { /* ignore */ }
}

async function longshotStep() {
  const state = longshot
  if (!state || state.busy || stopping) return
  state.busy = true
  try {
    const ctx = crop.getContext('2d')
    const rect = videoRect()
    ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, cropW, cropH)
    const sig = signature()
    if (!state.previous) {
      appendRows(0, cropH)
      state.previous = sig
      state.offset = 0
      state.maxOffset = cropH
    } else {
      const delta = matchShift(state.previous, sig)
      if (delta !== null && Math.abs(delta) <= cropH * 0.9) {
        if (delta > 0) {
          state.offset += delta
          const newBottom = state.offset + cropH
          if (newBottom > state.maxOffset + 1) {
            const startRow = Math.max(0, Math.round(state.maxOffset - state.offset))
            const count = Math.round(newBottom - state.maxOffset)
            appendRows(startRow, count)
            state.maxOffset = newBottom
          }
        } else if (delta < 0) {
          state.offset = Math.max(0, state.offset + delta)
        }
        state.previous = sig
      } else if (delta !== null) {
        state.skipped = (state.skipped || 0) + 1
      }
    }
    if (state.totalH > 0) {
      if (state.totalH >= maxHeight) {
        sub.textContent = '已达到长度上限'
        void stopLongshot(true)
        return
      }
      sub.textContent = `已采集 ${state.totalH}px${state.skipped ? ' · 已跳过过快滚动' : ''}`
      drawMiniPreview()
      if (Date.now() - state.lastPost > 600) {
        state.lastPost = Date.now()
        void api.post({ type: 'progress', height: state.totalH }).catch(() => {})
      }
    }
  } catch { /* frame skip */ } finally {
    state.busy = false
  }
}

async function startLongshot() {
  if (stopping) return
  setState('preparing', '长截图', '正在准备…')
  controls(['cancel'])
  try {
    await ensureStream()
    crop.width = cropW
    crop.height = cropH
    longshot = { strips: [], totalH: 0, offset: 0, maxOffset: 0, previous: null, busy: false, lastPost: 0, skipped: 0 }
    preview.hidden = false
    setState('longshot', '长截图', '滚动页面，完成后点停止')
    controls(['stop', 'cancel'])
    startedAt = Date.now()
    await longshotStep()
    loopId = setInterval(() => { void longshotStep() }, 150)
    void api.post({ type: 'started' }).catch(() => {})
    timerId = setInterval(() => {
      if (!stopping) sub.textContent = `已采集 ${longshot.totalH}px`
    }, 700)
  } catch (error) {
    fail(error)
  }
}

async function stopLongshot(auto = false) {
  if (stopping || !longshot) return
  stopping = true
  clearInterval(loopId)
  clearInterval(timerId)
  loopId = 0
  timerId = 0
  setState('saving', '正在生成…', auto ? '已达到长度上限' : '')
  controls([])
  try {
    const height = Math.max(1, longshot.totalH)
    const final = document.createElement('canvas')
    final.width = cropW
    final.height = height
    const ctx = final.getContext('2d')
    let y = 0
    for (const strip of longshot.strips) {
      ctx.drawImage(strip, 0, y)
      y += strip.height
    }
    const blob = await new Promise(resolve => final.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('长图编码失败')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const thumbCanvas = document.createElement('canvas')
    const ratio = 16 / 9
    const topHeight = Math.min(height, Math.round(cropW / ratio))
    thumbCanvas.width = Math.max(1, Math.round(cropW))
    thumbCanvas.height = Math.max(1, topHeight)
    thumbCanvas.getContext('2d').drawImage(final, 0, 0)
    const thumbScale = Math.min(1, 320 / Math.max(thumbCanvas.width, thumbCanvas.height))
    const thumb = document.createElement('canvas')
    thumb.width = Math.max(1, Math.round(thumbCanvas.width * thumbScale))
    thumb.height = Math.max(1, Math.round(thumbCanvas.height * thumbScale))
    thumb.getContext('2d').drawImage(thumbCanvas, 0, 0, thumb.width, thumb.height)
    await api.post({ type: 'image-start', bytes: bytes.byteLength, width: cropW, height, bounds, thumb: thumb.toDataURL('image/jpeg', 0.72) })
    for (let offset = 0, seq = 0; offset < bytes.length; offset += CHUNK, seq += 1) {
      const slice = bytes.slice(offset, offset + CHUNK)
      await api.post({ type: 'image-chunk', seq, bytes: slice.buffer })
      await waitAck(seq)
    }
    const savedPromise = waitSaved()
    await api.post({ type: 'image-end', width: cropW, height, bounds })
    const saved = await savedPromise
    if (saved?.ok !== false) {
      setState('saved', '已保存', `${cropW} × ${height}`)
      controls([])
      setTimeout(() => { void api.close() }, 900)
    } else {
      setState('error', '保存失败', '长图未能写入')
      controls(['cancel'])
    }
  } catch (error) {
    fail(error)
  } finally {
    releaseStream()
  }
}

/* ---------- 事件 ---------- */
api.onMessage(message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'ack' && acks.has(message.sequence)) {
    acks.get(message.sequence)()
    acks.delete(message.sequence)
  }
  if (message.type === 'saved') savedResolve?.({ ok: message.ok !== false })
  if (message.type === 'stop') {
    if (mode === 'record') void stopRecording(true)
    else void stopLongshot(false)
  }
  if (message.type === 'cancel') {
    if (mode === 'record') void stopRecording(false)
    else void cancel()
  }
})

async function cancel() {
  if (stopping) return
  stopping = true
  try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch { /* ignore */ }
  releaseStream()
  await api.post({ type: 'cancel' }).catch(() => {})
  await api.close()
}

buttons.start.addEventListener('click', () => { void (mode === 'record' ? startRecording() : startLongshot()) })
buttons.pause.addEventListener('click', () => togglePause(true))
buttons.resume.addEventListener('click', () => togglePause(false))
buttons.stop.addEventListener('click', () => { void (mode === 'record' ? stopRecording(true) : stopLongshot(false)) })
buttons.cancel.addEventListener('click', () => { void cancel() })

addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (mode === 'record' && startedAt) void stopRecording(true)
    else void cancel()
  }
})
addEventListener('pagehide', () => {
  stopping = true
  releaseStream()
}, { once: true })

label.textContent = mode === 'record' ? '录屏' : '长截图'
sub.textContent = mode === 'record' ? '点击开始后录制' : '滚动页面采集'
controls(['start', 'cancel'])
