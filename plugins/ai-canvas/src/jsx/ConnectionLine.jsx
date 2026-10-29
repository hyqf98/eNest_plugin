/**
 * ConnectionLine — 手绘预览线（拖拽中）与幽灵线（松手弹选择器期间）共用组件。
 * 与正式连线 HandDrawnEdge 同款 roughjs 贝塞尔 + 端点箭头 + --ac-edge 色，
 * 消除"拖出来是虚线、连上后变实线、中间还断线"的不一致。
 */
import { useEffect, useMemo, useRef } from 'react'
import { getBezierPath } from '@xyflow/react'
import { roughEdgeParts, seedFrom, edgeColor, offsetPoint } from './roughEdge.mjs'

/** 给定两端，算出手绘贝塞尔 path 与箭头切线角 */
function edgeGeom(fromX, fromY, toX, toY, fromPosition, toPosition) {
  const [d] = getBezierPath({ sourceX: fromX, sourceY: fromY, targetX: toX, targetY: toY, sourcePosition: fromPosition, targetPosition: toPosition })
  const [, ty2] = offsetPoint(toX, toY, toPosition, 50)
  const [tx2] = offsetPoint(toX, toY, toPosition, 50)
  const angle = Math.atan2(toY - ty2, toX - tx2)
  void tx2
  return { d, angle }
}

/** 把一段手绘贝塞尔（带箭头）画进传入的 <g>；colorVar 覆盖描边色（状态线传 --ac-accent 等） */
export function RoughStroke({ d, endX, endY, angle, seed, roughness = 1.2, arrow = true, ghost = false, selected = false, colorVar = '--ac-edge' }) {
  const ref = useRef(null)
  useEffect(() => {
    const g = ref.current
    if (!g) return
    const svg = g.ownerSVGElement ?? g.closest('svg')
    if (!svg) return
    const color = getComputedStyle(g).getPropertyValue(colorVar).trim() || edgeColor(g)
    const width = Math.max(1.3, 2.1 - roughness * 0.3) + (selected ? 0.8 : 0)
    g.replaceChildren(...roughEdgeParts(svg, { d, endX, endY, angle, seed: seedFrom(seed), color, roughness, width, arrow }))
    g.style.opacity = ghost ? '0.85' : '1'
  }, [d, endX, endY, angle, seed, roughness, arrow, ghost, selected, colorVar])
  return <g ref={ref} />
}

/** React Flow connectionLineComponent：拖拽连线过程中显示 */
export function HandDrawnConnectionLine({ fromX, fromY, toX, toY, fromPosition, toPosition }) {
  const { d, angle } = useMemo(
    () => edgeGeom(fromX, fromY, toX, toY, fromPosition, toPosition),
    [fromX, fromY, toX, toY, fromPosition, toPosition]
  )
  return <RoughStroke d={d} endX={toX} endY={toY} angle={angle} seed="connection-preview" />
}

/**
 * 幽灵线：松手弹选择器期间，从源端口持续画到落点，选完/取消即由正式线或清除接管。
 * 必须自带 <svg> 根（ViewportPortal 提供的是 div），且 svg 根要占满视口容器：
 * SVG 根 overflow 默认 hidden，0×0 根会把绘制内容整个裁掉（元素存在但画不出来）。
 * 坐标是 flow 坐标（随 viewport 变换），inset:0 + overflow:visible 兼容负坐标。
 */
export function ConnectionGhost({ from, to, fromPosition = 'right', toPosition = 'left' }) {
  if (!from || !to) return null
  const { d, angle } = edgeGeom(from.x, from.y, to.x, to.y, fromPosition, toPosition)
  return (
    <svg className="ac-ghost-svg" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none', zIndex: 20 }}>
      <RoughStroke d={d} endX={to.x} endY={to.y} angle={angle} seed="connection-ghost" ghost />
    </svg>
  )
}
