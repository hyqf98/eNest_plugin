/**
 * CanvasStage — React Flow 画布实例。
 * 注册 registry 节点 + 手绘连线；连线校验走 nodeSchema 的端口兼容表；
 * 左轨拖放/点击加节点；点阵纸底；V/H 双操作模式；拖拽对齐吸附 + 辅助线；
 * 右键菜单与运行期只读由 props 传入，删除快捷键统一交 App 编排。
 */
import { useCallback, useRef } from 'react'
import { ReactFlow, Background, BackgroundVariant, MiniMap, ViewportPortal, useReactFlow } from '@xyflow/react'
import { getNodeDef } from '../js/nodeRegistry.mjs'
import { compatibleKinds, findPort } from '../js/nodeSchema.mjs'
import { RegistryNode, CanvasActionsContext } from './nodes/RegistryNode.jsx'
import { HandDrawnEdge } from './HandDrawnEdge.jsx'
import { HandDrawnConnectionLine, ConnectionGhost } from './ConnectionLine.jsx'
import { RunningEdgesContext } from './RunningState.jsx'
import { useAlignGuides } from './hooks/useAlignGuides.jsx'

const nodeTypes = { registry: RegistryNode }
const edgeTypes = { handdrawn: HandDrawnEdge }

export function CanvasStage({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onConnectEnd,
  actions, runningEdges, mode, readOnly, nodesRef, onDropNode, ghost,
  onPaneContextMenu, onNodeContextMenu, onEdgeContextMenu }) {

  const { screenToFlowPosition } = useReactFlow()
  const guides = useAlignGuides(nodesRef)
  const stageRef = useRef(null)

  const isValidConnection = useCallback((connection) => {
    if (!connection.sourceHandle && !connection.targetHandle) return false
    if (connection.source === connection.target) return false
    const source = nodes.find(n => n.id === connection.source)
    const target = nodes.find(n => n.id === connection.target)
    if (!source || !target) return false
    const sourceDef = getNodeDef(source.data.type)
    const targetDef = getNodeDef(target.data.type)
    const out = findPort(sourceDef?.outputs, connection.sourceHandle)
    const input = findPort(targetDef?.inputs, connection.targetHandle)
    if (!out || !input) return false
    if (!compatibleKinds(out.kind, input.kind)) return false
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
    onDropNode(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }, [screenToFlowPosition, onDropNode])

  const pointerMode = mode === 'pointer'
  return (
    <div className="ac-stage" ref={stageRef}>
      <CanvasActionsContext.Provider value={actions}>
        <RunningEdgesContext.Provider value={runningEdges}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodeOrigin={[0.5, 0.5]}
            isValidConnection={isValidConnection}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeDrag={guides.onNodeDrag}
            onNodeDragStop={(event, node) => {
              const snapped = guides.onNodeDragStop(event, node)
              if (snapped) onNodesChange([{ id: node.id, type: 'position', position: snapped }])
            }}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            defaultEdgeOptions={{ type: 'handdrawn' }}
            connectionLineComponent={HandDrawnConnectionLine}
            connectionLineContainerStyle={{ zIndex: 20 }}
            panOnScroll={pointerMode}
            zoomOnScroll={!pointerMode}
            zoomActivationKeyCode={pointerMode ? 'Meta' : null}
            panOnDrag={pointerMode ? [1] : true}
            selectionOnDrag={pointerMode}
            selectionMode="partial"
            multiSelectionKeyCode={null}
            zoomOnDoubleClick={false}
            minZoom={0.25}
            maxZoom={2.5}
            nodesDraggable={!readOnly && pointerMode}
            nodesConnectable={!readOnly}
            elementsSelectable={!readOnly}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: false }}
          >
            <Background variant={BackgroundVariant.Dots} gap={26} size={1.6} color="var(--ac-grid)" className="ac-paper-grid" />
            <MiniMap pannable zoomable className="ac-minimap" nodeColor={() => 'var(--ac-minimap-node)'} maskColor="var(--ac-minimap-mask)" />
            <ViewportPortal>{guides.guideElements}{ghost && <ConnectionGhost {...ghost} />}</ViewportPortal>
          </ReactFlow>
        </RunningEdgesContext.Provider>
      </CanvasActionsContext.Provider>
    </div>
  )
}
