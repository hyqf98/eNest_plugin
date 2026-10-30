/** 底部任务条：进行中/刚结束任务的进度文案 + 最新输出行 + 取消 + 可展开输出区。 */
import { useState } from 'react'
import { Button } from '../ui/index.jsx'

export function TaskBar({ tasks, onCancel }) {
  const [expanded, setExpanded] = useState(false)
  const live = tasks.filter(task => task.running || !task.ok)
  const running = tasks.filter(task => task.running)
  if (tasks.length === 0) return null
  const current = live[live.length - 1] ?? tasks[tasks.length - 1]

  return (
    <section className="taskbar" data-running={running.length > 0 ? 'true' : 'false'} aria-live="polite">
      <div className="taskbar-main">
        <span className={'task-dot' + (current.running ? ' on' : '')} aria-hidden="true" />
        <span className="task-label">{current.label}</span>
        <span className="task-line mono">{current.running ? (current.lastLine || '启动中…') : (current.ok ? (current.note ?? '完成') : `失败：${current.note ?? ''}`)}</span>
        <div className="taskbar-actions">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(prev => !prev)} aria-expanded={expanded}>{expanded ? '收起输出' : '展开输出'}</Button>
          {current.running && <Button variant="danger" size="sm" onClick={() => void onCancel(current.taskId)}>取消</Button>}
        </div>
      </div>
      {expanded && (
        <pre className="task-output">{(current.lines ?? []).join('\n') || '暂无输出'}</pre>
      )}
    </section>
  )
}
