/**
 * Toolbar — 顶部工具栏：草稿 Tab 条 + 运行全部/停止 + 模式/检视 + 缩放/适配 + 撤销重做。
 */
import { useReactFlow } from '@xyflow/react'
import { Button } from '../ui/index.jsx'

export function Toolbar({ drafts, activeId, onSelectDraft, onNewDraft, onRenameDraft, onDeleteDraft,
  onRunAll, onStop, workflowRunning, canUndo, canRedo, onUndo, onRedo,
  mode, onModeChange, inspectorOpen, onToggleInspector,
  nodeCount, edgeCount, runningCount }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  return (
    <div className="ac-toolbar">
      <div className="ac-draft-tabs" role="tablist" aria-label="画布草稿">
        {drafts.map(draft => (
          <div key={draft.id}
            className={`ac-draft-tab ${draft.id === activeId ? 'ac-draft-active' : ''}`}
            role="tab" aria-selected={draft.id === activeId}
            onClick={() => onSelectDraft(draft.id)}
            onDoubleClick={() => onRenameDraft(draft.id)}
            title="双击重命名">
            <span className="ac-draft-name">{draft.name}</span>
            {drafts.length > 1 && (
              <button type="button" className="ac-draft-close" title="删除草稿"
                onClick={e => { e.stopPropagation(); onDeleteDraft(draft.id) }}>×</button>
            )}
          </div>
        ))}
        <button type="button" className="ac-draft-add" title="新建画布" onClick={onNewDraft}>＋</button>
      </div>
      <div className="ac-toolbar-actions">
        <span className="ac-toolbar-stat" title="节点 / 连线 / 运行中">{nodeCount} 节点 · {edgeCount} 连线{runningCount > 0 ? ` · ${runningCount} 运行中` : ''}</span>
        <div className="ac-toolbar-sep" />
        <Button size="sm" variant={mode === 'pointer' ? 'primary' : 'ghost'} onClick={() => onModeChange('pointer')} title="指针模式：拖拽框选 / 滚轮平移（V）">↖</Button>
        <Button size="sm" variant={mode === 'hand' ? 'primary' : 'ghost'} onClick={() => onModeChange('hand')} title="手模式：拖拽平移（H）">✋</Button>
        <Button size="sm" variant={inspectorOpen ? 'primary' : 'ghost'} onClick={onToggleInspector} title="变量检视面板（查看/改写节点输出后只跑下游）">▤</Button>
        <div className="ac-toolbar-sep" />
        {workflowRunning
          ? <Button size="sm" variant="danger" onClick={onStop}>■ 停止</Button>
          : <Button size="sm" variant="primary" onClick={onRunAll} title="按拓扑序运行整张画布">▶ 运行全部</Button>}
        <div className="ac-toolbar-sep" />
        <Button size="sm" variant="ghost" onClick={onUndo} disabled={!canUndo} title="撤销 (⌘Z)">↶</Button>
        <Button size="sm" variant="ghost" onClick={onRedo} disabled={!canRedo} title="重做 (⇧⌘Z)">↷</Button>
        <div className="ac-toolbar-sep" />
        <Button size="sm" variant="ghost" onClick={() => zoomOut({ duration: 180 })} title="缩小">−</Button>
        <Button size="sm" variant="ghost" onClick={() => fitView({ duration: 320, padding: 0.18 })} title="适配视图 (⌘1)">⊡</Button>
        <Button size="sm" variant="ghost" onClick={() => zoomIn({ duration: 180 })} title="放大">＋</Button>
      </div>
    </div>
  )
}
