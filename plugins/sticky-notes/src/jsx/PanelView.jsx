import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { Button } from '../ui/index.jsx'

export function PanelView({ note, title, count, ready, error, onCopy, onOpen }) {
  const rootRef = useRef(null)
  const [size, setSize] = useState({ compact: true, rowLimit: 1 })
  useEffect(() => observeWidgetSize(rootRef.current, setSize, { reservedHeight: 112, rowHeight: 23, maxRows: 12 }), [])
  const text = String(note?.text || '').slice(0, 2500).replace(/^#{1,6}\s+/gm, '').trim()
  return (
    <section ref={rootRef} className="pk-widget notes-widget" data-compact={size.compact} aria-label="备忘录小组件" aria-busy={!ready && !error} style={{ '--note-tint': note?.color || 'var(--accent)' }}>
      <div className="notes-widget-heading"><span>备忘录</span><span>{note?.pinned ? '已置顶' : `${count} 条笔记`}</span></div>
      <div className="pk-widget-content notes-widget-content">
        <h1 className="notes-widget-title">{error ? '暂时无法读取' : !ready ? '正在读取笔记…' : note ? title : '留下一点想法'}</h1>
        {size.rowLimit > 0 && <p className="notes-widget-excerpt" style={{ WebkitLineClamp: size.rowLimit }}>{error || (note ? text || '这条笔记还没有正文。' : '在完整窗口新建笔记，或将常看的内容置顶。')}</p>}
      </div>
      <div className="pk-widget-actions notes-widget-actions">
        {note && <Button size="sm" variant="ghost" onClick={onCopy}>复制</Button>}
        <Button size="sm" variant="ghost" onClick={onOpen}>{note ? '打开笔记' : '打开备忘录'}</Button>
      </div>
    </section>
  )
}
