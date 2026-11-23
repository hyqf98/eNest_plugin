import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon.jsx'
import { host } from '../lib/env.js'
import { objectUrlFor, loadImageElement } from '../lib/blobs.js'
import { canvasToBlob, writeBlob } from '../lib/files.js'
import { thumbFromCanvas } from '../lib/media.js'
import { draftFor, loadDrafts, saveDraft } from '../lib/draft.js'
import { EditHistory, clamp, selection } from '../editor/core.js'
import { applyOperation, renderPreview } from '../editor/ops.js'
import { formatDimensions } from '../lib/format.js'

const TOOLS = [
  { id: 'arrow', icon: 'arrow', label: '箭头（A）', key: 'a' },
  { id: 'rect', icon: 'rect', label: '矩形（R）', key: 'r' },
  { id: 'text', icon: 'text', label: '文字（T）', key: 't' },
  { id: 'mosaic', icon: 'mosaic', label: '马赛克（M）', key: 'm' },
  { id: 'crop', icon: 'crop', label: '裁剪（C）', key: 'c' }
]
const COLORS = ['#e45d50', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827']
const WIDTHS = [3, 6, 10]

export function EditorView({ item, library, onClose, onSaved, onPinImage, toast }) {
  const [tool, setTool] = useState('arrow')
  const [color, setColor] = useState(COLORS[0])
  const [lineWidth, setLineWidth] = useState(6)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [meta, setMeta] = useState({ width: item.width || 0, height: item.height || 0 })
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [steps, setSteps] = useState(0)
  const [textBox, setTextBox] = useState(null)
  const [saving, setSaving] = useState(false)

  const imageCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const wrapRef = useRef(null)
  const textRef = useRef(null)
  const original = useRef(null)
  const history = useRef(new EditHistory(40))
  const drawStart = useRef(null)
  const pointerId = useRef(null)
  const draftTimer = useRef(0)
  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const widthRef = useRef(lineWidth)
  toolRef.current = tool
  colorRef.current = color
  widthRef.current = lineWidth

  const syncControls = useCallback(() => {
    setCanUndo(history.current.canUndo)
    setCanRedo(history.current.canRedo)
    setSteps(history.current.cursor)
  }, [])

  const renderCanvas = useCallback(() => {
    const image = original.current
    const canvas = imageCanvasRef.current
    if (!image || !canvas) return
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    for (const operation of history.current.current()) applyOperation(canvas, operation)
    const overlay = overlayCanvasRef.current
    if (overlay) {
      overlay.width = canvas.width
      overlay.height = canvas.height
      overlay.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
    }
    setMeta({ width: canvas.width, height: canvas.height })
    syncControls()
  }, [syncControls])

  useEffect(() => {
    let alive = true
    setReady(false)
    setError('')
    setTextBox(null)
    history.current.clear()
    syncControls()
    void (async () => {
      try {
        await loadDrafts().catch(() => {})
        const draft = draftFor(item.id)
        if (draft) history.current.restore(draft.operations, draft.cursor)
        const entry = await objectUrlFor(item)
        const image = await loadImageElement(entry.url)
        if (!alive) return
        original.current = image
        setReady(true)
        requestAnimationFrame(renderCanvas)
      } catch (reason) {
        if (alive) { setError(String(reason?.message || reason)); setReady(true) }
      }
    })()
    return () => {
      alive = false
      clearTimeout(draftTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  useEffect(() => {
    if (!textBox) return undefined
    const timer = setTimeout(() => textRef.current?.focus(), 20)
    return () => clearTimeout(timer)
  }, [textBox])

  useEffect(() => () => {
    clearTimeout(draftTimer.current)
    void saveDraft(item.id, {
      operations: history.current.operations,
      cursor: history.current.cursor
    }).catch(() => {})
  }, [item.id])

  const scheduleDraft = useCallback(() => {
    clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      void saveDraft(item.id, { operations: history.current.operations, cursor: history.current.cursor }).catch(() => {})
    }, 450)
  }, [item.id])

  const commit = useCallback(operation => {
    if (!history.current.push(operation)) {
      toast('已达到 40 步编辑上限', 'warn')
      return
    }
    renderCanvas()
    scheduleDraft()
  }, [renderCanvas, scheduleDraft, toast])

  const point = event => {
    const canvas = overlayCanvasRef.current
    const rect = canvas.getBoundingClientRect()
    return {
      x: clamp((event.clientX - rect.left) * canvas.width / rect.width, 0, canvas.width),
      y: clamp((event.clientY - rect.top) * canvas.height / rect.height, 0, canvas.height)
    }
  }

  const cancelDraw = useCallback(() => {
    drawStart.current = null
    if (pointerId.current !== null && overlayCanvasRef.current?.hasPointerCapture?.(pointerId.current)) {
      overlayCanvasRef.current.releasePointerCapture(pointerId.current)
    }
    pointerId.current = null
    const overlay = overlayCanvasRef.current
    if (overlay) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height)
  }, [])

  const paintPreview = useCallback(end => {
    const overlay = overlayCanvasRef.current
    if (!overlay || !drawStart.current) return
    renderPreview(overlay.getContext('2d'), toolRef.current, drawStart.current, end, colorRef.current, widthRef.current)
  }, [])

  const onPointerDown = event => {
    if (!ready || !original.current || event.button !== 0 || textBox) return
    if (toolRef.current === 'text') {
      const rect = overlayCanvasRef.current.getBoundingClientRect()
      const wrapRect = wrapRef.current.getBoundingClientRect()
      setTextBox({
        left: event.clientX - wrapRect.left,
        top: event.clientY - wrapRect.top,
        width: Math.max(120, Math.min(360, rect.width * 0.5)),
        point: point(event),
        value: ''
      })
      return
    }
    drawStart.current = point(event)
    pointerId.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = event => {
    if (drawStart.current) paintPreview(point(event))
  }

  const onPointerUp = event => {
    if (!drawStart.current) return
    const end = point(event)
    const start = drawStart.current
    const canvas = imageCanvasRef.current
    const box = selection(start, end, canvas.width, canvas.height)
    const toolNow = toolRef.current
    cancelDraw()
    if (toolNow === 'arrow' && Math.hypot(start.x - end.x, start.y - end.y) > 3) {
      commit({ type: 'arrow', start, end, color: colorRef.current, lineWidth: widthRef.current })
    } else if (toolNow !== 'arrow' && toolNow !== 'text' && box.width >= 3 && box.height >= 3) {
      commit({ type: toolNow, ...box, color: colorRef.current, lineWidth: widthRef.current })
    }
  }

  const commitText = () => {
    if (!textBox) return
    const value = textBox.value.trim()
    const target = textBox
    setTextBox(null)
    if (!value) return
    commit({
      type: 'text',
      x: target.point.x,
      y: target.point.y,
      text: value,
      color: colorRef.current,
      size: 32
    })
  }

  const undo = () => { history.current.undo(); renderCanvas(); scheduleDraft() }
  const redo = () => { history.current.redo(); renderCanvas(); scheduleDraft() }

  useEffect(() => {
    const onKey = event => {
      if (event.isComposing) return
      if (event.target.closest?.('input, textarea')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const found = TOOLS.find(entry => entry.key === event.key.toLowerCase())
        if (found) { event.preventDefault(); setTool(found.id) }
      }
      if (event.key === 'Escape') cancelDraw()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderCanvas])

  const long = meta.width > 0 && meta.height > meta.width * 2.2
  const currentDataUrl = () => imageCanvasRef.current.toDataURL('image/png')

  const copy = async () => {
    try {
      await host.clipboard.writeImage(currentDataUrl())
      toast('已复制图片', 'success')
    } catch (reason) { toast(String(reason?.message || reason), 'error') }
  }

  const pin = () => {
    try { onPinImage(currentDataUrl(), `${item.name} 标注`) } catch (reason) { toast(String(reason?.message || reason), 'error') }
  }

  const saveAs = async () => {
    if (saving) return
    setSaving(true)
    try {
      const canvas = imageCanvasRef.current
      const blob = await canvasToBlob(canvas, 'image/png')
      const file = await writeBlob(blob, 'png')
      const thumb = thumbFromCanvas(canvas, { topCrop: canvas.height > canvas.width * 2.2 })
      const saved = await library.addSaved({
        kind: 'image',
        fileId: file.id,
        ext: 'png',
        thumb,
        name: `${item.name} 标注`,
        width: canvas.width,
        height: canvas.height,
        bytes: file.size,
        source: 'edit',
        originId: item.id
      })
      toast('已另存为新的截图', 'success')
      onSaved(saved)
    } catch (reason) {
      toast(String(reason?.message || reason), 'error')
    } finally {
      setSaving(false)
    }
  }

  const exportImage = async () => {
    try {
      const blob = await canvasToBlob(imageCanvasRef.current, 'image/png')
      const file = await writeBlob(blob, 'png')
      try {
        const result = await host.storage.files.export(file.id, { defaultName: `${item.name}.png` })
        if (result?.ok) toast('已导出', 'success')
      } finally {
        await host.storage.files.remove(file.id).catch(() => {})
      }
    } catch (reason) { toast(String(reason?.message || reason), 'error') }
  }

  const close = async () => {
    clearTimeout(draftTimer.current)
    await saveDraft(item.id, {
      operations: history.current.operations,
      cursor: history.current.cursor
    }).catch(() => {})
    onClose()
  }

  const reset = () => {
    history.current.clear()
    renderCanvas()
    void saveDraft(item.id, null).catch(() => {})
  }

  return (
    <div className="sa-editor">
      <div className="sa-ed-head">
        <button type="button" className="sa-icon-btn" aria-label="返回" title="返回" onClick={() => { void close() }}><Icon name="left" /></button>
        <span className="sa-ed-name">{item.name}</span>
        <span className="sa-ed-state sa-mono">
          {formatDimensions(meta.width, meta.height)}{steps ? ` · ${steps} 步` : ''}
        </span>
        <button type="button" className="sa-icon-btn text" onClick={reset} disabled={!steps}>恢复原图</button>
      </div>

      <div className="sa-ed-stage">
        {!ready ? <div className="sa-ed-loading"><span className="sa-spinner" /> 正在打开图片…</div> : null}
        {error ? <div className="sa-ed-empty">{error}</div> : null}
        <div className={`sa-canvas-wrap${long ? ' long' : ''}`} ref={wrapRef} style={ready && !error ? undefined : { display: 'none' }}>
          <canvas ref={imageCanvasRef} className="sa-canvas-image" aria-label="截图预览" />
          <canvas
            ref={overlayCanvasRef}
            className="sa-canvas-overlay"
            data-tool={tool}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={cancelDraw}
          />
          {textBox ? (
            <input
              ref={textRef}
              className="sa-text-editor"
              style={{ left: textBox.left, top: textBox.top, width: textBox.width }}
              value={textBox.value}
              placeholder="输入文字"
              onChange={event => setTextBox(prev => (prev ? { ...prev, value: event.target.value } : prev))}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); commitText() }
                else if (event.key === 'Escape') { event.preventDefault(); setTextBox(null) }
              }}
              onBlur={commitText}
            />
          ) : null}
        </div>
      </div>

      <div className="sa-ed-toolbar" role="toolbar" aria-label="标注工具">
        {TOOLS.map(entry => (
          <button
            key={entry.id}
            type="button"
            className="sa-tool"
            data-active={tool === entry.id}
            title={entry.label}
            aria-label={entry.label}
            onClick={() => { setTool(entry.id); if (entry.id === 'text') setTextBox(null) }}
          >
            <Icon name={entry.icon} />
          </button>
        ))}
        <span className="sa-sep" />
        <span className="sa-swatches">
          {COLORS.map(value => (
            <button
              key={value}
              type="button"
              className="sa-swatch"
              data-active={color === value}
              style={{ background: value }}
              aria-label={`颜色 ${value}`}
              onClick={() => setColor(value)}
            />
          ))}
          <label className="sa-swatch custom" title="自定义颜色">
            <input type="color" value={color} onChange={event => setColor(event.target.value)} aria-label="自定义颜色" />
          </label>
        </span>
        <span className="sa-widths">
          {WIDTHS.map(value => (
            <button key={value} type="button" className="sa-width" data-active={lineWidth === value} title={`粗细 ${value}`} onClick={() => setLineWidth(value)}>
              <i style={{ height: value }} />
            </button>
          ))}
        </span>
        <span className="sa-sep" />
        <button type="button" className="sa-tool" disabled={!canUndo} title="撤销（⌘/Ctrl Z）" onClick={undo}><Icon name="undo" /></button>
        <button type="button" className="sa-tool" disabled={!canRedo} title="重做（⌘/Ctrl Shift Z）" onClick={redo}><Icon name="redo" /></button>
        <span className="sa-sep" />
        <button type="button" className="sa-tool" title="复制" aria-label="复制" onClick={copy}><Icon name="copy" /></button>
        <button type="button" className="sa-tool" title="贴到桌面" aria-label="贴到桌面" onClick={pin}><Icon name="pin" /></button>
        <button type="button" className="sa-tool" title="另存为新截图" aria-label="另存为新截图" disabled={saving} onClick={saveAs}><Icon name="save" /></button>
        <button type="button" className="sa-ed-primary" disabled={saving} onClick={exportImage}>导出</button>
      </div>
    </div>
  )
}
