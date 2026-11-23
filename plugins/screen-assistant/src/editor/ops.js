/** canvas 标注绘制：箭头 / 矩形 / 文字 / 马赛克 / 裁剪。 */
import { selection } from './core.js'

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
  if (op.type === 'crop') {
    const box = selection({ x: op.x, y: op.y }, { x: op.x + op.width, y: op.y + op.height }, canvas.width, canvas.height)
    if (!box.width || !box.height) return
    const pixels = ctx.getImageData(box.x, box.y, box.width, box.height)
    canvas.width = box.width
    canvas.height = box.height
    canvas.getContext('2d').putImageData(pixels, 0, 0)
  } else if (op.type === 'arrow') {
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
  if (tool === 'crop') ctx.setLineDash([8, 6])
  if (tool === 'mosaic') {
    ctx.fillStyle = 'rgba(95,112,125,.5)'
    ctx.fillRect(box.x, box.y, box.width, box.height)
  }
  ctx.strokeRect(box.x, box.y, box.width, box.height)
  ctx.setLineDash([])
}
