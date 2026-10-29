/**
 * Toolbar — 顶部工具栏：草稿 Tab 条 + 画布 JSON 导入/导出。
 * 运行按钮在画布右侧悬浮轨；缩放/撤销/模式等由快捷键承担（⌘Z/⌘1/⌘=/⌘-/V/H）。
 */
export function Toolbar({ drafts, activeId, onSelectDraft, onNewDraft, onRenameDraft, onDeleteDraft, onExport, onImport }) {
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
        <button type="button" className="ac-rail-btn" title="导出画布 JSON" onClick={onExport}>
          <span aria-hidden>⤒</span>
          <span className="ac-rail-tip">导出</span>
        </button>
        <button type="button" className="ac-rail-btn" title="导入画布 JSON" onClick={onImport}>
          <span aria-hidden>⤓</span>
          <span className="ac-rail-tip">导入</span>
        </button>
      </div>
    </div>
  )
}
