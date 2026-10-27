/**
 * render.mjs —— 画布全量渲染与导出合成
 * 单 <canvas> dpr 缩放；viewport 一次 setTransform；对象按数组序（z 序）绘制。
 * 荧光笔：先画到临时层再以固定透明度合成，避免单笔自叠加深。
 */

import { getStroke } from 'perfect-freehand'
import { drawShape } from './roughDraw.mjs'

const FONT_HAND = '"LXGW WenKai Lite", "Kaiti SC", "STKaiti", serif'

/** perfect-freehand outline → Path2D */
export function strokePath(points, size, { highlighter = false, thinning = 0.55 } = {}) {
  const strokeOpts = highlighter
    ? { size, thinning: 0, smoothing: 0.6, streamline: 0.5, cap: 'round', easing: (t) => t }
    : { size, thinning, smoothing: 0.55, streamline: 0.45, cap: 'round', join: 'round' }
  const outline = getStroke(points, strokeOpts)
  const path = new Path2D()
  if (outline.length) {
    path.moveTo(outline[0][0], outline[0][1])
    for (let i = 1; i < outline.length; i++) path.lineTo(outline[i][0], outline[i][1])
    path.closePath()
  }
  return path
}

function drawTextObject(ctx, obj) {
  ctx.save()
  ctx.font = `${obj.size}px ${FONT_HAND}`
  ctx.fillStyle = obj.color
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  const lines = String(obj.text || '').split('\n')
  lines.forEach((line, i) => {
    ctx.fillText(line, obj.x, obj.y + i * obj.size * 1.3)
  })
  ctx.restore()
}

/** 量测文字包围盒并回填 _w（渲染循环外调用） */
export function measureText(ctx, obj) {
  ctx.save()
  ctx.font = `${obj.size}px ${FONT_HAND}`
  const lines = String(obj.text || '').split('\n')
  let w = 0
  for (const line of lines) w = Math.max(w, ctx.measureText(line || ' ').width)
  ctx.restore()
  obj._w = w
  return { w, h: lines.length * obj.size * 1.3 }
}

function drawInkObject(ctx, obj) {
  const path = strokePath(obj.points, obj.size, { highlighter: obj.highlighter })
  if (obj.highlighter) {
    // 荧光笔：临时层合成固定 alpha，整笔一次上色
    ctx.save()
    ctx.globalAlpha = 0.4
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = obj.color
    ctx.fill(path)
    ctx.restore()
  } else {
    ctx.fillStyle = obj.color
    ctx.fill(path)
  }
}

/** 新对象淡入时长（ms）；创建时打 _born 时间戳，渲染时按剩余时间渐显 */
export const BORN_FADE_MS = 260

function bornAlpha(obj, now = performance.now()) {
  if (!obj._born) return 1
  const t = (now - obj._born) / BORN_FADE_MS
  if (t >= 1) { delete obj._born; return 1 }
  return 0.15 + 0.85 * (1 - Math.pow(1 - Math.max(0, t), 3)) // easeOutCubic，保留少许起笔可见性
}

/** 橡皮擦除笔迹：把墨迹按像素挖除（destination-out），所见即所擦 */
function drawEraseObject(ctx, obj) {
  // 擦除半径存的是屏幕像素语义，换算回世界单位与 ghost 圈一致
  const path = strokePath(obj.points, obj.size, { highlighter: true, thinning: 0 })
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  ctx.fill(path)
  ctx.restore()
}

/** 在已设好变换的 ctx 上按 z 序绘制全部对象 */
export function renderObjects(ctx, canvas, objects, { images = new Map(), roughness = 1, highlightAlphaLayer, now = performance.now(), hoverImage = null } = {}) {
  // 分两批：荧光笔最后统一 multiply 合成也行；这里按 z 序直接画（multiply 对纸色即成半透明高亮）
  for (const obj of objects) {
    if (obj.kind === 'ink') {
      const alpha = bornAlpha(obj, now)
      if (alpha >= 1) drawInkObject(ctx, obj)
      else { ctx.save(); ctx.globalAlpha = alpha; drawInkObject(ctx, obj); ctx.restore() }
    }
  }
  // 像素擦除：墨迹全部画完后按 z 序挖除（后面的擦除可以挖前面的墨）
  for (const obj of objects) {
    if (obj.kind === 'erase') drawEraseObject(ctx, obj)
  }
  for (const obj of objects) {
    if (obj.kind === 'shape') {
      const alpha = bornAlpha(obj, now)
      if (alpha >= 1) drawShape(ctx, canvas, obj, roughness)
      else { ctx.save(); ctx.globalAlpha = alpha; drawShape(ctx, canvas, obj, roughness); ctx.restore() }
    }
  }
  for (const obj of objects) {
    if (obj.kind === 'text') {
      const alpha = bornAlpha(obj, now)
      ctx.save()
      if (alpha < 1) ctx.globalAlpha = alpha
      measureText(ctx, obj)
      drawTextObject(ctx, obj)
      ctx.restore()
    }
  }
  for (const obj of objects) {
    if (obj.kind === 'image') {
      const img = images.get(obj.blobId) || images.get(`inline:${obj.id}`)
      if (!img) continue
      const alpha = bornAlpha(obj, now)
      ctx.save()
      if (alpha < 1) ctx.globalAlpha = alpha
      // 悬停放大：绕图片中心缩放（含回弹动画的过渡值）
      if (hoverImage && hoverImage.id === obj.id && hoverImage.scale !== 1) {
        const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2
        ctx.translate(cx, cy)
        ctx.scale(hoverImage.scale, hoverImage.scale)
        ctx.translate(-cx, -cy)
        ctx.shadowColor = 'rgba(30, 36, 46, 0.28)'
        ctx.shadowBlur = 18 * hoverImage.scale
        ctx.shadowOffsetY = 4
      }
      ctx.drawImage(img, obj.x, obj.y, obj.w, obj.h)
      ctx.restore()
    }
  }
}

/** 是否还有淡入中的对象（驱动动画帧继续） */
export function anyFading(objects, now = performance.now()) {
  return objects.some((obj) => obj._born && now - obj._born < BORN_FADE_MS)
}

/** 点阵网格（世界坐标网格，随缩放平移） */
export function renderGrid(ctx, vp, width, height, color) {
  const spacing = 24
  const step = spacing * vp.zoom
  if (step < 6) return
  const startX = ((vp.x % step) + step) % step
  const startY = ((vp.y % step) + step) % step
  ctx.save()
  ctx.fillStyle = color
  for (let x = startX; x < width; x += step) {
    for (let y = startY; y < height; y += step) {
      ctx.beginPath()
      ctx.arc(x, y, 1.1, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

/** 墨迹层离屏画布复用（尺寸变化时重建） */
let inkLayerCanvas = null

/** 全帧渲染（视口画布） */
export function renderFrame(ctx, canvas, { vp, dpr, objects, images, theme, settings, hoverImage = null }) {
  const { width, height } = canvas
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width / dpr, height / dpr)
  ctx.fillStyle = theme.paper
  ctx.fillRect(0, 0, width / dpr, height / dpr)
  if (settings.grid === 'dots') renderGrid(ctx, vp, width / dpr, height / dpr, theme.grid)

  const hasErase = objects.some((o) => o.kind === 'erase')
  if (hasErase) {
    // 墨迹 + 擦除画到独立层：destination-out 只挖墨迹，不伤纸底/网格
    if (!inkLayerCanvas) inkLayerCanvas = document.createElement('canvas')
    if (inkLayerCanvas.width !== width || inkLayerCanvas.height !== height) {
      inkLayerCanvas.width = width
      inkLayerCanvas.height = height
    }
    const ictx = inkLayerCanvas.getContext('2d')
    ictx.setTransform(1, 0, 0, 1, 0, 0)
    ictx.clearRect(0, 0, width, height)
    ictx.setTransform(dpr * vp.zoom, 0, 0, dpr * vp.zoom, dpr * vp.x, dpr * vp.y)
    renderObjects(ictx, inkLayerCanvas, objects, { images, roughness: settings.roughness, hoverImage })
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(inkLayerCanvas, 0, 0)
    return
  }

  ctx.setTransform(dpr * vp.zoom, 0, 0, dpr * vp.zoom, dpr * vp.x, dpr * vp.y)
  renderObjects(ctx, canvas, objects, { images, roughness: settings.roughness, hoverImage })
}

/**
 * 导出合成：按内容包围盒（世界坐标）+ padding，zoom=1 重绘到离屏画布。
 * transparent=true 时不铺纸色。返回 { canvas, dataUrl(type) } 由调用方 toDataURL。
 */
export function composeExport(objects, { images = new Map(), roughness = 1, transparent = false, paper = '#fff', padding = 24, maxDim = 8192 }) {
  // 计算内容 bbox（文字需量测：用临时 ctx）
  const probe = document.createElement('canvas').getContext('2d')
  for (const obj of objects) if (obj.kind === 'text') measureText(probe, obj)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const obj of objects) {
    const b = bboxOf(obj)
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  }
  if (minX === Infinity) return null
  minX -= padding; minY -= padding; maxX += padding; maxY += padding
  let w = Math.ceil(maxX - minX), h = Math.ceil(maxY - minY)
  if (w < 1 || h < 1) return null
  const scale = Math.min(1, maxDim / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(w * scale))
  canvas.height = Math.max(1, Math.ceil(h * scale))
  const ctx = canvas.getContext('2d')
  const hasErase = objects.some((o) => o.kind === 'erase')
  const drawList = hasErase ? objects.filter((o) => o.kind !== 'erase') : objects
  if (hasErase) {
    // 墨迹层先独立画 + 挖除，再合成到导出画布（纸底不被动到）
    const layer = document.createElement('canvas')
    layer.width = canvas.width; layer.height = canvas.height
    const lctx = layer.getContext('2d')
    lctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale)
    renderObjects(lctx, layer, drawList.filter((o) => o.kind === 'ink'), { images, roughness })
    lctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale)
    for (const obj of objects) if (obj.kind === 'erase') drawEraseObject(lctx, obj)
    if (!transparent) { ctx.fillStyle = paper; ctx.fillRect(0, 0, canvas.width, canvas.height) }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(layer, 0, 0)
    // 其余对象（图形/文字/贴图）画在墨迹之上
    ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale)
    renderObjects(ctx, canvas, drawList.filter((o) => o.kind !== 'ink'), { images, roughness })
    return { canvas, offsetX: minX, offsetY: minY, scale }
  }
  if (!transparent) { ctx.fillStyle = paper; ctx.fillRect(0, 0, canvas.width, canvas.height) }
  ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale)
  // roughDraw 缓存走世界坐标，离屏画布重算即可
  renderObjects(ctx, canvas, objects, { images, roughness })
  return { canvas, offsetX: minX, offsetY: minY, scale }
}

function bboxOf(obj) {
  if (obj.kind === 'ink' || obj.kind === 'erase') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of obj.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    const half = obj.size / 2 + 1
    return { x: minX - half, y: minY - half, w: maxX - minX + half * 2, h: maxY - minY + half * 2 }
  }
  if (obj.kind === 'shape') {
    const x2 = obj.x2 ?? obj.x + obj.w, y2 = obj.y2 ?? obj.y + obj.h
    return { x: Math.min(obj.x, x2), y: Math.min(obj.y, y2), w: Math.abs(x2 - obj.x), h: Math.abs(y2 - obj.y) }
  }
  if (obj.kind === 'text') {
    const lines = String(obj.text || '').split('\n')
    const w = obj._w || Math.max(...lines.map((l) => l.length), 1) * obj.size
    return { x: obj.x, y: obj.y, w, h: lines.length * obj.size * 1.3 }
  }
  return { x: obj.x, y: obj.y, w: obj.w, h: obj.h }
}
