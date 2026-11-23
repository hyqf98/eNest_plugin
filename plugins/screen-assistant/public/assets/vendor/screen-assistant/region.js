/* 选区覆盖层：可调整框选 + 截图/长截图/录屏动作。 */
const api = window.enestAux
const context = await api.getContext()
const data = context.data || {}
const display = context.display
const actions = Array.isArray(data.actions) && data.actions.length ? data.actions : ['image', 'longshot', 'record']

const shot = document.getElementById('shot')
const selection = document.getElementById('selection')
const veil = document.getElementById('veil')
const maskTop = document.getElementById('mask-top')
const maskBottom = document.getElementById('mask-bottom')
const maskLeft = document.getElementById('mask-left')
const maskRight = document.getElementById('mask-right')
const liveBox = document.getElementById('live')
const live = document.getElementById('live-video')
const badge = document.getElementById('badge')
const tools = document.getElementById('tools')
const hint = document.getElementById('hint')
const audioButton = document.getElementById('audio')
const shotButton = document.getElementById('shot-btn')
const longshotButton = document.getElementById('longshot')
const recordButton = document.getElementById('record')
const cancelButton = document.getElementById('cancel')

const CHUNK = 512 * 1024
const MIN_SIZE = 5
let rect = null
let mode = ''
let handleName = ''
let origin = null
let startPoint = null
let dragging = false
let finished = false
let busy = false
let withAudio = data.withAudio === true
let stream = null
let videoReady = false
let settleToken = 0

const acks = new Map()
let proceedResolve = null
let savedResolve = null

api.onMessage(message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'ack' && acks.has(message.seq)) {
    acks.get(message.seq)()
    acks.delete(message.seq)
  }
  if (message.type === 'saved') savedResolve?.(message)
  if (message.type === 'proceed') proceedResolve?.()
})

function waitSaved() {
  return new Promise(resolve => {
    const timer = setTimeout(() => { savedResolve = null; resolve(null) }, 6000)
    savedResolve = message => { clearTimeout(timer); savedResolve = null; resolve(message) }
  })
}

function sourceSize() {
  return {
    width: shot.naturalWidth || Math.round((display.width || 0) * (display.scaleFactor || 1)),
    height: shot.naturalHeight || Math.round((display.height || 0) * (display.scaleFactor || 1))
  }
}

function ratio() {
  const source = sourceSize()
  return { x: (source.width || innerWidth) / innerWidth, y: (source.height || innerHeight) / innerHeight }
}

function physicalBounds() {
  if (!rect) return null
  const scale = ratio()
  const x = Math.max(0, Math.min(innerWidth, rect.x))
  const y = Math.max(0, Math.min(innerHeight, rect.y))
  const width = Math.max(0, Math.min(innerWidth - x, rect.width))
  const height = Math.max(0, Math.min(innerHeight - y, rect.height))
  return {
    x: Math.round(x * scale.x),
    y: Math.round(y * scale.y),
    width: Math.round(width * scale.x),
    height: Math.round(height * scale.y)
  }
}

function point(event) {
  return {
    x: Math.max(0, Math.min(innerWidth, event.clientX)),
    y: Math.max(0, Math.min(innerHeight, event.clientY))
  }
}

function normalize(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

function inside(value) {
  return rect && value.x >= rect.x && value.x <= rect.x + rect.width && value.y >= rect.y && value.y <= rect.y + rect.height
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function draw() {
  const active = !!rect && rect.width >= 1 && rect.height >= 1
  selection.style.display = active ? 'block' : 'none'
  veil.style.display = active ? 'block' : 'none'
  if (active) {
    selection.style.left = `${rect.x}px`
    selection.style.top = `${rect.y}px`
    selection.style.width = `${rect.width}px`
    selection.style.height = `${rect.height}px`
    Object.assign(maskTop.style, { left: '0px', top: '0px', width: `${innerWidth}px`, height: `${Math.max(0, rect.y)}px` })
    Object.assign(maskBottom.style, { left: '0px', top: `${rect.y + rect.height}px`, width: `${innerWidth}px`, height: `${Math.max(0, innerHeight - rect.y - rect.height)}px` })
    Object.assign(maskLeft.style, { left: '0px', top: `${rect.y}px`, width: `${Math.max(0, rect.x)}px`, height: `${rect.height}px` })
    Object.assign(maskRight.style, { left: `${rect.x + rect.width}px`, top: `${rect.y}px`, width: `${Math.max(0, innerWidth - rect.x - rect.width)}px`, height: `${rect.height}px` })
    liveBox.style.transform = `translate(${-rect.x}px, ${-rect.y}px)`
    liveBox.style.display = videoReady && !dragging ? 'block' : 'none'
    live.style.width = `${innerWidth}px`
    live.style.height = `${innerHeight}px`
  } else {
    liveBox.style.display = 'none'
  }
  const bounds = physicalBounds()
  const valid = bounds && bounds.width > 3 && bounds.height > 3
  badge.style.display = valid ? 'block' : 'none'
  tools.style.display = valid ? 'flex' : 'none'
  if (valid) {
    badge.textContent = `${bounds.width} × ${bounds.height}`
    let badgeX = Math.min(innerWidth - 132, rect.x)
    let badgeY = rect.y - 26
    if (badgeY < 6) badgeY = rect.y + 6
    badge.style.left = `${Math.max(6, badgeX)}px`
    badge.style.top = `${badgeY}px`
    layoutTools()
    hint.classList.add('is-hidden')
  } else {
    hint.classList.remove('is-hidden')
  }
}

function layoutTools() {
  const width = tools.offsetWidth || 320
  const height = tools.offsetHeight || 38
  let x = rect.x + rect.width - width
  let y = rect.y + rect.height + 8
  if (y + height > innerHeight - 8) y = rect.y - height - 8
  if (y < 8) y = clamp(rect.y + rect.height - height - 8, 8, innerHeight - height - 8)
  x = clamp(x, 8, innerWidth - width - 8)
  tools.style.left = `${x}px`
  tools.style.top = `${y}px`
}

function syncButtons() {
  shotButton.hidden = !actions.includes('image')
  longshotButton.hidden = !actions.includes('longshot')
  recordButton.hidden = !actions.includes('record')
  audioButton.hidden = !actions.includes('record')
  audioButton.setAttribute('aria-pressed', String(withAudio))
  audioButton.querySelector('#wave').style.opacity = withAudio ? '1' : '.35'
}

function preferredAction() {
  return data.prefer === 'record' || data.prefer === 'longshot' ? data.prefer : 'image'
}

function highlight() {
  const prefer = preferredAction()
  shotButton.classList.toggle('primary', prefer === 'image')
  recordButton.classList.toggle('primary', prefer === 'record')
  longshotButton.classList.toggle('primary', prefer === 'longshot')
  hint.textContent = prefer === 'record'
    ? '拖动选择区域 · Enter 开始录屏 · Esc 取消'
    : prefer === 'longshot'
      ? '拖动选择区域 · Enter 长截图 · Esc 取消'
      : '拖动选择区域 · Enter 截图 · Esc 取消'
}

syncButtons()
highlight()

try {
  shot.src = String(data.shot || '')
  if (shot.complete) draw()
  else shot.onload = () => draw()
} catch {
  await api.close()
  throw new Error('背景截图不可用')
}

/* ---------- 实时画面（用于 WYSIWYG 取帧） ---------- */
async function startLive() {
  if (stream || videoReady || !context.capture || finished) return
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 4096 }, height: { max: 4096 }, frameRate: { max: 30 } },
      audio: false
    })
    for (const track of stream.getTracks()) track.addEventListener('ended', stopLive, { once: true })
    live.srcObject = stream
    await live.play()
    await new Promise(resolve => {
      if (live.readyState >= 2 && live.videoWidth) return resolve()
      live.addEventListener('loadeddata', resolve, { once: true })
      setTimeout(resolve, 900)
    })
    if (!live.videoWidth || finished) { stopLive(); return }
    videoReady = true
    draw()
  } catch {
    stopLive()
  }
}

function stopLive() {
  videoReady = false
  liveBox.style.display = 'none'
  if (stream) {
    stream.getTracks().forEach(track => track.stop())
    stream = null
  }
  live.srcObject = null
}

function settleFrames() {
  const token = ++settleToken
  return new Promise(resolve => {
    let count = 0
    const tick = () => {
      if (finished || token !== settleToken) return resolve(false)
      count += 1
      if (count >= 3) return resolve(true)
      if (live.requestVideoFrameCallback) live.requestVideoFrameCallback(tick)
      else setTimeout(tick, 33)
    }
    if (live.requestVideoFrameCallback) live.requestVideoFrameCallback(tick)
    else setTimeout(tick, 33)
  })
}

function cropCanvas(bounds) {
  if (!videoReady || !live.videoWidth) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, bounds.width)
  canvas.height = Math.max(1, bounds.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const sourceWidth = Math.round((display.width || 0) * (display.scaleFactor || 1))
  const sourceHeight = Math.round((display.height || 0) * (display.scaleFactor || 1))
  const scaleX = live.videoWidth / (sourceWidth || live.videoWidth)
  const scaleY = live.videoHeight / (sourceHeight || live.videoHeight)
  try {
    ctx.drawImage(live, bounds.x * scaleX, bounds.y * scaleY, bounds.width * scaleX, bounds.height * scaleY, 0, 0, canvas.width, canvas.height)
    return canvas
  } catch {
    return null
  }
}

function thumbOf(canvas) {
  const maxEdge = 320
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height))
  const target = document.createElement('canvas')
  target.width = Math.max(1, Math.round(canvas.width * scale))
  target.height = Math.max(1, Math.round(canvas.height * scale))
  target.getContext('2d').drawImage(canvas, 0, 0, target.width, target.height)
  return target.toDataURL('image/jpeg', 0.72)
}

function waitAck(seq) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { acks.delete(seq); reject(new Error('写入确认超时')) }, 12000)
    acks.set(seq, () => { clearTimeout(timer); resolve() })
  })
}

async function sendImage() {
  if (finished || busy || !rect) return
  const bounds = physicalBounds()
  if (!bounds || bounds.width < 4 || bounds.height < 4) return
  busy = true
  finished = true
  try {
    if (videoReady) await settleFrames()
    const canvas = cropCanvas(bounds)
    if (!canvas) {
      await api.post({ type: 'fallback', bounds })
      await api.close()
      return
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('PNG 编码失败')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    await api.post({
      type: 'image-start',
      bytes: bytes.byteLength,
      width: canvas.width,
      height: canvas.height,
      bounds,
      thumb: thumbOf(canvas)
    })
    for (let offset = 0, seq = 0; offset < bytes.length; offset += CHUNK, seq += 1) {
      const slice = bytes.slice(offset, offset + CHUNK)
      await api.post({ type: 'image-chunk', seq, bytes: slice.buffer })
      await waitAck(seq)
    }
    await api.post({ type: 'image-end', width: canvas.width, height: canvas.height, bounds })
    await waitSaved()
    stopLive()
    await api.close()
  } catch {
    try { await api.post({ type: 'cancel' }) } catch { /* window may be gone */ }
    await api.close()
  }
}

async function chooseAction(action) {
  if (finished || busy || !rect) return
  if (action === 'image') { await sendImage(); return }
  if (!actions.includes(action)) return
  const bounds = physicalBounds()
  if (!bounds || bounds.width < 4 || bounds.height < 4) return
  busy = true
  finished = true
  tools.style.display = 'none'
  hint.textContent = '正在准备…'
  hint.classList.remove('is-hidden')
  try {
    await api.post({ type: 'action', action, bounds, withAudio })
    await new Promise(resolve => {
      proceedResolve = resolve
      setTimeout(resolve, 6000)
    })
  } finally {
    stopLive()
    await api.close()
  }
}

/* ---------- 指针交互 ---------- */
function begin(event) {
  if (finished || busy || event.button !== 0) return
  if (event.target.closest?.('#tools')) return
  const pos = point(event)
  const handleElement = event.target.closest?.('.handle')
  if (handleElement && rect) {
    mode = 'resize'
    handleName = handleElement.dataset.h || ''
    origin = { ...rect }
  } else if (rect && inside(pos)) {
    mode = 'move'
    origin = { ...rect }
    startPoint = pos
  } else {
    mode = 'new'
    startPoint = pos
    rect = { x: pos.x, y: pos.y, width: 0, height: 0 }
  }
  dragging = true
  document.body.setPointerCapture?.(event.pointerId)
  void startLive()
  draw()
  event.preventDefault()
}

function move(event) {
  if (!dragging) return
  const pos = point(event)
  if (mode === 'new') {
    rect = normalize(startPoint, pos)
  } else if (mode === 'move' && origin) {
    rect = {
      ...origin,
      x: clamp(origin.x + pos.x - startPoint.x, 0, innerWidth - origin.width),
      y: clamp(origin.y + pos.y - startPoint.y, 0, innerHeight - origin.height)
    }
  } else if (mode === 'resize' && origin) {
    let left = origin.x, top = origin.y, right = origin.x + origin.width, bottom = origin.y + origin.height
    if (handleName.includes('w')) left = clamp(pos.x, 0, right - MIN_SIZE)
    if (handleName.includes('e')) right = clamp(pos.x, left + MIN_SIZE, innerWidth)
    if (handleName.includes('n')) top = clamp(pos.y, 0, bottom - MIN_SIZE)
    if (handleName.includes('s')) bottom = clamp(pos.y, top + MIN_SIZE, innerHeight)
    rect = { x: left, y: top, width: right - left, height: bottom - top }
  }
  draw()
}

function end(event) {
  if (!dragging) return
  dragging = false
  mode = ''
  handleName = ''
  try { document.body.releasePointerCapture?.(event.pointerId) } catch { /* ignore */ }
  if (rect && (rect.width < MIN_SIZE || rect.height < MIN_SIZE)) rect = null
  draw()
}

addEventListener('pointerdown', begin)
addEventListener('pointermove', move)
addEventListener('pointerup', end)
addEventListener('pointercancel', end)
addEventListener('dblclick', event => {
  if (inside({ x: event.clientX, y: event.clientY })) void chooseAction(preferredAction())
})
addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    finished = true
    stopLive()
    void api.post({ type: 'cancel' }).catch(() => {})
    void api.close()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    void chooseAction(preferredAction())
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    rect = null
    draw()
  }
})
addEventListener('pagehide', () => {
  finished = true
  stopLive()
  shot.removeAttribute('src')
}, { once: true })

shotButton.addEventListener('click', event => { event.stopPropagation(); void sendImage() })
longshotButton.addEventListener('click', event => { event.stopPropagation(); void chooseAction('longshot') })
recordButton.addEventListener('click', event => { event.stopPropagation(); void chooseAction('record') })
cancelButton.addEventListener('click', event => {
  event.stopPropagation()
  finished = true
  stopLive()
  void api.post({ type: 'cancel' }).catch(() => {})
  void api.close()
})
audioButton.addEventListener('click', event => {
  event.stopPropagation()
  withAudio = !withAudio
  audioButton.setAttribute('aria-pressed', String(withAudio))
  audioButton.querySelector('#wave').style.opacity = withAudio ? '1' : '.35'
})
tools.addEventListener('pointerdown', event => event.stopPropagation())
