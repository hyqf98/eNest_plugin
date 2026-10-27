/**
 * HandDrawnEdge — roughjs 手绘贝塞尔连线 + 运行态流动虚线。
 * seed 取自 edge id 哈希（重绘抖动稳定）；箭头为两段短手绘线（按端点切线角）。
 * 运行中（源节点 running）叠加 dash 流动动画层；透明宽路径负责点选。
 */
import { useContext, useEffect, useMemo, useRef } from 'react'
import { getBezierPath } from '@xyflow/react'
import rough from 'roughjs'
import { RunningEdgesContext } from './RunningState.jsx'

function seedFrom(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h) || 7
}

function offsetPoint(x, y, position, delta) {
  if (position === 'left') return [x - delta, y]
  if (position === 'right') return [x + delta, y]
  if (position === 'top') return [x, y - delta]
  if (position === 'bottom') return [x, y + delta]
  return [x, y]
}

export function HandDrawnEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }) {
  const groupRef = useRef(null)
  const running = useContext(RunningEdgesContext)
  const isRunning = running?.edges?.has(id) ?? false
  const roughness = running?.roughness ?? 1.2

  const [path, endTangent] = useMemo(() => {
    const [p] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
    const [, cy] = offsetPoint(sourceX, sourceY, sourcePosition, 50)
    const [tx2, ty2] = offsetPoint(targetX, targetY, targetPosition, 50)
    void cy
    const angle = Math.atan2(targetY - ty2, targetX - tx2)
    return [p, angle]
  }, [sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const svg = group.ownerSVGElement ?? group.closest('svg')
    if (!svg) return
    const rc = rough.svg(svg)
    const style = getComputedStyle(group)
    const color = style.getPropertyValue('--ac-edge').trim() || '#8a5a2b'
    const width = Math.max(1.3, 2.1 - roughness * 0.3)
    const options = { seed: seedFrom(id), roughness, stroke: color, strokeWidth: width, bowing: 1.4 }
    const parts = [rc.path(path, options)]
    const head = 11
    for (const spread of [Math.PI - 0.46, Math.PI + 0.46]) {
      const a = endTangent + spread
      parts.push(rc.line(targetX, targetY, targetX + Math.cos(a) * head, targetY + Math.sin(a) * head, { ...options, strokeWidth: width + 0.2 }))
    }
    group.replaceChildren(...parts)
  }, [path, id, roughness, targetX, targetY, endTangent])

  return (
    <>
      <g ref={groupRef} className={`ac-edge-rough ${isRunning ? 'ac-edge-hot' : ''}`} />
      {isRunning && <path d={path} className="ac-edge-flow" fill="none" />}
      <path d={path} className="ac-edge-hit" fill="none" stroke="transparent" strokeWidth={16} />
    </>
  )
}
