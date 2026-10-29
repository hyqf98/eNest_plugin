import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { Button } from '../ui/index.jsx'

function excerpt(text) {
  return String(text || '').slice(0, 6000)
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '〔代码片段〕')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[*_~`]/g, '').trim()
}

export function PanelView({ name, text, stats, ready, error, dirty, conflict, onOpen }) {
  const rootRef = useRef(null)
  const [size, setSize] = useState({ compact: true, rowLimit: 1 })
  useEffect(() => observeWidgetSize(rootRef.current, setSize, { reservedHeight: 112, rowHeight: 23, maxRows: 12 }), [])
  return (
    <section ref={rootRef} className="pk-widget markdown-widget" data-compact={size.compact} aria-label="Markdown 文稿小组件" aria-busy={!ready && !error}>
      <div className="markdown-widget-heading"><span>Markdown</span><span>{conflict ? '有外部变更' : dirty ? '未保存' : `${stats.words} 字词`}</span></div>
      <div className="pk-widget-content markdown-widget-content">
        <h1 className="markdown-widget-title">{error ? '文稿暂时不可用' : !ready ? '正在读取文稿…' : text ? name : '写下下一句话'}</h1>
        {size.rowLimit > 0 && <p className="markdown-widget-excerpt" style={{ WebkitLineClamp: size.rowLimit }}>{error || excerpt(text) || '打开完整窗口开始书写。这里会显示当前文稿，重启后读取最近打开的文档。'}</p>}
      </div>
      <div className="pk-widget-actions markdown-widget-actions">
        <span>{text ? '当前文稿' : '文稿摘录'}</span>
        <Button size="sm" variant="ghost" onClick={onOpen}>{text ? '继续写作' : '打开编辑器'}</Button>
      </div>
    </section>
  )
}
