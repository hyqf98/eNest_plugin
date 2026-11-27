import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon.jsx'
import { Empty } from '../components/Empty.jsx'
import { host } from '../lib/env.js'
import { base64ToBytes, blobToDataUrl, canvasToBlob, writeBlob } from '../lib/files.js'
import { thumbFromImage } from '../lib/media.js'
import { formatBytes, stampName } from '../lib/format.js'
import {
  EXPORT_PRESETS, FORMAT_LABEL, SUPPORTED_MIME, WATERMARK_SLOTS,
  applyTransform as applyTransformCanvas, batchName, batchProgress, compressToTarget, eraseRegion,
  exifSummary, formatBytes as coreFormatBytes, paletteFromPixels,
  parseExif, scaleSize, transformPlan, watermarkAnchor, watermarkStyle, yieldFrame
} from '../tools/image-core.js'

const TOOLS = [
  { id: 'compress', icon: 'compress', label: '压缩' },
  { id: 'convert', icon: 'convert', label: '格式' },
  { id: 'resize', icon: 'resize', label: '缩放' },
  { id: 'transform', icon: 'transform', label: '旋转', hint: '旋转与裁剪' },
  { id: 'watermark', icon: 'watermark', label: '水印' },
  { id: 'exif', icon: 'exif', label: 'EXIF' },
  { id: 'palette', icon: 'palette', label: '色板' }
]

const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
const ACCEPT = ['.png', '.jpg', '.jpeg', '.webp']

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (image.naturalWidth * image.naturalHeight > 64_000_000) reject(new Error('图片需小于 6400 万像素'))
      else resolve(image)
    }
    image.onerror = () => reject(new Error('图片无法读取，可能是不支持的格式'))
    image.src = src
  })
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || file.size > 32 * 1024 * 1024) { reject(new Error(`${file?.name || '文件'} 超过 32 MB`)); return }
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`${file.name || '文件'} 读取失败`))
    reader.readAsDataURL(file)
  })
}

function drawScaled(image, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

async function queueItemFromDataUrl(dataUrl, name) {
  const image = await loadImage(dataUrl)
  const mime = /^data:([^;]+)/.exec(dataUrl)?.[1] || 'image/png'
  if (!SUPPORTED_MIME.includes(mime)) throw new Error(`不支持的格式：${mime}`)
  return {
    id: uid(),
    name: String(name || '图片').slice(0, 100),
    mime,
    dataUrl,
    bytes: Math.round(dataUrl.length * 0.75),
    width: image.naturalWidth,
    height: image.naturalHeight,
    image,
    thumb: thumbFromImage(image, { maxEdge: 200 })
  }
}

export function ToolsView({ incoming, library, onPinImage, toast }) {
  const [queue, setQueue] = useState([])
  const [activeId, setActiveId] = useState('')
  const [tool, setTool] = useState('compress')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [dropActive, setDropActive] = useState(false)

  const [compressMode, setCompressMode] = useState('target')
  const [targetKb, setTargetKb] = useState(200)
  const [quality, setQuality] = useState(75)
  const [convertFormat, setConvertFormat] = useState('image/jpeg')
  const [convertQuality, setConvertQuality] = useState(90)
  const [resizeMode, setResizeMode] = useState('long')
  const [resizeValue, setResizeValue] = useState(1280)
  const [rotate, setRotate] = useState(0)
  const [flipX, setFlipX] = useState(false)
  const [flipY, setFlipY] = useState(false)
  const [crop, setCrop] = useState(null)
  const [cropBox, setCropBox] = useState(null)
  const [wmText, setWmText] = useState('')
  const [wmSlot, setWmSlot] = useState('bottom-right')
  const [wmOpacity, setWmOpacity] = useState(80)
  const [wmSize, setWmSize] = useState(28)
  const [wmPreviewSrc, setWmPreviewSrc] = useState('')
  const [exifRows, setExifRows] = useState(null)
  const [exifBusy, setExifBusy] = useState(false)
  const [palette, setPalette] = useState(null)
  const [paletteBusy, setPaletteBusy] = useState(false)

  const busyRef = useRef(false)
  const fileInputRef = useRef(null)
  const boardRef = useRef(null)
  const dragRef = useRef(null)
  const queueRef = useRef(queue)
  queueRef.current = queue

  const active = useMemo(() => queue.find(item => item.id === activeId) || null, [queue, activeId])
  const activeRef = useRef(active)
  activeRef.current = active
  const boardSrc = wmPreviewSrc && tool === 'watermark' ? wmPreviewSrc : active?.dataUrl
  const locked = busy || dragging

  const run = useCallback(async fn => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await fn()
    } catch (error) {
      toast(String(error?.message || error), 'error')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [toast])

  const addItems = useCallback(async rows => {
    if (!rows.length) return
    const added = []
    for (const row of rows) {
      try { added.push(await queueItemFromDataUrl(row.dataUrl, row.name)) }
      catch (error) { toast(String(error?.message || error), 'error') }
    }
    if (!added.length) return
    setQueue(prev => [...added, ...prev].slice(0, 24))
    setActiveId(prev => prev || added[0].id)
  }, [toast])

  const importDataUrls = useCallback(rows => run(() => addItems(rows)), [addItems, run])

  useEffect(() => {
    if (!incoming?.seq || !incoming.images?.length) return
    void importDataUrls(incoming.images)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq])

  const pickFiles = () => void run(async () => {
    const handles = await host.localFiles.pick({ kind: 'file', multiple: true, access: 'read' })
    const rows = []
    for (const handle of handles || []) {
      try {
        const dataUrl = await host.localFiles.read({ handleId: handle.id, encoding: 'dataUrl' })
        rows.push({ dataUrl, name: handle.name })
      } catch (error) {
        toast(`${handle.name}：${error.message}`, 'error')
      }
    }
    await addItems(rows)
  })

  const paste = () => void run(async () => {
    const image = await host.clipboard.readImage()
    if (!image?.dataUrl) throw new Error('剪贴板中没有图片')
    await addItems([{ dataUrl: image.dataUrl, name: `剪贴板图片 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` }])
  })

  const onDrop = event => {
    event.preventDefault()
    setDropActive(false)
    const files = Array.from(event.dataTransfer?.files || []).filter(file => ACCEPT.some(ext => file.name.toLowerCase().endsWith(ext)))
    if (!files.length) return
    void run(async () => {
      const rows = []
      for (const file of files) {
        try { rows.push({ dataUrl: await readFileDataUrl(file), name: file.name }) }
        catch (error) { toast(error.message, 'error') }
      }
      await addItems(rows)
    })
  }

  const removeItem = id => {
    setQueue(prev => {
      const next = prev.filter(item => item.id !== id)
      if (activeId === id) setActiveId(next[0]?.id || '')
      return next
    })
  }

  useEffect(() => {
    setResult(null)
    setCrop(null)
    setCropBox(null)
    setRotate(0)
    setFlipX(false)
    setFlipY(false)
    setWmPreviewSrc('')
    setExifRows(null)
    setPalette(null)
  }, [activeId])

  useEffect(() => {
    if (!active) return
    if (tool === 'exif' && exifRows === null && !exifBusy) {
      setExifBusy(true)
      try {
        const summary = exifSummary(parseExif(base64ToBytes(active.dataUrl)))
        setExifRows(Object.entries(summary))
      } catch {
        setExifRows([])
      } finally {
        setExifBusy(false)
      }
    }
    if (tool === 'palette' && palette === null && !paletteBusy) {
      setPaletteBusy(true)
      try {
        const width = Math.min(120, active.width)
        const height = Math.max(1, Math.round(width * active.height / active.width))
        const canvas = drawScaled(active.image, width, height)
        setPalette(paletteFromPixels(canvas.getContext('2d').getImageData(0, 0, width, height).data, 6))
      } catch {
        setPalette([])
      } finally {
        setPaletteBusy(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, active?.id, exifRows, palette])

  const publishResult = async (canvas, mime, quality, label) => {
    const blob = await canvasToBlob(canvas, mime, quality)
    const dataUrl = await blobToDataUrl(blob)
    setResult({
      blob,
      dataUrl,
      mime,
      bytes: blob.size,
      width: canvas.width,
      height: canvas.height,
      label,
      before: active?.bytes || 0
    })
  }

  const baseCanvas = () => drawScaled(active.image, active.width, active.height)

  const applyCompress = () => void run(async () => {
    if (!active) return
    const canvas = baseCanvas()
    const mime = active.mime === 'image/png' ? 'image/jpeg' : active.mime
    if (compressMode === 'target') {
      const found = await compressToTarget({
        encode: async value => {
          const blob = await canvasToBlob(canvas, mime, value)
          return { blob, bytes: blob.size }
        },
        targetBytes: Math.max(20, targetKb) * 1024
      })
      if (!found) throw new Error('压缩失败')
      const dataUrl = await blobToDataUrl(found.blob)
      setResult({
        blob: found.blob, dataUrl, mime, bytes: found.bytes,
        width: canvas.width, height: canvas.height,
        label: `压缩到 ${coreFormatBytes(found.bytes)}${found.saturated ? '（已达最高质量）' : ''}`,
        before: active.bytes
      })
    } else {
      await publishResult(canvas, mime, quality / 100, `质量 ${quality}%`)
    }
  })

  const applyConvert = () => void run(async () => {
    if (!active) return
    await publishResult(baseCanvas(), convertFormat, convertQuality / 100, `转为 ${FORMAT_LABEL[convertFormat]}`)
  })

  const applyResize = () => void run(async () => {
    if (!active) return
    const size = scaleSize(active.width, active.height, resizeMode, resizeValue)
    const canvas = drawScaled(active.image, size.width, size.height)
    await publishResult(canvas, active.mime, 0.92, `缩放到 ${size.width}×${size.height}`)
  })

  const previewResize = () => {
    if (!active) return
    try {
      const size = scaleSize(active.width, active.height, resizeMode, resizeValue)
      setProgress(`${active.width}×${active.height} → ${size.width}×${size.height}`)
    } catch (error) { toast(error.message, 'error') }
  }

  const applyPreset = preset => {
    if (!active) return
    if (preset.id === 'original') { setResizeValue(Math.max(active.width, active.height)); setResizeMode('long'); return }
    setResizeMode('long')
    setResizeValue(preset.id === 'icon' ? 256 : preset.id === 'cover' ? 1200 : preset.id === 'hd' ? 1280 : 1920)
  }

  const applyRotateFlip = () => void run(async () => {
    if (!active) return
    const plan = transformPlan({ rotate, flipX, flipY, width: active.width, height: active.height })
    const canvas = document.createElement('canvas')
    canvas.width = plan.width
    canvas.height = plan.height
    applyTransformCanvas(canvas.getContext('2d'), active.image, plan, flipX, flipY)
    await publishResult(canvas, active.mime, 0.95, `旋转 ${rotate}°${flipX ? ' · 水平翻转' : ''}${flipY ? ' · 垂直翻转' : ''}`)
  })

  const applyCrop = () => void run(async () => {
    if (!active || !crop || crop.width < 2 || crop.height < 2) return
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(crop.width)
    canvas.height = Math.round(crop.height)
    canvas.getContext('2d').drawImage(active.image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
    await publishResult(canvas, active.mime, 0.95, `裁剪 ${canvas.width}×${canvas.height}`)
    setCrop(null)
    setCropBox(null)
  })

  const eraseSelection = () => void run(async () => {
    if (!active || !crop || crop.width < 2 || crop.height < 2) return
    const canvas = baseCanvas()
    eraseRegion(canvas.getContext('2d'), crop, canvas.width, canvas.height)
    await publishResult(canvas, 'image/png', undefined, '删除选区内容')
    setCrop(null)
    setCropBox(null)
  })

  const drawWatermark = (canvas, text) => {
    const { alpha, size } = watermarkStyle({ opacity: wmOpacity, fontSize: wmSize })
    const ctx = canvas.getContext('2d')
    const anchor = watermarkAnchor(wmSlot)
    const padding = Math.max(12, Math.round(canvas.width * 0.02))
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.font = `600 ${size}px -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
    const metrics = ctx.measureText(text)
    const x = anchor.x === 0 ? padding : anchor.x === 0.5 ? (canvas.width - metrics.width) / 2 : canvas.width - metrics.width - padding
    const y = anchor.y === 0 ? padding : anchor.y === 0.5 ? canvas.height / 2 - size / 2 : canvas.height - size - padding
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(0,0,0,.35)'
    ctx.fillText(text, x + 2, y + 2)
    ctx.fillStyle = '#fff'
    ctx.fillText(text, x, y)
    ctx.restore()
  }

  const applyWatermark = () => void run(async () => {
    if (!active) return
    const text = wmText.trim()
    if (!text) throw new Error('请输入水印文字')
    const canvas = baseCanvas()
    drawWatermark(canvas, text)
    await publishResult(canvas, active.mime, 0.95, `水印「${text.slice(0, 12)}」`)
  })

  const toggleWatermarkPreview = () => {
    if (!active) return
    if (wmPreviewSrc) { setWmPreviewSrc(''); return }
    const text = wmText.trim()
    if (!text) { toast('请输入水印文字', 'info'); return }
    const canvas = baseCanvas()
    drawWatermark(canvas, text)
    setWmPreviewSrc(canvas.toDataURL('image/png'))
  }

  const stripExif = () => void run(async () => {
    if (!active) return
    await publishResult(baseCanvas(), 'image/png', undefined, '已重绘剥离元数据')
  })

  const copyHex = async hex => {
    try { await host.clipboard.writeText(hex); toast(`已复制 ${hex}`, 'success') } catch (error) { toast(error.message, 'error') }
  }

  const saveResult = () => void run(async () => {
    if (!result || !active) return
    const ext = result.mime === 'image/webp' ? 'webp' : result.mime === 'image/jpeg' ? 'jpg' : 'png'
    const file = await writeBlob(result.blob, ext)
    const saved = await library.addSaved({
      kind: 'image',
      fileId: file.id,
      ext,
      thumb: await thumbFromImage(await loadImage(result.dataUrl), { maxEdge: 320 }),
      name: `${active.name} · ${result.label}`,
      width: result.width,
      height: result.height,
      bytes: file.size,
      source: 'tool'
    })
    toast(`已保存到媒体库${saved ? '' : ''}`, 'success')
  })

  const exportResult = () => void run(async () => {
    if (!result) return
    const ext = result.mime === 'image/webp' ? 'webp' : result.mime === 'image/jpeg' ? 'jpg' : 'png'
    const file = await writeBlob(result.blob, ext)
    try {
      const exported = await host.storage.files.export(file.id, { defaultName: `图片-${Date.now()}.${ext}` })
      if (exported?.ok) toast('已导出', 'success')
    } finally {
      await host.storage.files.remove(file.id).catch(() => {})
    }
  })

  const copyResult = async () => {
    if (!result) return
    try { await host.clipboard.writeImage(result.dataUrl); toast('已复制', 'success') } catch (error) { toast(error.message, 'error') }
  }

  const pinResult = () => {
    if (!result) return
    try { onPinImage(result.dataUrl, active?.name || '图片') } catch (error) { toast(error.message, 'error') }
  }

  const useResultAsCurrent = () => void run(async () => {
    if (!result || !active) return
    const item = await queueItemFromDataUrl(result.dataUrl, `${active.name} · ${result.label}`)
    setQueue(prev => prev.map(row => row.id === active.id ? item : row))
    setActiveId(item.id)
    setResult(null)
    toast('已替换当前图片', 'success')
  })

  const batchCompress = () => void run(async () => {
    const rows = queueRef.current
    if (!rows.length) return
    const total = rows.length
    let done = 0
    const outputs = []
    for (const [index, item] of rows.entries()) {
      setProgress(`批量压缩 ${batchProgress(index, total).text}`)
      try {
        const canvas = drawScaled(item.image, item.width, item.height)
        const mime = item.mime === 'image/png' ? 'image/jpeg' : item.mime
        const found = await compressToTarget({
          encode: async value => {
            const blob = await canvasToBlob(canvas, mime, value)
            return { blob, bytes: blob.size }
          },
          targetBytes: Math.max(20, targetKb) * 1024
        })
        if (found) {
          outputs.push({ dataUrl: await blobToDataUrl(found.blob), name: batchName(item.name, '压缩', mime === 'image/webp' ? 'webp' : 'jpg') })
          done += 1
        }
      } catch (error) {
        toast(`${item.name}：${error.message}`, 'error')
      }
      await yieldFrame()
    }
    setProgress('')
    await addItems(outputs)
    toast(`批量压缩完成 ${done}/${total} 张`, done ? 'success' : 'info')
  })

  const batchConvert = () => void run(async () => {
    const rows = queueRef.current
    if (!rows.length) return
    const total = rows.length
    let done = 0
    const outputs = []
    for (const [index, item] of rows.entries()) {
      setProgress(`批量转换 ${batchProgress(index, total).text}`)
      try {
        const canvas = drawScaled(item.image, item.width, item.height)
        const blob = await canvasToBlob(canvas, 'image/webp', 0.9)
        outputs.push({ dataUrl: await blobToDataUrl(blob), name: batchName(item.name, '', 'webp') })
        done += 1
      } catch (error) {
        toast(`${item.name}：${error.message}`, 'error')
      }
      await yieldFrame()
    }
    setProgress('')
    await addItems(outputs)
    toast(`已批量转换 ${done} 张为 WebP`, done ? 'success' : 'info')
  })

  const cropFromPointer = event => {
    if (!active || tool !== 'transform') return null
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(active.width, (event.clientX - rect.left) * active.width / rect.width)),
      y: Math.max(0, Math.min(active.height, (event.clientY - rect.top) * active.height / rect.height))
    }
  }

  const onBoardPointerDown = event => {
    if (!active || tool !== 'transform' || event.button !== 0) return
    const point = cropFromPointer(event)
    if (!point) return
    dragRef.current = point
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
    setCrop({ x: point.x, y: point.y, width: 0, height: 0 })
    setCropBox({ left: 0, top: 0, width: 0, height: 0 })
  }

  const onBoardPointerMove = event => {
    if (!dragRef.current || !active) return
    const point = cropFromPointer(event)
    if (!point) return
    const start = dragRef.current
    setCrop({
      x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y)
    })
  }

  const onBoardPointerUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
  }

  const cropStyle = useMemo(() => {
    if (!crop || !active) return null
    return {
      left: `${crop.x / active.width * 100}%`,
      top: `${crop.y / active.height * 100}%`,
      width: `${crop.width / active.width * 100}%`,
      height: `${crop.height / active.height * 100}%`
    }
  }, [crop, active])

  const hasItems = queue.length > 0

  return (
    <div className="sa-tools">
      <aside className="sa-tools-queue" aria-label="图片队列">
        <button type="button" className="sa-queue-add" onClick={pickFiles} disabled={locked}>
          <Icon name="plus" size={16} />
          添加
        </button>
        {queue.map(item => (
          <div
            key={item.id}
            className="sa-queue-item"
            role="button"
            tabIndex={0}
            data-active={item.id === activeId}
            title={item.name}
            onClick={() => setActiveId(item.id)}
            onKeyDown={event => { if (event.key === 'Enter') setActiveId(item.id) }}
          >
            <img src={item.thumb} alt={item.name} />
            <button type="button" className="remove" aria-label="移出队列" onClick={event => { event.stopPropagation(); removeItem(item.id) }}>×</button>
          </div>
        ))}
      </aside>

      <section
        className="sa-tools-board"
        aria-label="图片预览"
        onDragOver={event => { event.preventDefault(); setDropActive(true) }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDrop}
      >
        {!hasItems ? (
          <div className="sa-tools-drop" data-dragging={dropActive}>
            <Icon name="image" />
            <span>拖入图片，或选择文件</span>
            <div className="sa-inline-actions" style={{ width: 220 }}>
              <button type="button" className="pk-btn pk-btn-primary" onClick={pickFiles}>选择图片</button>
              <button type="button" className="pk-btn" onClick={paste}>粘贴</button>
            </div>
          </div>
        ) : active ? (
          <div
            className="sa-tools-canvas"
            ref={boardRef}
            onPointerDown={onBoardPointerDown}
            onPointerMove={onBoardPointerMove}
            onPointerUp={onBoardPointerUp}
            style={{ cursor: tool === 'transform' ? 'crosshair' : 'default' }}
          >
            <img src={boardSrc} alt={active.name} draggable={false} />
            {cropStyle ? <span className="sa-tools-crop" style={cropStyle} /> : null}
          </div>
        ) : (
          <Empty text="选择左侧的一张图片" />
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void run(async () => { await addItems([{ dataUrl: await readFileDataUrl(file), name: file.name }]) })
          }}
        />
      </section>

      <aside className="sa-tools-panel" aria-label="图片工具">
        {!active ? <div className="pk-empty-state"><strong className="pk-empty-title">请先添加图片</strong></div> : (
          <>
            <div className="sa-tool-grid" role="tablist" aria-label="工具">
              {TOOLS.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tool === entry.id}
                  className="sa-tool-tab"
                  data-active={tool === entry.id}
                  title={entry.hint || entry.label}
                  onClick={() => { setTool(entry.id); setResult(null) }}
                >
                  <Icon name={entry.icon} />
                  {entry.label}
                </button>
              ))}
            </div>
            {tool === 'compress' ? (
              <>
                <div className="sa-field">
                  <span>压缩方式</span>
                  <div className="sa-presets">
                    <button type="button" data-active={compressMode === 'target'} onClick={() => setCompressMode('target')}>目标体积</button>
                    <button type="button" data-active={compressMode === 'quality'} onClick={() => setCompressMode('quality')}>固定质量</button>
                  </div>
                </div>
                {compressMode === 'target' ? (
                  <label className="sa-field">
                    <span className="row"><span>目标体积上限</span><output>{targetKb} KB</output></span>
                    <input type="range" min={20} max={2048} step={20} value={targetKb} onChange={event => setTargetKb(Number(event.target.value))} />
                  </label>
                ) : (
                  <label className="sa-field">
                    <span className="row"><span>质量</span><output>{quality}%</output></span>
                    <input type="range" min={5} max={100} step={5} value={quality} onChange={event => setQuality(Number(event.target.value))} />
                  </label>
                )}
                <button type="button" className="pk-btn pk-btn-primary" disabled={locked} onClick={applyCompress}>开始压缩</button>
              </>
            ) : null}

            {tool === 'convert' ? (
              <>
                <div className="sa-field">
                  <span>目标格式</span>
                  <div className="sa-presets">
                    {[['image/png', 'PNG'], ['image/jpeg', 'JPEG'], ['image/webp', 'WebP']].map(([value, label]) => (
                      <button key={value} type="button" data-active={convertFormat === value} onClick={() => setConvertFormat(value)}>{label}</button>
                    ))}
                  </div>
                </div>
                <label className="sa-field">
                  <span className="row"><span>质量（JPEG / WebP）</span><output>{convertQuality}%</output></span>
                  <input type="range" min={5} max={100} step={5} value={convertQuality} onChange={event => setConvertQuality(Number(event.target.value))} />
                </label>
                <button type="button" className="pk-btn pk-btn-primary" disabled={locked} onClick={applyConvert}>转换格式</button>
              </>
            ) : null}

            {tool === 'resize' ? (
              <>
                <div className="sa-field">
                  <span>缩放方式</span>
                  <div className="sa-presets">
                    <button type="button" data-active={resizeMode === 'long'} onClick={() => setResizeMode('long')}>最长边</button>
                    <button type="button" data-active={resizeMode === 'percent'} onClick={() => setResizeMode('percent')}>百分比</button>
                  </div>
                </div>
                <label className="sa-field">
                  <span className="row"><span>{resizeMode === 'percent' ? '缩放比例' : '最长边'}</span><output>{resizeValue}{resizeMode === 'percent' ? '%' : 'px'}</output></span>
                  <input type="range" min={resizeMode === 'percent' ? 10 : 64} max={resizeMode === 'percent' ? 200 : 6000} step={resizeMode === 'percent' ? 5 : 16} value={resizeValue} onChange={event => setResizeValue(Number(event.target.value))} />
                </label>
                <div className="sa-presets">
                  {EXPORT_PRESETS.map(preset => (
                    <button key={preset.id} type="button" onClick={() => applyPreset(preset)}>{preset.label}</button>
                  ))}
                </div>
                <div className="sa-inline-actions">
                  <button type="button" className="pk-btn pk-btn-primary" disabled={locked} onClick={applyResize}>应用缩放</button>
                  <button type="button" className="pk-btn" onClick={previewResize}>预览尺寸</button>
                </div>
              </>
            ) : null}

            {tool === 'transform' ? (
              <>
                <div className="sa-inline-actions">
                  <button type="button" className="pk-btn" onClick={() => setRotate(value => (value + 90) % 360)}>旋转 90°</button>
                  <button type="button" className="pk-btn" data-pressed={flipX} aria-pressed={flipX} onClick={() => setFlipX(value => !value)}>水平翻转</button>
                  <button type="button" className="pk-btn" data-pressed={flipY} aria-pressed={flipY} onClick={() => setFlipY(value => !value)}>垂直翻转</button>
                </div>
                <div className="sa-field">
                  <span className="row">
                    <span>选区</span>
                    <output>{crop ? `${Math.round(crop.width)} × ${Math.round(crop.height)}` : '在预览上拖动'}</output>
                  </span>
                  <div className="sa-inline-actions">
                    <button type="button" className="pk-btn" disabled={!crop || locked} onClick={applyCrop}>应用裁剪</button>
                    <button type="button" className="pk-btn pk-btn-danger" disabled={!crop || locked} onClick={eraseSelection}>删除选区</button>
                  </div>
                </div>
                <button type="button" className="pk-btn pk-btn-primary" disabled={locked} onClick={applyRotateFlip}>应用旋转/翻转</button>
              </>
            ) : null}

            {tool === 'watermark' ? (
              <>
                <label className="sa-field">
                  <span>水印文字</span>
                  <input type="text" maxLength={60} placeholder="例如：@eNest" value={wmText} onChange={event => setWmText(event.target.value)} />
                </label>
                <label className="sa-field">
                  <span className="row"><span>透明度</span><output>{wmOpacity}%</output></span>
                  <input type="range" min={5} max={100} step={5} value={wmOpacity} onChange={event => setWmOpacity(Number(event.target.value))} />
                </label>
                <label className="sa-field">
                  <span className="row"><span>字号</span><output>{wmSize}px</output></span>
                  <input type="range" min={10} max={200} step={2} value={wmSize} onChange={event => setWmSize(Number(event.target.value))} />
                </label>
                <div className="sa-field">
                  <span>位置</span>
                  <div className="sa-wm-grid" role="group" aria-label="水印位置">
                    {WATERMARK_SLOTS.map(slot => (
                      <button key={slot} type="button" data-active={wmSlot === slot} aria-label={slot} onClick={() => setWmSlot(slot)} />
                    ))}
                  </div>
                </div>
                <div className="sa-inline-actions">
                  <button type="button" className="pk-btn" onClick={toggleWatermarkPreview}>{wmPreviewSrc ? '关闭预览' : '叠加预览'}</button>
                  <button type="button" className="pk-btn pk-btn-primary" disabled={locked} onClick={applyWatermark}>写入水印</button>
                </div>
              </>
            ) : null}

            {tool === 'exif' ? (
              <>
                {exifBusy ? <div className="sa-batch-progress"><span className="sa-spinner" /> 正在读取…</div> : null}
                {exifRows && exifRows.length ? (
                  <dl className="sa-exif">
                    {exifRows.map(([key, value]) => (
                      <Fragment key={key}>
                        <dt>{key}</dt>
                        <dd>{String(value)}</dd>
                      </Fragment>
                    ))}
                  </dl>
                ) : !exifBusy ? <div className="sa-panel-empty">没有可读的 EXIF</div> : null}
                <button type="button" className="pk-btn" disabled={locked} onClick={stripExif}>重绘并剥离元数据</button>
              </>
            ) : null}

            {tool === 'palette' ? (
              <>
                {paletteBusy ? <div className="sa-batch-progress"><span className="sa-spinner" /> 正在提取…</div> : null}
                {palette && palette.length ? (
                  <div className="sa-palette">
                    {palette.map(entry => (
                      <button key={entry.hex} type="button" style={{ background: entry.hex }} onClick={() => copyHex(entry.hex)}>{entry.hex}</button>
                    ))}
                  </div>
                ) : !paletteBusy ? <div className="sa-panel-empty">没有可提取的颜色</div> : null}
              </>
            ) : null}

            {result ? (
              <div className="sa-result">
                <img src={result.dataUrl} alt={result.label} />
                <div className="meta">
                  <b>{result.label}</b>
                  <span>{coreFormatBytes(result.before)} → {coreFormatBytes(result.bytes)}</span>
                </div>
                <div className="sa-inline-actions">
                  <button type="button" className="pk-btn pk-btn-primary" onClick={saveResult}>保存到媒体库</button>
                  <button type="button" className="pk-btn" onClick={exportResult}>导出</button>
                  <button type="button" className="pk-btn" onClick={copyResult}>复制</button>
                  <button type="button" className="pk-btn" onClick={pinResult}>贴图</button>
                  <button type="button" className="pk-btn" onClick={useResultAsCurrent}>用作当前</button>
                </div>
              </div>
            ) : null}

            {queue.length > 1 ? (
              <div className="sa-inline-actions">
                <button type="button" className="pk-btn" disabled={locked} onClick={batchCompress}>批量压缩</button>
                <button type="button" className="pk-btn" disabled={locked} onClick={batchConvert}>批量转 WebP</button>
              </div>
            ) : null}
            {progress ? <div className="sa-batch-progress">{progress}</div> : null}
            {busy ? <div className="sa-progress"><i style={{ width: '40%' }} /></div> : null}
            <div className="sa-batch-progress">
              {active.width} × {active.height} · {coreFormatBytes(active.bytes)} · {active.name}
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
