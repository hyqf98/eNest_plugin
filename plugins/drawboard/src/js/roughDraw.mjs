/**
 * roughDraw.mjs —— roughjs 手绘图形绘制与缓存
 * 每个 shape 带 seed，重绘时抖动保持稳定（Excalidraw 同款做法）。
 * roughness=0 时走规整 canvas 路径。
 */

import rough from 'roughjs'
import { arrowGeometry } from './objects.mjs'

let rc = null
const drawableCache = new Map()

function getRc(canvas) {
  if (!rc || rc.canvas !== canvas) rc = rough.canvas(canvas)
  return rc
}

function cacheKey(obj, roughness) {
  return `${obj.id}:${obj.type}:${obj.x},${obj.y},${obj.x2 ?? obj.x + obj.w},${obj.y2 ?? obj.y + obj.h}:${obj.stroke}:${obj.color}:${obj.fill}:${roughness}`
}

/**
 * 在已应用 world 变换的 ctx 上绘制 shape。
 * roughjs 的坐标是世界坐标（ctx setTransform 已含 zoom），线宽用屏幕像素除回 zoom 保持视觉恒定。
 */
export function drawShape(ctx, canvas, obj, roughness) {
  const x2 = obj.x2 ?? obj.x + obj.w
  const y2 = obj.y2 ?? obj.y + obj.h
  const minX = Math.min(obj.x, x2), minY = Math.min(obj.y, y2)
  const w = Math.abs(x2 - obj.x), h = Math.abs(y2 - obj.y)

  if (roughness <= 0) {
    drawCleanShape(ctx, obj, minX, minY, w, h, x2, y2)
    return
  }

  const key = cacheKey(obj, roughness)
  let drawable = drawableCache.get(key)
  const r = getRc(canvas)
  // 手绘感加强：bowing 大弯折 + 双笔触 + 恒定微抖；roughness 语义放大 1.5x（设置 1 ≈ 旧 1.5）
  const effRough = roughness * 1.5
  const opts = {
    seed: obj.seed,
    roughness: effRough,
    bowing: Math.min(2.5, 1.2 + effRough * 0.6),
    curveFitting: 0.82,
    maxRandomnessOffset: 2.2 + effRough * 0.8,
    preserveVertices: false,
    stroke: obj.color,
    strokeWidth: obj.stroke,
    disableMultiStroke: false, // 双笔触=手绘重描感
    disableMultiStrokeFill: false,
  }
  if (obj.fill && obj.fill !== 'none') opts.fill = obj.fill
  if (!drawable) {
    if (obj.type === 'rect') drawable = r.generator.rectangle(minX, minY, w, h, opts)
    else if (obj.type === 'ellipse') drawable = r.generator.ellipse(minX + w / 2, minY + h / 2, w, h, opts)
    else if (obj.type === 'line') drawable = r.generator.line(obj.x, obj.y, x2, y2, opts)
    else if (obj.type === 'arrow') {
      // roughjs 4.6.6 无原生箭头：杆只画到箭翼根部（不“出头”），箭翼单独一条 linearPath 走手绘抖动
      const { h1, tip, h2, back } = arrowGeometry(obj.x, obj.y, x2, y2)
      const shaft = r.generator.line(obj.x, obj.y, back[0], back[1], opts)
      const head = r.generator.linearPath([h1, tip, h2], { ...opts, disableMultiStroke: true })
      drawable = { type: 'arrow', options: shaft.options, sets: [...shaft.sets, ...head.sets] }
    }
    if (drawable) {
      drawableCache.set(key, drawable)
      if (drawableCache.size > 600) {
        const first = drawableCache.keys().next().value
        drawableCache.delete(first)
      }
    }
  }
  if (drawable) r.draw(drawable)
}

/** roughness=0 的规整路径 */
export function drawCleanShape(ctx, obj, minX, minY, w, h, x2, y2) {
  ctx.save()
  ctx.strokeStyle = obj.color
  ctx.lineWidth = obj.stroke
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (obj.fill && obj.fill !== 'none') {
    ctx.fillStyle = obj.fill
    ctx.globalAlpha = 0.35
  }
  ctx.beginPath()
  if (obj.type === 'rect') ctx.rect(minX, minY, w, h)
  else if (obj.type === 'ellipse') ctx.ellipse(minX + w / 2, minY + h / 2, Math.max(w / 2, 1), Math.max(h / 2, 1), 0, 0, Math.PI * 2)
  else if (obj.type === 'line') { ctx.moveTo(obj.x, obj.y); ctx.lineTo(x2, y2) }
  else if (obj.type === 'arrow') { const { back } = arrowGeometry(obj.x, obj.y, x2, y2); ctx.moveTo(obj.x, obj.y); ctx.lineTo(back[0], back[1]) }
  if (obj.fill && obj.fill !== 'none') ctx.fill()
  ctx.globalAlpha = 1
  ctx.stroke()
  ctx.restore()
  if (obj.type === 'arrow') drawArrowHead(ctx, obj, x2, y2)
}

/** 规整路径的箭头头：与 arrowGeometry 同一比例语义（Excalidraw 风，箭翼随杆长） */
export function drawArrowHead(ctx, obj, x2, y2) {
  const { h1, tip, h2 } = arrowGeometry(obj.x, obj.y, x2, y2)
  ctx.save()
  ctx.strokeStyle = obj.color
  ctx.lineWidth = obj.stroke
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(h1[0], h1[1])
  ctx.lineTo(tip[0], tip[1])
  ctx.lineTo(h2[0], h2[1])
  ctx.stroke()
  ctx.restore()
}
