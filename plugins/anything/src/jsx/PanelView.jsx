import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { fileIcon } from '../js/icons.js'
import { formatSize } from '../js/query.js'
import '../widget.css'

export function PanelView({ query, results, status, booted, onQuery, onOpen, onOpenShell }) {
  const root = useRef(null)
  const [size, setSize] = useState({ compact: true, wide: false, rowLimit: 0 })
  useEffect(() => observeWidgetSize(root.current, setSize, { reservedHeight: 112, rowHeight: 44, maxRows: 8 }), [])
  const rows = results.filter(file => file.path)
  const visible = rows.slice(0, size.rowLimit)
  const noEngine = results.some(file => file.__idle === 'no-engine')
  const empty = !booted ? '正在检测搜索引擎…' : noEngine ? '搜索引擎未就绪，请在主窗口设置' : query.trim() ? '暂无匹配文件' : '输入文件名，搜索本机文件'

  return (
    <section ref={root} className="pk-widget anything-widget" data-compact={size.compact} aria-label="文件搜索小组件">
      <div className="pk-widget-heading">
        <h2 className="pk-widget-title">文件搜索</h2>
        <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" title="在主窗口打开文件搜索" aria-label="在主窗口打开文件搜索" onClick={onOpenShell}>展开</button>
      </div>
      <input className="anything-widget-query" type="search" value={query} aria-label="搜索本机文件" placeholder="搜索文件名…" data-input-context="editor"
        onChange={event => onQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.isComposing && visible[0]) { event.preventDefault(); onOpen(visible[0].path) }
          if (event.key === 'Escape' && query) { event.preventDefault(); onQuery('') }
        }}
      />
      {size.rowLimit > 0 && (
        <div className="pk-widget-content anything-widget-results">
          {visible.length ? <ul aria-label="文件搜索结果">
            {visible.map(file => <li key={file.path}>
              <button type="button" className="anything-widget-result" title={`打开 ${file.path}`} onClick={() => onOpen(file.path)}>
                <span className="anything-widget-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: fileIcon(file) }} />
                <span className="anything-widget-file"><strong>{file.name}</strong><small>{size.wide ? file.dir : file.isDirectory ? '文件夹' : formatSize(file.size, false)}</small></span>
              </button>
            </li>)}
          </ul> : <p className="pk-widget-caption anything-widget-empty">{status.kind === 'busy' ? '正在搜索…' : empty}</p>}
        </div>
      )}
      <p className="pk-widget-caption anything-widget-status" data-kind={status.kind} role="status" title={status.text}>
        {status.kind === 'error' || status.kind === 'busy' ? status.text : rows.length ? `${rows.length} 项结果${rows.length > visible.length ? ' · 展开查看全部' : ''}` : empty}
      </p>
    </section>
  )
}
