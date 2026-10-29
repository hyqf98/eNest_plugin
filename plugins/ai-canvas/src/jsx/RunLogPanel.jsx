/**
 * RunLogPanel — 执行日志悬浮板（画布右上，运行后自动出现）。
 * 每个节点一行：标题、状态、耗时、输入摘要、输出摘要、错误。
 * 数据直接从节点的 state/lastRun 推导，不额外维护一份日志存储。
 */
import { getNodeDef } from '../js/nodeRegistry.mjs'
import { PORT_KIND, PORT_KINDS } from '../js/nodeSchema.mjs'

function summarizeValue(port, value) {
  if (value == null) return '—'
  if (port?.kind === PORT_KIND.IMAGE) {
    const list = Array.isArray(value) ? value : [value]
    return `${list.length} 张图片`
  }
  if (port?.kind === PORT_KIND.JSON) return JSON.stringify(value).slice(0, 80)
  const text = String(value)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

const STATE_LABEL = { idle: '待命', running: '运行中', success: '成功', error: '失败' }

export function RunLogPanel({ nodes, onClose }) {
  // 只列有运行记录或失败的节点，保持面板紧凑
  const rows = nodes
    .map(node => ({ node, def: getNodeDef(node.data?.type) }))
    .filter(({ node, def }) => def && (node.data?.lastRun || node.data?.error || node.data?.state === 'running'))

  return (
    <div className="ac-logpanel" role="log" aria-label="节点执行日志">
      <header className="ac-log-head">
        <span className="ac-log-title">执行日志</span>
        <span className="ac-log-count">{rows.length} 个节点</span>
        <button type="button" className="ac-insp-close" onClick={onClose}>收起</button>
      </header>
      <div className="ac-log-rows">
        {rows.length === 0 && <div className="ac-log-empty">还没有运行记录。点节点右上角 ▶ 或顶部「运行」后，这里会显示每个节点的输入、输出与错误。</div>}
        {rows.map(({ node, def }) => {
          const run = node.data.lastRun
          const state = node.data.state || 'idle'
          return <div key={node.id} className={`ac-log-row ac-log-${state}`}>
            <div className="ac-log-rowhead">
              <span className={`ac-light ac-light-${state}`} aria-hidden />
              <span className="ac-log-node">{node.data.title || def.title}</span>
              <span className="ac-log-state">{STATE_LABEL[state] ?? state}</span>
              {run?.durationMs != null && <span className="ac-log-time">{(run.durationMs / 1000).toFixed(1)}s</span>}
            </div>
            {node.data.error && <div className="ac-log-error">✕ {node.data.error}</div>}
            {run?.inputs && Object.keys(run.inputs).length > 0 && (
              <div className="ac-log-line">
                <b>输入</b>
                {def.inputs.map(port => run.inputs[port.key] === undefined ? null : (
                  <span key={port.key} className="ac-log-item">
                    <i className={`ac-var-kind ac-var-${port.kind}`}>{PORT_KINDS[port.kind]?.glyph ?? '?'}</i>
                    {port.label ?? port.key}：{summarizeValue(port, run.inputs[port.key])}
                  </span>
                ))}
              </div>
            )}
            {run?.outputs && Object.keys(run.outputs).length > 0 && (
              <div className="ac-log-line">
                <b>输出</b>
                {def.outputs.map(port => run.outputs[port.key] === undefined ? null : (
                  <span key={port.key} className="ac-log-item">
                    <i className={`ac-var-kind ac-var-${port.kind}`}>{PORT_KINDS[port.kind]?.glyph ?? '?'}</i>
                    {port.label ?? port.key}：{summarizeValue(port, run.outputs[port.key])}
                  </span>
                ))}
              </div>
            )}
            {run?.usage?.total_tokens != null && <div className="ac-log-line ac-log-usage">tokens {run.usage.total_tokens}</div>}
          </div>
        })}
      </div>
    </div>
  )
}
