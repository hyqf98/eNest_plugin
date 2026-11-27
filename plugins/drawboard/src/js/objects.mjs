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
 *
 * 图形的可变换特性（都是可选字段，旧文档不带这些字段时按默认值处理）：
 *  - rect   roundness：圆角半径（世界单位），0 = 直角
 *  - line / arrow  points：世界坐标点列。直线上只有起点和终点两个点；
 *    拖动中点会往里插入中间点，由 curved=true 走平滑曲线。
 *    x,y / x2,y2 始终等于点列的首尾，旧代码按两端读写的逻辑不用改。
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
      // 弯曲的线/箭头：曲线会鼓出控制点围成的矩形，按采样后的实际走向取包围盒
      if (isLinear(obj) && obj.curved) return linearBBox({ ...obj, points: linearCurveSamples(obj) })
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

/* ---------- 线 / 箭头的点列 ---------- */

/** 矩形圆角半径上限：短边的一半（再大就是胶囊形，超过没有视觉意义） */
export const RECT_ROUND_MAX = (obj) => Math.max(0, Math.min(Math.abs(obj.w), Math.abs(obj.h)) / 2)
/** 矩形圆角半径的像素上限，和 Excalidraw 的固定半径一致：大矩形不会变成巨大的胶囊 */
export const RECT_ROUND_LIMIT = 32

export function rectRoundness(obj) {
  const limit = Math.min(RECT_ROUND_LIMIT, RECT_ROUND_MAX(obj))
  const value = Number(obj.roundness)
  return Number.isFinite(value) ? Math.max(0, Math.min(limit, value)) : 0
}

/** 是否线/箭头（点列类型的图形） */
export const isLinear = (obj) => obj.kind === 'shape' && (obj.type === 'line' || obj.type === 'arrow')

/**
 * 线/箭头的点列（世界坐标）。带 points 的用 points；旧数据只有两端，按两点直线返回。
 * 首尾始终与 x,y / x2,y2 同步，所以任何读写点列的地方都不用再区分新旧数据。
 */
export function linearPoints(obj) {
  if (Array.isArray(obj.points) && obj.points.length >= 2) {
    // 以 x,y / x2,y2 为准重建首尾：无论 points 是否与两端共享引用，读到的永远一致
    const middle = obj.points.slice(1, -1).map((p) => ({ x: p.x, y: p.y }))
    return [{ x: obj.x, y: obj.y }, ...middle, { x: obj.x2 ?? obj.x + obj.w, y: obj.y2 ?? obj.y + obj.h }]
  }
  return [{ x: obj.x, y: obj.y }, { x: obj.x2 ?? obj.x + obj.w, y: obj.y2 ?? obj.y + obj.h }]
}

/** 写入点列并同步两端（唯一入口：改了点列就调它，保证首尾与 x,y / x2,y2 永远一致） */
export function setLinearPoints(obj, points) {
  const first = points[0], last = points[points.length - 1]
  obj.x = first.x; obj.y = first.y
  obj.x2 = last.x; obj.y2 = last.y
  obj.points = points.map((p) => ({ x: p.x, y: p.y }))
  obj.curved = points.length > 2
}

/** 线/箭头的控制柄位置：每两个相邻点之间的中点（屏幕/世界坐标取决于传入点列的坐标系） */
export function linearMidpoints(points) {
  const out = []
  for (let i = 1; i < points.length; i++) {
    out.push({ index: i, x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 })
  }
  return out
}

/* ---------- 包围盒：点列 ---------- */

function linearBBox(obj) {
  const pts = linearPoints(obj)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * 采样曲线得到更紧的包围盒：弯曲的线，其曲线可能超出控制点围成的矩形。
 * 采样数固定，保证同一对象的包围盒稳定。
 */
export function linearCurveSamples(obj, steps = 16) {
  const pts = linearPoints(obj)
  if (!obj.curved || pts.length < 3) return pts
  const out = [pts[0]]
  // Catmull-Rom 样条过所有控制点，与绘制层 rough.curve 的走向一致（端点处用重复端点补足）
  const P = [pts[0], ...pts, pts[pts.length - 1]]
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2]
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  return out
}

/* ---------- 箭头几何（绘制与命中共用，Excalidraw 风：箭头翼随杆长成比例） ---------- */

export const ARROW_SPREAD = Math.PI / 7

/** 返回 { angle, headLen, h1:[x,y], tip:[x,y], h2:[x,y], back:[x,y] }：h1→tip→h2 为箭翼折线，back 为杆的收尾点 */
export function arrowGeometry(x1, y1, x2, y2) {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const shaft = Math.hypot(x2 - x1, y2 - y1)
  const headLen = Math.min(22, Math.max(7, shaft * 0.22))
  const h1 = [x2 - headLen * Math.cos(angle - ARROW_SPREAD), y2 - headLen * Math.sin(angle - ARROW_SPREAD)]
  const h2 = [x2 - headLen * Math.cos(angle + ARROW_SPREAD), y2 - headLen * Math.sin(angle + ARROW_SPREAD)]
  // 杆只画到箭翼在杆向上的投影点，箭头不“出头”
  const back = [x2 - headLen * Math.cos(angle) * Math.cos(ARROW_SPREAD), y2 - headLen * Math.sin(angle) * Math.cos(ARROW_SPREAD)]
  return { angle, headLen, h1, tip: [x2, y2], h2, back }
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

/** 矩形四边贴边命中（Excalidraw 同款：空心图形点内部不拦截） */
function hitRectBorder(obj, wx, wy, tolerance) {
  const x2 = obj.x2 ?? obj.x + obj.w
  const y2 = obj.y2 ?? obj.y + obj.h
  const minX = Math.min(obj.x, x2), maxX = Math.max(obj.x, x2)
  const minY = Math.min(obj.y, y2), maxY = Math.max(obj.y, y2)
  const t = Math.max(obj.stroke / 2, 2) + tolerance
  return distToSegment(wx, wy, minX, minY, maxX, minY) <= t
    || distToSegment(wx, wy, maxX, minY, maxX, maxY) <= t
    || distToSegment(wx, wy, maxX, maxY, minX, maxY) <= t
    || distToSegment(wx, wy, minX, maxY, minX, minY) <= t
}

/** 椭圆轮廓采样命中 */
function hitEllipseBorder(obj, wx, wy, tolerance) {
  const x2 = obj.x2 ?? obj.x + obj.w
  const y2 = obj.y2 ?? obj.y + obj.h
  const minX = Math.min(obj.x, x2), minY = Math.min(obj.y, y2)
  const w = Math.abs(x2 - obj.x), h = Math.abs(y2 - obj.y)
  const cx = minX + w / 2, cy = minY + h / 2
  const a = Math.max(w / 2, 1), b = Math.max(h / 2, 1)
  const t = Math.max(obj.stroke / 2, 2) + tolerance
  const steps = 32
  let px = cx + a, py = cy
  for (let i = 1; i <= steps; i++) {
    const ang = (i / steps) * Math.PI * 2
    const nx = cx + a * Math.cos(ang), ny = cy + b * Math.sin(ang)
    if (distToSegment(wx, wy, px, py, nx, ny) <= t) return true
    px = nx; py = ny
  }
  return false
}

/** 线/箭头命中：沿实际走向（曲线则沿采样折线）逐段算距离 */
function hitLinear(obj, wx, wy, tolerance) {
  const t = Math.max(obj.stroke / 2, 2) + tolerance
  const pts = linearCurveSamples(obj)
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(wx, wy, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= t) return true
  }
  return false
}

export function hitShape(obj, wx, wy, tolerance = 6) {
  if (isLinear(obj)) return hitLinear(obj, wx, wy, tolerance)
  if (obj.fill && obj.fill !== 'none') return hitShapeInterior(obj, wx, wy, tolerance)
  if (obj.type === 'rect') return hitRectBorder(obj, wx, wy, tolerance)
  if (obj.type === 'ellipse') return hitEllipseBorder(obj, wx, wy, tolerance)
  return false
}

function hitShapeInterior(obj, wx, wy, tolerance = 6) {
  const x2 = obj.x2 ?? obj.x + obj.w
  const y2 = obj.y2 ?? obj.y + obj.h
  const minX = Math.min(obj.x, x2), maxX = Math.max(obj.x, x2)
  const minY = Math.min(obj.y, y2), maxY = Math.max(obj.y, y2)
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

/** 同点全部精确命中（从顶往下），供选中循环使用 */
export function hitChain(objects, wx, wy, tolerance = 6) {
  const strict = []
  const interior = []
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i]
    if (obj.kind === 'erase') continue
    if (obj.kind === 'ink') { if (hitInk(obj, wx, wy, tolerance)) strict.push(obj); continue }
    if (obj.kind === 'shape') {
      if (hitShape(obj, wx, wy, tolerance)) { strict.push(obj); continue }
      // 空心图形内部：兜底候选，只有没有任何精确命中时才生效
      if ((obj.type === 'rect' || obj.type === 'ellipse') && hitShapeInterior(obj, wx, wy, tolerance)) interior.push(obj)
      continue
    }
    if (obj.kind === 'text') { if (hitText(obj, wx, wy, tolerance)) strict.push(obj); continue }
    if (obj.kind === 'image') { if (hitImage(obj, wx, wy)) strict.push(obj) }
  }
  return { strict, interior }
}

/** 框选：对象必须完全落在选框内（Excalidraw 语义，避免贴边带出别的东西）；擦除笔迹不可选 */
export function marqueeSelect(objects, rect) {
  const minX = Math.min(rect.x, rect.x + rect.w), minY = Math.min(rect.y, rect.y + rect.h)
  const maxX = Math.max(rect.x, rect.x + rect.w), maxY = Math.max(rect.y, rect.y + rect.h)
  const out = []
  for (const obj of objects) {
    if (obj.kind === 'erase') continue
    const b = objectBBox(obj)
    if (b.x >= minX && b.x + b.w <= maxX && b.y >= minY && b.y + b.h <= maxY) out.push(obj.id)
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
    // 点列整体平移（linearPoints 读的时候会以 x,y / x2,y2 重建首尾，这里全量移动即可）
    if (Array.isArray(obj.points)) for (const p of obj.points) { p.x += dx; p.y += dy }
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
    // 矩形/椭圆以 w/h 存形：不缩放宽高就只剩一条线
    if (obj.w != null) obj.w *= sx
    if (obj.h != null) obj.h *= sy
    // 中间点与圆角跟着形状一起缩放（等比时圆角保持视觉大小，非等比时取两向均值）
    if (Array.isArray(obj.points)) for (let i = 1; i < obj.points.length - 1; i++) {
      obj.points[i] = { x: map(obj.points[i].x, anchor.x, sx), y: map(obj.points[i].y, anchor.y, sy) }
    }
    if (obj.roundness != null) obj.roundness *= (sx + sy) / 2
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
