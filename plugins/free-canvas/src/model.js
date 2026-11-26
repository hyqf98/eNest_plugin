export const STORAGE_KEY = 'free-canvas.workspaces'
export const MAX_BOARDS = 12
export const MAX_CARDS = 20
export const kinds = ['clock', 'note', 'tasks', 'timer', 'calculator', 'monitor']
const legacyKinds = new Map([['com.github.eNest.timestamp', 'clock'], ['com.github.eNest.sticky-notes', 'note'], ['com.github.eNest.todos', 'tasks'], ['com.github.eNest.pomodoro', 'timer'], ['com.github.eNest.calculator', 'calculator'], ['com.github.eNest.sysguard', 'monitor']])
const integer = (value, low, high, fallback = low) => Number.isFinite(value) ? Math.max(low, Math.min(high, Math.round(value))) : fallback
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)

export function bounds(value = {}, screen = false) {
  return { x: integer(value.x, screen ? -100000 : 0, 100000, 0), y: integer(value.y, screen ? -100000 : 0, 100000, 0), width: integer(value.width, screen ? 240 : 140, 16000, 360), height: integer(value.height, screen ? 160 : 96, 16000, 220) }
}

export function content(kind, value = {}) {
  if (kind === 'note') return { text: String(value.text ?? '').slice(0, 4000) }
  if (kind === 'tasks') return { rows: Array.isArray(value.rows) ? value.rows.slice(0, 32).filter(row => row && identifier(row.id)).map(row => ({ id: row.id, text: String(row.text ?? '').slice(0, 200), done: row.done === true })) : [] }
  if (kind === 'calculator') return { expression: String(value.expression ?? '').slice(0, 160) }
  if (kind === 'timer') return { end: integer(value.end, 0, Number.MAX_SAFE_INTEGER), left: integer(value.left, 0, 25 * 60000, 25 * 60000) }
  return {}
}

export const newCard = (kind, rect) => ({ id: crypto.randomUUID(), kind, rect: bounds(rect), data: content(kind) })
export const newBoard = (displayId, rect, title) => ({ id: crypto.randomUUID(), title, displayId, rect: bounds(rect, true), cards: [] })

function validContent(kind, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  if (kind === 'note') return typeof data.text === 'string' && data.text.length <= 4000
  if (kind === 'calculator') return typeof data.expression === 'string' && data.expression.length <= 160
  if (kind === 'tasks') return Array.isArray(data.rows) && data.rows.length <= 32 && data.rows.every(row => row && identifier(row.id) && typeof row.text === 'string' && row.text.length <= 200 && typeof row.done === 'boolean') && new Set(data.rows.map(row => row.id)).size === data.rows.length
  if (kind === 'timer') return Number.isSafeInteger(data.end) && data.end >= 0 && Number.isSafeInteger(data.left) && data.left >= 0 && data.left <= 25 * 60000
  return Object.keys(data).length === 0
}

export function restore(raw) {
  if (raw == null) return { version: 1, boards: [] }
  if (raw.version !== 1 || !Array.isArray(raw.boards) || raw.boards.length > MAX_BOARDS) throw new Error('画布数据格式无法识别，已停止写入以保护原数据。')
  const ids = new Set()
  for (const board of raw.boards) {
    if (!board || !identifier(board.id) || ids.has(board.id) || !Number.isSafeInteger(board.displayId) || typeof board.title !== 'string' || board.title.length > 100 || !rectValid(board.rect) || !Array.isArray(board.cards) || board.cards.length > MAX_CARDS) throw new Error('画布数据不完整，已停止写入。')
    ids.add(board.id)
    for (const card of board.cards) {
      if (!card || !identifier(card.id) || ids.has(card.id) || !kinds.includes(card.kind) || !rectValid(card.rect) || !validContent(card.kind, card.data)) throw new Error('组件数据不完整，已停止写入。')
      ids.add(card.id)
    }
  }
  return raw
}

const rectValid = rect => rect && ['x','y','width','height'].every(field => Number.isFinite(rect[field])) && rect.width > 0 && rect.height > 0

export function importGeometry(raw, room) {
  const source = raw?.version === 1 && raw.panels
  if (!Array.isArray(source) || source.length > 64) throw new Error('请选择宿主导出的旧布局 JSON。')
  const boards = []
  let skipped = 0
  for (const panel of source) {
    if (!rectValid(panel?.bounds) || !Array.isArray(panel.widgets)) continue
    if (boards.length >= room) throw new Error('剩余画布位置不足；本次未导入。')
    const board = newBoard(Number.isSafeInteger(panel.bounds.displayId) ? panel.bounds.displayId : -1, panel.bounds, `导入的画布 ${boards.length + 1}`)
    for (const widget of [...panel.widgets].sort((first, second) => (Number.isSafeInteger(first?.z) ? first.z : 0) - (Number.isSafeInteger(second?.z) ? second.z : 0))) {
      if (!legacyKinds.has(widget?.pluginId) || !rectValid(widget) || board.cards.length >= MAX_CARDS) { skipped++; continue }
      board.cards.push(newCard(legacyKinds.get(widget.pluginId), widget))
    }
    boards.push(board)
  }
  if (!boards.length) throw new Error('未找到可导入的画布。')
  return { boards, skipped }
}
