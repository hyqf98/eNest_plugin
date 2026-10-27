/**
 * useAlignGuides — 拖拽节点时的 5px 对齐吸附 + 辅助线（Dify useHelpline 同款）。
 *
 * onNodeDrag 里拿被拖节点与其余节点的 left/top 比对，记录对齐命中；
 * onNodeDragStop 返回吸附后的坐标（无命中返回 null），由调用方写回节点并清零辅助线。
 * 辅助线以画布坐标渲染（ViewportPortal 内），自动随缩放平移。
 */
import { useCallback, useMemo, useState } from 'react'

const ALIGN_THRESHOLD = 5
const DEFAULT_H = 140
const DEFAULT_W = 268

export function useAlignGuides(nodesRef) {
  const [guides, setGuides] = useState({ x: [], y: [] })

  const onNodeDrag = useCallback((event, node) => {
    const others = (nodesRef.current ?? []).filter(n => n.id !== node.id && !n.hidden)
    const nextX = []
    const nextY = []
    for (const other of others) {
      if (Math.abs(other.position.x - node.position.x) < ALIGN_THRESHOLD) {
        nextX.push({ pos: other.position.x, from: Math.min(other.position.y, node.position.y), to: Math.max(other.position.y + (other.measured?.height ?? DEFAULT_H), node.position.y + (node.measured?.height ?? DEFAULT_H)) })
      }
      if (Math.abs(other.position.y - node.position.y) < ALIGN_THRESHOLD) {
        nextY.push({ pos: other.position.y, from: Math.min(other.position.x, node.position.x), to: Math.max(other.position.x + (other.measured?.width ?? DEFAULT_W), node.position.x + (node.measured?.width ?? DEFAULT_W)) })
      }
    }
    setGuides(prev => {
      if (prev.x.length === nextX.length && prev.y.length === nextY.length
        && prev.x.every((g, i) => g.pos === nextX[i]?.pos) && prev.y.every((g, i) => g.pos === nextY[i]?.pos)) return prev
      return { x: nextX, y: nextY }
    })
  }, [nodesRef])

  /** 返回吸附后的目标坐标（未命中则 null），并清除辅助线 */
  const onNodeDragStop = useCallback((event, node) => {
    setGuides({ x: [], y: [] })
    const others = (nodesRef.current ?? []).filter(n => n.id !== node.id && !n.hidden)
    let snapped = null
    for (const other of others) {
      if (Math.abs(other.position.x - node.position.x) < ALIGN_THRESHOLD) snapped = { ...(snapped ?? node.position), x: other.position.x }
      if (Math.abs(other.position.y - node.position.y) < ALIGN_THRESHOLD) snapped = { ...(snapped ?? node.position), y: other.position.y }
    }
    return snapped
  }, [nodesRef])

  const guideElements = useMemo(() => (
    <>
      {guides.x.map((g, i) => <div key={`vx-${i}`} className="ac-guide ac-guide-v" style={{ left: g.pos, top: g.from, height: Math.max(8, g.to - g.from) }} />)}
      {guides.y.map((g, i) => <div key={`hy-${i}`} className="ac-guide ac-guide-h" style={{ top: g.pos, left: g.from, width: Math.max(8, g.to - g.from) }} />)}
    </>
  ), [guides])

  return { onNodeDrag, onNodeDragStop, guideElements }
}
