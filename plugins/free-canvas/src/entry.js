import '@enest/plugin-kit/style.css'
import './manager.css'
import { STORAGE_KEY, MAX_BOARDS, MAX_CARDS, kinds, bounds, content, restore, importGeometry, newBoard, newCard } from './model.js'

const api = window.enest
const entry = 'assets/vendor/free-canvas/surface.html'
const get = id => document.getElementById(id)
const message = text => { get('status').textContent = text }
const report = error => message(error?.message || '操作未完成')
const active = new Map(), early = new Map(), openingBoards = new Set()
const pending = new Map()
let displays = [], store, serial = Promise.resolve(), opening = 0, selecting = false
const boardWindow = id => [...active.entries()].find(([, item]) => item.boardId === id)?.[0]
const ownBoard = (state, id) => {
  const board = state.boards.find(item => item.id === id)
  if (!board) throw new Error('画布已移除')
  return board
}
const safeRect = rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0
const sameRect = (first, second) => ['x', 'y', 'width', 'height'].every(key => first[key] === second[key])
const button = (name, handle) => {
  const element = document.createElement('button')
  element.type = 'button'; element.textContent = name; element.onclick = () => perform(handle)
  return element
}
const perform = handle => { void Promise.resolve().then(handle).catch(report) }

function render() {
  const available = !!store && displays.length > 0
  get('select').disabled = !available || selecting || store.boards.length >= MAX_BOARDS
  get('new').disabled = !available || store.boards.length >= MAX_BOARDS
  get('import').disabled = !store || store.boards.length >= MAX_BOARDS
  const list = get('boards'); list.replaceChildren()
  if (!store) return
  if (!store.boards.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有画布。新建后，在空白处拖动即可放置组件。'; list.append(empty)
  }
  for (const board of store.boards) {
    const row = document.createElement('article'), label = document.createElement('div'), name = document.createElement('strong'), details = document.createElement('small'), actions = document.createElement('div')
    row.className = 'board'; actions.className = 'actions'; name.textContent = board.title
    const windowId = boardWindow(board.id)
    details.textContent = `${board.cards.length} 个组件 · ${board.rect.width} × ${board.rect.height}${windowId ? ' · 已打开' : ''}`
    actions.append(button(windowId ? '关闭窗口' : '打开画布', () => windowId ? api.auxiliary.close(windowId) : openBoard(board.id)), button('移除', async () => {
      if (!window.confirm(`移除「${board.title}」和其中的组件？`)) return
      if (windowId) await flushPending(windowId)
      await change(draft => { draft.boards = draft.boards.filter(item => item.id !== board.id) })
      if (windowId) await api.auxiliary.close(windowId)
    }))
    label.append(name, details); row.append(label, actions); list.append(row)
  }
}

function change(mutate, boardId) {
  const operation = serial.then(async () => {
    if (!store) throw new Error('私有画布未成功读取，禁止覆盖。')
    const draft = { version: 1, boards: store.boards.map(board => board.id === boardId ? structuredClone(board) : board) }
    if (mutate(draft) === false) return
    restore(draft)
    const ids = draft.boards.map(board => board.id), previous = new Map(store.boards.map(board => [board.id, board]))
    const operations = draft.boards.filter(board => board !== previous.get(board.id)).map(board => ({ op: 'set', key: `${STORAGE_KEY}.${board.id}`, value: board }))
    for (const id of previous.keys()) if (!ids.includes(id)) operations.push({ op: 'remove', key: `${STORAGE_KEY}.${id}` })
    if (JSON.stringify(ids) !== JSON.stringify([...previous.keys()])) operations.push({ op: 'set', key: STORAGE_KEY, value: { version: 1, ids } })
    if (!operations.length) return
    await api.storage.commit(operations)
    store = draft; render()
  })
  serial = operation.catch(report)
  return operation
}

async function displayList() {
  const previously = get('display').value ? Number(get('display').value) : null
  displays = await api.screen.displays()
  get('display').replaceChildren(...displays.map((display, index) => new Option(`${display.primary ? '主屏' : `显示器 ${index + 1}`} · ${display.bounds.width} × ${display.bounds.height}`, display.id)))
  const target = displays.find(item => item.id === previously) || displays.find(item => item.primary) || displays[0]
  if (target) get('display').value = String(target.id)
  return target
}

async function openSurface(options, owner) {
  opening++
  try {
    const { windowId } = await api.auxiliary.open({ entry, ...options })
    if (owner.boardId && !store.boards.some(board => board.id === owner.boardId)) { await api.auxiliary.close(windowId); return }
    active.set(windowId, owner)
    const queued = early.get(windowId) || []; early.delete(windowId)
    for (const event of queued) receive(event)
    render(); return windowId
  } finally { if (!--opening) early.clear() }
}

async function openBoard(id) {
  if (boardWindow(id) || openingBoards.has(id)) return
  openingBoards.add(id)
  try {
    const board = ownBoard(store, id)
    await displayList()
    const saved = displays.find(item => item.id === board.displayId), target = saved || displays.find(item => item.primary) || displays[0]
    if (!target) throw new Error('没有可用显示器')
    const rect = saved ? board.rect : { width: board.rect.width, height: board.rect.height }
    await openSurface({ title: board.title, data: { mode: 'board', board }, displayId: target.id, bounds: rect, alwaysOnTop: get('top').checked, resizable: true, movable: true }, { boardId: id, fallback: !saved, displayId: target.id })
  } finally { openingBoards.delete(id) }
}

async function createBoard(display, rect) {
  const board = newBoard(display.id, rect, '')
  await change(draft => {
    if (draft.boards.length >= MAX_BOARDS) throw new Error(`最多保存 ${MAX_BOARDS} 块画布`)
    let index = 1; while (draft.boards.some(item => item.title === `画布 ${index}`)) index++
    board.title = `画布 ${index}`; draft.boards.push(board)
  })
  await openBoard(board.id)
}

async function selectRegion() {
  if (selecting) return
  selecting = true; render()
  try {
    const display = await displayList()
    if (!display) throw new Error('没有可用显示器')
    await openSurface({ title: '拖动画布范围 · Esc 取消', placement: 'display', displayId: display.id, data: { mode: 'select' }, transparent: true, alwaysOnTop: true, movable: false }, { display })
  } catch (error) { selecting = false; render(); throw error }
}

const post = (windowId, data) => api.auxiliary.send(windowId, data)
async function boardMessage(windowId, owner, data) {
  if (data?.type === 'window.close') { await api.auxiliary.close(windowId); return }
  if (data?.type === 'window.bounds' && safeRect(data.rect)) {
    const fallback = owner.fallback
    owner.fallback = false
    try { await api.auxiliary.send(windowId, {}, { bounds: bounds(data.rect, true) }) }
    catch (error) { owner.fallback = fallback; throw error }
    return
  }
  if (data?.type === 'sample') {
    const id = data.id
    if (!ownBoard(store, owner.boardId).cards.some(item => item.id === id && item.kind === 'monitor') || owner.sampling) return
    owner.sampling = true
    try {
      const processes = await api.sys.processes()
      if (active.get(windowId) !== owner) return
      await post(windowId, { type: 'sample', id, count: processes.length, cpu: processes.reduce((sum, item) => sum + (Number(item.pcpu) || 0), 0), rss: processes.reduce((sum, item) => sum + (Number(item.rss) || 0), 0) })
    } finally { owner.sampling = false }
    return
  }
  if (!['card.add', 'card.move', 'card.data', 'card.remove'].includes(data?.type)) return
  await change(draft => {
    const board = ownBoard(draft, owner.boardId)
    if (data.type === 'card.add') {
      if (!kinds.includes(data.kind) || !safeRect(data.rect)) throw new Error('无效的组件区域')
      if (board.cards.length >= MAX_CARDS) throw new Error(`每块画布最多 ${MAX_CARDS} 个组件`)
      board.cards.push(newCard(data.kind, data.rect)); return
    }
    const card = board.cards.find(item => item.id === data.id)
    if (!card) return false
    if (data.type === 'card.move' && safeRect(data.rect)) card.rect = bounds(data.rect)
    else if (data.type === 'card.remove') board.cards = board.cards.filter(item => item !== card)
    else if (data.type === 'card.data' && data.value && typeof data.value === 'object') card.data = content(card.kind, data.value)
    else return false
  }, owner.boardId)
  if (active.get(windowId) === owner) await post(windowId, { type: 'board', board: ownBoard(store, owner.boardId), sequence: data.sequence })
}

function dispatchBoard(windowId, owner, data) {
  void boardMessage(windowId, owner, data).catch(error => {
    report(error)
    if (active.get(windowId) === owner) void post(windowId, { type: 'error', message: error.message, board: store?.boards.find(item => item.id === owner.boardId), sequence: data?.sequence }).catch(report)
  })
}

function flushPending(windowId) {
  for (const [key, item] of pending) {
    if (windowId && item.windowId !== windowId) continue
    clearTimeout(item.timer); pending.delete(key); dispatchBoard(item.windowId, item.owner, item.data)
  }
  return serial
}

function queueBoard(windowId, owner, data) {
  if (data?.type !== 'card.data') { flushPending(windowId); dispatchBoard(windowId, owner, data); return }
  const card = ownBoard(store, owner.boardId).cards.find(item => item.id === data.id)
  if (!card || !data.value || typeof data.value !== 'object') return
  const key = `${windowId}/${card.id}`, old = pending.get(key)
  if (old) clearTimeout(old.timer)
  const item = { windowId, owner, data: { type: 'card.data', id: card.id, sequence: data.sequence, value: content(card.kind, data.value) } }
  item.timer = setTimeout(() => { pending.delete(key); dispatchBoard(windowId, owner, item.data) }, 180)
  pending.set(key, item)
}

function receive(event) {
  const { windowId, type, data, state } = event, owner = active.get(windowId)
  if (!owner) {
    if (opening && early.size < 16) { const queued = early.get(windowId) || []; if (queued.length < 8) queued.push(event); early.set(windowId, queued) }
    return
  }
  if (type === 'auxiliary.closed') { flushPending(windowId); active.delete(windowId); if (owner.display) selecting = false; render(); return }
  if (type === 'auxiliary.changed') {
    if (owner.display && (state.display.id !== owner.display.id || state.interaction === 'passthrough')) { perform(() => api.auxiliary.close(windowId)); return }
    if (owner.boardId && state.display.id !== owner.displayId) { owner.displayId = state.display.id; owner.fallback = true }
    if (owner.boardId && !owner.fallback && safeRect(state.bounds)) perform(() => change(draft => {
      const board = ownBoard(draft, owner.boardId)
      if (state.display.id !== owner.displayId || (board.displayId === state.display.id && sameRect(board.rect, state.bounds))) return false
      board.displayId = state.display.id
      board.rect = { ...state.bounds }
    }, owner.boardId))
    return
  }
  if (!owner.display && store?.boards.some(board => board.id === owner.boardId)) {
    queueBoard(windowId, owner, data); return
  }
  if (!owner.display) return
  if (owner.done || data?.type !== 'region' || !safeRect(data.rect)) return
  owner.done = true
  perform(async () => {
    await api.auxiliary.close(windowId)
    const rect = data.rect, display = owner.display
    if (rect.width < 60 || rect.height < 40) throw new Error('请框选更大的画布区域')
    await createBoard(display, { ...rect, x: display.bounds.x + rect.x, y: display.bounds.y + rect.y })
  })
}

async function boot() {
  render()
  if (!api) throw new Error('请从 eNest 打开自由画布。')
  for (const type of ['auxiliary.closed', 'auxiliary.message', 'auxiliary.changed']) api.on(type, event => receive({ ...event, type }))
  api.onBeforeClose(() => flushPending()); api.onBeforeSuspend(() => flushPending())
  const index = await api.storage.get(STORAGE_KEY)
  if (index != null && (index.version !== 1 || !Array.isArray(index.ids) || index.ids.length > MAX_BOARDS || !index.ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id)) || new Set(index.ids).size !== index.ids.length)) throw new Error('画布目录无法识别，已停止写入。')
  const boards = await Promise.all((index?.ids || []).map(async id => {
    const board = await api.storage.get(`${STORAGE_KEY}.${id}`)
    if (!board || board.id !== id) throw new Error('画布归属不符或数据缺失，已停止写入。')
    return board
  }))
  store = restore({ version: 1, boards })
  await displayList(); render(); message('画布保存在本插件中，关闭窗口不会删除内容。')
  get('select').onclick = () => perform(selectRegion)
  get('new').onclick = () => perform(async () => {
    const display = await displayList()
    if (!display) throw new Error('没有可用显示器')
    const area = display.workArea
    await createBoard(display, { x: area.x + 30, y: area.y + 40, width: Math.min(760, area.width), height: Math.min(520, area.height) })
  })
  get('import').onclick = () => perform(async () => {
    const [file] = await api.localFiles.pick({ kind: 'file', multiple: false, access: 'read' })
    if (!file) return
    if (file.size > 512 * 1024) throw new Error('布局文件超过 512 KB')
    const raw = JSON.parse(await api.localFiles.read({ handleId: file.id, encoding: 'text', maxBytes: 512 * 1024 }))
    const { boards, skipped } = importGeometry(raw, MAX_BOARDS - store.boards.length)
    if (!window.confirm(`追加 ${boards.length} 块画布？只复制位置和组件类型，原文件不变。`)) return
    await change(draft => { if (draft.boards.length + boards.length > MAX_BOARDS) throw new Error('画布数量超过上限'); draft.boards.push(...boards) })
    message(`已导入 ${boards.length} 块画布，跳过 ${skipped} 个不支持的组件。`)
  })
}
void boot().catch(report)
