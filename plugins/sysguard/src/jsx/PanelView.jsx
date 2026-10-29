import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { formatKb, formatPct, topProcesses } from '../js/core.js'
import '../css/widget.css'

export function PanelView({ procs, ports, portsError, sampledAt, error, onRefresh, onOpenShell }) {
  const root = useRef(null)
  const [size, setSize] = useState({ height: 0, compact: true, rowLimit: 0 })
  useEffect(() => observeWidgetSize(root.current, setSize, { reservedHeight: 200, rowHeight: 26, maxRows: 6 }), [])
  const cpu = procs.reduce((sum, proc) => sum + (Number(proc.pcpu) || 0), 0)
  const memory = procs.reduce((sum, proc) => sum + (Number(proc.rss) || 0), 0)
  const top = topProcesses(procs, 'pcpu', size.rowLimit)
  const time = sampledAt ? new Date(sampledAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''
  const state = error ? `采样失败${sampledAt ? ' · 显示上次数据' : ''}` : sampledAt ? `${procs.length} 进程 · ${portsError ? '端口不可用' : `${ports.length} 监听端口`}` : '等待本机采样…'

  return (
    <section ref={root} className="pk-widget sysguard-widget" data-compact={size.compact} aria-label="本机进程资源小组件">
      <div className="pk-widget-heading">
        <h2 className="pk-widget-title">本机资源</h2>
        <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" title="在主窗口查看进程与端口" aria-label="在主窗口查看进程与端口" onClick={onOpenShell}>展开</button>
      </div>
      <dl className="sysguard-widget-metrics">
        <div title="各进程 CPU 百分比之和，多核机器可能超过 100%，不是系统总使用率">
          <dt>进程 CPU 合计</dt><dd>{sampledAt ? formatPct(cpu) : '—'}</dd>
        </div>
        <div title="各进程驻留内存之和，可能含共享页，不等同于系统已用内存">
          <dt>进程内存</dt><dd>{sampledAt ? formatKb(memory) : '—'}</dd>
        </div>
      </dl>
      {top.length > 0 && <div className="pk-widget-content sysguard-widget-top">
        <p className="pk-widget-caption">CPU 占用较高的进程</p>
        <ol>{top.map(proc => <li key={proc.pid}><span title={`${proc.name} · PID ${proc.pid}`}>{proc.name}</span><strong>{formatPct(proc.value)}</strong></li>)}</ol>
      </div>}
      <p className="pk-widget-caption sysguard-widget-status" data-error={!!error || !!portsError} title={error || portsError || `${state}${time ? ` · ${time}` : ''}`} role="status">{state}</p>
      {size.height >= 200 && <div className="sysguard-widget-footer">
        <span>{time ? `${time} 更新` : '由插件现有采样器提供'}</span>
        <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" onClick={onRefresh}>刷新</button>
      </div>}
    </section>
  )
}
