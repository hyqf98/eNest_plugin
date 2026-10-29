import { Button } from '../ui/index.jsx'

export function PanelView({ timeText, statusText, task, remaining, ready, busy, error, todayCount, toggleText, onToggle, onExpand }) {
  return (
    <section className="pk-widget pomo-widget" aria-label="番茄钟小组件" aria-busy={busy || (!ready && !error)}>
      <div className="pk-widget-heading">
        <h1 className="pk-widget-title">番茄钟</h1>
        <Button variant="ghost" size="sm" onClick={onExpand} aria-label="移到主窗，打开完整番茄钟">展开</Button>
      </div>
      <div className="pk-widget-content pomo-widget-clock">
        <p className="pk-widget-caption" role="status">{error || (!ready ? '正在读取计时…' : statusText)}</p>
        <span className="pk-widget-value" role="timer" aria-label={`剩余 ${timeText}`}>{timeText}</span>
        <div className="pomo-widget-track" aria-hidden="true">
          <span style={{ transform: `scaleX(${remaining})` }} />
        </div>
        <p className="pk-widget-caption pomo-widget-task" title={task || undefined}>{task || '一次只做一件事'}</p>
      </div>
      <div className="pk-widget-actions">
        <span className="pk-widget-caption pomo-widget-today">今日 {todayCount} 次</span>
        <Button variant="primary" size="sm" disabled={busy || !ready} onClick={onToggle}>{toggleText}</Button>
      </div>
    </section>
  )
}
