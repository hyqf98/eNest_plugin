/**
 * CanvasStage — React Flow 画布实例。
 * 注册 registry 节点 + 手绘连线；端口 kind 校验连线；左轨拖放/点击加节点；
 * 点阵纸底、手绘选择框；连线类型 image/image、text/text 才有效。
 */
import { useCallback, useMemo, useRef } from 'react'
import { ReactFlow, Background, BackgroundVariant, MiniMap, useReactFlow, getBezierPath } from '@xyflow/react'
import { getNodeDef, defaultParams } from '../js/nodeRegistry.mjs'
import { RegistryNode, CanvasActionsContext } from './nodes/RegistryNode.jsx'
import { HandDrawnEdge } from './HandDrawnEdge.jsx'
import { RunningEdgesContext } from './RunningState.jsx'

const nodeTypes = { registry: RegistryNode }
const edgeTypes = { handdrawn: HandDrawnEdge }

let nodeSeq = 0
export function makeNode(type, position, extra = {}) {
  const id = `n${Date.now().toString(36)}${(nodeSeq++).toString(36)}`
  return {
    id, type: 'registry', position,
    data: { type, params: defaultParams(type), state: 'idle', error: null, lastRun: null, ...extra }
  }
}

export function CanvasStage({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onSelectionChange,
  actions, runningEdges, onDropNode, onPaneContextMenu, onNodeDoubleClick }) {
  const { screenToFlowPosition } = useReactFlow()
  const wrapperRef = useRef(null)

  const isValidConnection = useCallback((connection) => {
    if (!connection.sourceHandle || !connection.targetHandle) return false
    if (connection.source === connection.target) return false
    const source = nodes.find(n => n.id === connection.source)
    const target = nodes.find(n => n.id === connection.target)
    if (!source || !target) return false
    const sourceDef = getNodeDef(source.data.type)
    const targetDef = getNodeDef(target.data.type)
    const out = sourceDef?.outputs.find(p => p.key === connection.sourceHandle)
    const input = targetDef?.inputs.find(p => p.key === connection.targetHandle)
    if (!out || !input) return false
    if (out.kind !== input.kind) return false
    if (edges.some(e => e.source === connection.source && e.sourceHandle === connection.sourceHandle
      && e.target === connection.target && e.targetHandle === connection.targetHandle)) return false
    // 禁止成环：目标可达源则拒绝
    const adjacency = new Map()
    for (const e of edges) {
      if (!adjacency.has(e.source)) adjacency.set(e.source, [])
      adjacency.get(e.source).push(e.target)
    }
    const queue = [connection.target]
    const seen = new Set()
    while (queue.length) {
      const cur = queue.pop()
      if (cur === connection.source) return false
      if (seen.has(cur)) continue
      seen.add(cur)
      queue.push(...(adjacency.get(cur) ?? []))
    }
    return true
  }, [nodes, edges])

  const onDragOver = useCallback((event) => {
    if (event.dataTransfer.types.includes('application/x-ai-canvas-node')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    }
  }, [])

  const onDrop = useCallback((event) => {
    const type = event.dataTransfer.getData('application/x-ai-canvas-node')
    if (!type) return
    event.preventDefault()
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    onDropNode(type, position)
  }, [screenToFlowPosition, onDropNode])

  return (
    <div className="ac-stage" ref={wrapperRef}>
      <CanvasActionsContext.Provider value={actions}>
        <RunningEdgesContext.Provider value={runningEdges}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneContextMenu={onPaneContextMenu}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodeOrigin={[0.5, 0.5]}
            isValidConnection={isValidConnection}
            onDragOver={onDragOver}
            onDrop={onDrop}
            defaultEdgeOptions={{ type: 'handdrawn' }}
            connectionLineType={'default'}
            connectionLineStyle={{ stroke: 'var(--ac-accent)', strokeWidth: 2, strokeDasharray: '6 5' }}
            selectNodesOnDrag
            panOnScroll={false}
            zoomOnDoubleClick={false}
            minZoom={0.25}
            maxZoom={2.5}
            proOptions={{ hideAttribution: false }}
          >
            <Background variant={BackgroundVariant.Dots} gap={26} size={1.6} color="var(--ac-grid)" className="ac-paper-grid" />
            <MiniMap pannable zoomable className="ac-minimap" nodeColor={() => 'var(--ac-minimap-node)'} maskColor="var(--ac-minimap-mask)" />
          </ReactFlow>
        </RunningEdgesContext.Provider>
      </CanvasActionsContext.Provider>
    </div>
  )
}
