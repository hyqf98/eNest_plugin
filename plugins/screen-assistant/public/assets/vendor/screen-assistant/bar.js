/* 录制 / 长截图控制条：自身持有 capture 流，页面只负责写私有文件。 */
import { projectRect, rasterSize, sameDisplay } from './geometry.js'

const api = window.enestAux
const context = await api.getContext()
const data = context.data || {}
const mode = data.mode
const displaySize = rasterSize(context.display)
const bounds = data.bounds
const withAudio = mode === 'record' && data.withAudio === true

const bar = document.getElementById('bar')
const label = document.getElementById('label')
const sub = document.getElementById('sub')
const preview = document.getElementById('preview')
const video = document.getElementById('video')
const crop = document.getElementById('crop')
const cropContext = crop.getContext('2d')
const buttons = {
  start: document.getElementById('start'),
  pause: document.getElementById('pause'),
  resume: document.getElementById('resume'),
  stop: document.getElementById('stop'),
  cancel: document.getElementById('cancel')
}

const CHUNK = 512 * 1024
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
let frameWidth = 0, frameHeight = 0, frameCrop = null
let cropW = 0, cropH = 0, maxHeight = 0

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
let savingRecording = false
let sequence = 0
let writtenBytes = 0
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
  if (nextSub !== undefined) { sub.textContent = nextSub; sub.title = nextSub }
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
  const width = video.videoWidth, height = video.videoHeight
  if (frameCrop && frameWidth === width && frameHeight === height) return frameCrop
  if (!width || !height) throw new Error('未收到屏幕画面')
  const fit = Math.min(width / displaySize.width, height / displaySize.height)
  if (width - displaySize.width * fit > 2 || height - displaySize.height * fit > 2) {
    throw new Error('采集画面与所选显示器比例不符，请重新选择范围')
  }
  const rect = projectRect(bounds, displaySize, { width, height })
  const pixels = projectRect(bounds, displaySize, { width, height }, true)
  if (pixels.width < 1 || pixels.height < 1) throw new Error('当前采集分辨率下选区过小，请扩大范围')
  frameWidth = width
  frameHeight = height
  frameCrop = { ...rect, outputWidth: pixels.width, outputHeight: pixels.height }
  return frameCrop
}

function endCapture(error) {
  if (stopping) return
  if (mode === 'record' && startedAt) void stopRecording(error.message)
  else if (mode === 'longshot' && longshot?.totalH) void stopLongshot(false, error.message)
  else fail(error)
}

function drawCropFrame() {
  if (video.readyState < 2) return false
  let rect
  try { rect = videoRect() } catch (error) { endCapture(error); return false }
  try {
    cropContext.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, cropW, cropH)
    return true
  } catch (error) { endCapture(error); return false }
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
  if (['saved', 'cancelled', 'error'].includes(bar.dataset.state)) return
  stopping = true
  savingRecording = false
  releaseStream()
  const text = String(error?.message || error || '操作失败')
  setState('error', '操作失败', text)
  controls(['cancel'])
  void api.post({ type: 'failed', message: text }).catch(() => {})
}

async function ensureStream() {
  if (!sameDisplay(data.display, context.display)) {
    throw new Error('显示器设置已变化，请重新选择录制范围')
  }
  if (withAudio && context.capture?.withAudio !== true) throw new Error('控制条未获系统声音采集授权，请重新发起录屏')
  let acquired
  try {
    acquired = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 4096 }, height: { max: 4096 }, frameRate: { max: 30 } },
      audio: withAudio,
      systemAudio: withAudio ? 'include' : 'exclude'
    })
  } catch (error) {
    if (stopping) return false
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      throw new Error(`未获${withAudio ? '屏幕或系统声音' : '屏幕'}采集授权，请检查 eNest 的屏幕录制权限后重试`)
    }
    if (withAudio) throw new Error(`无法开始带系统声音的录屏：${error?.message || '设备不可用'}。可关闭「录制系统声音」后重试`)
    throw error
  }
  if (stopping) {
    acquired.getTracks().forEach(track => track.stop())
    return false
  }
  stream = acquired
  const track = stream.getVideoTracks()[0]
  if (!track || track.readyState === 'ended') throw new Error('屏幕采集已结束')
  track.addEventListener('ended', () => endCapture(new Error('屏幕采集已结束')), { once: true })
  if (withAudio) {
    const audioTrack = stream.getAudioTracks().find(track => track.enabled && track.readyState === 'live')
    if (!audioTrack) throw new Error('未取得系统音轨，录屏未开始。请检查系统声音采集权限，或关闭「录制系统声音」后重试')
    audioTrack.addEventListener('ended', () => endCapture(new Error('系统声音采集已结束')), { once: true })
  } else {
    for (const audioTrack of stream.getAudioTracks()) { audioTrack.stop(); stream.removeTrack(audioTrack) }
  }
  video.srcObject = stream
  await video.play()
  if (stopping) return false
  if (video.readyState < 2 || !video.videoWidth) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('未收到屏幕画面')), 8000)
      video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
  if (stopping) return false
  const rect = videoRect()
  crop.width = cropW = rect.outputWidth
  crop.height = cropH = rect.outputHeight
  maxHeight = Math.max(240, Math.min(16000, Math.floor(32_000_000 / cropW)))
  return true
}

function chooseMime(hasAudio) {
  const candidates = hasAudio
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']
  return candidates.find(value => MediaRecorder.isTypeSupported(value)) || 'video/webm'
}

function elapsedNow() {
  if (!startedAt) return 0
  const paused = pausedTotal + (pausedAt ? Date.now() - pausedAt : 0)
  return Math.max(0, Date.now() - startedAt - paused)
}

function postTiming(type, elapsedMs = elapsedNow()) {
  void api.post({ type, elapsedMs }).catch(() => {})
}

function startTimer() {
  clearInterval(timerId)
  timerId = setInterval(() => {
    if (!stopping && startedAt) sub.textContent = `${formatClock(elapsedNow())}${!manualPaused && pausedAt ? ' · 等待写入' : ''}`
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
    if (stopping && !savingRecording) return
    const slice = bytes.slice(offset, offset + CHUNK)
    const id = sequence++
    await Promise.all([waitAck(id), api.post({ type: 'chunk', sequence: id, bytes: slice.buffer })])
    writtenBytes += slice.byteLength
  }
  pendingBytes = Math.max(0, pendingBytes - blob.size)
  if (!stopping && !manualPaused && pendingBytes < 1024 * 1024 && recorder?.state === 'paused') {
    resumeEncoder()
  }
}

/* ---------- 录屏 ---------- */
function renderLoop() {
  if (stopping) return
  drawCropFrame()
  if (stopping) return
  if (video.requestVideoFrameCallback) videoFrame = video.requestVideoFrameCallback(renderLoop)
  else raf = requestAnimationFrame(renderLoop)
}

async function countdown() {
  for (const value of [3, 2, 1]) {
    if (stopping) return
    setState('countdown', String(value), '准备录制')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function startRecording() {
  if (stopping || bar.dataset.state !== 'idle') return
  setState('preparing', '录屏', '正在准备…')
  controls(['cancel'])
  try {
    if (!await ensureStream() || stopping) return
    renderLoop()
    if (stopping) return
    output = crop.captureStream(30)
    if (withAudio) for (const track of stream.getAudioTracks()) output.addTrack(track)
    const hasAudio = output.getAudioTracks().length > 0
    const bitrate = Math.max(2_500_000, Math.min(10_000_000, Math.round(cropW * cropH * 2.4)))
    recorder = new MediaRecorder(output, { mimeType: chooseMime(hasAudio), videoBitsPerSecond: bitrate })
    recorder.onerror = event => fail(event.error || new Error('录制失败'))
    recorder.onstop = () => {
      if (recorderStopped) recorderStopped()
      else if (startedAt && !stopping) fail(new Error('录屏编码意外停止，未能生成完整的录屏文件'))
    }
    recorder.ondataavailable = event => {
      const blob = event.data
      if (!blob?.size || (stopping && !savingRecording)) return
      pendingBytes += blob.size
      writeChain = writeChain.then(() => writeBlob(blob)).catch(error => fail(error))
      if (pendingBytes > 8 * 1024 * 1024 && recorder.state === 'recording') {
        try { pauseEncoder() } catch (error) { fail(error) }
      }
    }
    await countdown()
    if (stopping) return
    recorder.start(250)
    startedAt = Date.now()
    pausedTotal = 0
    manualPaused = false
    setState('recording', '正在录制', '00:00')
    controls(['pause', 'stop', 'cancel'])
    startTimer()
    await api.post({ type: 'started' })
  } catch (error) {
    if (!stopping) fail(error)
  }
}

async function stopRecording(reason = '') {
  if (stopping) return
  if (!startedAt || !recorder) return cancel()
  stopping = true
  savingRecording = true
  const durationMs = elapsedNow()
  const audio = output?.getAudioTracks().length > 0
  clearInterval(timerId)
  clearInterval(loopId)
  setState('saving', '正在保存…', reason)
  postTiming('saving', durationMs)
  controls([])
  try {
    if (recorder.state === 'inactive') throw new Error('录屏编码已提前停止，未能生成完整文件')
    let timer
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('录屏编码器未能完成收尾，文件未保存')), 8000)
        recorderStopped = resolve
        recorder.stop()
      })
    } finally { clearTimeout(timer); recorderStopped = null }
    releaseStream()
    await writeChain
    if (!savingRecording) return
    if (!writtenBytes) throw new Error('没有可保存的录制画面')
    let thumb = ''
    try { thumb = thumbOfCrop() } catch {}
    const savedPromise = waitSaved()
    await api.post({
      type: 'stopped',
      durationMs,
      width: cropW,
      height: cropH,
      bytes: writtenBytes,
      chunks: sequence,
      interruption: reason,
      thumb,
      audio
    })
    const saved = await savedPromise
    if (saved?.ok) {
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

function pauseEncoder() {
  if (recorder.state !== 'recording') return
  recorder.pause()
  pausedAt = Date.now()
  postTiming('paused')
}

function resumeEncoder() {
  if (recorder.state !== 'paused') return
  recorder.resume()
  if (pausedAt) pausedTotal += Date.now() - pausedAt
  pausedAt = 0
  postTiming('recording')
}

function togglePause(paused) {
  if (!recorder || stopping) return
  try {
    if (paused) {
      pauseEncoder()
      manualPaused = true
      setState('paused', '已暂停', formatClock(elapsedNow()))
      controls(['resume', 'stop', 'cancel'])
    } else {
      manualPaused = false
      if (pendingBytes < 1024 * 1024) resumeEncoder()
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
    if (!drawCropFrame()) return
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
  } catch (error) { endCapture(error) } finally {
    state.busy = false
  }
}

async function startLongshot() {
  if (stopping || bar.dataset.state !== 'idle') return
  setState('preparing', '长截图', '正在准备…')
  controls(['cancel'])
  try {
    if (!await ensureStream() || stopping) return
    longshot = { strips: [], totalH: 0, offset: 0, maxOffset: 0, previous: null, busy: false, lastPost: 0, skipped: 0 }
    preview.hidden = false
    setState('longshot', '长截图', '滚动页面，完成后点停止')
    controls(['stop', 'cancel'])
    startedAt = Date.now()
    await longshotStep()
    if (stopping) return
    loopId = setInterval(() => { void longshotStep() }, 150)
    void api.post({ type: 'started' }).catch(() => {})
    timerId = setInterval(() => {
      if (!stopping) sub.textContent = `已采集 ${longshot.totalH}px`
    }, 700)
  } catch (error) {
    if (!stopping) fail(error)
  }
}

async function stopLongshot(auto = false, reason = '') {
  if (stopping) return
  if (!longshot?.totalH) return startedAt ? fail(new Error('尚未取得可保存的长截图画面')) : cancel()
  stopping = true
  releaseStream()
  setState('saving', '正在生成…', reason || (auto ? '已达到长度上限' : ''))
  postTiming('saving')
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
      await Promise.all([waitAck(seq), api.post({ type: 'image-chunk', seq, bytes: slice.buffer })])
    }
    const savedPromise = waitSaved()
    await api.post({ type: 'image-end', width: cropW, height, bounds, interruption: reason, limitReached: auto })
    const saved = await savedPromise
    if (saved?.ok) {
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
    if (mode === 'record') void stopRecording()
    else void stopLongshot(false)
  }
  if (message.type === 'cancel') void cancel()
})

async function cancel() {
  if (bar.dataset.state === 'error') { await api.close(); return }
  if (stopping) return
  stopping = true
  setState('cancelled', '正在取消…', '')
  controls([])
  try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch { /* ignore */ }
  releaseStream()
  await api.post({ type: 'cancel' }).catch(() => {})
  await api.close()
}

buttons.start.addEventListener('click', () => { void (mode === 'record' ? startRecording() : startLongshot()) })
buttons.pause.addEventListener('click', () => togglePause(true))
buttons.resume.addEventListener('click', () => togglePause(false))
buttons.stop.addEventListener('click', () => { void (mode === 'record' ? stopRecording() : stopLongshot(false)) })
buttons.cancel.addEventListener('click', () => { void cancel() })

addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!startedAt) void cancel()
    else if (mode === 'record') void stopRecording()
    else void stopLongshot(false)
  }
})
addEventListener('pagehide', () => {
  stopping = true
  savingRecording = false
  releaseStream()
}, { once: true })

if (mode !== 'record' && mode !== 'longshot') {
  fail(new Error('采集模式无效，请重新开始'))
} else {
  label.textContent = mode === 'record' ? '录屏' : '长截图'
  sub.textContent = mode === 'record' ? `点击开始 · ${withAudio ? '含系统声音' : '无声录制'}` : '滚动页面采集'
  controls(['start', 'cancel'])
}
