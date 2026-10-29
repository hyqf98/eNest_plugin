/**
 * App — AI 画布主组件：视图路由 + 草稿/撤销/运行编排 + Dify 式建图交互。
 * 数据流：drafts（分键 KV）→ 活动草稿 nodes/edges（React Flow state）→
 * 执行引擎（运行上下文优先，lastRun 回落）→ 节点 data.lastRun（asset 引用）+ 画廊索引。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider, useNodesState, useEdgesState, addEdge, useReactFlow } from '@xyflow/react'
import '../js/nodeDefs/index.mjs'
import { CanvasStage } from './CanvasStage.jsx'
import { Toolbar } from './Toolbar.jsx'
import { LeftRail } from './LeftRail.jsx'
import { RightRail } from './RightRail.jsx'
import { GalleryPanel } from './GalleryPanel.jsx'
import { RunLogPanel } from './RunLogPanel.jsx'
import { SettingsDialog } from './SettingsDialog.jsx'
import { InspectorPanel } from './InspectorPanel.jsx'
import { NodePicker } from './NodePicker.jsx'
import { FloatingMenu } from './FloatingMenu.jsx'
import { pickLocalImage } from './nodes/RegistryNode.jsx'
import { pickSaveDirectory } from '../js/backendBridge.mjs'
import { loadDrafts, saveDrafts, newDraft, removeDraftRecord, onWriteError } from '../js/store.mjs'
import { loadProviders } from '../js/providers.mjs'
import { loadPreferences, savePreferences, resolvePaper, watchSystemScheme } from '../js/theme.mjs'
import { executeNode, runWorkflow, createRunContext, downstreamOf, topoLevels } from '../js/workflow.mjs'
import { assetPreviewUrl } from '../js/assets.mjs'
import { getNodeDef, listNodeDefs, groupNodeDefs } from '../js/nodeRegistry.mjs'
import { makeNode, downstreamPosition, upstreamPosition, layoutPositions, dropAnchorPosition } from '../js/canvasNodes.mjs'
import { findPort, matchInputPort, matchOutputToTarget } from '../js/nodeSchema.mjs'
import { serializeGraph, parseGraph } from '../js/graphIO.mjs'

function toast(message, kind = 'info') {
  const kit = window.PluginKit
  if (kit?.toast) { kit.toast(message, kind); return }
  console.log(`[ai-canvas:${kind}] ${message}`)
}

/** 连线句柄名：无端口侧（起点/终点节点）走 default */
const oppositeHandle = (match) => (match.port ? match.port.key : 'default')

function Workbench() {
  const { fitView, screenToFlowPosition, zoomIn, zoomOut, getViewport, setViewport } = useReactFlow()
  const [ready, setReady] = useState(false)
  const [drafts, setDrafts] = useState([])
  const [activeId, setActiveId] = useState('')
  const [view, setView] = useState('canvas')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [providers, setProviders] = useState([])
  const [prefs, setPrefs] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [workflowRunning, setWorkflowRunning] = useState(false)
  const [mode, setMode] = useState('pointer')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [picker, setPicker] = useState(null)
  const [ghost, setGhost] = useState(null)   // 松手→选完期间的临时连线 { from, to, fromPosition, toPosition }
  const [menu, setMenu] = useState(null)
  const stopFlag = useRef(false)
  const clipboardRef = useRef(null)

  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const nodesRef = useRef(nodes); nodesRef.current = nodes
  const edgesRef = useRef(edges); edgesRef.current = edges
  const graphRef = useRef({ nodes, edges }); graphRef.current = { nodes, edges }
  const providersRef = useRef(providers); providersRef.current = providers
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  const draftsRef = useRef(drafts); draftsRef.current = drafts
  const prefsRef = useRef(prefs); prefsRef.current = prefs

  /* —— 运行上下文（会话级，跨单节点/下游运行共享产物） —— */
  const runContextRef = useRef(null)
  const ensureContext = useCallback(() => {
    if (!runContextRef.current) runContextRef.current = createRunContext(nodesRef.current)
    return runContextRef.current
  }, [])

  /* —— 撤销 / 重做（结构性快照，参数编辑不入栈） —— */
  const undoStack = useRef([])
  const redoStack = useRef([])
  const [historyTick, setHistoryTick] = useState(0)
  const pushHistory = useCallback(() => {
    undoStack.current.push({ nodes: nodesRef.current, edges: edgesRef.current })
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = []
    setHistoryTick(t => t + 1)
  }, [])
  const undo = useCallback(() => {
    const snap = undoStack.current.pop()
    if (!snap) return
    redoStack.current.push({ nodes: nodesRef.current, edges: edgesRef.current })
    setNodes(snap.nodes); setEdges(snap.edges)
    setHistoryTick(t => t + 1)
  }, [setNodes, setEdges])
  const redo = useCallback(() => {
    const snap = redoStack.current.pop()
    if (!snap) return
    undoStack.current.push({ nodes: nodesRef.current, edges: edgesRef.current })
    setNodes(snap.nodes); setEdges(snap.edges)
    setHistoryTick(t => t + 1)
  }, [setNodes, setEdges])

  /* —— 初始化：草稿 + 供应商 + 偏好 —— */
  useEffect(() => {
    let alive = true
    onWriteError(message => toast(message, 'error'))
    void (async () => {
      const [loadedDrafts, loadedProviders, loadedPrefs] = await Promise.all([loadDrafts(), loadProviders(), loadPreferences()])
      if (!alive) return
      setDrafts(loadedDrafts)
      setActiveId(loadedDrafts[0]?.id ?? '')
      setNodes(loadedDrafts[0]?.nodes ?? [])
      setEdges(loadedDrafts[0]?.edges ?? [])
      setProviders(loadedProviders)
      setPrefs(loadedPrefs)
      setReady(true)
      if (loadedDrafts[0]?.viewport) setViewport(loadedDrafts[0].viewport)
      else setTimeout(() => fitView({ padding: 0.18 }), 80)
    })()
    const enest = window.enest || window.zapi
    const offEnter = enest?.onEnter?.(event => {
      if (event?.code === 'settings' || event?.code === 'openPrefs') setSettingsOpen(true)
    })
    const offClose = enest?.onBeforeSuspend?.(() => { saveDrafts(draftsRef.current, { immediate: true }) })
    return () => { alive = false; offEnter?.(); offClose?.() }
  }, [setNodes, setEdges, setViewport, fitView])

  /* —— 持久化（防抖，活动草稿写回 drafts） —— */
  useEffect(() => {
    if (!ready) return
    setDrafts(prev => {
      const next = prev.map(d => d.id === activeId ? { ...d, nodes, edges } : d)
      void saveDrafts(next)
      return next
    })
  }, [nodes, edges, activeId, ready])

  /* —— 偏好 → DOM（纸面主题）：auto 解析成具体纸面，并挂到 :root 供 portal 弹框继承 —— */
  const [schemeTick, setSchemeTick] = useState(0)
  useEffect(() => watchSystemScheme(() => setSchemeTick(t => t + 1)), [])
  const effectivePaper = useMemo(() => resolvePaper(prefs?.paper), [prefs?.paper, schemeTick])
  useEffect(() => {
    if (!prefs) return
    document.documentElement.setAttribute('data-paper', effectivePaper)
    document.getElementById('root')?.setAttribute('data-paper', effectivePaper)
  }, [prefs, effectivePaper])

  const changePrefs = useCallback(async next => {
    setPrefs(next)
    await savePreferences(next)
  }, [])

  const reloadProviders = useCallback(async () => setProviders(await loadProviders()), [])

  /* —— 草稿管理（切换/新建时记录视口） —— */
  const snapshotActive = useCallback(prev => prev.map(d =>
    d.id === activeIdRef.current ? { ...d, nodes: nodesRef.current, edges: edgesRef.current, viewport: getViewport() } : d), [getViewport])

  const selectDraft = useCallback(id => {
    const draft = draftsRef.current.find(d => d.id === id)
    if (!draft || id === activeIdRef.current) return
    setDrafts(prev => { const next = snapshotActive(prev); void saveDrafts(next); return next })
    setActiveId(id)
    setNodes(draft.nodes ?? [])
    setEdges(draft.edges ?? [])
    runContextRef.current = null
    if (draft.viewport) setViewport(draft.viewport)
    else setTimeout(() => fitView({ duration: 260, padding: 0.18 }), 60)
  }, [snapshotActive, setNodes, setEdges, setViewport, fitView])

  const addDraft = useCallback(() => {
    const draft = newDraft(`画布 ${draftsRef.current.length + 1}`)
    setDrafts(prev => { const next = [...snapshotActive(prev), draft]; void saveDrafts(next); return next })
    setActiveId(draft.id)
    setNodes([]); setEdges([])
    runContextRef.current = null
  }, [snapshotActive, setNodes, setEdges])

  const renameDraft = useCallback(id => {
    const current = draftsRef.current.find(d => d.id === id)
    const name = window.prompt('重命名画布', current?.name ?? '')
    if (name === null || !name.trim()) return
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, name: name.trim() } : d))
  }, [])

  const deleteDraft = useCallback(id => {
    setDrafts(prev => {
      const next = prev.filter(d => d.id !== id)
      if (!next.length) next.push(newDraft('画布 1'))
      if (id === activeIdRef.current) {
        setActiveId(next[0].id)
        setNodes(next[0].nodes ?? []); setEdges(next[0].edges ?? [])
        runContextRef.current = null
      }
      void saveDrafts(next)
      void removeDraftRecord(id)
      return next
    })
  }, [setNodes, setEdges])

  /* —— 节点操作 —— */
  const addNode = useCallback((type, position) => {
    const spot = position ?? screenToFlowPosition({ x: window.innerWidth * 0.52, y: window.innerHeight * 0.48 })
    const node = makeNode(type, spot)
    // 设置里的默认参数偏好作用于生成/编辑类新节点（仅当该类型声明了此参数）
    const p = prefsRef.current
    if (p && node.data.params.size !== undefined && p.defaultSize) node.data.params.size = p.defaultSize
    if (p && node.data.params.quality !== undefined && p.defaultQuality) node.data.params.quality = p.defaultQuality
    setNodes(prev => [...prev, node])
    return node
  }, [setNodes, screenToFlowPosition])

  const deleteNodes = useCallback(ids => {
    pushHistory()
    const set = new Set(ids)
    setNodes(prev => prev.filter(n => !set.has(n.id)))
    setEdges(prev => prev.filter(e => !set.has(e.source) && !set.has(e.target)))
    for (const id of set) runContextRef.current?.forget?.(id)
  }, [setNodes, setEdges, pushHistory])

  const onConnect = useCallback((connection) => {
    pushHistory()
    setEdges(prev => addEdge({ ...connection, type: 'handdrawn' }, prev))
  }, [setEdges, pushHistory])

  const onParamChange = useCallback((nodeId, key, value) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, params: { ...n.data.params, [key]: value } } } : n))
  }, [setNodes])

  const onPickLocalImageParam = useCallback(async (nodeId, paramKey) => {
    try {
      const ref = await pickLocalImage()
      if (ref) onParamChange(nodeId, paramKey, ref)
      return ref
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error'); return null }
  }, [onParamChange])

  /** 文件保存节点：原生目录选择器（经插件后端），结果写回 directory 参数 */
  const onPickDirectory = useCallback(async (nodeId, paramKey) => {
    try {
      const dir = await pickSaveDirectory()
      if (dir) onParamChange(nodeId, paramKey, dir)
      return dir
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
      return null
    }
  }, [onParamChange])

  const openImage = useCallback(async assetId => {
    try {
      const url = await assetPreviewUrl(assetId)
      if (url) setLightbox({ assetId, url })
    } catch { /* 忽略 */ }
  }, [])

  /* —— 运行编排 —— */
  const applyNodePatch = useCallback((nodeId, patch) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...patch, lastRun: patch.lastRun ?? n.data.lastRun } } : n))
  }, [setNodes])

  const runSingle = useCallback(async nodeId => {
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (!node) return
    applyNodePatch(nodeId, { state: 'running', error: null, warnings: [] })
    try {
      const patch = await executeNode(node, {
        edges: edgesRef.current, nodesById: new Map(nodesRef.current.map(n => [n.id, n])),
        providers: providersRef.current, draftId: activeIdRef.current, runContext: ensureContext()
      })
      applyNodePatch(nodeId, patch)
      toast('节点运行成功', 'success')
    } catch (error) {
      applyNodePatch(nodeId, { state: 'error', error: error instanceof Error ? error.message : String(error) })
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [applyNodePatch, ensureContext])

  const runAll = useCallback(async () => {
    if (workflowRunning) return
    stopFlag.current = false
    setWorkflowRunning(true)
    try {
      const context = ensureContext()
      context.clear()
      const result = await runWorkflow({
        nodes: nodesRef.current, edges: edgesRef.current, providers: providersRef.current,
        draftId: activeIdRef.current, onNodeState: applyNodePatch,
        shouldStop: () => stopFlag.current, runContext: context
      })
      if (result.ok) toast('画布运行完成', 'success')
      else if (!stopFlag.current) toast(`运行结束：${result.failed.length} 个节点失败`, 'error')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setWorkflowRunning(false)
    }
  }, [workflowRunning, applyNodePatch, ensureContext])

  /** 只跑下游：上下文保留上游产物（含检视面板的临时改写） */
  const runDownstream = useCallback(async nodeId => {
    if (workflowRunning) return
    const ids = new Set(downstreamOf(nodeId, edgesRef.current))
    if (!ids.size) { toast('该节点没有下游节点'); return }
    setWorkflowRunning(true)
    const context = ensureContext()
    const ordered = topoLevels(nodesRef.current, edgesRef.current).flat().filter(id => ids.has(id))
    try {
      const nodesById = new Map(nodesRef.current.map(n => [n.id, n]))
      for (const id of ordered) {
        const node = nodesById.get(id)
        if (!node || !getNodeDef(node.data.type)) continue
        applyNodePatch(id, { state: 'running', error: null })
        try {
          const patch = await executeNode(node, {
            edges: edgesRef.current, nodesById, providers: providersRef.current,
            draftId: activeIdRef.current, runContext: context
          })
          applyNodePatch(id, patch)
        } catch (error) {
          applyNodePatch(id, { state: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      }
      toast('下游运行完成', 'success')
    } finally {
      setWorkflowRunning(false)
    }
  }, [workflowRunning, applyNodePatch, ensureContext])

  const stopAll = useCallback(() => { stopFlag.current = true }, [])

  const overrideOutput = useCallback((nodeId, portKey, text) => {
    const context = ensureContext()
    const outputs = { ...(context.getOutputs(nodeId) ?? {}) }
    outputs[portKey] = text
    context.setOutputs(nodeId, outputs)
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (node?.data?.lastRun) {
      applyNodePatch(nodeId, { lastRun: { ...node.data.lastRun, outputs: { ...node.data.lastRun.outputs, [portKey]: text } } })
    }
  }, [ensureContext, applyNodePatch])

  /* —— 画布 JSON 导出 / 导入（节点标准化序列化） —— */
  const exportGraph = useCallback(async () => {
    try {
      const draft = draftsRef.current.find(d => d.id === activeIdRef.current)
      const json = serializeGraph(nodesRef.current, edgesRef.current, { name: draft?.name ?? '' })
      const enest = window.enest || window.zapi
      if (!enest?.shell?.saveTextFile) throw new Error('宿主文件接口不可用')
      const res = await enest.shell.saveTextFile({
        defaultName: `${(draft?.name || 'ai-canvas').replace(/[\\/:*?"<>|]/g, '-')}.canvas.json`,
        content: json
      })
      if (res?.ok) toast('画布已导出', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [])

  const importGraph = useCallback(async () => {
    try {
      const enest = window.enest || window.zapi
      if (!enest?.localFiles?.pick) throw new Error('宿主文件接口不可用')
      const handles = await enest.localFiles.pick({ kind: 'file', multiple: false, access: 'read' })
      const handle = Array.isArray(handles) ? handles[0] : handles
      if (!handle?.id) return
      const text = await enest.localFiles.read({ handleId: handle.id, encoding: 'utf8', maxBytes: 8 * 1024 * 1024 })
      const { nodes: importedNodes, edges: importedEdges, warnings, name } = parseGraph(text)
      pushHistory()
      setNodes(importedNodes)
      setEdges(importedEdges)
      runContextRef.current = null
      setTimeout(() => fitView({ duration: 260, padding: 0.18 }), 80)
      if (warnings.length) toast(`已导入 ${importedNodes.length} 个节点，${warnings.length} 条警告`, 'info')
      else toast(`已导入${name ? `「${name}」` : ''}：${importedNodes.length} 个节点`, 'success')
      for (const warning of warnings.slice(0, 3)) console.warn('[ai-canvas:import]', warning)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [pushHistory, setNodes, setEdges, fitView])

  /* —— 从端口拖线到空白处松手：弹节点选择器；期间幽灵线持续显示从源端口到落点 —— */
  const onConnectEnd = useCallback((event, connectionState) => {
    if (connectionState?.isValid) return                 // 落到合法端口：正常连线，不弹选择器
    const from = connectionState?.fromHandle
    const nodeId = connectionState?.fromNode?.id
    if (!from || !nodeId) return
    const sourceNode = nodesRef.current.find(n => n.id === nodeId)
    if (!sourceNode) return
    const def = getNodeDef(sourceNode.data.type)
    const isSource = from.type === 'source'
    const port = findPort(isSource ? def?.outputs : def?.inputs, from.id)
    if (!port) return
    const groups = groupNodeDefs(listNodeDefs().filter(candidate =>
      isSource ? !!matchInputPort(port, candidate) : !!matchOutputToTarget(port, candidate)))
    if (!groups.length) return
    const anchor = { x: event.clientX ?? 0, y: event.clientY ?? 0 }
    const dropPosition = screenToFlowPosition(anchor)
    // 幽灵线起点：直接取源端口 DOM 中心（最准），失败回落按节点几何估算
    let fromPoint = null
    try {
      const handleEl = document.querySelector(
        `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${from.id}"]`)
      if (handleEl) {
        const hr = handleEl.getBoundingClientRect()
        fromPoint = screenToFlowPosition({ x: hr.x + hr.width / 2, y: hr.y + hr.height / 2 })
      }
    } catch { /* DOM 查询失败走估算 */ }
    if (!fromPoint) {
      const pos = sourceNode.position ?? { x: 0, y: 0 }
      const halfW = (sourceNode.measured?.width ?? 268) / 2
      fromPoint = { x: pos.x + (isSource ? halfW : -halfW), y: pos.y }
    }
    setGhost({
      from: fromPoint, to: dropPosition,
      fromPosition: isSource ? 'right' : 'left',
      toPosition: isSource ? 'left' : 'right'
    })
    const clearGhost = () => setGhost(null)
    setPicker({
      anchor,
      groups,
      title: isSource ? '接出节点' : '接入节点',
      onPick: (picked) => {
        clearGhost()
        pushHistory()
        // 松手点 = 新节点接入端口位置（画布 nodeOrigin 0.5 时 position 即中心，需偏移半宽）
        const created = addNode(picked.type, dropAnchorPosition(dropPosition, { asTarget: isSource }))
        if (isSource) {
          const match = matchInputPort(port, picked)
          setEdges(prev => addEdge({
            source: nodeId, sourceHandle: from.id, target: created.id, targetHandle: oppositeHandle(match), type: 'handdrawn'
          }, prev))
        } else {
          const match = matchOutputToTarget(port, picked)
          setEdges(prev => addEdge({
            source: created.id, sourceHandle: oppositeHandle(match), target: nodeId, targetHandle: from.id, type: 'handdrawn'
          }, prev))
        }
        setPicker(null)
      }
    })
  }, [addNode, pushHistory, setEdges, screenToFlowPosition])

  /* —— Dify 式建图：点击端口 ＋ 弹选择器，选中即建节点并自动连线 —— */
  const onHandleAddNode = useCallback((handle, anchor) => {
    const { nodeId, side, handleId } = handle
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (!node) return
    const def = getNodeDef(node.data.type)
    if (side === 'source') {
      const sourcePort = findPort(def?.outputs, handleId)
      const groups = groupNodeDefs(listNodeDefs().filter(candidate => !!matchInputPort(sourcePort, candidate)))
      if (!groups.length) { toast('没有可接出的节点类型', 'error'); return }
      setPicker({
        anchor, groups,
        onPick: (picked) => {
          const match = matchInputPort(sourcePort, picked)
          pushHistory()
          const created = addNode(picked.type, downstreamPosition(node, nodesRef.current))
          setEdges(prev => addEdge({
            source: nodeId, sourceHandle: handleId, target: created.id, targetHandle: oppositeHandle(match), type: 'handdrawn'
          }, prev))
          setPicker(null)
        }
      })
    } else {
      const targetPort = findPort(def?.inputs, handleId)
      const groups = groupNodeDefs(listNodeDefs().filter(candidate => !!matchOutputToTarget(targetPort, candidate)))
      if (!groups.length) { toast('没有可接入的节点类型', 'error'); return }
      setPicker({
        anchor, groups,
        onPick: (picked) => {
          const match = matchOutputToTarget(targetPort, picked)
          pushHistory()
          const created = addNode(picked.type, upstreamPosition(node, nodesRef.current))
          setEdges(prev => addEdge({
            source: created.id, sourceHandle: oppositeHandle(match), target: nodeId, targetHandle: handleId, type: 'handdrawn'
          }, prev))
          setPicker(null)
        }
      })
    }
  }, [addNode, pushHistory, setEdges])

  /* —— 边中点插入节点：删旧边、建新两边 —— */
  const onEdgeInsert = useCallback((edgeId, anchor) => {
    const edge = edgesRef.current.find(e => e.id === edgeId)
    if (!edge) return
    const source = nodesRef.current.find(n => n.id === edge.source)
    const target = nodesRef.current.find(n => n.id === edge.target)
    if (!source || !target) return
    const sourcePort = findPort(getNodeDef(source.data.type)?.outputs, edge.sourceHandle)
    const targetPort = findPort(getNodeDef(target.data.type)?.inputs, edge.targetHandle)
    const groups = groupNodeDefs(listNodeDefs().filter(def =>
      !!matchInputPort(sourcePort, def) && !!matchOutputToTarget(targetPort, def)))
    if (!groups.length) { toast('没有合适的节点可以插到这条线上', 'error'); return }
    setPicker({
      anchor, groups, title: '插入节点',
      onPick: (picked) => {
        const inMatch = matchInputPort(sourcePort, picked)
        const outMatch = matchOutputToTarget(targetPort, picked)
        pushHistory()
        const mid = { x: ((source.position?.x ?? 0) + (target.position?.x ?? 0)) / 2 + 200, y: target.position?.y ?? 0 }
        const created = addNode(picked.type, mid)
        setEdges(prev => [
          ...prev.filter(e => e.id !== edgeId),
          { id: `${edge.source}-${edge.sourceHandle}-${created.id}-in`, source: edge.source, sourceHandle: edge.sourceHandle, target: created.id, targetHandle: oppositeHandle(inMatch), type: 'handdrawn' },
          { id: `${created.id}-out-${edge.target}-${edge.targetHandle}`, source: created.id, sourceHandle: oppositeHandle(outMatch), target: edge.target, targetHandle: edge.targetHandle, type: 'handdrawn' }
        ])
        setPicker(null)
      }
    })
  }, [addNode, pushHistory, setEdges])

  /* —— 复制 / 粘贴 / 原地副本 —— */
  const copyNodes = useCallback(ids => {
    const set = new Set(ids)
    const copied = nodesRef.current.filter(n => set.has(n.id)).map(n => ({ ...n, data: { ...n.data } }))
    if (!copied.length) return
    clipboardRef.current = {
      nodes: copied,
      edges: edgesRef.current.filter(e => set.has(e.source) && set.has(e.target)).map(e => ({ ...e }))
    }
    toast(`已复制 ${copied.length} 个节点`)
  }, [])

  const pasteNodes = useCallback((atPosition) => {
    const clip = clipboardRef.current
    if (!clip?.nodes?.length) return
    pushHistory()
    const base = atPosition ?? screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const minX = Math.min(...clip.nodes.map(n => n.position.x))
    const minY = Math.min(...clip.nodes.map(n => n.position.y))
    const idMap = new Map()
    const created = clip.nodes.map(node => {
      const fresh = makeNode(node.data.type, { x: base.x + (node.position.x - minX), y: base.y + (node.position.y - minY) })
      idMap.set(node.id, fresh.id)
      fresh.data = { ...fresh.data, params: { ...(node.data.params ?? {}) }, localImage: node.data.localImage ?? null }
      return fresh
    })
    setNodes(prev => [...prev, ...created])
    setEdges(prev => [...prev, ...clip.edges
      .filter(e => idMap.has(e.source) && idMap.has(e.target))
      .map(e => ({
        ...e,
        id: `${idMap.get(e.source)}-${e.sourceHandle ?? ''}-${idMap.get(e.target)}-${e.targetHandle ?? ''}`,
        source: idMap.get(e.source), target: idMap.get(e.target)
      }))])
  }, [pushHistory, setNodes, setEdges, screenToFlowPosition])

  const duplicateNodes = useCallback(ids => {
    const set = new Set(ids)
    const sources = nodesRef.current.filter(n => set.has(n.id))
    if (!sources.length) return
    clipboardRef.current = {
      nodes: sources.map(n => ({ ...n, position: { x: n.position.x + 40, y: n.position.y + 40 }, data: { ...n.data } })),
      edges: edgesRef.current.filter(e => set.has(e.source) && set.has(e.target)).map(e => ({ ...e }))
    }
    pasteNodes()
  }, [pasteNodes])

  const selectAllNodes = useCallback(() => {
    setNodes(prev => prev.map(n => ({ ...n, selected: true })))
  }, [setNodes])

  /* —— 自动排版 —— */
  const organizeNodes = useCallback(() => {
    if (nodesRef.current.length < 2) return
    pushHistory()
    try {
      const positions = layoutPositions(nodesRef.current, edgesRef.current, topoLevels)
      setNodes(prev => prev.map(n => positions.has(n.id) ? { ...n, position: positions.get(n.id) } : n))
      setTimeout(() => fitView({ duration: 260, padding: 0.18 }), 60)
    } catch (error) { toast(error instanceof Error ? error.message : String(error), 'error') }
  }, [pushHistory, setNodes, fitView])

  /* —— 右键三菜单 —— */
  const openPaneMenu = useCallback((event) => {
    if (workflowRunning) return
    event.preventDefault?.()
    const anchor = { x: event.clientX, y: event.clientY }
    const position = screenToFlowPosition(anchor)
    // 画布右键 = 节点库：直接列出全部节点类型供添加，不混入视图操作
    setPicker({ anchor, groups: groupNodeDefs(), title: '添加节点',
      onPick: (picked) => { pushHistory(); addNode(picked.type, position); setPicker(null) } })
  }, [workflowRunning, screenToFlowPosition, pushHistory, addNode])

  const openNodeMenu = useCallback((event, node) => {
    if (workflowRunning) return
    event.preventDefault?.()
    const selectedIds = nodes.filter(n => n.selected).map(n => n.id)
    const group = selectedIds.length > 1 && selectedIds.includes(node.id) ? selectedIds : [node.id]
    const def = getNodeDef(node.data.type)
    const items = []
    if (def?.runnable) items.push({ glyph: '▶', label: '运行此节点', onClick: () => runSingle(node.id) })
    if (downstreamOf(node.id, edgesRef.current).length) items.push({ glyph: '⇥', label: '运行下游', onClick: () => runDownstream(node.id) })
    items.push({ sep: true },
      { glyph: '⧉', label: '复制', hint: '⌘C', onClick: () => copyNodes(group) },
      { glyph: '⧉', label: '原地副本', hint: '⌘D', onClick: () => duplicateNodes(group) },
      { sep: true },
      { glyph: '×', label: '删除', danger: true, hint: 'Del', onClick: () => deleteNodes(group) })
    setMenu({ anchor: { x: event.clientX, y: event.clientY }, items })
  }, [workflowRunning, nodes, runSingle, runDownstream, copyNodes, duplicateNodes, deleteNodes])

  const openEdgeMenu = useCallback((event, edge) => {
    event.preventDefault?.()
    setMenu({
      anchor: { x: event.clientX, y: event.clientY },
      items: [{ glyph: '×', label: '删除连线', danger: true, onClick: () => { pushHistory(); setEdges(prev => prev.filter(e => e.id !== edge.id)) } }]
    })
  }, [pushHistory, setEdges])

  const openAddMenuAtCenter = useCallback(() => {
    setPicker({ anchor: { x: 120, y: window.innerHeight * 0.4 }, groups: groupNodeDefs(),
      onPick: (picked) => { pushHistory(); addNode(picked.type); setPicker(null) } })
  }, [addNode, pushHistory])

  /* —— 快捷键：输入框/选区内不拦截 —— */
  useEffect(() => {
    const onKey = (event) => {
      const target = event.target
      if (target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (event.isComposing) return
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      const selectedIds = nodesRef.current.filter(n => n.selected).map(n => n.id)
      if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
      if (mod && key === 'y') { event.preventDefault(); redo(); return }
      if (mod && key === 'c') { if (selectedIds.length) { event.preventDefault(); copyNodes(selectedIds) } return }
      if (mod && key === 'd') { if (selectedIds.length) { event.preventDefault(); duplicateNodes(selectedIds) } return }
      if (mod && key === 'v') { if (clipboardRef.current?.nodes?.length) { event.preventDefault(); pasteNodes() } return }
      if (mod && key === 'a') { event.preventDefault(); selectAllNodes(); return }
      if (mod && key === 'o') { event.preventDefault(); organizeNodes(); return }
      if (mod && key === '1') { event.preventDefault(); fitView({ padding: 0.18 }); return }
      if (mod && (key === '=' || key === '+')) { event.preventDefault(); zoomIn({ duration: 140 }); return }
      if (mod && key === '-') { event.preventDefault(); zoomOut({ duration: 140 }); return }
      if (key === 'delete' || key === 'backspace') { if (selectedIds.length) { event.preventDefault(); deleteNodes(selectedIds) } return }
      if (key === 'escape') { setPicker(null); setGhost(null); setMenu(null); return }
      if (!mod && key === 'v') { setMode('pointer'); return }
      if (!mod && key === 'h') { setMode('hand'); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, copyNodes, pasteNodes, duplicateNodes, selectAllNodes, deleteNodes, organizeNodes, fitView, zoomIn, zoomOut])

  /* —— 运行中的连线（源节点 running → 出边动画） —— */
  const runningEdges = useMemo(() => {
    const set = new Set()
    for (const node of nodes) {
      if (node.data.state !== 'running') continue
      for (const edge of edges) if (edge.source === node.id) set.add(edge.id)
    }
    return { edges: set, roughness: prefs?.roughness ?? 1.2 }
  }, [nodes, edges, prefs?.roughness])

  const getOutputs = useCallback(nodeId =>
    runContextRef.current?.getOutputs(nodeId) ?? nodesRef.current.find(n => n.id === nodeId)?.data?.lastRun?.outputs ?? null, [])

  const onNodeDataChange = useCallback((nodeId, patch) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n))
  }, [setNodes])

  const actions = useMemo(() => ({
    onRunNode: runSingle,
    onDeleteNodes: deleteNodes,
    onParamChange,
    onNodeDataChange,
    onPickLocalImageParam,
    onPickDirectory,
    onOpenImage: openImage,
    onHandleAddNode,
    onEdgeInsert,
    workflowRunning,
    graphRef,
    getOutputs
  }), [runSingle, deleteNodes, onParamChange, onNodeDataChange, onPickLocalImageParam, onPickDirectory, openImage, onHandleAddNode, onEdgeInsert, workflowRunning, getOutputs])

  if (!ready || !prefs) return <div className="ac-boot">正在准备画布…</div>

  return (
    <div className="ac-app" data-paper={effectivePaper} data-grid={prefs.grid}>
      <svg className="ac-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id="ac-rough" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.02 0.028" numOctaves="3" seed="11" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="ac-rough-fine" x="-8%" y="-8%" width="116%" height="116%">
            <feTurbulence type="fractalNoise" baseFrequency="0.05 0.065" numOctaves="2" seed="5" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.6" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <div className="ac-main">
        <Toolbar
          drafts={drafts} activeId={activeId}
          onSelectDraft={selectDraft} onNewDraft={addDraft} onRenameDraft={renameDraft} onDeleteDraft={deleteDraft}
          onExport={exportGraph} onImport={importGraph}
        />
        <div className="ac-body">
          <LeftRail
            view={view}
            onAddNode={(type, screenPoint) => {
              pushHistory()
              const position = screenPoint ? screenToFlowPosition(screenPoint) : undefined
              addNode(type, position)
            }}
            onOpenAddMenu={openAddMenuAtCenter}
            onOpenGallery={() => setView(v => v === 'gallery' ? 'canvas' : 'gallery')}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <RightRail workflowRunning={workflowRunning} onRunAll={runAll} onStop={stopAll}
            canUndo={undoStack.current.length > 0} canRedo={redoStack.current.length > 0}
            onUndo={undo} onRedo={redo}
            onFit={() => fitView({ duration: 260, padding: 0.18 })}
            logOpen={logOpen} onToggleLog={() => setLogOpen(o => !o)}
            inspectorOpen={inspectorOpen} onToggleInspector={() => setInspectorOpen(o => !o)} />
          <CanvasStage
            nodes={nodes} edges={edges}
            onNodesChange={changes => {
              const structural = changes.some(c => c.type === 'position' && c.dragging === false) || changes.some(c => c.type === 'remove')
              if (structural) pushHistory()
              onNodesChange(changes)
            }}
            onEdgesChange={changes => {
              if (changes.some(c => c.type === 'remove')) pushHistory()
              onEdgesChange(changes)
            }}
            onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          actions={actions}
          runningEdges={runningEdges}
          mode={mode}
          readOnly={workflowRunning}
          nodesRef={nodesRef}
          ghost={ghost}
            onDropNode={(type, position) => { pushHistory(); addNode(type, position) }}
            onPaneContextMenu={openPaneMenu}
            onNodeContextMenu={openNodeMenu}
            onEdgeContextMenu={openEdgeMenu}
          />
          {inspectorOpen && (
            <InspectorPanel nodes={nodes} getOutputs={getOutputs}
              onOverride={overrideOutput} onCollapse={() => setInspectorOpen(false)} />
          )}
          {logOpen && <RunLogPanel nodes={nodes} onClose={() => setLogOpen(false)} />}
          {view === 'gallery' && (
            <GalleryPanel onOpenImage={openImage} onClose={() => setView('canvas')} />
          )}
          {picker && (
            <NodePicker anchor={picker.anchor} groups={picker.groups} title={picker.title ?? '添加节点'}
              onPick={picker.onPick} onClose={() => { setPicker(null); setGhost(null) }} />
          )}
          {menu && <FloatingMenu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
        </div>
        <div className="ac-status">
          <span>点端口 ＋ 接出节点 · 线中点插入 · {mode === 'pointer' ? '拖拽框选 / 滚轮平移（V 指针）' : '拖拽平移（H 手）'} · ⌘Z 撤销 · 右键更多</span>
          <span className="ac-status-flex" />
          <span>{workflowRunning ? '运行中，编辑已锁定，可停止' : '就绪'}</span>
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen} onOpenChange={setSettingsOpen}
        providers={providers} onProvidersChanged={reloadProviders}
        prefs={prefs} onPrefsChanged={changePrefs}
      />

      {lightbox && (
        <div className="ac-lightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <img src={lightbox.url} alt="预览" draggable={false} />
          <button type="button" className="ac-lightbox-close" title="关闭" onClick={() => setLightbox(null)}>×</button>
        </div>
      )}
    </div>
  )
}

export function App() {
  return (
    <ReactFlowProvider>
      <Workbench />
    </ReactFlowProvider>
  )
}
