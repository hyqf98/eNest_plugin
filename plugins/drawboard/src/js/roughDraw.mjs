/**
 * roughDraw.mjs —— roughjs 手绘图形绘制与缓存
 * 每个 shape 带 seed，重绘时抖动保持稳定（Excalidraw 同款做法）。
 * roughness=0 时走规整 canvas 路径。
 */

import rough from 'roughjs'
import { arrowGeometry, linearCurveSamples, linearPoints, rectRoundness } from './objects.mjs'

let rc = null
const drawableCache = new Map()

function getRc(canvas) {
  if (!rc || rc.canvas !== canvas) rc = rough.canvas(canvas)
  return rc
}

function cacheKey(obj, roughness) {
  // 点列与圆角都参与键：拖动控制柄时缓存必须失效，否则会一直画旧形状
  const pts = Array.isArray(obj.points) ? `;p${obj.points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join('|')}` : ''
  return `${obj.id}:${obj.type}:${obj.x},${obj.y},${obj.x2 ?? obj.x + obj.w},${obj.y2 ?? obj.y + obj.h}:${obj.stroke}:${obj.color}:${obj.fill}:${obj.roundness ?? 0}:${obj.curved ? 1 : 0}${pts}:${roughness}`
}

/** 把 rough drawable 的 ops 画出来；roughness=0 时走规整路径 */
function roughOptions(obj, roughness) {
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
  return opts
}

/**
 * 圆角矩形的 SVG 路径（世界坐标）。r 已是合法半径（0 ~ 短边/2）。
 * 用三段式圆弧：每个角一条二次曲线，路径闭合。
 */
export function roundedRectPath(x, y, w, h, r) {
  if (!(r > 0)) return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`
  const x2 = x + w, y2 = y + h
  return [
    `M ${x + r} ${y}`,
    `L ${x2 - r} ${y}`, `Q ${x2} ${y} ${x2} ${y + r}`,
    `L ${x2} ${y2 - r}`, `Q ${x2} ${y2} ${x2 - r} ${y2}`,
    `L ${x + r} ${y2}`, `Q ${x} ${y2} ${x} ${y2 - r}`,
    `L ${x} ${y + r}`, `Q ${x} ${y} ${x + r} ${y}`,
    'Z',
  ].join(' ')
}

/** 线/箭头的实际走向（曲线则已采样），供箭头方向与规整绘制使用 */
const linearPathPoints = (obj) => linearCurveSamples(obj).map((p) => [p.x, p.y])

/**
 * 在已应用 world 变换的 ctx 上绘制 shape。
 * roughjs 的坐标是世界坐标（ctx setTransform 已含 zoom），线宽用屏幕像素除回 zoom 保持视觉恒定。
 */
export function drawShape(ctx, canvas, obj, roughness) {
  if (roughness <= 0) {
    drawCleanShape(ctx, obj)
    return
  }

  const key = cacheKey(obj, roughness)
  let drawable = drawableCache.get(key)
  const r = getRc(canvas)
  const opts = roughOptions(obj, roughness)
  if (!drawable) {
    if (obj.type === 'rect') {
      const radius = rectRoundness(obj)
      // 圆角矩形：roughjs 没有原生 API，用 SVG 路径（半径为 0 时仍走 rectangle，保持旧手感）
      drawable = radius > 0
        ? r.generator.path(roundedRectPath(obj.x, obj.y, obj.w, obj.h, radius), opts)
        : r.generator.rectangle(obj.x, obj.y, obj.w, obj.h, opts)
    } else if (obj.type === 'ellipse') {
      drawable = r.generator.ellipse(obj.x + obj.w / 2, obj.y + obj.h / 2, obj.w, obj.h, opts)
    } else if (obj.type === 'line') {
      drawable = obj.curved ? r.generator.curve(linearPathPoints(obj), opts) : r.generator.line(obj.x, obj.y, obj.x2, obj.y2, opts)
    } else if (obj.type === 'arrow') {
      // roughjs 4.6.6 无原生箭头：杆只画到箭翼根部（不“出头”），箭翼单独一条 linearPath 走手绘抖动
      const pts = linearPathPoints(obj)
      drawable = curvedArrowDrawable(r, obj, pts, opts)
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

/**
 * 箭头的杆与箭翼。直线箭头保持原来的几何（杆缩到翼根、箭翼随杆长）；
 * 弯曲箭头的箭头方向取曲线末端的切线，杆画到切线上箭翼的根部，曲线不“出头”。
 */
function curvedArrowDrawable(r, obj, pts, opts) {
  const headLen = arrowHeadLength(obj, pts)
  const dir = endTangent(pts)
  const tip = pts[pts.length - 1]
  const cos = Math.cos(Math.PI / 7), sin = Math.sin(Math.PI / 7)
  const back = [tip[0] - dir[0] * headLen * cos, tip[1] - dir[1] * headLen * cos]
  const h1 = [tip[0] - headLen * (dir[0] * cos - dir[1] * sin), tip[1] - headLen * (dir[1] * cos + dir[0] * sin)]
  const h2 = [tip[0] - headLen * (dir[0] * cos + dir[1] * sin), tip[1] - headLen * (dir[1] * cos - dir[0] * sin)]
  if (!obj.curved) {
    // 直线：沿用 arrowGeometry 的精确数值，保证旧图形一个像素都不变
    const g = arrowGeometry(obj.x, obj.y, obj.x2, obj.y2)
    const shaft = r.generator.line(obj.x, obj.y, g.back[0], g.back[1], opts)
    const head = r.generator.linearPath([g.h1, g.tip, g.h2], { ...opts, disableMultiStroke: true })
    return { type: 'arrow', options: shaft.options, sets: [...shaft.sets, ...head.sets] }
  }
  const curve = r.generator.curve(trimEnd(pts, headLen * cos), opts)
  const head = r.generator.linearPath([h1, tip, h2], { ...opts, disableMultiStroke: true })
  return { type: 'arrow', options: curve.options, sets: [...curve.sets, ...head.sets] }
}

/** 箭翼长度：与直线箭头同一比例（随总长成比例，夹在 7~22 之间） */
function arrowHeadLength(obj, pts) {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return Math.min(22, Math.max(7, total * 0.22))
}

/** 末端切线方向（单位向量）：取曲线最后一段有长度的方向 */
function endTangent(pts) {
  const tip = pts[pts.length - 1]
  for (let i = pts.length - 2; i >= 0; i--) {
    const dx = tip[0] - pts[i][0], dy = tip[1] - pts[i][1], len = Math.hypot(dx, dy)
    if (len > 1e-6) return [dx / len, dy / len]
  }
  return [1, 0]
}

/** 把末尾去掉长度 d：杆只画到箭翼根部，箭头不“出头” */
function trimEnd(pts, d) {
  const out = [[...pts[0]]]
  for (let i = 1; i < pts.length; i++) out.push([...pts[i]])
  let remaining = d
  while (out.length > 1) {
    const a = out[out.length - 2], b = out[out.length - 1]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len > remaining + 1e-6) {
      const t = 1 - remaining / len
      out[out.length - 1] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      return out
    }
    remaining -= len
    out.pop()
  }
  return out
}

/** roughness=0 的规整路径 */
export function drawCleanShape(ctx, obj) {
  const x2 = obj.x2 ?? obj.x + obj.w
  const y2 = obj.y2 ?? obj.y + obj.h
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
  if (obj.type === 'rect') {
    const radius = rectRoundness(obj)
    if (radius > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(obj.x, obj.y, obj.w, obj.h, radius)
    else if (radius > 0) tracePath(ctx, roundedRectPath(obj.x, obj.y, obj.w, obj.h, radius))
    else ctx.rect(obj.x, obj.y, obj.w, obj.h)
  } else if (obj.type === 'ellipse') ctx.ellipse(obj.x + obj.w / 2, obj.y + obj.h / 2, Math.max(obj.w / 2, 1), Math.max(obj.h / 2, 1), 0, 0, Math.PI * 2)
  else if (obj.type === 'line') traceLinear(ctx, obj)
  else if (obj.type === 'arrow') traceLinear(ctx, obj, arrowHeadLength(obj, linearPathPoints(obj)) * Math.cos(Math.PI / 7))
  if (obj.fill && obj.fill !== 'none') ctx.fill()
  ctx.globalAlpha = 1
  ctx.stroke()
  ctx.restore()
  if (obj.type === 'arrow') drawArrowHead(ctx, obj)
}

/** 规整路径的线/箭头杆：直线画两端，曲线沿采样点连线（与手绘层同一走向） */
function traceLinear(ctx, obj, trim = 0) {
  let pts = linearPathPoints(obj)
  if (trim > 0) pts = trimEnd(pts, trim)
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
}

/** 把 SVG 路径字符串描到 ctx（只支持 roundedRectPath 产出的 M/L/Q/Z） */
function tracePath(ctx, d) {
  const tokens = d.match(/[MLQZ]|-?[\d.]+/g)
  let i = 0
  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (cmd === 'M') { ctx.moveTo(+tokens[i], +tokens[i + 1]); i += 2 }
    else if (cmd === 'L') { ctx.lineTo(+tokens[i], +tokens[i + 1]); i += 2 }
    else if (cmd === 'Q') { ctx.quadraticCurveTo(+tokens[i], +tokens[i + 1], +tokens[i + 2], +tokens[i + 3]); i += 4 }
    else if (cmd === 'Z') ctx.closePath()
  }
}

/** 规整路径的箭头头：直线沿用 arrowGeometry（随杆长成比例）；曲线箭头沿末端切线 */
export function drawArrowHead(ctx, obj) {
  const pts = linearPathPoints(obj)
  const headLen = arrowHeadLength(obj, pts)
  let h1, tip, h2
  if (!obj.curved) {
    ({ h1, tip, h2 } = arrowGeometry(obj.x, obj.y, obj.x2, obj.y2))
  } else {
    const dir = endTangent(pts)
    const cos = Math.cos(Math.PI / 7), sin = Math.sin(Math.PI / 7)
    tip = pts[pts.length - 1]
    h1 = [tip[0] - headLen * (dir[0] * cos - dir[1] * sin), tip[1] - headLen * (dir[1] * cos + dir[0] * sin)]
    h2 = [tip[0] - headLen * (dir[0] * cos + dir[1] * sin), tip[1] - headLen * (dir[1] * cos - dir[0] * sin)]
  }
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
