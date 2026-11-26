/* 选区覆盖层：可调整框选 + 截图/长截图/录屏动作。 */
import { displayRectInViewport, sameDisplay, toolbarPosition, viewportRectOnDisplay, visibleWorkArea } from './geometry.js'

const api = window.enestAux
const ownerAttached = new Promise(resolve => {
  const detach = api.onMessage(message => { if (message?.type === 'attached') { detach(); resolve() } })
})
const context = await api.getContext()
const data = context.data || {}
const display = data.display
let viewportBounds = context.viewportBounds
let viewport = { width: innerWidth, height: innerHeight }
let area = visibleWorkArea(display, viewportBounds, viewport)
const action = data.action
const actionLabels = { image: '截图', longshot: '长截图', record: '录屏' }

const selection = document.getElementById('selection')
const veil = document.getElementById('veil')
const maskTop = document.getElementById('mask-top')
const maskBottom = document.getElementById('mask-bottom')
const maskLeft = document.getElementById('mask-left')
const maskRight = document.getElementById('mask-right')
const badge = document.getElementById('badge')
const tools = document.getElementById('tools')
const hint = document.getElementById('hint')
const confirmButton = document.getElementById('confirm')
const cancelButton = document.getElementById('cancel')

const MIN_SIZE = 5
let rect = null
let mode = ''
let handleName = ''
let origin = null
let startPoint = null
let dragging = false
let finished = false
let audioButton = null
let ready = false
let handoffTimer = null

api.onMessage(message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'enest:surface-changed' && !finished) {
    if (!sameDisplay(display, message.state.display)) { void leave('failed', '显示器已变化，请重新框选'); return }
    if (message.state.interaction === 'passthrough') { void leave('cancel'); return }
    layout(message.state.viewportBounds ?? viewportBounds)
  }
})

function physicalBounds() {
  return rect ? viewportRectOnDisplay(rect, display, viewportBounds, viewport) : null
}

function layout(content = viewportBounds) {
  const previous = physicalBounds()
  viewportBounds = content
  viewport = { width: innerWidth, height: innerHeight }
  area = visibleWorkArea(display, content, viewport)
  if (previous) rect = displayRectInViewport(previous, display, content, viewport)
  hint.style.bottom = `${viewport.height - area.y - area.height + 16}px`
  draw()
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
  }
  const bounds = physicalBounds()
  const valid = bounds && bounds.width > 3 && bounds.height > 3
  badge.style.display = valid ? 'block' : 'none'
  tools.style.display = valid ? 'flex' : 'none'
  if (valid) {
    badge.textContent = `${bounds.width} × ${bounds.height}`
    const badgeX = clamp(rect.x, area.x + 6, area.x + area.width - badge.offsetWidth - 6)
    let badgeY = rect.y - 26
    if (badgeY < area.y + 6) badgeY = rect.y + 6
    badge.style.left = `${badgeX}px`
    badge.style.top = `${clamp(badgeY, area.y + 6, area.y + area.height - badge.offsetHeight - 6)}px`
    layoutTools()
    hint.classList.add('is-hidden')
  } else {
    hint.classList.remove('is-hidden')
  }
}

function layoutTools() {
  const position = toolbarPosition(rect, tools.getBoundingClientRect(), area)
  tools.style.left = `${position.x}px`
  tools.style.top = `${position.y}px`
}

function configureTools() {
  if (!Object.hasOwn(actionLabels, action)) throw new Error('选区动作无效')
  const label = actionLabels[action]
  const description = action === 'image' ? '截取当前画面' : `确认${label}范围`
  document.getElementById('confirm-label').textContent = label
  confirmButton.title = `${description}（Enter）`
  hint.textContent = `拖动选择区域 · Enter ${description} · Esc 取消`
  if (action !== 'record') return
  const controls = document.getElementById('record-audio').content.cloneNode(true)
  audioButton = controls.querySelector('button')
  audioButton.setAttribute('aria-pressed', String(data.withAudio === true))
  audioButton.addEventListener('click', () => {
    audioButton.setAttribute('aria-pressed', String(audioButton.getAttribute('aria-pressed') !== 'true'))
  })
  tools.prepend(controls)
}

void ownerAttached.then(async () => {
  try {
    if (!sameDisplay(display, context.display)) throw new Error('显示器已变化，请重新框选')
    if (finished) return
    configureTools()
    layout()
    ready = true
    document.body.dataset.ready = 'true'
    await api.post({ type: 'ready' })
  } catch (error) {
    await leave('failed', error.message || '选区不可用')
  }
})

async function closeSurface() {
  clearTimeout(handoffTimer)
  handoffTimer = null
  await api.close().catch(() => {})
}

async function confirmSelection() {
  if (!ready || finished || !rect) return
  const bounds = physicalBounds()
  if (!bounds || bounds.width < 4 || bounds.height < 4) return
  finished = true
  document.body.dataset.finished = 'true'
  handoffTimer = setTimeout(() => { void closeSurface() }, 1500)
  try {
    await api.post({ type: 'action', action, bounds, ...(audioButton ? { withAudio: audioButton.getAttribute('aria-pressed') === 'true' } : {}) })
  } finally { await closeSurface() }
}

async function leave(type, message) {
  if (finished) { await closeSurface(); return }
  finished = true
  document.body.dataset.finished = 'true'
  try { await api.post({ type, message }) } catch {} finally { await closeSurface() }
}

/* ---------- 指针交互 ---------- */
function begin(event) {
  if (!ready || finished || event.button !== 0) return
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
  else if (rect) rect = displayRectInViewport(physicalBounds(), display, viewportBounds, viewport)
  draw()
}

addEventListener('pointerdown', begin)
addEventListener('pointermove', move)
addEventListener('pointerup', end)
addEventListener('pointercancel', end)
addEventListener('resize', () => { if (!finished) layout() })
addEventListener('dblclick', event => {
  if (!event.target.closest?.('#tools') && inside({ x: event.clientX, y: event.clientY })) void confirmSelection()
})
addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    void leave('cancel')
  } else if (event.key === 'Enter' && !event.target.closest?.('#tools button')) {
    event.preventDefault()
    void confirmSelection()
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    rect = null
    draw()
  }
})
addEventListener('pagehide', () => {
  finished = true
  clearTimeout(handoffTimer)
}, { once: true })

confirmButton.addEventListener('click', () => { void confirmSelection() })
cancelButton.addEventListener('click', event => {
  event.stopPropagation()
  void leave('cancel')
})
tools.addEventListener('pointerdown', event => event.stopPropagation())
