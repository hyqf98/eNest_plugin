/**
 * objects.mjs —— 画板统一对象模型与几何计算（纯逻辑，无 DOM 依赖）
 *
 * 对象类型：
 *  - ink    墨迹（钢笔/荧光笔）：perfect-freehand 点序列 [{x,y,p}] 世界坐标
 *  - shape  手绘图形：rect/ellipse/line/arrow {x,y,w,h}（line/arrow 用 x,y→x2,y2）
 *  - text   文字：{x,y,text,size,color}
 *  - image  贴图：{x,y,w,h,blobId}
 * 所有对象带 id / kind / color / z（数组序即 z 序，不单独存 z 字段）。
 *
 * 变换约定：世界坐标原点在画布中心（初始视口 0,0 对准窗口中心），
 * 平移缩放只改 viewport，不改对象坐标；对象拖动/缩放直接改世界坐标。
 */

let uidCounter = 0
export function uid() {
  uidCounter += 1
  return `o${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/* ---------- 包围盒 ---------- */

export function inkBBox(points, size) {
  const half = Math.max(size / 2 + 1, 2)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX - half, y: minY - half, w: maxX - minX + half * 2, h: maxY - minY + half * 2 }
}

export function objectBBox(obj) {
  switch (obj.kind) {
    case 'ink':
    case 'erase':
      return inkBBox(obj.points, obj.size)
    case 'shape': {
      const x2 = obj.x2 ?? obj.x + obj.w
      const y2 = obj.y2 ?? obj.y + obj.h
      return { x: Math.min(obj.x, x2), y: Math.min(obj.y, y2), w: Math.abs(x2 - obj.x), h: Math.abs(y2 - obj.y) }
    }
    case 'text': {
      // 文字宽度需测量，这里给近似值；精确值由 render 层量测后回填 obj._w
      const lines = String(obj.text || '').split('\n')
      const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '')
      const approxW = Math.max(longest.length, 1) * obj.size * (obj._measured ? 1 : 1.05)
      const w = obj._w ?? approxW
      const h = lines.length * obj.size * 1.3
      return { x: obj.x, y: obj.y, w, h }
    }
    case 'image': return { x: obj.x, y: obj.y, w: obj.w, h: obj.h }
    default: return { x: 0, y: 0, w: 0, h: 0 }
  }
}

export function selectionBBox(objects) {
  if (!objects.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const obj of objects) {
    const b = objectBBox(obj)
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function contentBBox(objects, padding = 16) {
  const b = selectionBBox(objects)
  if (!b) return null
  return { x: b.x - padding, y: b.y - padding, w: b.w + padding * 2, h: b.h + padding * 2 }
}

/* ---------- 命中检测 ---------- */

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

export function hitInk(obj, wx, wy, tolerance = 6) {
  const pts = obj.points
  const hitR = Math.max(obj.size / 2, 2) + tolerance
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(wx, wy, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= hitR) return true
  }
  if (pts.length === 1) return Math.hypot(wx - pts[0].x, wy - pts[0].y) <= hitR
  return false
}

export function hitShape(obj, wx, wy, tolerance = 6) {
  const x2 = obj.x2 ?? obj.x + obj.w
  const y2 = obj.y2 ?? obj.y + obj.h
  const minX = Math.min(obj.x, x2), maxX = Math.max(obj.x, x2)
  const minY = Math.min(obj.y, y2), maxY = Math.max(obj.y, y2)
  if (obj.type === 'line' || obj.type === 'arrow') {
    return distToSegment(wx, wy, obj.x, obj.y, x2, y2) <= Math.max(obj.stroke / 2, 2) + tolerance
  }
  // 矩形/椭圆：包围区域整体可选中（无填充手绘框点中心也应选中）
  return wx >= minX - tolerance && wx <= maxX + tolerance && wy >= minY - tolerance && wy <= maxY + tolerance
}

export function hitText(obj, wx, wy, tolerance = 4) {
  const b = objectBBox(obj)
  return wx >= b.x - tolerance && wx <= b.x + b.w + tolerance && wy >= b.y - tolerance && wy <= b.y + b.h + tolerance
}

export function hitImage(obj, wx, wy) {
  const b = objectBBox(obj)
  return wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h
}

/** 从顶（数组末尾）往下找第一个命中对象（擦除笔迹不可命中） */
export function hitTest(objects, wx, wy, tolerance = 6) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i]
    if (obj.kind === 'erase') continue
    if (obj.kind === 'ink' && hitInk(obj, wx, wy, tolerance)) return obj
    if (obj.kind === 'shape' && hitShape(obj, wx, wy, tolerance)) return obj
    if (obj.kind === 'text' && hitText(obj, wx, wy, tolerance)) return obj
    if (obj.kind === 'image' && hitImage(obj, wx, wy)) return obj
  }
  return null
}

/** 框选：bbox 与选框相交即选中（文字/图形边框语义一致）；擦除笔迹不可选 */
export function marqueeSelect(objects, rect) {
  const minX = Math.min(rect.x, rect.x + rect.w), minY = Math.min(rect.y, rect.y + rect.h)
  const maxX = Math.max(rect.x, rect.x + rect.w), maxY = Math.max(rect.y, rect.y + rect.h)
  const out = []
  for (const obj of objects) {
    if (obj.kind === 'erase') continue
    const b = objectBBox(obj)
    if (b.x + b.w < minX || b.x > maxX || b.y + b.h < minY || b.y > maxY) continue
    out.push(obj.id)
  }
  return out
}

/* ---------- 变换 ---------- */

export function translateObject(obj, dx, dy) {
  if (obj.kind === 'ink') {
    for (const p of obj.points) { p.x += dx; p.y += dy }
  } else if (obj.kind === 'shape') {
    obj.x += dx; obj.y += dy
    if (obj.x2 != null) obj.x2 += dx
    if (obj.y2 != null) obj.y2 += dy
  } else {
    obj.x += dx; obj.y += dy
  }
}

/** 以锚点为中心缩放对象（sx/sy 为因子） */
export function scaleObject(obj, sx, sy, anchor) {
  const map = (v, a, f) => a + (v - a) * f
  if (obj.kind === 'ink') {
    for (const p of obj.points) {
      p.x = map(p.x, anchor.x, sx)
      p.y = map(p.y, anchor.y, sy)
    }
    obj.size *= (sx + sy) / 2
  } else if (obj.kind === 'shape') {
    obj.x = map(obj.x, anchor.x, sx)
    obj.y = map(obj.y, anchor.y, sy)
    if (obj.x2 != null) obj.x2 = map(obj.x2, anchor.x, sx)
    if (obj.y2 != null) obj.y2 = map(obj.y2, anchor.y, sy)
    obj.stroke *= (sx + sy) / 2
  } else if (obj.kind === 'text') {
    obj.x = map(obj.x, anchor.x, sx)
    obj.y = map(obj.y, anchor.y, sy)
    obj.size *= (sx + sy) / 2
  } else if (obj.kind === 'image') {
    obj.x = map(obj.x, anchor.x, sx)
    obj.y = map(obj.y, anchor.y, sy)
    obj.w *= sx
    obj.h *= sy
  }
}

/* ---------- 墨迹橡皮（矢量切分） ---------- */

/**
 * 局部橡皮：半径 r 的圆沿路径扫过，命中的点序被移除，剩余连续段切成多条新墨迹。
 * 返回 null 表示未命中；返回 {removed, pieces} 由调用方重建对象数组。
 */
export function eraseInkSplit(obj, wx, wy, r) {
  const pts = obj.points
  const keep = new Array(pts.length).fill(true)
  let hitAny = false
  // 所见即所擦：命中半径就是橡皮圆半径 r（不叠加笔宽，圆圈多大擦多大）
  const er = r
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(pts[i].x - wx, pts[i].y - wy) <= er) { keep[i] = false; hitAny = true }
  }
  // 相邻连线中点穿过擦除区：只删两点中距圆更近者，避免一判双删导致断链过宽
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i].x + pts[i - 1].x) / 2, my = (pts[i].y + pts[i - 1].y) / 2
    if (Math.hypot(mx - wx, my - wy) <= er) {
      hitAny = true
      const di = Math.hypot(pts[i].x - wx, pts[i].y - wy)
      const dp = Math.hypot(pts[i - 1].x - wx, pts[i - 1].y - wy)
      if (di <= dp) keep[i] = false
      else keep[i - 1] = false
    }
  }
  if (!hitAny) return null
  const pieces = []
  let current = []
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) current.push(pts[i])
    else if (current.length) { pieces.push(current); current = [] }
  }
  if (current.length) pieces.push(current)
  // 单点段丢弃（太短无意义）；两点以下保留（点一下）
  const valid = pieces.filter((ps) => ps.length >= 2 || (ps.length === 1 && obj.points.length === 1))
  return { removed: !valid.length, pieces: valid }
}

/* ---------- 工厂 ---------- */

export function makeInk(points, { color, size, highlighter = false }) {
  return { id: uid(), kind: 'ink', points, color, size, highlighter }
}

export function makeShape(type, a, { color, stroke, seed, fill }) {
  const base = { id: uid(), kind: 'shape', type, color, stroke, seed: seed ?? (Math.random() * 2000) | 0, fill: fill || 'none' }
  if (type === 'line' || type === 'arrow') return { ...base, x: a.x, y: a.y, x2: a.x, y2: a.y }
  return { ...base, x: a.x, y: a.y, w: 0, h: 0 }
}

export function makeText(x, y, { color, size, text = '' }) {
  return { id: uid(), kind: 'text', x, y, text, size, color }
}

export function makeImage(x, y, w, h, { blobId, opacity = 1 }) {
  return { id: uid(), kind: 'image', x, y, w, h, blobId, opacity }
}

/** 深拷贝一批对象并平移（原位复制用） */
export function cloneObjects(objects, dx = 12, dy = 12) {
  return objects.map((obj) => {
    const copy = JSON.parse(JSON.stringify(obj))
    copy.id = uid()
    translateObject(copy, dx, dy)
    return copy
  })
}
