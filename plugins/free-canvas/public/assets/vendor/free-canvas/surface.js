import { calculate } from './calculator.js'

const bridge = window.enestAux, get = id => document.getElementById(id)
const names = { clock: '时钟', note: '便签', tasks: '待办', timer: '番茄钟', calculator: '计算器', monitor: '进程概览' }
const views = new Map(), changes = new Map(), samples = new Map()
let board, sequence = 0, nextRect, ticker, statusTimer
const element = (tag, text, className) => {
  const node = document.createElement(tag)
  if (text != null) node.textContent = text
  if (className) node.className = className
  return node
}
const button = (text, action, className) => {
  const node = element('button', text, className); node.type = 'button'; if (action) node.addEventListener('click', action); return node
}
const status = text => { clearTimeout(statusTimer); get('status').textContent = text; statusTimer = setTimeout(() => { get('status').textContent = '' }, 4500) }
const send = value => { void bridge.post(value).catch(error => status(error.message)) }
const size = (node, rect) => Object.assign(node.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
const cardById = id => board?.cards.find(item => item.id === id)
function edit(card, value) {
  card.data = value; const revision = ++sequence; changes.set(card.id, revision)
  send({ type: 'card.data', id: card.id, value, sequence: revision })
}

function drag(node, begin) {
  node.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return
    const gesture = begin(event)
    if (!gesture) return
    event.preventDefault(); event.stopPropagation(); node.setPointerCapture(event.pointerId)
    function move(next) { if (next.pointerId === event.pointerId) gesture.move(next) }
    function finish(next) {
      if (next.pointerId !== event.pointerId) return
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', finish); node.removeEventListener('pointercancel', finish); node.removeEventListener('lostpointercapture', finish)
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId)
      if (next.type === 'pointerup') gesture.end(next); else gesture.cancel?.()
    }
    node.addEventListener('pointermove', move); node.addEventListener('pointerup', finish); node.addEventListener('pointercancel', finish); node.addEventListener('lostpointercapture', finish)
  })
}

function draw(node, chosen) {
  drag(node, start => {
    if (start.target !== node) return
    const area = node.getBoundingClientRect(), left = start.clientX - area.left, top = start.clientY - area.top
    const preview = element('div', null, 'outline'); node.append(preview)
    const rect = next => {
      const right = Math.max(0, Math.min(area.width, next.clientX - area.left)), bottom = Math.max(0, Math.min(area.height, next.clientY - area.top))
      return { x: Math.min(left, right), y: Math.min(top, bottom), width: Math.abs(left - right), height: Math.abs(top - bottom) }
    }
    size(preview, rect(start))
    return { move: next => size(preview, rect(next)), end(next) { const result = rect(next); preview.remove(); if (result.width > 8 && result.height > 8) chosen(result) }, cancel: () => preview.remove() }
  })
}

function pick(rect) { nextRect = rect; get('palette').showModal(); get('choices').firstElementChild?.focus() }
function cardGesture(view, handle, resize) {
  handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown')
  handle.addEventListener('keydown', event => {
    const offsets = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, offset = offsets[event.key]
    if (!offset || event.isComposing) return
    const card = cardById(view.id); if (!card) return
    event.preventDefault(); const delta = event.shiftKey ? 24 : 4, current = card.rect
    card.rect = resize ? { ...current, width: Math.max(140, current.width + offset[0] * delta), height: Math.max(96, current.height + offset[1] * delta) } : { ...current, x: Math.max(0, current.x + offset[0] * delta), y: Math.max(0, current.y + offset[1] * delta) }
    size(view.root, card.rect); send({ type: 'card.move', id: card.id, rect: card.rect })
  })
  drag(handle, start => {
    const card = cardById(view.id); if (!card) return
    const original = { ...card.rect }
    const rect = next => {
      const dx = next.clientX - start.clientX, dy = next.clientY - start.clientY
      return resize ? { ...original, width: Math.max(140, original.width + dx), height: Math.max(96, original.height + dy) } : { ...original, x: Math.max(0, original.x + dx), y: Math.max(0, original.y + dy) }
    }
    return { move: next => size(view.root, rect(next)), end(next) { card.rect = rect(next); size(view.root, card.rect); send({ type: 'card.move', id: card.id, rect: card.rect }) }, cancel: () => size(view.root, original) }
  })
}

function initFace(view, kind) {
  const face = view.face, current = () => cardById(view.id)
  if (kind === 'clock') {
    const time = element('time', '', 'clock'), date = element('span', '', 'caption'); face.append(time, date)
    view.tick = () => { const now = new Date(); time.textContent = now.toLocaleTimeString('zh-CN', { hour12: false }); date.textContent = now.toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' }) }
  } else if (kind === 'note' || kind === 'calculator') {
    const note = kind === 'note', field = note ? 'text' : 'expression', input = element(note ? 'textarea' : 'input'), result = element('output')
    input.maxLength = note ? 4000 : 160; input.placeholder = note ? '写点什么…' : '例如 (12 + 8) × 3'; input.setAttribute('aria-label', note ? '便签内容' : '算式'); face.append(input)
    if (!note) face.append(result)
    const evaluate = () => { if (!note) result.textContent = calculate(input.value.replaceAll('×', '*').replaceAll('÷', '/')) }
    input.oninput = () => { edit(current(), { [field]: input.value }); evaluate() }
    view.update = () => { const value = current().data[field] || ''; if (input.value !== value) input.value = value; evaluate() }
  } else if (kind === 'timer') {
    const time = element('output'), row = element('div', null, 'row')
    const toggle = button('开始', () => {
      const card = current(), now = Date.now(), data = card.data
      if (data.end > now) edit(card, { end: 0, left: Math.max(0, data.end - now) })
      else { const left = data.end || !data.left ? 25 * 60000 : data.left; edit(card, { end: now + left, left }) }
      view.tick()
    })
    row.append(toggle, button('重置', () => { edit(current(), { end: 0, left: 25 * 60000 }); view.tick() })); face.append(time, row)
    view.tick = () => { const { end, left } = current().data; const seconds = Math.ceil(Math.max(0, end ? end - Date.now() : left) / 1000); time.textContent = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; toggle.textContent = end > Date.now() ? '暂停' : end ? '再来一次' : left < 25 * 60000 ? '继续' : '开始' }
  } else if (kind === 'tasks') {
    const rows = element('div'), form = element('form', null, 'row'), input = element('input'), add = element('button', '添加')
    input.maxLength = 200; input.placeholder = '新的待办'; input.setAttribute('aria-label', '新的待办'); form.append(input, add); face.append(form, rows)
    function write(updated) { edit(current(), { rows: updated }); view.update() }
    form.onsubmit = event => { event.preventDefault(); const text = input.value.trim(), items = current().data.rows; if (!text) return; if (items.length >= 32) { status('每个组件最多 32 条待办'); return } write([...items, { id: crypto.randomUUID(), text, done: false }]); input.value = '' }
    view.update = () => {
      const items = current().data.rows, signature = JSON.stringify(items); if (view.signature === signature) return; view.signature = signature
      rows.replaceChildren(...items.map(item => {
        const row = element('div', null, 'row'), label = element('label'), check = element('input'); check.type = 'checkbox'; check.checked = item.done
        check.onchange = () => write(current().data.rows.map(task => task.id === item.id ? { ...task, done: check.checked } : task))
        const remove = button('×', () => write(current().data.rows.filter(task => task.id !== item.id))); remove.setAttribute('aria-label', `删除待办 ${item.text}`)
        label.append(check, element('span', item.text)); row.append(label, remove); return row
      }))
    }
  } else if (kind === 'monitor') {
    const summary = element('span', '', 'caption'), sample = button('采样', () => send({ type: 'sample', id: view.id })); face.append(sample, summary)
    view.update = () => { summary.textContent = samples.get(view.id) || '只在点击时读取进程统计。' }
  }
}

function applyBoard(next, acknowledged, failed = false) {
  for (const card of next.cards) {
    const pending = changes.get(card.id), previous = cardById(card.id)
    if (pending != null && acknowledged === pending) changes.delete(card.id)
    else if (pending != null && previous) card.data = previous.data
  }
  board = next; get('title').textContent = board.title; get('hint').hidden = board.cards.length > 0
  const ids = new Set(board.cards.map(card => card.id))
  for (const [id, view] of views) if (!ids.has(id)) { view.root.remove(); views.delete(id); changes.delete(id); samples.delete(id) }
  for (const card of board.cards) {
    let view = views.get(card.id)
    if (!view) {
      const root = element('article', null, 'card'), header = element('header'), handle = button(names[card.kind], null, 'drag'), grip = button('◢', null, 'resize'), face = element('div', null, 'face')
      grip.setAttribute('aria-label', '拖动以调整组件大小'); handle.title = '拖动以移动组件'; const remove = button('×', () => { if (window.confirm(`移除「${names[card.kind]}」？`)) send({ type: 'card.remove', id: card.id }) }, 'remove'); remove.setAttribute('aria-label', '移除组件')
      root.dataset.kind = card.kind; view = { id: card.id, root, face }; views.set(card.id, view); header.append(handle, remove); root.append(header, face, grip); get('space').append(root)
      initFace(view, card.kind); cardGesture(view, handle, false); cardGesture(view, grip, true)
    }
    size(view.root, card.rect); view.update?.(); view.tick?.()
  }
  get('space').style.width = `${Math.max(0,...board.cards.map(card => card.rect.x + card.rect.width))}px`; get('space').style.height = `${Math.max(0,...board.cards.map(card => card.rect.y + card.rect.height))}px`
  updateTicker()
  if (failed) status('保存失败，已恢复到已提交内容。')
}

function updateTicker() {
  const needed = !document.hidden && board?.cards.some(card => card.kind === 'clock' || card.kind === 'timer' && card.data.end > Date.now())
  if (!needed) { clearInterval(ticker); ticker = null; return }
  if (!ticker) ticker = setInterval(() => { for (const view of views.values()) view.tick?.(); updateTicker() }, 1000)
}

function setupBoard(initial) {
  get('board').hidden = false
  draw(get('space'), pick)
  for (const [kind, label] of Object.entries(names)) get('choices').append(button(label, () => { if (nextRect) send({ type: 'card.add', kind, rect: nextRect }); nextRect = null; get('palette').close() }))
  get('cancel').onclick = () => get('palette').close(); get('add').onclick = () => pick({ x: get('viewport').scrollLeft + 12, y: get('viewport').scrollTop + 12, width: Math.min(260, get('viewport').clientWidth - 24), height: 150 }); get('close').onclick = () => send({ type: 'window.close' })
  for (const [id, resize] of [['move', false], ['window-size', true]]) drag(get(id), start => {
    const original = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }
    const rect = next => { const dx = next.screenX - start.screenX, dy = next.screenY - start.screenY; return resize ? { ...original, width: Math.max(240, original.width + dx), height: Math.max(160, original.height + dy) } : { ...original, x: original.x + dx, y: original.y + dy } }
    return { move(next) { const current = rect(next); get('status').textContent = resize ? `${current.width} × ${current.height}` : `${current.x}, ${current.y}` }, end(next) { get('status').textContent = ''; send({ type: 'window.bounds', rect: rect(next) }) }, cancel() { get('status').textContent = '' } }
  })
  applyBoard(initial)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const view of views.values()) view.tick?.(); updateTicker() }); window.addEventListener('pagehide', () => clearInterval(ticker), { once: true })
}

async function boot() {
  const context = await bridge.getContext()
  if (context.data.mode === 'select') {
    get('selector').hidden = false; draw(get('selector'), rect => { if (rect.width >= 60 && rect.height >= 40) send({ type: 'region', rect }); else status('请框选更大的区域') }); document.addEventListener('keydown', event => { if (event.key === 'Escape') void bridge.close() }); return
  }
  setupBoard(context.data.board)
  bridge.onMessage(data => {
    if (data?.type === 'board' || (data?.type === 'error' && data.board)) applyBoard(data.board, data.sequence, data.type === 'error')
    if (data?.type === 'error') status(data.message || '操作失败')
    if (data?.type === 'sample') { samples.set(data.id, `${data.count} 个进程 · CPU 合计 ${data.cpu.toFixed(1)}% · RSS 合计 ${(data.rss / 1024 / 1024).toFixed(2)} GiB`); views.get(data.id)?.update?.() }
  })
}
void boot().catch(error => status(error.message))
