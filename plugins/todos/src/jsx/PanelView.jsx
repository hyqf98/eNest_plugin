import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { Button } from '../ui/index.jsx'

function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function PanelView({ tasks, ready, failed, saveState, onComplete, onOpen }) {
  const rootRef = useRef(null)
  const [size, setSize] = useState({ compact: true, rowLimit: 0 })
  const [day, setDay] = useState(localDay)
  useEffect(() => observeWidgetSize(rootRef.current, setSize, { reservedHeight: 160, rowHeight: 28, maxRows: 5 }), [])
  useEffect(() => {
    let timer
    const update = () => {
      clearTimeout(timer)
      setDay(localDay())
      const midnight = new Date()
      midnight.setHours(24, 0, 0, 0)
      timer = setTimeout(update, midnight.getTime() - Date.now() + 100)
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', update) }
  }, [])
  const pending = tasks.filter(task => !task.done && !task.archived).sort((a, b) =>
    Number(Boolean(b.due && b.due <= day)) - Number(Boolean(a.due && a.due <= day))
    || Number(b.pinned) - Number(a.pinned)
    || Number(b.priority === 'high') - Number(a.priority === 'high')
    || (a.due || '9999').localeCompare(b.due || '9999')
    || (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    || a.createdAt - b.createdAt)
  const next = pending[0]
  const done = tasks.filter(task => task.done && !task.archived && localDay(new Date(task.updatedAt)) === day).length
  const due = pending.filter(task => task.due && task.due <= day).length
  return (
    <section ref={rootRef} className="pk-widget todos-widget" data-compact={size.compact} aria-label="待办清单小组件" aria-busy={!ready && !failed}>
      <div className="todos-widget-heading"><span>待办清单</span><span>{failed ? '读取失败' : ready ? `今日完成 ${done}` : '正在读取…'}</span></div>
      <div className="pk-widget-content todos-widget-content">
        <div className="todos-widget-count"><strong>{ready ? pending.length : '—'}</strong><span>待完成{due ? ` · ${due} 项到期` : ''}</span></div>
        <p className="todos-widget-next">{failed ? '原数据已保留，请展开后重试。' : !ready ? '正在整理下一步…' : next?.text || '今天的事情，都安排好了。'}</p>
        {size.rowLimit > 0 && <ul className="todos-widget-list">{pending.slice(1, size.rowLimit + 1).map(task => <li key={task.id}>{task.text}</li>)}</ul>}
      </div>
      <div className="pk-widget-actions todos-widget-actions">
        {saveState.startsWith('保存失败') ? <span role="status">保存失败</span> : null}
        {next && ready && <Button size="sm" variant="ghost" onClick={() => onComplete(next.id)}>完成下一项</Button>}
        <Button size="sm" variant="ghost" onClick={onOpen}>打开</Button>
      </div>
    </section>
  )
}
