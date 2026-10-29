/**
 * RegistryNode — 注册表驱动的通用节点组件（所有业务节点共用一个）。
 *
 * 端口、参数表单、状态、输出预览全部按 nodeRegistry 的 def 渲染：
 *   - 输出预览遍历 def.outputs 按 kind 分派；文本可放大为 markdown 预览
 *   - textarea 参数可放大为编辑弹窗（编辑 + markdown 预览 + 变量引用）
 *   - 单节点运行按钮判 def.runnable（与 def.protocol 是否走网络解耦）
 *   - 端口 Handle 按数量纵向对称分布，单口居中
 *   - 文本参数可插 {{#节点.端口#}} 变量引用（acceptsVariable）
 * 交互回调经 CanvasActionsContext 注入，避免 React Flow 闭包陈旧。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { getNodeDef } from '../../js/nodeRegistry.mjs'
import { PORT_KIND, PARAM_TYPE, summarizeParam } from '../../js/nodeSchema.mjs'
import { renderMarkdownLite } from '../../js/markdownLite.mjs'
import { assetPreviewUrl, saveAsset } from '../../js/assets.mjs'
import { fromDataUrl } from '../../js/netFetch.mjs'
import { Button } from '../../ui/index.jsx'
import { PromptEditor } from '../PromptEditor.jsx'

export const CanvasActionsContext = createContext(null)

/** 图片预览块：blob URL 异步解析；悬停浮出大图（ComfyUI 手感），点击进灯箱 */
function ImageThumb({ assetId, onOpen, large = false }) {
  const [url, setUrl] = useState(null)
  const [hoverAt, setHoverAt] = useState(null)
  useEffect(() => {
    let alive = true
    assetPreviewUrl(assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [assetId])
  if (!url) return <div className={`ac-thumb ${large ? 'ac-thumb-lg' : ''} ac-thumb-loading`} aria-hidden>…</div>
  return <>
    <button type="button" className={`ac-thumb ${large ? 'ac-thumb-lg' : ''}`}
      onClick={() => onOpen(assetId)} title="点击放大"
      onMouseEnter={e => {
        const r = e.currentTarget.getBoundingClientRect()
        setHoverAt({ x: r.right + 10, y: Math.max(12, r.top - 60) })
      }}
      onMouseLeave={() => setHoverAt(null)}>
      <img src={url} alt="" draggable={false} />
    </button>
    {hoverAt && (
      <span className="ac-thumb-zoom" style={{ left: hoverAt.x, top: hoverAt.y }} aria-hidden>
        <img src={url} alt="" draggable={false} />
      </span>
    )}
  </>
}

/**
 * 端口纵向位置：按该侧端口总数居中对称分布（百分比，随节点高度自适应）。
 * 单口 → 50%；双口 → 34%/66%；三口 → 25%/50%/75%。连线锚点与可见圆点同一盒子。
 */
function handleTopStyle(index, count) {
  if (count <= 1) return { top: '50%' }
  const step = 32 / (count - 1)
  return { top: `${34 + index * step}%` }
}

/** 放大按钮：编辑弹窗 / markdown 预览 */
function ExpandButton({ onOpen, label = '放大编辑' }) {
  return <button type="button" className="ac-varbtn" title={label}
    onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.preventDefault(); e.stopPropagation(); onOpen() }}>⛶</button>
}

/**
 * 声明式参数表单：按 def.params 分派控件类型。
 * 文本参数（acceptsVariable）走 PromptEditor：@ 呼出变量选择器，引用显示为内联 chip。
 */
function ParamForm({ def, params, nodeId, onChange, onPickImage, onPickDirectory, onExpandText, ctx }) {
  return <div className="ac-params">
    {def.params.map(p => {
      const value = params[p.key]
      if (p.type === PARAM_TYPE.TEXTAREA || p.type === PARAM_TYPE.TEXT) {
        const multiline = p.type === PARAM_TYPE.TEXTAREA
        const promptLike = multiline && p.acceptsVariable
        // 用 div 不用 label：label 会把点击代理给内部第一个 button（⛶），
        // 导致"点输入框"直接弹出放大编辑。
        return <div key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}
            {multiline && <ExpandButton onOpen={() => onExpandText(p, String(value ?? ''))} />}
          </span>
          {promptLike
            ? <PromptEditor value={String(value ?? '')}
                placeholder={`${p.placeholder ?? ''}（@ 引用上游文本/图片）`}
                nodes={ctx.nodes} edges={ctx.edges} nodeId={nodeId} getOutputs={ctx.getOutputs}
                onChange={next => onChange(p.key, next)} />
            : multiline
              ? <textarea className="ac-input ac-textarea nodrag" rows={p.rows ?? 3} placeholder={p.placeholder ?? ''}
                  value={value ?? ''} onChange={e => onChange(p.key, e.target.value)} />
              : <input className="ac-input nodrag" type="text" placeholder={p.placeholder ?? ''}
                  value={value ?? ''} onChange={e => onChange(p.key, e.target.value)} />}
        </div>
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
                <ImageThumb assetId={value.assetId} large onOpen={() => onPickImage(p, value.assetId)} />
                <Button size="sm" variant="ghost" onClick={() => onChange(p.key, null)}>清除</Button>
              </div>
            : <Button size="sm" variant="ghost" onClick={() => onPickImage(p)}>选择图片 / 从画廊拖入</Button>}
        </div>
      }
      if (p.type === PARAM_TYPE.DIRECTORY) {
        return <div key={p.key} className="ac-field">
          <span className="ac-field-label">{p.label}</span>
          {value?.handleId
            ? <div className="ac-localimg-row">
                <span className="ac-dirpath" title={value.displayPath || value.handleId}>📁 {value.displayPath || '已选择'}</span>
                <Button size="sm" variant="ghost" onClick={() => onPickDirectory(p)}>更改</Button>
                <Button size="sm" variant="ghost" onClick={() => onChange(p.key, null)}>清除</Button>
              </div>
            : <Button size="sm" variant="ghost" onClick={() => onPickDirectory(p)}>选择文件夹…</Button>}
        </div>
      }
      return null
    })}
  </div>
}

/** 文本输出预览：点击 ⛶ 放大为 markdown 渲染视图 */
function TextOut({ text, onPreview }) {
  return <div className="ac-textout ac-textout-row" title={text}>
    <span className="ac-textout-body">{text}</span>
    <ExpandButton label="放大预览" onOpen={() => onPreview(text)} />
  </div>
}

/** 输出预览：按端口 kind 分派，不写死 key */
function OutputPreview({ def, lastRun, actions, onPreviewText }) {
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
          <div className="ac-thumbs">{list.map((img, i) => <ImageThumb key={`${img.assetId}-${i}`} assetId={img.assetId} onOpen={aid => actions?.onOpenImage(aid)} />)}</div>
        </div>
      }
      if (port.kind === PORT_KIND.JSON) {
        return <pre key={port.key} className="ac-json">{JSON.stringify(value, null, 2)}</pre>
      }
      const text = String(value)
      if (!text) return null
      return <TextOut key={port.key} text={text} onPreview={onPreviewText} />
    })}
    {lastRun.display?.images?.length > 0 && (
      <div className="ac-thumbs ac-final">
        {lastRun.display.images.map((img, i) => <ImageThumb key={`${img.assetId}-${i}`} assetId={img.assetId} large onOpen={aid => actions?.onOpenImage(aid)} />)}
      </div>
    )}
    {lastRun.display?.saved?.length > 0 && (
      <div className="ac-saved" title={lastRun.display.saved.join('\n')}>
        ✓ 已保存 {lastRun.display.saved.length} 张{lastRun.display.skipped?.length ? ` · 跳过 ${lastRun.display.skipped.length} 张` : ''}
      </div>
    )}
  </div>
}

/** 放大弹窗：编辑（@ 引用 + markdown 预览）或只读预览 */
function ExpandDialog({ state, onClose, onChange, nodeId, ctx }) {
  const [draft, setDraft] = useState(state.value ?? '')
  const [showMd, setShowMd] = useState(state.mode === 'preview')
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const isEdit = state.mode === 'edit'
  const save = () => { onChange(state.paramKey, draft); onClose() }

  return (
    <div className="ac-expand-scrim" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ac-expand" role="dialog" aria-modal="true" aria-label={state.title}>
        <header className="ac-expand-head">
          <span className="ac-node-title">{state.title}</span>
          <span className="ac-expand-actions">
            <button type="button" className={`ac-run ac-expand-toggle ${showMd ? 'ac-expand-on' : ''}`}
              title="Markdown 预览" onClick={() => setShowMd(s => !s)}>M↓</button>
            <button type="button" className="ac-del" title="关闭" onClick={onClose}>×</button>
          </span>
        </header>
        <div className="ac-expand-body">
          {isEdit && !showMd && (
            <PromptEditor value={draft} placeholder={state.placeholder ?? ''}
              className="ac-expand-textarea"
              nodes={ctx.nodes} edges={ctx.edges} nodeId={nodeId} getOutputs={ctx.getOutputs}
              onChange={setDraft} />
          )}
          {showMd && (
            <div className="ac-md" dangerouslySetInnerHTML={{ __html: renderMarkdownLite(isEdit ? draft : state.value) }} />
          )}
          {isEdit && (
            <footer className="ac-expand-foot">
              <span className="ac-expand-hint">{draft.length} 字 · @ 引用上游 · Esc 取消</span>
              <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
              <Button size="sm" variant="primary" onClick={save}>保存</Button>
            </footer>
          )}
        </div>
      </div>
    </div>
  )
}

export function RegistryNode({ id, data, selected }) {
  const actions = useContext(CanvasActionsContext)
  const def = getNodeDef(data.type)
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [dropHover, setDropHover] = useState(false)
  const areaRef = useRef(null)
  const running = data.state === 'running'

  if (!def) return <div className="ac-node ac-node-unknown">未知节点：{data.type}</div>

  const title = data.title || def.title
  const edges = actions?.graphRef?.current?.edges ?? []
  const promptCtx = {
    nodes: actions?.graphRef?.current?.nodes ?? [], edges,
    getOutputs: actions?.getOutputs
  }

  /** 必需输入是否有着落（有入边 / 有本地兜底），决定运行按钮是否出现 */
  const requiredReady = def.inputs
    .filter(port => port.optional === false)
    .every(port => {
      if (edges.some(e => e.target === id && e.targetHandle === port.key)) return true
      if (port.kind === PORT_KIND.IMAGE) return !!data.localImage?.assetId || !!data.params?.[port.key]?.assetId
      return !!String(data.params?.[port.key] ?? '').trim()
    })
  const canRun = def.runnable && requiredReady

  const openExpandText = (param, value) => setExpanded({
    mode: 'edit', paramKey: param.key, title: `${def.title} · ${param.label}`,
    value, placeholder: param.placeholder ?? ''
  })

  const previewText = (text) => setExpanded({ mode: 'preview', title: `${def.title} · 输出预览`, value: text })

  const pickImage = async (param, assetId) => {
    // 已选图时点击缩略图 = 看大图
    if (assetId) { actions?.onOpenImage(assetId); return }
    try {
      const ref = await actions?.onPickLocalImageParam(id, param.key)
      if (ref) actions?.onParamChange(id, param.key, ref)
    } catch { /* 用户取消 */ }
  }

  const pickDirectory = async (param) => {
    try {
      const dir = await actions?.onPickDirectory(id, param.key)
      if (dir) actions?.onParamChange(id, param.key, dir)
    } catch { /* 用户取消 */ }
  }

  /** 画廊拖入：有 IMAGE 参数就写参数，否则落到 data.localImage（图片输入兜底） */
  const imageParam = def.params.find(p => p.type === PARAM_TYPE.IMAGE)
  const onDragOver = e => {
    if (!e.dataTransfer.types.includes('application/x-ai-canvas-asset')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropHover) setDropHover(true)
  }
  const onDragLeave = () => setDropHover(false)
  const onDrop = e => {
    const assetId = e.dataTransfer.getData('application/x-ai-canvas-asset')
    if (!assetId) return
    e.preventDefault()
    e.stopPropagation()
    setDropHover(false)
    if (imageParam) actions?.onParamChange(id, imageParam.key, { assetId })
    else if (def.inputs.some(p => p.kind === PORT_KIND.IMAGE)) actions?.onNodeDataChange(id, { localImage: { assetId } })
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
      open ? '' : 'ac-node-collapsed',
      dropHover ? 'ac-node-drop' : ''
    ].filter(Boolean).join(' ')}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {/* 端口合一：小圆点即命中区——拖它连线，单击弹节点选择器（hover 时点内浮现 ＋）。 */}
      {def.inputs.map((port, index) => (
        <Handle key={`in-${port.key}`} id={port.key} type="target" position={Position.Left}
          style={handleTopStyle(index, def.inputs.length)}
          className={`ac-handle ac-handle-in ac-handle-${port.kind} ${addable ? 'ac-handle-addable' : ''}`} data-kind={port.kind}
          onClick={addable ? (e => { e.stopPropagation(); actions.onHandleAddNode({ nodeId: id, portKey: port.key, side: 'target', handleId: port.key }, { x: e.clientX, y: e.clientY }) }) : undefined}>
          {addable && <span className="ac-handle-plus" aria-hidden>＋</span>}
        </Handle>
      ))}
      {def.outputs.map((port, index) => (
        <Handle key={`out-${port.key}`} id={port.key} type="source" position={Position.Right}
          style={handleTopStyle(index, def.outputs.length)}
          className={`ac-handle ac-handle-out ac-handle-${port.kind} ${addable ? 'ac-handle-addable' : ''}`} data-kind={port.kind}
          onClick={addable ? (e => { e.stopPropagation(); actions.onHandleAddNode({ nodeId: id, portKey: port.key, side: 'source', handleId: port.key }, { x: e.clientX, y: e.clientY }) }) : undefined}>
          {addable && <span className="ac-handle-plus" aria-hidden>＋</span>}
        </Handle>
      ))}

      <header className="ac-node-head" onDoubleClick={e => {
        if (e.target.closest('.ac-node-title')) return
        setOpen(o => !o)
      }}>
        <span className="ac-glyph" aria-hidden>{def.glyph}</span>
        {editingTitle
          ? <input className="ac-title-input" autoFocus value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={() => { actions?.onNodeDataChange(id, { title: titleDraft.trim() }); setEditingTitle(false) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { actions?.onNodeDataChange(id, { title: titleDraft.trim() }); setEditingTitle(false) }
                if (e.key === 'Escape') setEditingTitle(false)
              }} />
          : <span className="ac-node-title" title={`${def.description || def.title}（双击改名）`}
              onDoubleClick={e => { e.stopPropagation(); setTitleDraft(title); setEditingTitle(true) }}>{title}</span>}
        <span className="ac-node-tools">
          {canRun && <button type="button" className={`ac-run ${running ? 'ac-run-busy' : ''}`}
            title={running ? '运行中…' : '运行此节点'} disabled={running || actions?.workflowRunning}
            onClick={() => actions?.onRunNode(id)}>▶</button>}
          <button type="button" className="ac-del" title="删除节点" onClick={() => actions?.onDeleteNodes([id])}>×</button>
        </span>
      </header>

      {open ? <>
        <ParamForm def={def} params={data.params ?? {}} nodeId={id} ctx={promptCtx}
          onChange={(key, value) => actions?.onParamChange(id, key, value)}
          onPickImage={pickImage} onPickDirectory={pickDirectory} onExpandText={openExpandText} />
        {data.error && <div className="ac-error" role="alert">{data.error}</div>}
        {data.warnings?.length > 0 && <div className="ac-warning">{data.warnings.join('；')}</div>}
        <OutputPreview def={def} lastRun={data.lastRun} actions={actions} onPreviewText={previewText} />
        {data.lastRun?.usage?.total_tokens != null && (
          <div className="ac-usage">
            {data.lastRun.durationMs ? `${(data.lastRun.durationMs / 1000).toFixed(1)}s · ` : ''}
            tokens {data.lastRun.usage.total_tokens}
          </div>
        )}
      </> : <div className="ac-node-summary">{summary}</div>}

      {expanded && (
        <ExpandDialog state={expanded} nodeId={id} ctx={promptCtx}
          onClose={() => setExpanded(null)}
          onChange={(key, value) => actions?.onParamChange(id, key, value)} />
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
