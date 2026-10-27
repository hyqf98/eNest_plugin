/**
 * App — AI 画布主组件：视图路由（画布/画廊）+ 弹框设置 + 草稿/撤销/运行编排。
 * 数据流：drafts（storage KV）→ 活动草稿的 nodes/edges（React Flow state）→
 * 执行引擎（单节点 / 全画布）→ 节点 data.lastRun（asset 引用）+ 画廊索引。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider, useNodesState, useEdgesState, addEdge, useReactFlow } from '@xyflow/react'
import { CanvasStage, makeNode } from './CanvasStage.jsx'
import { Toolbar } from './Toolbar.jsx'
import { LeftRail } from './LeftRail.jsx'
import { GalleryView } from './GalleryView.jsx'
import { SettingsDialog } from './SettingsDialog.jsx'
import { pickLocalImage } from './nodes/RegistryNode.jsx'
import { loadDrafts, saveDrafts, newDraft } from '../js/store.mjs'
import { loadProviders } from '../js/providers.mjs'
import { loadPreferences, savePreferences } from '../js/theme.mjs'
import { executeNode, runWorkflow } from '../js/workflow.mjs'
import { assetPreviewUrl } from '../js/assets.mjs'
import { defaultParams } from '../js/nodeRegistry.mjs'

function toast(message, kind = 'info') {
  const kit = window.PluginKit
  if (kit?.toast) { kit.toast(message, kind); return }
  console.log(`[ai-canvas:${kind}] ${message}`)
}

function Workbench() {
  const { fitView, screenToFlowPosition } = useReactFlow()
  const [ready, setReady] = useState(false)
  const [drafts, setDrafts] = useState([])
  const [activeId, setActiveId] = useState('')
  const [view, setView] = useState('canvas')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [providers, setProviders] = useState([])
  const [prefs, setPrefs] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [workflowRunning, setWorkflowRunning] = useState(false)
  const stopFlag = useRef(false)

  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const nodesRef = useRef(nodes); nodesRef.current = nodes
  const edgesRef = useRef(edges); edgesRef.current = edges
  const providersRef = useRef(providers); providersRef.current = providers
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  const draftsRef = useRef(drafts); draftsRef.current = drafts

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
    })()
    const enest = window.enest || window.zapi
    const offEnter = enest?.onEnter?.(event => {
      if (event?.code === 'settings' || event?.code === 'openPrefs') setSettingsOpen(true)
    })
    const offClose = enest?.onBeforeSuspend?.(() => { saveDrafts(draftsRef.current, { immediate: true }) })
    return () => { alive = false; offEnter?.(); offClose?.() }
  }, [setNodes, setEdges])

  /* —— 持久化（防抖，活动草稿写回 drafts） —— */
  useEffect(() => {
    if (!ready) return
    setDrafts(prev => {
      const next = prev.map(d => d.id === activeId ? { ...d, nodes, edges } : d)
      void saveDrafts(next)
      return next
    })
  }, [nodes, edges, activeId, ready])

  /* —— 偏好 → DOM（纸面主题） —— */
  useEffect(() => {
    if (prefs) document.getElementById('root')?.setAttribute('data-paper', prefs.paper)
  }, [prefs])

  const changePrefs = useCallback(async next => {
    setPrefs(next)
    await savePreferences(next)
  }, [])

  const reloadProviders = useCallback(async () => setProviders(await loadProviders()), [])

  /* —— 草稿管理 —— */
  const selectDraft = useCallback(id => {
    // 切换前把当前草稿落盘（state 已随 useEffect 同步到 drafts）
    const draft = draftsRef.current.find(d => d.id === id)
    if (!draft || id === activeIdRef.current) return
    setActiveId(id)
    setNodes(draft.nodes ?? [])
    setEdges(draft.edges ?? [])
    setTimeout(() => fitView({ duration: 260, padding: 0.18 }), 60)
  }, [setNodes, setEdges, fitView])

  const addDraft = useCallback(() => {
    const draft = newDraft(`画布 ${draftsRef.current.length + 1}`)
    setDrafts(prev => [...prev, draft])
    setActiveId(draft.id)
    setNodes([]); setEdges([])
  }, [setNodes, setEdges])

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
      }
      void saveDrafts(next)
      return next
    })
  }, [setNodes, setEdges])

  /* —— 节点操作 —— */
  const addNode = useCallback((type, position) => {
    pushHistory()
    const spot = position ?? screenToFlowPosition({ x: window.innerWidth * 0.52, y: window.innerHeight * 0.48 })
    setNodes(prev => [...prev, makeNode(type, spot, { params: defaultParams(type) })])
  }, [setNodes, pushHistory, screenToFlowPosition])

  const deleteNodes = useCallback(ids => {
    pushHistory()
    const set = new Set(ids)
    setNodes(prev => prev.filter(n => !set.has(n.id)))
    setEdges(prev => prev.filter(e => !set.has(e.source) && !set.has(e.target)))
  }, [setNodes, setEdges, pushHistory])

  const onConnect = useCallback((connection) => {
    pushHistory()
    setEdges(prev => addEdge({ ...connection, type: 'handdrawn' }, prev))
  }, [setEdges, pushHistory])

  const onParamChange = useCallback((nodeId, key, value) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, params: { ...n.data.params, [key]: value } } } : n))
  }, [setNodes])

  const onNodeDataChange = useCallback((nodeId, patch) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n))
  }, [setNodes])

  const onPickLocalImage = useCallback(async nodeId => {
    try {
      const localImage = await pickLocalImage()
      if (localImage) onNodeDataChange(nodeId, { localImage })
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error') }
  }, [onNodeDataChange])

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
    applyNodePatch(nodeId, { state: 'running', error: null })
    try {
      const patch = await executeNode(node, {
        edges: edgesRef.current, nodesById: new Map(nodesRef.current.map(n => [n.id, n])),
        providers: providersRef.current, draftId: activeIdRef.current
      })
      applyNodePatch(nodeId, patch)
      toast('节点运行成功', 'success')
    } catch (error) {
      applyNodePatch(nodeId, { state: 'error', error: error instanceof Error ? error.message : String(error) })
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [applyNodePatch])

  const runAll = useCallback(async () => {
    if (workflowRunning) return
    stopFlag.current = false
    setWorkflowRunning(true)
    try {
      const result = await runWorkflow({
        nodes: nodesRef.current, edges: edgesRef.current, providers: providersRef.current,
        draftId: activeIdRef.current, onNodeState: applyNodePatch,
        shouldStop: () => stopFlag.current
      })
      if (result.ok) toast('画布运行完成', 'success')
      else if (!stopFlag.current) toast(`运行结束：${result.failed.length} 个节点失败`, 'error')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setWorkflowRunning(false)
    }
  }, [workflowRunning, applyNodePatch])

  const stopAll = useCallback(() => { stopFlag.current = true }, [])

  /* —— 快捷键：⌘Z / ⇧⌘Z / Delete —— */
  useEffect(() => {
    const onKey = (event) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo(); else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  /* —— 运行中的连线（源节点 running → 出边动画） —— */
  const runningEdges = useMemo(() => {
    const set = new Set()
    for (const node of nodes) {
      if (node.data.state !== 'running') continue
      for (const edge of edges) if (edge.source === node.id) set.add(edge.id)
    }
    return { edges: set, roughness: prefs?.roughness ?? 1.2 }
  }, [nodes, edges, prefs?.roughness])
  const runningCount = nodes.filter(n => n.data.state === 'running').length

  const actions = useMemo(() => ({
    onRunNode: runSingle,
    onDeleteNodes,
    onParamChange,
    onNodeDataChange,
    onPickLocalImage,
    onOpenImage: openImage,
    workflowRunning
  }), [runSingle, deleteNodes, onParamChange, onNodeDataChange, onPickLocalImage, openImage, workflowRunning])

  if (!ready || !prefs) return <div className="ac-boot">正在准备画布…</div>

  const galleryToCanvas = assetId => {
    pushHistory()
    setNodes(prev => [...prev, makeNode('imageEdit', screenToFlowPosition({ x: window.innerWidth * 0.55, y: window.innerHeight * 0.48 }),
      { params: defaultParams('imageEdit'), localImage: { assetId }, state: 'idle' })])
  }

  return (
    <div className="ac-app" data-paper={prefs.paper} data-grid={prefs.grid}>
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
          onRunAll={runAll} onStop={stopAll} workflowRunning={workflowRunning}
          canUndo={undoStack.current.length > 0} canRedo={redoStack.current.length > 0}
          onUndo={undo} onRedo={redo}
          nodeCount={nodes.length} edgeCount={edges.length} runningCount={runningCount}
        />
        <div className="ac-body">
          <LeftRail
            view={view}
            onAddNode={addNode}
            onOpenGallery={() => setView(v => v === 'gallery' ? 'canvas' : 'gallery')}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          {view === 'canvas'
            ? <CanvasStage
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
                actions={actions}
                runningEdges={runningEdges}
                onDropNode={(type, position) => addNode(type, position)}
                onPaneContextMenu={null}
              />
            : <GalleryView
                onOpenImage={openImage}
                onToCanvas={galleryToCanvas}
                onBack={() => setView('canvas')}
              />}
        </div>
        <div className="ac-status">
          <span>拖拽端口连线（图↔图、文↔文）· 双击节点标题折叠 · ⌘Z 撤销</span>
          <span className="ac-status-flex" />
          <span>{workflowRunning ? '运行中，可停止' : '就绪'}</span>
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
