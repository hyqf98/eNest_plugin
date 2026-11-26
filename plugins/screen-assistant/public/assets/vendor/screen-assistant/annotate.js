import { EditHistory, applyOperation, clamp, renderPreview, selection } from './annotate-core.js'

const api = window.enestAux
const ownerAttached = new Promise(resolve => {
  const detach = api.onMessage(message => { if (message?.type === 'attached') { detach(); resolve() } })
})
const stage = document.getElementById('stage')
const base = document.getElementById('base')
const ink = document.getElementById('ink')
const textInput = document.getElementById('text-input')
const bar = document.getElementById('bar')
const swatches = document.getElementById('swatches')
const undoButton = document.getElementById('undo')
const redoButton = document.getElementById('redo')
const doneButton = document.getElementById('done')
const cancelButton = document.getElementById('cancel')
const imageSize = document.getElementById('size')

const COLORS = ['#e45d50', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827']
const CHUNK = 512 * 1024
const CHUNK_INTERVAL_MS = 80
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const history = new EditHistory(40)
let tool = 'rect'
let color = COLORS[0]
let lineWidth = 6
let start = null
let pointerId = null
let penPoints = null
let textBox = null
let finished = false
let ready = false
let preview = false

/* ---------- 与主页面的消息 ---------- */
const acks = new Map()
let savedResolve = null
api.onMessage(message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'ack' && acks.has(message.seq)) {
    acks.get(message.seq)()
    acks.delete(message.seq)
  }
  if (message.type === 'saved') savedResolve?.(message)
})

function waitAck(seq) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { acks.delete(seq); reject(new Error('写入确认超时')) }, 12000)
    acks.set(seq, () => { clearTimeout(timer); resolve() })
  })
}

function waitSaved() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { savedResolve = null; reject(new Error('保存确认超时，请查看媒体库')) }, 20_000)
    savedResolve = message => {
      clearTimeout(timer)
      savedResolve = null
      if (message.ok) resolve()
      else reject(new Error(message.message || '标注图片未保存'))
    }
  })
}

async function post(message) {
  try { await api.post(message) }
  catch (error) {
    if (!String(error?.message || error).includes('Auxiliary message rate limit reached')) throw error
    await delay(1050)
    await api.post(message)
  }
}

/* ---------- 画布 ---------- */
const original = new Image()

function drawPen(ctx, points, strokeColor, width) {
  const first = points[0]
  ctx.save()
  ctx.beginPath()
  if (points.length === 1) {
    ctx.fillStyle = strokeColor
    ctx.arc(first.x, first.y, width / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = width
    ctx.lineCap = ctx.lineJoin = 'round'
    ctx.moveTo(first.x, first.y)
    for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y)
    ctx.stroke()
  }
  ctx.restore()
}

function redraw() {
  const ctx = base.getContext('2d')
  ctx.clearRect(0, 0, base.width, base.height)
  if (ready) ctx.drawImage(original, 0, 0)
  for (const operation of history.current()) {
    if (operation.type === 'pen') drawPen(ctx, operation.points, operation.color, operation.lineWidth)
    else applyOperation(base, operation)
  }
  ink.getContext('2d').clearRect(0, 0, ink.width, ink.height)
  syncControls()
}

function syncControls() {
  undoButton.disabled = !history.canUndo
  redoButton.disabled = !history.canRedo
}

/** 鼠标的逻辑坐标换算成画布的物理像素坐标。 */
function point(event) {
  const rect = ink.getBoundingClientRect()
  return {
    x: clamp((event.clientX - rect.left) * ink.width / rect.width, 0, ink.width),
    y: clamp((event.clientY - rect.top) * ink.height / rect.height, 0, ink.height)
  }
}

/* ---------- 工具栏状态 ---------- */
function syncTools() {
  for (const button of bar.querySelectorAll('.tool[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool))
  ink.dataset.tool = tool
  for (const button of bar.querySelectorAll('.width')) button.setAttribute('aria-pressed', String(Number(button.dataset.width) === lineWidth))
}

for (const value of COLORS) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'swatch'
  button.style.background = value
  button.title = value
  button.setAttribute('aria-label', `颜色 ${value}`)
  button.setAttribute('aria-pressed', String(value === color))
  button.addEventListener('click', () => {
    color = value
    for (const swatch of swatches.children) swatch.setAttribute('aria-pressed', String(swatch === button))
  })
  swatches.appendChild(button)
}

function chooseTool(next) {
  if (!ready || finished || preview) return
  if (start) cancelDraw()
  commitText()
  tool = next
  syncTools()
}

for (const button of bar.querySelectorAll('.tool[data-tool]')) {
  button.addEventListener('click', () => chooseTool(button.dataset.tool))
}
for (const button of bar.querySelectorAll('.width')) {
  button.addEventListener('click', () => { lineWidth = Number(button.dataset.width); syncTools() })
}
undoButton.addEventListener('click', undo)
redoButton.addEventListener('click', redo)

function undo() { history.undo(); redraw() }
function redo() { history.redo(); redraw() }

/* ---------- 绘制 ---------- */
function commit(operation) {
  if (!history.push(operation)) return
  redraw()
}

function cancelDraw() {
  start = null
  penPoints = null
  if (pointerId !== null && ink.hasPointerCapture?.(pointerId)) ink.releasePointerCapture(pointerId)
  pointerId = null
  ink.getContext('2d').clearRect(0, 0, ink.width, ink.height)
}

function openTextBox(at) {
  const fontSize = Math.max(1, Math.round(16 * base.width / stage.getBoundingClientRect().width))
  textBox = { point: at, size: fontSize }
  textInput.style.display = 'block'
  textInput.style.left = `min(${at.x / base.width * 100}%, max(0px, 100% - 160px))`
  textInput.style.top = `min(${at.y / base.height * 100}%, max(0px, 100% - 28px))`
  textInput.style.fontSize = '16px'
  textInput.value = ''
  requestAnimationFrame(() => textInput.focus())
}

function commitText() {
  if (!textBox) return
  const value = textInput.value.trim()
  const target = textBox
  textBox = null
  textInput.style.display = 'none'
  if (value) {
    commit({ type: 'text', x: target.point.x, y: target.point.y, text: value, color, size: target.size })
  }
}

ink.addEventListener('pointerdown', event => {
  if (!ready || finished || preview || event.button !== 0 || textBox || pointerId !== null) return
  event.preventDefault()
  if (tool === 'text') {
    openTextBox(point(event))
    return
  }
  start = point(event)
  pointerId = event.pointerId
  ink.setPointerCapture(event.pointerId)
  if (tool === 'pen') {
    penPoints = [start]
    drawPen(ink.getContext('2d'), penPoints, color, lineWidth)
  }
})

function extendPen(end) {
  const previous = penPoints.at(-1)
  if (Math.hypot(end.x - previous.x, end.y - previous.y) < 0.75) return
  if (penPoints.length >= 8192) penPoints = penPoints.filter((_, index) => index % 2 === 0)
  penPoints.push(end)
  drawPen(ink.getContext('2d'), [previous, end], color, lineWidth)
}

ink.addEventListener('pointermove', event => {
  if (!start || event.pointerId !== pointerId) return
  const end = point(event)
  if (penPoints) extendPen(end)
  else renderPreview(ink.getContext('2d'), tool, start, end, color, lineWidth)
})

function finishDraw(event) {
  if (!start || event.pointerId !== pointerId) return
  const end = point(event)
  if (penPoints) {
    extendPen(end)
    const points = penPoints
    cancelDraw()
    commit({ type: 'pen', points, color, lineWidth })
    return
  }
  const from = start
  const box = selection(from, end, ink.width, ink.height)
  const toolNow = tool
  cancelDraw()
  if (toolNow === 'arrow') {
    if (Math.hypot(from.x - end.x, from.y - end.y) > 3) commit({ type: 'arrow', start: from, end, color, lineWidth })
  } else if (box.width >= 3 && box.height >= 3) {
    commit({ type: toolNow, ...box, color, lineWidth })
  }
}

ink.addEventListener('pointerup', finishDraw)
ink.addEventListener('lostpointercapture', event => { if (pointerId === event.pointerId) cancelDraw() })
ink.addEventListener('pointercancel', event => { if (pointerId === event.pointerId) cancelDraw() })
addEventListener('blur', () => { if (start) cancelDraw() })

textInput.addEventListener('keydown', event => {
  event.stopPropagation()
  if (event.isComposing) return
  if (event.key === 'Enter') { event.preventDefault(); commitText() }
  else if (event.key === 'Escape') { event.preventDefault(); textBox = null; textInput.style.display = 'none' }
})
textInput.addEventListener('blur', commitText)

addEventListener('keydown', event => {
  if (finished || event.isComposing) return
  if (event.target === textInput) return
  const key = event.key.toLowerCase()
  if (preview) {
    if (key === 'escape') { event.preventDefault(); void cancel() }
    return
  }
  if ((event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (key === 'escape') { event.preventDefault(); void cancel(); return }
  if (key === 'enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void done(); return }
  const shortcut = { p: 'pen', r: 'rect', a: 'arrow', t: 'text', m: 'mosaic' }[key]
  if (shortcut) { event.preventDefault(); chooseTool(shortcut) }
})

/* ---------- 完成与取消 ---------- */

/** 完成的图片分块回传给主页面，由主页面写剪贴板并存入媒体库。 */
async function done() {
  if (!ready || finished || start || preview) return
  commitText()
  finished = true
  doneButton.disabled = true
  cancelButton.disabled = true
  bar.inert = true
  imageSize.textContent = '正在保存…'
  try {
    await post({ type: 'saving' })
    const blob = await new Promise(resolve => base.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('PNG 编码失败')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    await post({ type: 'image-start', bytes: bytes.byteLength, width: base.width, height: base.height })
    let lastChunkAt = -Infinity
    for (let offset = 0, seq = 0; offset < bytes.length; offset += CHUNK, seq += 1) {
      const wait = lastChunkAt + CHUNK_INTERVAL_MS - performance.now()
      if (wait > 0) await delay(wait)
      lastChunkAt = performance.now()
      await Promise.all([waitAck(seq), post({ type: 'image-chunk', seq, bytes: bytes.slice(offset, offset + CHUNK).buffer })])
    }
    await Promise.all([waitSaved(), post({ type: 'image-end', width: base.width, height: base.height })])
  } catch (error) {
    await post({ type: 'failed', message: error.message || '标注保存失败' }).catch(() => {})
  } finally {
    await api.close().catch(() => {})
  }
}

async function cancel() {
  return leave('cancel')
}

async function leave(type, message) {
  if (finished) return
  finished = true
  if (type !== 'cancel') await ownerAttached
  await post({ type, message }).catch(() => {})
  await api.close().catch(() => {})
}

function syncMode() {
  document.title = preview ? '截图预览' : '截图标注'
  document.querySelector('#titlebar h1').textContent = document.title
  cancelButton.textContent = preview ? '关闭' : '取消'
  cancelButton.title = `${cancelButton.textContent}（Esc）`
  doneButton.textContent = preview ? '标注' : '完成并复制'
  doneButton.title = preview ? '标注这张截图' : '完成并复制（Enter）'
  doneButton.disabled = !ready
  bar.inert = !ready || preview
  bar.style.display = preview ? 'none' : ''
  base.style.display = preview ? 'none' : ''
  ink.style.display = preview ? 'none' : ''
  if (preview) {
    original.alt = '截图副本'
    original.draggable = false
    Object.assign(original.style, { display: 'block', width: '100%', height: '100%' })
    stage.prepend(original)
  } else {
    original.remove()
    base.width = ink.width = original.naturalWidth
    base.height = ink.height = original.naturalHeight
    redraw()
  }
}

doneButton.addEventListener('click', () => {
  if (preview) { preview = false; syncMode() }
  else void done()
})
cancelButton.addEventListener('click', () => { void cancel() })

/* ---------- 启动 ---------- */
addEventListener('pagehide', () => { original.removeAttribute('src') }, { once: true })

void ownerAttached.then(async () => {
  try {
    const { data } = await api.getContext()
    preview = data?.preview === true
    if (!/^data:image\/png;base64,/.test(String(data?.shot || ''))) throw new Error('截图数据不可用')
    original.src = data.shot
    await original.decode()
    if (finished) return
    stage.style.setProperty('--image-ratio', String(original.naturalWidth / original.naturalHeight))
    imageSize.textContent = `${original.naturalWidth} × ${original.naturalHeight} px`
    ready = true
    syncTools()
    syncMode()
    document.body.dataset.ready = 'true'
    await post({ type: 'ready' })
  } catch (error) {
    await leave('failed', error.message || '标注编辑窗无法启动')
  }
})
