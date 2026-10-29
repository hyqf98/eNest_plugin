/**
 * canvasNodes — 画布节点实例工厂与布局辅助。
 * makeNode 是创建节点的唯一入口：React Flow 壳 + 标准 data 一次成形。
 */

import { getNodeDef } from './nodeRegistry.mjs'
import { createNodeData, nextNodeId } from './nodeSchema.mjs'

export const NODE_WIDTH = 268
export const NODE_COLUMN_GAP = 96
export const NODE_ROW_GAP = 40
const ROW_STEP = 76

export function makeNode(type, position, extra) {
  const def = getNodeDef(type)
  if (!def) throw new Error(`未知节点类型：${type}`)
  return {
    id: nextNodeId(),
    type: 'registry',
    position,
    data: createNodeData(def, extra)
  }
}

/** 同列避让：给新节点找一个不与既有节点重叠的纵向位置 */
export function avoidOverlap(position, nodes) {
  const collides = pos => nodes.some(node => {
    const dx = Math.abs((node.position?.x ?? 0) - pos.x)
    const dy = Math.abs((node.position?.y ?? 0) - pos.y)
    return dx < NODE_WIDTH * 0.6 && dy < ROW_STEP
  })
  let spot = { ...position }
  let guard = 0
  while (collides(spot) && guard < 200) {
    spot = { ...spot, y: spot.y + ROW_STEP }
    guard += 1
  }
  return spot
}

/** 在源节点右侧新建下游节点的落点 */
export function downstreamPosition(sourceNode, nodes) {
  const base = sourceNode?.position ?? { x: 0, y: 0 }
  return avoidOverlap({ x: base.x + NODE_WIDTH + NODE_COLUMN_GAP, y: base.y }, nodes)
}

/** 在目标节点左侧新建上游节点的落点 */
export function upstreamPosition(targetNode, nodes) {
  const base = targetNode?.position ?? { x: 0, y: 0 }
  return avoidOverlap({ x: base.x - NODE_WIDTH - NODE_COLUMN_GAP, y: base.y }, nodes)
}

/**
 * 拖线松手建点的落位：nodeOrigin 是 [0.5,0.5]（position=节点中心），
 * 但用户期望松手点 = 新节点的接入口位置。isSource（从输出端口拖出）时新节点
 * 的输入口在左缘 → 中心右移半宽；反向拖时新节点的输出口在右缘 → 中心左移半宽。
 */
export function dropAnchorPosition(drop, { asTarget }) {
  const half = NODE_WIDTH / 2
  return { x: drop.x + (asTarget ? half : -half), y: drop.y }
}

/** 自动排版：按拓扑分层，层内纵向堆叠，返回新位置表 */
export function layoutPositions(nodes, edges, topoLevels) {
  const levels = topoLevels(nodes, edges)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const positions = new Map()
  levels.forEach((level, column) => {
    // 层内按现有 y 排序，保留用户手工调序的意图
    const ordered = [...level].sort((a, b) => (byId.get(a)?.position?.y ?? 0) - (byId.get(b)?.position?.y ?? 0))
    let cursorY = 0
    for (const id of ordered) {
      positions.set(id, { x: column * (NODE_WIDTH + NODE_COLUMN_GAP), y: cursorY })
      cursorY += 200
    }
  })
  return positions
}
