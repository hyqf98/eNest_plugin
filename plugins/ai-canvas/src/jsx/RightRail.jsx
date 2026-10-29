/**
 * RightRail — 画布右侧浮动轨道（与左轨同手绘描边样式）。
 * 运行/停止为主按钮（顶部大钮），下方次要动作：撤销/重做/适配视图/变量检视。
 * 顶栏只保留草稿区，其余工具集中到这里，避免右上角堆叠。
 */
export function RightRail({ workflowRunning, onRunAll, onStop, canUndo, canRedo, onUndo, onRedo,
  onFit, logOpen, onToggleLog, inspectorOpen, onToggleInspector }) {
  return (
    <div className="ac-rrail" role="toolbar" aria-label="画布运行与视图工具">
      <button type="button"
        className={`ac-rrail-run ${workflowRunning ? 'ac-rrail-stop' : ''}`}
        title={workflowRunning ? '停止运行' : '运行全部（拓扑序）'}
        onClick={workflowRunning ? onStop : onRunAll}>
        <span aria-hidden>{workflowRunning ? '■' : '▶'}</span>
        <span className="ac-rail-tip">{workflowRunning ? '停止' : '运行'}</span>
      </button>
      <div className="ac-rrail-sep" />
      <button type="button" className="ac-rrail-btn" title="执行日志" aria-pressed={logOpen}
        onClick={onToggleLog}>
        <span aria-hidden>☰</span>
        <span className="ac-rail-tip">执行日志</span>
      </button>
      <button type="button" className="ac-rrail-btn" title="变量检视面板" aria-pressed={inspectorOpen}
        onClick={onToggleInspector}>
        <span aria-hidden>▤</span>
        <span className="ac-rail-tip">变量检视</span>
      </button>
      <button type="button" className="ac-rrail-btn" title="适配视图 (⌘1)" onClick={onFit}>
        <span aria-hidden>⊡</span>
        <span className="ac-rail-tip">适配视图</span>
      </button>
      <div className="ac-rrail-sep" />
      <button type="button" className="ac-rrail-btn" title="撤销 (⌘Z)" disabled={!canUndo} onClick={onUndo}>
        <span aria-hidden>↶</span>
        <span className="ac-rail-tip">撤销</span>
      </button>
      <button type="button" className="ac-rrail-btn" title="重做 (⇧⌘Z)" disabled={!canRedo} onClick={onRedo}>
        <span aria-hidden>↷</span>
        <span className="ac-rail-tip">重做</span>
      </button>
    </div>
  )
}
