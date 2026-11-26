/* 选区标注内核：与插件内编辑器（src/editor/core.js、ops.js）同一套几何与绘制。
   覆盖层是独立页面、不经打包，所以这里保留一份同源副本；改绘制规则时两处同步。 */

export function selection(start, end, width, height) {
  const x1 = Math.max(0, Math.min(width, Math.round(Math.min(start.x, end.x))))
  const y1 = Math.max(0, Math.min(height, Math.round(Math.min(start.y, end.y))))
  const x2 = Math.max(0, Math.min(width, Math.round(Math.max(start.x, end.x))))
  const y2 = Math.max(0, Math.min(height, Math.round(Math.max(start.y, end.y))))
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

/** 线性历史：cursor 之前是已生效的操作，之后是可重做的。 */
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

  get canUndo() { return this.cursor > 0 }

  get canRedo() { return this.cursor < this.operations.length }
}

export function drawArrow(ctx, op) {
  const { start, end } = op
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const length = Math.max(14, op.lineWidth * 4)
  ctx.strokeStyle = op.color
  ctx.fillStyle = op.color
  ctx.lineWidth = op.lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(end.x, end.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(end.x - length * Math.cos(angle - Math.PI / 6), end.y - length * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(end.x - length * Math.cos(angle + Math.PI / 6), end.y - length * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

export function applyOperation(canvas, op) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  if (op.type === 'arrow') {
    drawArrow(ctx, op)
  } else if (op.type === 'rect') {
    ctx.strokeStyle = op.color
    ctx.lineWidth = op.lineWidth || 6
    ctx.strokeRect(op.x, op.y, op.width, op.height)
  } else if (op.type === 'text') {
    ctx.fillStyle = op.color
    ctx.font = `600 ${op.size}px -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(op.text, op.x, op.y)
  } else if (op.type === 'mosaic') {
    const box = selection({ x: op.x, y: op.y }, { x: op.x + op.width, y: op.y + op.height }, canvas.width, canvas.height)
    if (!box.width || !box.height) return
    const small = document.createElement('canvas')
    const block = 18
    small.width = Math.max(1, Math.ceil(box.width / block))
    small.height = Math.max(1, Math.ceil(box.height / block))
    small.getContext('2d').drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, small.width, small.height)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small, 0, 0, small.width, small.height, box.x, box.y, box.width, box.height)
    ctx.restore()
  }
}

/** 拖动过程中的预览，只画在覆盖画布上，确认后才进入历史。 */
export function renderPreview(ctx, tool, start, end, color, lineWidth) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  if (!start) return
  if (tool === 'arrow') {
    drawArrow(ctx, { start, end, color, lineWidth })
    return
  }
  const box = selection(start, end, ctx.canvas.width, ctx.canvas.height)
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  if (tool === 'mosaic') {
    ctx.fillStyle = 'rgba(95,112,125,.5)'
    ctx.fillRect(box.x, box.y, box.width, box.height)
  }
  ctx.strokeRect(box.x, box.y, box.width, box.height)
}
