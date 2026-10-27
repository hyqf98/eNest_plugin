/**
 * RegistryNode — 注册表驱动的通用节点组件（文生图/图生图/提示词模板共用）。
 * 端口、参数表单、状态灯、输出预览全部按 nodeRegistry 声明渲染；新节点类型零 UI 改动。
 * 交互回调经 CanvasActionsContext 注入，避免 React Flow 闭包陈旧。
 */
import { createContext, useContext, useEffect, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { getNodeDef } from '../../js/nodeRegistry.mjs'
import { assetPreviewUrl, saveAsset } from '../../js/assets.mjs'
import { fromDataUrl } from '../../js/netFetch.mjs'
import { Button } from '../../ui/index.jsx'

export const CanvasActionsContext = createContext(null)

function StatusLight({ state }) {
  const label = { idle: '待命', running: '运行中', success: '成功', error: '失败' }[state] ?? state
  return <span className={`ac-light ac-light-${state || 'idle'}`} title={label} />
}

/** 图片预览块（blob URL 异步解析） */
function ImageThumb({ assetId, onOpen }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    assetPreviewUrl(assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [assetId])
  if (!url) return <div className="ac-thumb ac-thumb-loading" aria-hidden>…</div>
  return <button type="button" className="ac-thumb" onClick={() => onOpen(assetId)} title="点击放大">
    <img src={url} alt="" draggable={false} />
  </button>
}

/** 声明式参数表单 */
function ParamForm({ def, params, onChange }) {
  return <div className="ac-params">
    {def.params.map(p => {
      if (p.type === 'textarea') {
        return <label key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}</span>
          <textarea
            className="ac-input ac-textarea" rows={p.rows ?? 3} placeholder={p.placeholder ?? ''}
            value={params[p.key] ?? ''} onChange={e => onChange(p.key, e.target.value)}
          />
        </label>
      }
      if (p.type === 'select') {
        return <label key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}</span>
          <select className="ac-input ac-select" value={params[p.key] ?? p.default} onChange={e => onChange(p.key, e.target.value)}>
            {p.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      }
      if (p.type === 'slider') {
        return <label key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}<em className="ac-field-value">{params[p.key] ?? p.default}</em></span>
          <input type="range" className="ac-range" min={p.min} max={p.max} step={p.step}
            value={params[p.key] ?? p.default} onChange={e => onChange(p.key, Number(e.target.value))} />
        </label>
      }
      return null
    })}
  </div>
}

/** imageEdit 无上游时的本地图输入 */
function LocalImagePicker({ localImage, onPick, onClear }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    if (localImage?.assetId) assetPreviewUrl(localImage.assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    else setUrl(localImage?.dataUrl ?? null)
    return () => { alive = false }
  }, [localImage?.assetId, localImage?.dataUrl])
  return <div className="ac-localimg">
    {url
      ? <div className="ac-localimg-row">
          <img className="ac-localimg-thumb" src={url} alt="输入图" draggable={false} />
          <Button size="sm" variant="ghost" onClick={onClear}>清除</Button>
        </div>
      : <div className="ac-localimg-row">
          <Button size="sm" variant="ghost" onClick={onPick}>本地上传 / 粘贴</Button>
        </div>}
  </div>
}

export function RegistryNode({ id, data, selected }) {
  const actions = useContext(CanvasActionsContext)
  const def = getNodeDef(data.type)
  const [open, setOpen] = useState(true)
  const state = data.state || 'idle'
  const images = data.lastRun?.images ?? []
  const textOut = data.lastRun?.outputs?.text
  if (!def) return <div className="ac-node ac-node-unknown">未知节点：{data.type}</div>

  const hasUpstreamImage = def.inputs.some(p => p.kind === 'image' && !p.optional)
  const running = state === 'running'

  return (
    <div className={`ac-node ac-node-${data.type} ${selected ? 'ac-node-selected' : ''} ${running ? 'ac-node-running' : ''} ${state === 'error' ? 'ac-node-error' : ''} ${state === 'success' ? 'ac-node-success' : ''}`}>
      {def.inputs.map(port => (
        <Handle key={`in-${port.key}`} id={port.key} type="target" position={Position.Left}
          className={`ac-handle ac-handle-in ac-handle-${port.kind}`} data-kind={port.kind} isConnectable />
      ))}
      {def.outputs.map(port => (
        <Handle key={`out-${port.key}`} id={port.key} type="source" position={Position.Right}
          className={`ac-handle ac-handle-out ac-handle-${port.kind}`} data-kind={port.kind} isConnectable />
      ))}

      <header className="ac-node-head" onDoubleClick={() => setOpen(o => !o)}>
        <span className="ac-glyph" aria-hidden>{def.glyph}</span>
        <span className="ac-node-title">{def.title}</span>
        <StatusLight state={state} />
        <span className="ac-node-tools">
          {def.protocol && <button type="button" className={`ac-run ${running ? 'ac-run-busy' : ''}`} title={running ? '运行中…' : '运行此节点'}
            onClick={() => actions?.onRunNode(id)} disabled={running || actions?.workflowRunning}>▶</button>}
          <button type="button" className="ac-del" title="删除节点" onClick={() => actions?.onDeleteNodes([id])}>×</button>
        </span>
      </header>

      {open && <>
        {def.inputs.filter(p => p.kind === 'image').length > 0 && !data.hideLocalPick && (
          <LocalImagePicker localImage={data.localImage}
            onPick={() => actions?.onPickLocalImage(id)}
            onClear={() => actions?.onNodeDataChange(id, { localImage: null })} />
        )}
        <ParamForm def={def} params={data.params ?? {}} onChange={(key, value) => actions?.onParamChange(id, key, value)} />
        {data.error && <div className="ac-error" role="alert">{data.error}</div>}
        {textOut && <div className="ac-textout" title={textOut}>{String(textOut)}</div>}
        {images.length > 0 && <div className="ac-thumbs">
          {images.map(img => <ImageThumb key={img.assetId} assetId={img.assetId} onOpen={aid => actions?.onOpenImage(aid)} />)}
        </div>}
        {data.lastRun?.usage?.total_tokens != null && (
          <div className="ac-usage">tokens {data.lastRun.usage.total_tokens}</div>
        )}
      </>}
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
  return { assetId: saved.assetId }
}
