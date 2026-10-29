/**
 * HandDrawnEdge — 正式手绘连线：roughjs 贝塞尔 + 端点箭头（与预览线/幽灵线同用
 * RoughStroke 渲染，保证拖线预览、松手幽灵、正式连线三者样式完全一致）。
 * 运行中（源节点 running）叠加 dash 流动动画层；透明宽路径负责点选；
 * 边中点 hover/选中时浮出 ＋（点击插入节点并重接两端）。
 */
import { useContext, useMemo, useState } from 'react'
import { getBezierPath, EdgeLabelRenderer, useInternalNode } from '@xyflow/react'
import { RunningEdgesContext } from './RunningState.jsx'
import { CanvasActionsContext } from './nodes/RegistryNode.jsx'
import { RoughStroke } from './ConnectionLine.jsx'
import { offsetPoint } from './roughEdge.mjs'

export function HandDrawnEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }) {
  const [hovered, setHovered] = useState(false)
  const running = useContext(RunningEdgesContext)
  const actions = useContext(CanvasActionsContext)
  const isRunning = running?.edges?.has(id) ?? false
  const roughness = running?.roughness ?? 1.2
  const sourceState = useInternalNode(source)?.data?.state
  const targetState = useInternalNode(target)?.data?.state
  const edgeStatus = sourceState === 'error' || targetState === 'error'
    ? 'error'
    : sourceState === 'success' && targetState === 'success' ? 'success' : 'normal'

  const { path, endTangent, mid } = useMemo(() => {
    const [p, mx, my] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
    const [, ty2] = offsetPoint(targetX, targetY, targetPosition, 50)
    const [tx2] = offsetPoint(targetX, targetY, targetPosition, 50)
    void tx2
    return { path: p, endTangent: Math.atan2(targetY - ty2, targetX - tx2), mid: { x: mx, y: my } }
  }, [sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition])

  const canInsert = actions?.onEdgeInsert && !actions?.workflowRunning
  const colorVar = edgeStatus === 'error' ? '--ac-accent' : edgeStatus === 'success' ? '--ac-handle-ok' : '--ac-edge'
  return (
    <>
      <g className={isRunning ? 'ac-edge-hot' : ''} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <RoughStroke d={path} endX={targetX} endY={targetY} angle={endTangent} seed={id}
          roughness={roughness} selected={selected} colorVar={colorVar} />
      </g>
      {isRunning && <path d={path} className="ac-edge-flow" fill="none" />}
      <path d={path} className="ac-edge-hit" fill="none" stroke="transparent" strokeWidth={16} />
      {(canInsert && (hovered || selected)) && (
        <EdgeLabelRenderer>
          <button type="button" className="ac-edge-add nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`, position: 'absolute', zIndex: 20, pointerEvents: 'all' }}
            title="在此插入节点"
            onClick={e => { e.stopPropagation(); actions.onEdgeInsert(id, { x: e.clientX, y: e.clientY }) }}>＋</button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
