/** 详情顶卡：实例名/版本/路径/关键变量/总占用。 */
import { formatBytes, totalBytes } from '../js/format.js'

export function DetailHeader({ detail, family, selected }) {
  if (!detail && !family) return null
  const instance = detail?.instance ?? family?.instances.find(item => item.id === selected.id)
  if (!instance) return null
  const usage = detail?.diskUsage ?? []
  const grandTotal = totalBytes(usage)
  return (
    <section className="overview">
      <div className="overview-main">
        <div className="overview-name">{instance.label}</div>
        <div className="overview-meta">
          {instance.version && <span className="badge">{instance.version}</span>}
          {instance.binPath && <span className="mono path">{instance.binPath}</span>}
          {!instance.binPath && instance.rootPath && <span className="mono path">{instance.rootPath}</span>}
          {instance.note && <span className="muted">{instance.note}</span>}
        </div>
        {(detail?.keyVars?.length ?? 0) > 0 && (
          <div className="keyvars">
            {detail.keyVars.map(variable => (
              <div key={variable.name} className="keyvar">
                <span className="keyvar-name">{variable.name}</span>
                <span className="mono">{variable.value}</span>
              </div>
            ))}
          </div>
        )}
        {(detail?.extra?.length ?? 0) > 0 && <div className="extra-lines">{detail.extra.map(line => <div key={line} className="muted">{line}</div>)}</div>}
      </div>
      {usage.length > 0 && (
        <div className="overview-usage">
          <div className="usage-total">{formatBytes(grandTotal)}</div>
          <div className="muted">总占用</div>
          <div className="usage-breakdown">
            {usage.map(entry => (
              <div key={entry.path} className="usage-row" title={entry.path}>
                <span className="usage-label">{entry.label}</span>
                <span className="usage-bytes">{formatBytes(entry.bytes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
