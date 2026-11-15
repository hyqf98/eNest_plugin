import { surfaceImageUrl } from './image.js'
const api = window.enestAux, context = await api.getContext(), image = document.getElementById('background')
const selection = document.getElementById('selection'), liveBox = document.getElementById('selection-live')
const live = document.getElementById('live'), hint = document.getElementById('hint')
let objectUrl
try { objectUrl = await surfaceImageUrl(context.data); image.src = objectUrl }
catch (error) { await api.close(); throw error }
let sx = 0, sy = 0, ex = 0, ey = 0, dragging = false, finished = false
let stream = null, videoReady = false, settling = 0, settleTimer = 0

/** 真实用户手势里拉起整屏实时流（getDisplayMedia 只认 genuine gesture，宿主侧已限定本屏 source）。 */
async function startLive() {
  if (stream || !context.capture) return
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 4096 }, height: { max: 4096 }, frameRate: { max: 30 } }, audio: false })
    for (const track of stream.getTracks()) track.addEventListener('ended', stopLive, { once: true })
    live.srcObject = stream
    await live.play()
    await new Promise(resolve => { if (live.readyState >= 2 && live.videoWidth) return resolve(); live.addEventListener('loadeddata', resolve, { once: true }); setTimeout(resolve, 800) })
    if (!live.videoWidth || finished) { stopLive(); return }
    videoReady = true
    liveBox.style.display = 'block'; hint.classList.add('is-live')
    draw()
  } catch { stopLive() }
}
function stopLive() {
  videoReady = false
  liveBox.style.display = 'none'; hint.classList.remove('is-live')
  if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null }
  live.srcObject = null
}

const point = event => [Math.max(0, Math.min(innerWidth, event.clientX)), Math.max(0, Math.min(innerHeight, event.clientY))]
function draw() {
  const x = Math.min(sx, ex), y = Math.min(sy, ey), width = Math.abs(ex - sx), height = Math.abs(ey - sy)
  const active = dragging || width > 2 || height > 2
  Object.assign(selection.style, { display: active ? 'block' : 'none', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` })
  if (videoReady && active) liveBox.style.transform = `translate(${-x}px, ${-y}px)`
  else if (videoReady) liveBox.style.display = 'none'
}
/** 等流稳定几帧再取：首帧常是启动前的残影（光标位置、动画相位都会旧）。 */
async function settleFrames() {
  settling++
  const token = settling
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => { if (live.requestVideoFrameCallback) live.requestVideoFrameCallback(() => resolve()); else setTimeout(resolve, 33) })
    if (finished || token !== settling) return false
  }
  return true
}
/** WYSIWYG 裁剪：从当前视频帧裁出选区。选框坐标是 CSS 像素，按视频/屏幕比例换算到视频像素。 */
function cropFromLive(bounds) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bounds.width)); canvas.height = Math.max(1, Math.round(bounds.height))
  const drawing = canvas.getContext('2d')
  if (!drawing) return null
  drawing.drawImage(live, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
/** 宿主单条辅助消息上限 1 MB、秒级流量 8 MB：dataUrl 分块 + 按墙钟限速发送，宿主端拼接。 */
async function postConfirm(bounds) {
  const dataUrl = videoReady ? (() => { try { return cropFromLive(bounds) } catch { return null } })() : null
  if (!dataUrl) { void api.post({ type: 'confirm', bounds }); return }
  const chunk = 768 * 1024
  const pieces = []
  for (let offset = 0; offset < dataUrl.length; offset += chunk) pieces.push(dataUrl.slice(offset, offset + chunk))
  try {
    await api.post({ type: 'confirm-frame', bounds, pieces: pieces.length, bytes: dataUrl.length })
    let windowStart = Date.now(), windowBytes = 0
    for (let index = 0; index < pieces.length; index++) {
      if (windowBytes + pieces[index].length > 7 * 1024 * 1024) {
        const wait = 1050 - (Date.now() - windowStart)
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
        windowStart = Date.now(); windowBytes = 0
      }
      windowBytes += pieces[index].length
      await api.post({ type: 'confirm-frame-chunk', index, data: pieces[index] })
    }
  } catch {
    // 分块传输被打断（用户取消/窗口关闭/限速拒绝）：退回普通确认，宿主二次截屏兜底。
    try { await api.post({ type: 'confirm', bounds }) } catch { /* 窗口已不可用 */ }
  }
}
async function confirm() {
  if (finished) return
  const ratioX = context.data.width / innerWidth, ratioY = context.data.height / innerHeight
  const pixel = { x: Math.round(Math.min(sx, ex) * ratioX), y: Math.round(Math.min(sy, ey) * ratioY), width: Math.round(Math.abs(ex - sx) * ratioX), height: Math.round(Math.abs(ey - sy) * ratioY) }
  if (pixel.width <= 3 || pixel.height <= 3) return
  finished = true
  if (videoReady) {
    // 视频像素与屏幕物理像素同源；选框 CSS 坐标按比例映射到视频坐标后裁剪。
    const sourceWidth = Math.round(context.display.width * context.display.scaleFactor), sourceHeight = Math.round(context.display.height * context.display.scaleFactor)
    const frame = { x: pixel.x * live.videoWidth / sourceWidth, y: pixel.y * live.videoHeight / sourceHeight, width: pixel.width * live.videoWidth / sourceWidth, height: pixel.height * live.videoHeight / sourceHeight }
    if (await settleFrames()) {
      const bounded = { x: Math.max(0, Math.min(live.videoWidth - 1, frame.x)), y: Math.max(0, Math.min(live.videoHeight - 1, frame.y)) }
      bounded.width = Math.max(1, Math.min(live.videoWidth - bounded.x, frame.width))
      bounded.height = Math.max(1, Math.min(live.videoHeight - bounded.y, frame.height))
      await postConfirm(bounded)
      stopLive()
      return
    }
    stopLive()
  }
  void api.post({ type: 'confirm', bounds: pixel })
}
addEventListener('pointerdown', event => {
  if (event.button !== 0 || finished) return
  ;[sx, sy] = [ex, ey] = point(event); dragging = true
  document.body.setPointerCapture(event.pointerId)
  void startLive(); draw()
})
addEventListener('pointermove', event => { if (dragging) { [ex, ey] = point(event); draw() } })
addEventListener('pointerup', event => {
  if (!dragging) return
  ;[ex, ey] = point(event); dragging = false; draw()
  if (videoReady || !context.capture) { void confirm(); return }
  // 流还在起：等一小会再确认，超时则按静态底图坐标确认（宿主二次截屏兜底）。
  clearTimeout(settleTimer)
  settleTimer = setTimeout(() => { if (!finished) void confirm() }, 900)
})
addEventListener('keydown', event => {
  if (event.key === 'Escape') { finished = true; stopLive(); void api.post({ type: 'cancel' }) }
  else if (event.key === 'Enter') void confirm()
})
addEventListener('pagehide', () => { finished = true; stopLive(); image.removeAttribute('src'); URL.revokeObjectURL(objectUrl) }, { once: true })
