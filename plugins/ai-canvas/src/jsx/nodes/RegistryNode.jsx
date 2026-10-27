/**
 * RegistryNode — 注册表驱动的通用节点组件（所有业务节点共用一个）。
 *
 * 端口、参数表单、状态、输出预览全部按 nodeRegistry 的 def 渲染：
 *   - 输出预览遍历 def.outputs 按 kind 分派，不写死端口 key
 *   - 单节点运行按钮判 def.runnable（与 def.protocol 是否走网络解耦）
 *   - 端口 Handle 按序号纵向偏移，多端口不再重叠
 *   - 文本参数可插 {{#节点.端口#}} 变量引用（acceptsVariable）
 * 交互回调经 CanvasActionsContext 注入，避免 React Flow 闭包陈旧。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { getNodeDef } from '../../js/nodeRegistry.mjs'
import { PORT_KIND, PORT_KINDS, PARAM_TYPE, summarizeParam } from '../../js/nodeSchema.mjs'
import { assetPreviewUrl, saveAsset } from '../../js/assets.mjs'
import { fromDataUrl } from '../../js/netFetch.mjs'
import { Button } from '../../ui/index.jsx'
import { VariablePicker } from '../VariablePicker.jsx'

export const CanvasActionsContext = createContext(null)

const RUN_LABEL = { idle: '待命', running: '运行中', success: '成功', error: '失败' }

function StatusLight({ state }) {
  return <span className={`ac-light ac-light-${state || 'idle'}`} title={RUN_LABEL[state] ?? state} />
}

/** 图片预览块（blob URL 异步解析） */
function ImageThumb({ assetId, onOpen, large = false }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    assetPreviewUrl(assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [assetId])
  if (!url) return <div className={`ac-thumb ${large ? 'ac-thumb-lg' : ''} ac-thumb-loading`} aria-hidden>…</div>
  return <button type="button" className={`ac-thumb ${large ? 'ac-thumb-lg' : ''}`} onClick={() => onOpen(assetId)} title="点击放大">
    <img src={url} alt="" draggable={false} />
  </button>
}

/** 输出口标签：与 Handle 的纵向偏移共用同一序号 */
const handleTop = index => 46 + index * 20

function PortLabels({ ports, side }) {
  if (!ports?.length) return null
  return <div className={`ac-ports ac-ports-${side}`} aria-hidden="true">
    {ports.map((port, index) => (
      <span key={port.key} className="ac-port-label" style={{ top: handleTop(index) }}>
        <i className={`ac-port-dot ac-port-${port.kind}`} />{port.label ?? port.key}
      </span>
    ))}
  </div>
}

/** 变量引用按钮：呼出上游变量选择器（阻止 label 默认把焦点交回输入框） */
function VariableButton({ onOpen }) {
  return <button type="button" className="ac-varbtn" title="引用上游变量"
    onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.preventDefault(); e.stopPropagation(); onOpen({ x: e.clientX, y: e.clientY + 6 }) }}>{'{ }'}</button>
}

/** 声明式参数表单：按 def.params 分派控件类型 */
function ParamForm({ def, params, onChange, onOpenVariable, onPickImage }) {
  return <div className="ac-params">
    {def.params.map(p => {
      const value = params[p.key]
      if (p.type === PARAM_TYPE.TEXTAREA || p.type === PARAM_TYPE.TEXT) {
        const multiline = p.type === PARAM_TYPE.TEXTAREA
        return <label key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}
            {p.acceptsVariable && <VariableButton onOpen={anchor => onOpenVariable(p, anchor)} />}
          </span>
          {multiline
            ? <textarea className="ac-input ac-textarea" rows={p.rows ?? 3} placeholder={p.placeholder ?? ''}
                data-param={p.key}
                value={value ?? ''} onChange={e => onChange(p.key, e.target.value)} />
            : <input className="ac-input" type="text" placeholder={p.placeholder ?? ''}
                data-param={p.key}
                value={value ?? ''} onChange={e => onChange(p.key, e.target.value)} />}
          {p.acceptsVariable && <span className="ac-field-hint">可用 {'{{#节点.端口#}}'} 引用上游输出</span>}
        </label>
      }
      if (p.type === PARAM_TYPE.SELECT) {
        return <label key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}</span>
          <select className="ac-input ac-select" value={value ?? p.default} onChange={e => onChange(p.key, e.target.value)}>
            {p.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      }
      if (p.type === PARAM_TYPE.SLIDER) {
        return <label key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}<em className="ac-field-value">{value ?? p.default}</em></span>
          <input type="range" className="ac-range" min={p.min} max={p.max} step={p.step}
            value={value ?? p.default} onChange={e => onChange(p.key, Number(e.target.value))} />
        </label>
      }
      if (p.type === PARAM_TYPE.NUMBER) {
        return <label key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}</span>
          <input className="ac-input" type="number" min={p.min} max={p.max} step={p.step}
            value={value ?? p.default} onChange={e => onChange(p.key, Number(e.target.value))} />
        </label>
      }
      if (p.type === PARAM_TYPE.SWITCH) {
        return <label key={p.key} className="ac-field ac-field-inline">
          <span className="ac-field-label">{p.label}</span>
          <input type="checkbox" className="ac-check" checked={value ?? p.default}
            onChange={e => onChange(p.key, e.target.checked)} />
        </label>
      }
      if (p.type === PARAM_TYPE.IMAGE) {
        return <div key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}</span>
          {value?.assetId
            ? <div className="ac-localimg-row">
                <ImageThumb assetId={value.assetId} onOpen={() => {}} />
                <Button size="sm" variant="ghost" onClick={() => onChange(p.key, null)}>清除</Button>
              </div>
            : <Button size="sm" variant="ghost" onClick={() => onPickImage(p)}>选择图片</Button>}
        </div>
      }
      return null
    })}
  </div>
}

/** 输出预览：按端口 kind 分派，不写死 key */
function OutputPreview({ def, lastRun }) {
  if (!lastRun) return null
  const outputs = lastRun.outputs ?? {}
  return <div className="ac-outputs">
    {def.outputs.map(port => {
      const value = outputs[port.key]
      if (value == null) return null
      if (port.kind === PORT_KIND.IMAGE) {
        const list = Array.isArray(value) ? value : [value]
        if (!list.length) return null
        return <div key={port.key} className="ac-outblock">
          {list.length > 1 && <span className="ac-outblock-title">{port.label ?? port.key}</span>}
          <div className="ac-thumbs">{list.map((img, i) => <ImageThumb key={`${img.assetId}-${i}`} assetId={img.assetId} />)}</div>
        </div>
      }
      if (port.kind === PORT_KIND.JSON) {
        return <pre key={port.key} className="ac-json">{JSON.stringify(value, null, 2)}</pre>
      }
      const text = String(value)
      if (!text) return null
      return <div key={port.key} className="ac-textout" title={text}>{text}</div>
    })}
    {lastRun.display?.images?.length > 0 && (
      <div className="ac-thumbs ac-final">
        {lastRun.display.images.map((img, i) => <ImageThumb key={`${img.assetId}-${i}`} assetId={img.assetId} large />)}
      </div>
    )}
  </div>
}

export function RegistryNode({ id, data, selected }) {
  const actions = useContext(CanvasActionsContext)
  const def = getNodeDef(data.type)
  const [open, setOpen] = useState(true)
  const [varTarget, setVarTarget] = useState(null)
  const areaRef = useRef(null)
  const running = data.state === 'running'

  if (!def) return <div className="ac-node ac-node-unknown">未知节点：{data.type}</div>

  const openVariable = (param, anchor) => setVarTarget({ param, anchor })

  const insertVariable = selector => {
    const param = varTarget?.param
    if (!param) return
    const el = areaRef.current?.querySelector(`[data-param="${param.key}"]`)
    const current = String(data.params?.[param.key] ?? '')
    const caret = typeof el?.selectionStart === 'number' ? el.selectionStart : current.length
    const next = `${current.slice(0, caret)}${selector}${current.slice(caret)}`
    actions?.onParamChange(id, param.key, next)
    requestAnimationFrame(() => {
      const target = areaRef.current?.querySelector(`[data-param="${param.key}"]`)
      target?.focus()
      const pos = caret + selector.length
      target?.setSelectionRange?.(pos, pos)
    })
  }

  const pickImage = async param => {
    try {
      const ref = await actions?.onPickLocalImageParam(id, param.key)
      if (ref) actions?.onParamChange(id, param.key, ref)
    } catch { /* 用户取消 */ }
  }

  const summary = open ? null : def.params
    .map(p => summarizeParam(p, data.params?.[p.key]))
    .filter(Boolean).join(' · ') || '（无参数）'

  const addable = actions?.onHandleAddNode && !actions?.workflowRunning

  return (
    <div ref={areaRef} className={[
      'ac-node', `ac-node-${data.type}`,
      selected && 'ac-node-selected',
      running && 'ac-node-running',
      data.state === 'success' && 'ac-node-success',
      data.state === 'error' && 'ac-node-error',
      open ? '' : 'ac-node-collapsed'
    ].filter(Boolean).join(' ')}>
      {def.inputs.map((port, index) => (
        <Handle key={`in-${port.key}`} id={port.key} type="target" position={Position.Left}
          style={{ top: handleTop(index) }}
          className={`ac-handle ac-handle-in ac-handle-${port.kind}`} data-kind={port.kind} />
      ))}
      {def.outputs.map((port, index) => (
        <Handle key={`out-${port.key}`} id={port.key} type="source" position={Position.Right}
          style={{ top: handleTop(index) }}
          className={`ac-handle ac-handle-out ac-handle-${port.kind}`} data-kind={port.kind} />
      ))}

      {addable && def.inputs.map((port, index) => (
        <button type="button" key={`add-in-${port.key}`} className="ac-handle-add ac-handle-add-left"
          style={{ top: handleTop(index) }} title={`在此节点前插入：${port.label ?? port.key}`}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); actions.onHandleAddNode({ nodeId: id, portKey: port.key, side: 'target', handleId: port.key }, { x: e.clientX, y: e.clientY }) }}>＋</button>
      ))}
      {addable && def.outputs.map((port, index) => (
        <button type="button" key={`add-out-${port.key}`} className="ac-handle-add ac-handle-add-right"
          style={{ top: handleTop(index) }} title={`从「${port.label ?? port.key}」接出节点`}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); actions.onHandleAddNode({ nodeId: id, portKey: port.key, side: 'source', handleId: port.key }, { x: e.clientX, y: e.clientY }) }}>＋</button>
      ))}

      <header className="ac-node-head" onDoubleClick={() => setOpen(o => !o)}>
        <span className="ac-glyph" aria-hidden>{def.glyph}</span>
        <span className="ac-node-title">{def.title}</span>
        <StatusLight state={data.state} />
        <span className="ac-node-tools">
          {def.runnable && <button type="button" className={`ac-run ${running ? 'ac-run-busy' : ''}`}
            title={running ? '运行中…' : '运行此节点'} disabled={running || actions?.workflowRunning}
            onClick={() => actions?.onRunNode(id)}>▶</button>}
          <button type="button" className="ac-del" title="删除节点" onClick={() => actions?.onDeleteNodes([id])}>×</button>
        </span>
      </header>

      {open ? <>
        <ParamForm def={def} params={data.params ?? {}}
          onChange={(key, value) => actions?.onParamChange(id, key, value)}
          onOpenVariable={openVariable} onPickImage={pickImage} />
        {data.error && <div className="ac-error" role="alert">{data.error}</div>}
        {data.warnings?.length > 0 && <div className="ac-warning">{data.warnings.join('；')}</div>}
        <OutputPreview def={def} lastRun={data.lastRun} />
        {data.lastRun?.usage?.total_tokens != null && (
          <div className="ac-usage">
            {data.lastRun.durationMs ? `${(data.lastRun.durationMs / 1000).toFixed(1)}s · ` : ''}
            tokens {data.lastRun.usage.total_tokens}
          </div>
        )}
      </> : <div className="ac-node-summary">{summary}</div>}

      {open && <PortLabels ports={def.inputs} side="left" />}
      {open && <PortLabels ports={def.outputs} side="right" />}

      {varTarget && (
        <VariablePicker anchor={varTarget.anchor} nodeId={id}
          nodes={actions?.graphRef?.current?.nodes ?? []} edges={actions?.graphRef?.current?.edges ?? []}
          getOutputs={actions?.getOutputs}
          onInsert={insertVariable} onClose={() => setVarTarget(null)} />
      )}
    </div>
  )
}

/** 本地选图：localFiles.pick → dataUrl（校验图片 MIME）→ 落 assets 拿稳定 assetId */
export async function pickLocalImage() {
  const enest = window.enest || window.zapi
  const handles = await enest.localFiles.pick({ kind: 'file', multiple: false, access: 'read' })
  const handle = Array.isArray(handles) ? handles[0] : handles
  if (!handle?.id) return null
  const dataUrl = await enest.localFiles.read({ handleId: handle.id, encoding: 'dataUrl', maxBytes: 32 * 1024 * 1024 })
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('所选文件不是图片')
  const { bytes, mime } = fromDataUrl(dataUrl)
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('仅支持 PNG / JPEG / WebP / GIF')
  const saved = await saveAsset({ bytes, mime, name: handle.name ?? 'local-input' })
  return { assetId: saved.assetId, name: saved.name ?? 'local-input' }
}
