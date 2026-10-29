/**
 * roughEdge — 手绘连线几何工具（正式边 / 拖线预览 / 幽灵线共用，保证三者样式一致）。
 */
import rough from 'roughjs'

/** 稳定种子：同一 id 的抖动形状恒定 */
export function seedFrom(id) {
  let h = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) || 7
}

/** 沿 handle 方位外移取切线参考点（箭头角度用） */
export function offsetPoint(x, y, position, delta) {
  if (position === 'left') return [x - delta, y]
  if (position === 'right') return [x + delta, y]
  if (position === 'top') return [x, y - delta]
  if (position === 'bottom') return [x, y + delta]
  return [x, y]
}

/** 生成一段手绘贝塞尔 + 端点双短线箭头；返回可 append 进 <g> 的 SVG 元素数组 */
export function roughEdgeParts(svgRoot, { d, endX, endY, angle, seed, color, roughness = 1.2, width = 2, arrow = true }) {
  const rc = rough.svg(svgRoot)
  const options = { seed, roughness, stroke: color, strokeWidth: width, bowing: 1.4 }
  const parts = [rc.path(d, options)]
  if (arrow) {
    const head = 11
    for (const spread of [Math.PI - 0.46, Math.PI + 0.46]) {
      const a = angle + spread
      parts.push(rc.line(endX, endY, endX + Math.cos(a) * head, endY + Math.sin(a) * head, { ...options, strokeWidth: width + 0.2 }))
    }
  }
  return parts
}

/** 取当前纸面 --ac-edge 描边色（portal 元素也能从 :root 兜底继承到） */
export function edgeColor(el) {
  try { return getComputedStyle(el).getPropertyValue('--ac-edge').trim() || '#8a5a2b' } catch { return '#8a5a2b' }
}
