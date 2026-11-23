/** 编辑历史与图像坐标几何；canvas 绘制在 ops.js。 */

export function selection(start, end, width, height) {
  const x1 = Math.max(0, Math.min(width, Math.round(Math.min(start.x, end.x))))
  const y1 = Math.max(0, Math.min(height, Math.round(Math.min(start.y, end.y))))
  const x2 = Math.max(0, Math.min(width, Math.round(Math.max(start.x, end.x))))
  const y2 = Math.max(0, Math.min(height, Math.round(Math.max(start.y, end.y))))
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

export class EditHistory {
  constructor(limit = 40) { this.limit = limit; this.operations = []; this.cursor = 0 }

  push(operation) {
    if (this.cursor >= this.limit) return false
    this.operations = this.operations.slice(0, this.cursor)
    this.operations.push(structuredClone(operation))
    this.cursor += 1
    return true
  }

  undo() { if (this.cursor > 0) this.cursor -= 1; return this.current() }

  redo() { if (this.cursor < this.operations.length) this.cursor += 1; return this.current() }

  clear() { this.operations = []; this.cursor = 0 }

  current() { return this.operations.slice(0, this.cursor) }

  restore(operations, cursor) {
    this.operations = Array.isArray(operations) ? operations.filter(validOperation).slice(0, this.limit) : []
    this.cursor = Math.max(0, Math.min(this.operations.length, Number(cursor) || 0))
  }

  get canUndo() { return this.cursor > 0 }

  get canRedo() { return this.cursor < this.operations.length }
}

export function validOperation(op) {
  if (!op || !['crop', 'arrow', 'rect', 'text', 'mosaic'].includes(op.type)) return false
  if (op.type === 'text') {
    return Number.isFinite(op.x) && Number.isFinite(op.y) && typeof op.text === 'string'
      && Number.isFinite(op.size) && op.size >= 12 && op.size <= 160 && /^#[\da-f]{6}$/i.test(op.color)
  }
  if (op.type === 'arrow') {
    return op.start && op.end && ['x', 'y'].every(key => Number.isFinite(op.start[key]) && Number.isFinite(op.end[key]))
      && Number.isFinite(op.lineWidth) && /^#[\da-f]{6}$/i.test(op.color)
  }
  return ['x', 'y', 'width', 'height'].every(key => Number.isFinite(op[key])) && op.width > 0 && op.height > 0
    && (op.type !== 'rect' || /^#[\da-f]{6}$/i.test(op.color))
}

export function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000)), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60)
  return `${hours ? `${hours}:` : ''}${String(hours ? minutes % 60 : minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}
