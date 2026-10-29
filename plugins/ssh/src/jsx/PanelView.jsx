import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { getResourceState, subscribeResourceState } from '@ssh/js/resource-state.js'
import '@ssh/css/widget.css'

const percent = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
const bytes = value => !Number.isFinite(value) ? '—' : value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GB` : `${(value / 1048576).toFixed(0)} MB`

export function PanelView({ onOpenShell }) {
  const root = useRef(null)
  const [size, setSize] = useState({ height: 0, compact: true, wide: false, rowLimit: 0 })
  const [state, setState] = useState(getResourceState)
  useEffect(() => observeWidgetSize(root.current, setSize, { reservedHeight: 194, rowHeight: 27, maxRows: 4 }), [])
  useEffect(() => subscribeResourceState(setState), [])
  const sample = state.sample
  const connected = !!state.sessionId && state.status === 'connected'
  const disks = (sample?.disks || []).slice(0, size.rowLimit)
  const network = sample?.net?.reduce((sum, item) => sum + (Number(item.rxKbps) || 0) + (Number(item.txKbps) || 0), 0)
  const status = !connected ? state.status === 'connecting' ? '正在连接服务器…' : '未连接服务器' : state.error ? `采样失败${sample ? ' · 显示上次数据' : ''}` : state.loading && !sample ? '正在读取服务器资源…' : '当前会话资源'

  return (
    <section ref={root} className="pk-widget ssh-widget" data-compact={size.compact} aria-label="SSH 服务器资源小组件">
      <div className="pk-widget-heading">
        <h2 className="pk-widget-title" title={state.target || 'SSH 服务器'}>{state.name || 'SSH 服务器'}</h2>
        <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" title="在主窗口打开 SSH" aria-label="在主窗口打开 SSH" onClick={onOpenShell}>展开</button>
      </div>
      {connected ? <>
        <dl className="ssh-widget-metrics">
          <div><dt>CPU</dt><dd>{percent(sample?.cpuPercent)}</dd></div>
          <div><dt>内存</dt><dd>{percent(sample?.memPercent)}</dd></div>
        </dl>
        {size.height >= 195 && <p className="pk-widget-caption ssh-widget-detail" title={state.target}>
          {sample ? `${bytes(sample.memUsed)} / ${bytes(sample.memTotal)}${size.wide && Number.isFinite(network) ? ` · ${network.toFixed(1)} KB/s` : ''}` : state.target}
        </p>}
        {disks.length > 0 && <ul className="pk-widget-content ssh-widget-disks" aria-label="服务器磁盘">
          {disks.map((disk, index) => <li key={`${disk.mount}:${index}`}><span title={disk.mount}>{disk.mount}</span><strong>{percent(disk.usedPercent)}</strong></li>)}
        </ul>}
      </> : <div className="pk-widget-content ssh-widget-empty"><p className="pk-widget-caption">{size.compact ? '在主窗口连接服务器后显示资源' : '在主窗口选择并连接服务器。面板跟随当前会话，不会自动新建连接。'}</p></div>}
      <p className="pk-widget-caption ssh-widget-status" data-error={!!state.error} role="status" title={state.error || state.target}>{status}</p>
      {connected && size.height >= 195 && <div className="ssh-widget-footer">
        <span>{state.sampledAt ? `${new Date(state.sampledAt).toLocaleTimeString('zh-CN', { hour12: false })} 更新` : '等待首个样本'}</span>
        <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" disabled={state.loading} onClick={() => void window.SshWorkbenchBridge?.refreshResources?.()}>刷新</button>
      </div>}
    </section>
  )
}
