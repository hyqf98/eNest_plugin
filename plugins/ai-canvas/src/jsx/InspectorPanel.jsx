/**
 * InspectorPanel — 底部变量检视面板（Dify 单步调试的核心件）。
 * 列出每个已运行节点的标准化输出（按端口分组），文本可直接编辑写回运行上下文，
 * 改完即可只跑下游验证，不必重跑上游网络请求。
 */
import { useEffect, useState } from 'react'
import { getNodeDef } from '../js/nodeRegistry.mjs'
import { PORT_KIND, PORT_KINDS } from '../js/nodeSchema.mjs'
import { assetPreviewUrl } from '../js/assets.mjs'

function ImageCell({ assetId }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    assetPreviewUrl(assetId).then(u => { if (alive) setUrl(u ?? '') }).catch(() => setUrl(''))
    return () => { alive = false }
  }, [assetId])
  if (!url) return <span className="ac-insp-loading">…</span>
  return url ? <img className="ac-insp-img" src={url} alt="" draggable={false} /> : <span className="ac-insp-empty">资源缺失</span>
}

function ValueCell({ port, value, onEdit }) {
  if (value == null) return <span className="ac-insp-empty">—</span>
  if (port.kind === PORT_KIND.IMAGE) {
    const list = Array.isArray(value) ? value : [value]
    return <span className="ac-insp-images">{list.map((img, i) => <ImageCell key={`${img.assetId}-${i}`} assetId={img.assetId} />)}</span>
  }
  if (port.kind === PORT_KIND.JSON) {
    const text = JSON.stringify(value)
    return <code className="ac-insp-json" title={text}>{text.length > 120 ? `${text.slice(0, 120)}…` : text}</code>
  }
  const text = String(value)
  return <input className="ac-insp-text" value={text} onChange={e => onEdit(e.target.value)} />
}

export function InspectorPanel({ nodes, getOutputs, onOverride, onCollapse }) {
  const rows = nodes.filter(node => {
    const outputs = getOutputs?.(node.id)
    return outputs && Object.keys(outputs).length > 0
  })
  if (!rows.length) {
    return (
      <div className="ac-inspector">
        <div className="ac-insp-head">
          <span className="ac-insp-title">变量检视</span>
          <span className="ac-insp-hint">运行节点后，这里可查看并临时改写其输出</span>
          <button type="button" className="ac-insp-close" onClick={onCollapse}>收起</button>
        </div>
      </div>
    )
  }
  return (
    <div className="ac-inspector">
      <div className="ac-insp-head">
        <span className="ac-insp-title">变量检视</span>
        <span className="ac-insp-hint">文本可编辑，改完直接「运行下游」</span>
        <button type="button" className="ac-insp-close" onClick={onCollapse}>收起</button>
      </div>
      <div className="ac-insp-rows">
        {rows.map(node => {
          const def = getNodeDef(node.data?.type)
          if (!def) return null
          const outputs = getOutputs(node.id) ?? {}
          return <div key={node.id} className="ac-insp-row">
            <span className="ac-insp-node"><span className="ac-glyph" aria-hidden>{def.glyph}</span>{def.title}</span>
            <div className="ac-insp-vars">
              {def.outputs.map(port => (
                <span key={port.key} className="ac-insp-var">
                  <i className={`ac-var-kind ac-var-${port.kind}`}>{PORT_KINDS[port.kind]?.glyph ?? '?'}</i>
                  <b>{port.label ?? port.key}</b>
                  <ValueCell port={port} value={outputs[port.key]}
                    onEdit={text => onOverride(node.id, port.key, text)} />
                </span>
              ))}
            </div>
          </div>
        })}
      </div>
    </div>
  )
}
