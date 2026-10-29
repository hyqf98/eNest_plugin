import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { Button } from '../ui/index.jsx'

export function PanelView({ snippets, ready, error, onCopy, onOpen }) {
  const rootRef = useRef(null)
  const [size, setSize] = useState({ compact: true, rowLimit: 1 })
  useEffect(() => observeWidgetSize(rootRef.current, setSize, { reservedHeight: 112, rowHeight: 23, maxRows: 10 }), [])
  const snippet = snippets[0]
  return (
    <section ref={rootRef} className="pk-widget clipboard-widget" data-compact={size.compact} aria-label="剪贴板暂存片段小组件" aria-busy={!ready && !error}>
      <div className="clipboard-widget-heading"><span>暂存片段</span><span>{snippets.length} 条</span></div>
      <div className="pk-widget-content clipboard-widget-content">
        <h1 className="clipboard-widget-title">{error ? '暂时无法读取' : !ready ? '正在读取片段…' : snippet?.title || '常用的话，放在这里'}</h1>
        {size.rowLimit > 0 && <p className="clipboard-widget-excerpt" style={{ WebkitLineClamp: size.rowLimit }}>{error || snippet?.body || '在剪贴板工具中保存暂存片段。组件只展示主动保存的内容，不展示新复制的历史。'}</p>}
      </div>
      <div className="pk-widget-actions clipboard-widget-actions">
        {snippet && <Button size="sm" variant="ghost" onClick={() => onCopy(snippet)}>复制片段</Button>}
        <Button size="sm" variant="ghost" onClick={onOpen}>管理</Button>
      </div>
    </section>
  )
}
