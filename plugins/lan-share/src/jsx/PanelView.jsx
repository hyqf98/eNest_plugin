import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { fmtBytes, fmtRemain } from '../js/util.mjs'
import '../css/widget.css'

export function PanelView({ share, now, status, onCopyLink, onOpenShell }) {
  const root = useRef(null)
  const [size, setSize] = useState({ height: 0, compact: true, rowLimit: 0 })
  useEffect(() => observeWidgetSize(root.current, setSize, { reservedHeight: 200, rowHeight: 28, maxRows: 5 }), [])
  const expired = !!share && now >= share.expiresAt
  return (
    <section ref={root} className="pk-widget lan-widget" data-compact={size.compact} aria-label="局域网分享小组件">
      <div className="pk-widget-heading">
        <h2 className="pk-widget-title">局域网传件</h2>
        <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" title="在主窗口打开局域网传件" aria-label="在主窗口打开局域网传件" onClick={onOpenShell}>展开</button>
      </div>
      {share ? <>
        <div className="lan-widget-code"><span>取件码</span><strong>{share.code}</strong><small>{expired ? '正在确认到期' : `剩余 ${fmtRemain(share.expiresAt - now)}`}</small></div>
        {size.rowLimit > 0 && <ul className="pk-widget-content lan-widget-files" aria-label="正在分享的文件">
          {share.files.slice(0, size.rowLimit).map(file => <li key={file.id}><span title={file.name}>{file.name}</span><small>{fmtBytes(file.size)}</small></li>)}
        </ul>}
        <p className="pk-widget-caption lan-widget-status" role="status" title={status || `${share.activeConnections ?? 0} 个活动连接`}>{status || `${share.files.length} 个文件 · 已下载 ${share.downloads} 次`}</p>
        {size.height >= 190 && <div className="pk-widget-actions">
          <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" disabled={expired} onClick={onCopyLink}>复制链接</button>
        </div>}
      </> : <div className="pk-widget-content lan-widget-empty"><p className="pk-widget-caption">当前没有分享<br />在主窗口选择文件并开始分享</p></div>}
    </section>
  )
}
