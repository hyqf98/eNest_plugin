/**
 * 图片工具箱主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 image-core.js（window.ImageCore）原样复用，绘制逻辑（makeThumb/drawScaled/
 * drawWatermark/crop 映射）经 state + ref 复用；文件选择仍走 bindFileInput 宿主选择器。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreMenu } from '../ui/index.jsx'
import { bindFileInput, readDroppedFiles } from '@enest/plugin-kit/file-inputs'
import { createNativeSurfaces } from '@enest/native-surfaces'

const api = createNativeSurfaces(window.enest || window.zapi)
const core = window.ImageCore
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`

const ACCEPT = ['.png', '.jpg', '.jpeg', '.webp']
const checkName = (name) => ACCEPT.some((ext) => String(name || '').toLowerCase().endsWith(ext))
const stripExt = (name) => String(name || '图片').replace(/\.[^.]+$/, '')
const TABS = ['compress', 'convert', 'resize', 'transform', 'watermark', 'exif', 'palette']

/** 图片读取 / 编码（与原版相同的工具函数） */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { if (image.naturalWidth * image.naturalHeight > 64e6) reject(new Error('图片需小于 6400 万像素')); else resolve(image) }
    image.onerror = () => reject(new Error('图片无法读取，可能是不支持的格式'))
    image.src = dataUrl
  })
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 32 * 1024 * 1024) return reject(new Error(`${file.name || '文件'} 超过 32 MB`))
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`${file.name || '文件'} 读取失败`))
    reader.readAsDataURL(file)
  })
}
function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`${core.FORMAT_LABEL[mime] || mime} 编码失败`))), mime, quality)
  })
}
async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('结果读取失败'))
    reader.readAsDataURL(blob)
  })
}
function drawScaled(image, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  canvas.getContext('2d').drawImage(image, 0, 0, width, height)
  return canvas
}
function makeThumb(image) {
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 200 / image.naturalWidth)
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.72)
}

export function App() {
  const kitRef = useRef(null)
  const fileInputRef = useRef(null)

  const [statusText, setStatusText] = useState('添加图片开始处理')
  const [items, setItems] = useState([])          // { id, name, mime, bytes, width, height, blobId, dataUrl, busy }
  const [activeId, setActiveId] = useState('')
  const [thumbs, setThumbs] = useState({})        // id → dataURL（React 渲染用；绘制仍用本地 Map）
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('compress')
  const [compressMode, setCompressMode] = useState('target')
  const [convertFormat, setConvertFormat] = useState('image/jpeg')
  const [resizeMode, setResizeMode] = useState('long')
  const [rotate, setRotate] = useState(0)
  const [flipX, setFlipX] = useState(false)
  const [flipY, setFlipY] = useState(false)
  const [crop, setCrop] = useState(null)
  const [cropBox, setCropBox] = useState(null)    // 显示坐标 { left, top, width, height }
  const [wmSlot, setWmSlot] = useState('bottom-right')
  const [wmPreview, setWmPreview] = useState(false)
  const [wmText, setWmText] = useState('')
  const [wmOpacity, setWmOpacity] = useState(80)
  const [wmSize, setWmSize] = useState(28)
  const [targetKb, setTargetKb] = useState(200)
  const [quality, setQuality] = useState(75)
  const [convertQuality, setConvertQuality] = useState(90)
  const [resizeValue, setResizeValue] = useState(1280)
  const [compressProgress, setCompressProgress] = useState('')
  const [bulkProgress, setBulkProgress] = useState('')
  const [exifRows, setExifRows] = useState(null)  // null=未读取, []=空, [[label, value]]
  const [palette, setPalette] = useState(null)
  const [lastResult, setLastResult] = useState(null)
  const [resizePreview, setResizePreview] = useState('')
  const [dragging, setDragging] = useState(false)

  const itemsRef = useRef(items); itemsRef.current = items
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  const busyRef = useRef(busy); busyRef.current = busy
  const tabRef = useRef(tab); tabRef.current = tab
  const compressModeRef = useRef(compressMode); compressModeRef.current = compressMode
  const convertFormatRef = useRef(convertFormat); convertFormatRef.current = convertFormat
  const resizeModeRef = useRef(resizeMode); resizeModeRef.current = resizeMode
  const transformRef = useRef({ rotate, flipX, flipY }); transformRef.current = { rotate, flipX, flipY }
  const cropRef = useRef(crop); cropRef.current = crop
  const wmRef = useRef({ slot: wmSlot, preview: wmPreview, text: wmText, opacity: wmOpacity, size: wmSize })
  wmRef.current = { slot: wmSlot, preview: wmPreview, text: wmText, opacity: wmOpacity, size: wmSize }
  const rangeRef = useRef({ targetKb, quality, convertQuality, resizeValue }); rangeRef.current = { targetKb, quality, convertQuality, resizeValue }
  const thumbsMapRef = useRef(new Map())          // 绘制通道用的本地 Map

  const thumbsVersionRef = useRef(0)
  const publishThumbs = useCallback(() => {
    thumbsVersionRef.current += 1
    setThumbs(Object.fromEntries(thumbsMapRef.current))
  }, [])

  const currentItem = useCallback(() => itemsRef.current.find((item) => item.id === activeIdRef.current), [])

  const status = useCallback((text) => setStatusText(text ?? ''), [])
  const fail = useCallback((error) => {
    const text = String(error?.message || error)
    setStatusText(text)
    kitRef.current?.toast(text, 'error')
  }, [])
  const run = useCallback((fn) => Promise.resolve().then(fn).catch(fail), [fail])

  /* ---------- 持久化（仅元数据，不含大图；原图按需重读 blob） ---------- */
  const persist = useCallback((rows) => {
    const snapshot = rows.map(({ id, name, mime, bytes, width, height, blobId, dataUrl }) => ({
      id, name, mime, bytes, width, height, blobId: blobId || '', dataUrl: blobId ? '' : (dataUrl || '')
    }))
    return kitRef.current?.save('imagetools_queue_v1', snapshot).catch(() => {})
  }, [])

  async function itemData(item) {
    if (!item.blobId) return item.dataUrl
    const blob = await api?.storage?.blobs?.get?.(item.blobId)
    if (!blob?.dataUrl) throw new Error('原图缓存已失效，请重新导入该图片')
    return blob.dataUrl
  }

  /* ---------- 导入（等价原 importDataUrl / importFiles / importClipboard） ---------- */
  const importDataUrl = useCallback(async (dataUrl, name, bytes) => {
    const image = await loadImage(dataUrl)
    const mime = /^data:([^;]+)/.exec(dataUrl)?.[1] || 'image/png'
    if (!core.SUPPORTED_MIME.includes(mime)) throw new Error(`不支持的格式：${mime}（仅 PNG / JPEG / WebP）`)
    const item = {
      id: uid(), name: String(name || '图片').slice(0, 80), mime, bytes: bytes || Math.round(dataUrl.length * 0.75),
      width: image.naturalWidth, height: image.naturalHeight, blobId: '', dataUrl: '', busy: false
    }
    try {
      if (api?.storage?.blobs?.put) {
        const blob = await api.storage.blobs.put({ dataUrl, name: item.name })
        item.blobId = blob.id; item.bytes = blob.bytes || item.bytes
      } else {
        item.dataUrl = dataUrl
      }
    } catch (error) {
      if (String(error?.message).includes('大小')) throw error
      item.dataUrl = dataUrl
    }
    thumbsMapRef.current.set(item.id, makeThumb(image))
    publishThumbs()
    setItems((prev) => {
      const next = [item, ...prev.filter((entry) => entry.name !== item.name || entry.bytes !== item.bytes)].slice(0, 24)
      void persist(next)
      return next
    })
    return item
  }, [persist, publishThumbs])

  const importFiles = useCallback(async (files) => {
    const list = Array.from(files || []).filter((file) => file)
    if (!list.length) return
    let done = 0
    setStatusText(`正在导入 ${list.length} 张…`)
    for (const file of list) {
      if (!checkName(file.name)) { kitRef.current?.toast(`不支持的格式：${file.name}（仅 PNG / JPEG / WebP）`, 'error'); continue }
      try { await importDataUrl(await readFileAsDataUrl(file), file.name, file.size); done += 1 } catch (error) { kitRef.current?.toast(`${file.name}：${error.message}`, 'error') }
      if (done % 3 === 0) await core.yieldFrame()
    }
    setStatusText(done ? `已导入 ${done} 张图片` : '未导入图片')
  }, [importDataUrl])

  const importClipboard = useCallback(async () => {
    if (!api?.clipboard?.readImage) throw new Error('剪贴板图片需要在 eNest 中使用')
    const image = await api.clipboard.readImage()
    if (!image?.dataUrl) { setStatusText('剪贴板中没有图片'); kitRef.current?.toast('剪贴板中没有图片', 'error'); return }
    await importDataUrl(image.dataUrl, `剪贴板图片 ${new Date().toLocaleString('sv-SE')}`, null)
    setStatusText('已从剪贴板导入')
  }, [importDataUrl])

  /* ---------- 选中图片（等价原 openItem / renderPreview） ---------- */
  const openItem = useCallback(async (item) => {
    resetTransformState()
    setPalette(null)
    setLastResult(null)
    try {
      await loadImage(await itemData(item))
      setActiveId(item.id)
    } catch (error) {
      fail(error)
    }
  }, [fail])

  const activeItem = items.find((item) => item.id === activeId)
  const previewSrc = activeItem ? (thumbs[activeItem.id] || '') : ''
  const fileMeta = activeItem
    ? `${activeItem.name} · ${activeItem.width}×${activeItem.height} · ${core.formatBytes(activeItem.bytes)}`
    : ''

  function resetTransformState() {
    setRotate(0); setFlipX(false); setFlipY(false); setCrop(null); setCropBox(null)
  }

  /* ---------- 裁剪框选（等价原 crop-stage 指针逻辑，坐标基于显示图 → 原图映射） ---------- */
  const cropStageRef = useRef(null)
  const cropImageRef = useRef(null)
  const cropDragRef = useRef(null)
  const cropRef2 = useRef(null)

  const toNatural = useCallback((point) => {
    const rect = cropImageRef.current?.getBoundingClientRect()
    const item = currentItem()
    if (!rect?.width || !item) return { x: 0, y: 0 }
    return {
      x: Math.round(Math.max(0, Math.min(item.width, (point.x - rect.left) / rect.width * item.width))),
      y: Math.round(Math.max(0, Math.min(item.height, (point.y - rect.top) / rect.height * item.height)))
    }
  }, [currentItem])

  const syncCropBox = useCallback(() => {
    const rect = cropImageRef.current?.getBoundingClientRect()
    const item = currentItem()
    const value = cropRef2.current
    if (!value || !rect?.width || !item) { setCropBox(null); return }
    setCropBox({
      left: (value.x / item.width) * rect.width,
      top: (value.y / item.height) * rect.height,
      width: (value.width / item.width) * rect.width,
      height: (value.height / item.height) * rect.height,
    })
  }, [currentItem])

  const cropInfo = (() => {
    const { rotate: r, flipX: fx, flipY: fy } = transformRef.current
    const value = crop
    const parts = []
    if (r) parts.push(`旋转 ${r}°`)
    if (fx) parts.push('水平翻转')
    if (fy) parts.push('垂直翻转')
    const base = parts.length ? parts.join(' · ') + ' · ' : ''
    return value ? `${base}裁剪 ${value.width}×${value.height}` : `${base || '变换：'}未框选`
  })()

  const onCropPointerDown = (event) => {
    if (event.button !== 0 || !currentItem()) return
    const start = toNatural({ x: event.clientX, y: event.clientY })
    cropDragRef.current = start
    const value = { x: start.x, y: start.y, width: 0, height: 0 }
    cropRef2.current = value
    setCrop(value)
    cropStageRef.current?.classList.add('armed')
    cropStageRef.current?.setPointerCapture(event.pointerId)
  }
  const onCropPointerMove = (event) => {
    if (!cropDragRef.current) return
    const point = toNatural({ x: event.clientX, y: event.clientY })
    const start = cropDragRef.current
    const value = {
      x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y),
    }
    cropRef2.current = value
    setCrop(value)
    syncCropBox()
  }
  const endCrop = () => { cropDragRef.current = null; cropStageRef.current?.classList.remove('armed') }

  /* ---------- withItem（等价原 busy 包装） ---------- */
  const withItem = useCallback(async (fn) => {
    const item = currentItem()
    if (!item) throw new Error('请先在队列中选择一张图片')
    if (busyRef.current) return
    setBusy(true)
    setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, busy: true } : row)))
    try { await fn(item) } finally {
      setBusy(false)
      setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, busy: false } : row)))
    }
  }, [currentItem])

  /* ---------- 结果条（等价原 setResult/syncResult） ---------- */
  const setResult = useCallback((result) => setLastResult(result), [])
  const resultRatio = lastResult ? core.ratioText(lastResult.before, lastResult.bytes) : ''

  /* ---------- 水印绘制（等价原 drawWatermark） ---------- */
  const drawWatermark = useCallback((canvas) => {
    const { slot, text: rawText, opacity, size: fontSize } = wmRef.current
    const text = String(rawText || '').trim()
    if (!text) return
    const { alpha, size } = core.watermarkStyle({ opacity, fontSize })
    const ctx = canvas.getContext('2d')
    const anchor = core.watermarkAnchor(slot)
    const pad = Math.round(size * 0.5)
    ctx.font = `600 ${size}px var(--font, sans-serif)`
    ctx.globalAlpha = alpha
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.lineWidth = Math.max(1, Math.round(size / 24))
    const metrics = ctx.measureText(text)
    const x = pad + anchor.x * (canvas.width - metrics.width - pad * 2)
    const y = pad + anchor.y * (canvas.height - size - pad * 2) + size * 0.82
    ctx.strokeText(text, x, y)
    ctx.fillText(text, x, y)
    ctx.globalAlpha = 1
  }, [])

  const renderWatermarkPreview = useCallback(async () => {
    const item = currentItem(); if (!item) return
    const image = await loadImage(thumbsMapRef.current.get(item.id) || await itemData(item))
    const canvas = drawScaled(image, image.naturalWidth, image.naturalHeight)
    drawWatermark(canvas)
    const el = document.getElementById('preview')
    if (el) el.src = canvas.toDataURL('image/png')
  }, [currentItem, drawWatermark])

  /* ---------- EXIF ---------- */
  async function readArrayBuffer(item) {
    const dataUrl = await itemData(item)
    const base64 = dataUrl.split(',')[1] || ''
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  const EXIF_LABELS = { camera: '相机', time: '拍摄时间', orientation: '方向', exposure: '曝光', aperture: '光圈', iso: '感光度', focal: '焦距', gps: 'GPS' }

  /* ---------- 缩放范围（等价原 syncResizeRange） ---------- */
  const syncResizeRange = useCallback(() => {
    const item = currentItem()
    setResizeValue(resizeModeRef.current === 'percent' ? 50 : Math.min(1280, item?.width || 1280))
  }, [currentItem])

  /* ---------- 裁剪框坐标随窗口/选中图刷新 ---------- */
  useEffect(() => { syncCropBox() }, [activeId, crop, syncCropBox])

  /* ---------- 文件选择（宿主选择器 bindFileInput 原样） ---------- */
  useEffect(() => {
    const input = fileInputRef.current
    if (!input) return
    bindFileInput(input, { api, onError: (error) => kitRef.current?.toast(error.message, 'error') })
    const onChange = () => {
      const files = Array.from(input.files || [])
      input.value = ''
      void run(() => importFiles(files))
    }
    input.addEventListener('change', onChange)
    return () => input.removeEventListener('change', onChange)
  }, [importFiles, run])

  const pickFiles = useCallback(() => fileInputRef.current?.click(), [])
  const pickClipboard = useCallback(() => void run(importClipboard), [importClipboard, run])

  /* ---------- 拖拽（等价原 app 级 dragover/dragleave/drop） ---------- */
  const dragDepth = useRef(0)
  const appRef = useRef(null)
  const onAppDragOver = (event) => { event.preventDefault(); setDragging(true); document.getElementById('drop-zone')?.classList.add('armed') }
  const onAppDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) { setDragging(false); document.getElementById('drop-zone')?.classList.remove('armed') }
  }
  const onAppDrop = (event) => {
    event.preventDefault(); dragDepth.current = 0
    setDragging(false); document.getElementById('drop-zone')?.classList.remove('armed')
    const files = Array.from(event.dataTransfer?.files || [])
    if (!files.length) return
    void run(async () => { await importFiles(await readDroppedFiles(files, { api })) })
  }

  /* ---------- 动作（等价原各 onclick） ---------- */
  const runCompress = () => void run(() => withItem(async (item) => {
    const image = await loadImage(await itemData(item))
    const mime = item.mime === 'image/png' ? 'image/jpeg' : item.mime
    const canvas = drawScaled(image, item.width, item.height)
    const encode = (q) => canvasToBlob(canvas, mime, q).then((blob) => (blob ? { blob, bytes: blob.size } : null))
    setCompressProgress('正在迭代质量…')
    let result
    if (compressModeRef.current === 'target') {
      const targetBytes = rangeRef.current.targetKb * 1024
      result = await core.compressToTarget({ encode, targetBytes })
      if (!result) throw new Error('压缩失败：无法编码')
    } else {
      const q = rangeRef.current.quality / 100
      const encoded = await encode(q)
      if (!encoded) throw new Error('压缩失败：无法编码')
      result = { ...encoded, quality: q, saturated: false }
    }
    const dataUrl = await blobToDataUrl(result.blob)
    setResult({
      dataUrl, mime, bytes: result.bytes,
      width: item.width, height: item.height,
      label: `质量 ${Math.round(result.quality * 100)}%${result.saturated ? ' · 已到质量上限' : ''}`,
      before: item.bytes
    })
    setCompressProgress(`完成：${core.formatBytes(item.bytes)} → ${core.formatBytes(result.bytes)}`)
  }))

  const runConvert = () => void run(() => withItem(async (item) => {
    const image = await loadImage(await itemData(item))
    const canvas = drawScaled(image, item.width, item.height)
    const q = rangeRef.current.convertQuality / 100
    const blob = await canvasToBlob(canvas, convertFormatRef.current, q)
    setResult({
      dataUrl: await blobToDataUrl(blob), mime: convertFormatRef.current, bytes: blob.size,
      width: item.width, height: item.height,
      label: `${core.FORMAT_LABEL[convertFormatRef.current]} · 质量 ${Math.round(q * 100)}%`,
      before: item.bytes
    })
    setStatusText(`已转换为 ${core.FORMAT_LABEL[convertFormatRef.current]}`)
  }))

  const previewResize = useCallback(() => {
    const item = currentItem(); if (!item) { kitRef.current?.toast('请先选择图片', 'error'); return }
    try {
      const next = core.scaleSize(item.width, item.height, resizeModeRef.current, rangeRef.current.resizeValue)
      setResizePreview(`${item.width}×${item.height} → ${next.width}×${next.height}`)
    } catch (error) { setResizePreview(error.message) }
  }, [currentItem])

  const applyPreset = useCallback((preset) => {
    const item = currentItem()
    if (!item) { kitRef.current?.toast('请先选择图片', 'error'); return }
    setResizeMode('long')
    resizeModeRef.current = 'long'
    setResizeValue(preset.id === 'original' ? Math.max(item.width, item.height) : preset.id === 'icon' ? 256 : preset.id === 'cover' ? 1200 : preset.id === 'hd' ? 1280 : 1920)
    rangeRef.current = { ...rangeRef.current, resizeValue: preset.id === 'original' ? Math.max(item.width, item.height) : preset.id === 'icon' ? 256 : preset.id === 'cover' ? 1200 : preset.id === 'hd' ? 1280 : 1920 }
    previewResizeRef.current()
  }, [currentItem])
  const previewResizeRef = useRef(previewResize)
  previewResizeRef.current = previewResize

  const runResize = () => void run(() => withItem(async (item) => {
    const next = core.scaleSize(item.width, item.height, resizeModeRef.current, rangeRef.current.resizeValue)
    const image = await loadImage(await itemData(item))
    const canvas = drawScaled(image, next.width, next.height)
    const blob = await canvasToBlob(canvas, item.mime, 0.92)
    setResult({
      dataUrl: await blobToDataUrl(blob), mime: item.mime, bytes: blob.size,
      width: next.width, height: next.height,
      label: `缩放 ${item.width}×${item.height} → ${next.width}×${next.height}`,
      before: item.bytes
    })
  }))

  function mapCropToTransformed(cropRect, item, plan) {
    const corners = [[cropRect.x, cropRect.y], [cropRect.x + cropRect.width, cropRect.y], [cropRect.x, cropRect.y + cropRect.height], [cropRect.x + cropRect.width, cropRect.y + cropRect.height]]
    const w = item.width, h = item.height
    const transformed = corners.map(([x, y]) => {
      let px = x - w / 2, py = y - h / 2
      for (let i = 0; i < plan.quarter; i += 1) { const temp = px; px = -py; py = temp }
      if (flipX) px = -px
      if (flipY) py = -py
      return [px + plan.width / 2, py + plan.height / 2]
    })
    const xs = transformed.map((p) => p[0]), ys = transformed.map((p) => p[1])
    const x1 = Math.max(0, Math.floor(Math.min(...xs))), y1 = Math.max(0, Math.floor(Math.min(...ys)))
    const x2 = Math.min(plan.width, Math.ceil(Math.max(...xs))), y2 = Math.min(plan.height, Math.ceil(Math.max(...ys)))
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  }

  const applyCrop = () => void run(() => withItem(async (item) => {
    const cropRect = cropRef.current
    if (!cropRect) throw new Error('请先在预览图上框选区域')
    const { rotate: r, flipX: fx, flipY: fy } = transformRef.current
    const image = await loadImage(await itemData(item))
    const canvas = document.createElement('canvas')
    canvas.width = cropRect.width; canvas.height = cropRect.height
    const ctx = canvas.getContext('2d')
    ctx.save()
    core.applyTransform(ctx, image, core.transformPlan({ rotate: r, flipX: fx, flipY: fy, width: item.width, height: item.height }), fx, fy)
    ctx.restore()
    const plan = core.transformPlan({ rotate: r, flipX: fx, flipY: fy, width: item.width, height: item.height })
    const mapped = mapCropToTransformed(cropRect, item, plan)
    const output = document.createElement('canvas')
    output.width = mapped.width; output.height = mapped.height
    output.getContext('2d').drawImage(canvas, -mapped.x, -mapped.y)
    const blob = await canvasToBlob(output, item.mime, 0.95)
    setResult({
      dataUrl: await blobToDataUrl(blob), mime: item.mime, bytes: blob.size,
      width: mapped.width, height: mapped.height,
      label: `裁剪 ${cropRect.width}×${cropRect.height}`,
      before: item.bytes
    })
  }))

  const toggleWmPreview = () => {
    setWmPreview((prev) => {
      const next = !prev
      if (next) void run(renderWatermarkPreview)
      else {
        const item = currentItem()
        const el = document.getElementById('preview')
        if (item && el) el.src = thumbsMapRef.current.get(item.id) || ''
      }
      return next
    })
  }

  const applyWatermark = () => void run(() => withItem(async (item) => {
    const text = String(wmRef.current.text || '').trim()
    if (!text) throw new Error('请输入水印文字')
    const image = await loadImage(await itemData(item))
    const canvas = drawScaled(image, item.width, item.height)
    drawWatermark(canvas)
    const blob = await canvasToBlob(canvas, item.mime, 0.95)
    setResult({
      dataUrl: await blobToDataUrl(blob), mime: item.mime, bytes: blob.size,
      width: item.width, height: item.height, label: `水印「${text.slice(0, 12)}」`, before: item.bytes
    })
  }))

  const readExif = () => void run(() => withItem(async (item) => {
    if (item.mime !== 'image/jpeg') { setExifRows([]); kitRef.current?.toast('EXIF 主要存在于 JPEG；PNG / WebP 通常无此信息', 'info'); return }
    const summary = core.exifSummary(core.parseExif(await readArrayBuffer(item)))
    setExifRows(Object.entries(summary).map(([key, value]) => [EXIF_LABELS[key] || key, String(value)]))
    setStatusText('EXIF 读取完成')
  }))

  const exportNoExif = () => void run(() => withItem(async (item) => {
    const image = await loadImage(await itemData(item))
    const canvas = drawScaled(image, item.width, item.height)
    const dataUrl = canvas.toDataURL('image/png')
    setResult({ dataUrl, mime: 'image/png', bytes: Math.round(dataUrl.length * 0.75), width: item.width, height: item.height, label: '已清除元数据（PNG 重绘）', before: item.bytes })
    setStatusText('已重绘并剥离元数据')
  }))

  const runPalette = () => void run(() => withItem(async (item) => {
    setStatusText('正在提取主色…')
    const image = await loadImage(await itemData(item))
    const canvas = drawScaled(image, Math.min(120, item.width), Math.max(1, Math.round(Math.min(120, item.width) * item.height / item.width)))
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    await core.yieldFrame()
    setPalette(core.paletteFromPixels(data, 6))
    setStatusText('已提取主色，点击复制 HEX')
  }))

  const copyHex = (hex) => void run(async () => { await kitRef.current?.copy(hex); setStatusText(`已复制 ${hex}`) })

  const useResult = () => void run(async () => {
    const result = lastResult
    if (!result) return
    const base = currentItem()?.name || '图片'
    const item = await importDataUrl(result.dataUrl, `${base} · ${result.label || '输出'}`, result.bytes)
    setActiveId(item.id)
    setLastResult(null)
    setStatusText('输出已替换为当前图片')
  })
  const saveResult = () => void run(async () => {
    if (!lastResult) return
    const ext = lastResult.mime === 'image/webp' ? 'webp' : lastResult.mime === 'image/jpeg' ? 'jpg' : 'png'
    await kitRef.current?.saveFile(`imagetools-${Date.now()}.${ext}`, lastResult.dataUrl)
  })
  const pinResult = () => void run(async () => {
    if (!lastResult) return
    if (!api?.pin?.open) throw new Error('贴图需要在 eNest 中使用')
    await api.pin.open({ dataUrl: lastResult.dataUrl, width: 380, title: '图片工具箱' })
    setStatusText('已创建贴图')
  })

  /* ---------- 批量（等价原 bulk 动作） ---------- */
  const bulkShrink = () => void run(async () => {
    const targetBytes = rangeRef.current.targetKb * 1024
    const rows = itemsRef.current
    const total = rows.length
    let done = 0
    setBulkProgress(core.batchProgress(0, total).text)
    for (const [index, item] of rows.entries()) {
      setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, busy: true } : row)))
      try {
        const image = await loadImage(await itemData(item))
        const mime = item.mime === 'image/png' ? 'image/jpeg' : item.mime
        const canvas = drawScaled(image, item.width, item.height)
        const result = await core.compressToTarget({ encode: (q) => canvasToBlob(canvas, mime, q).then((blob) => (blob ? { blob, bytes: blob.size } : null)), targetBytes })
        if (result) {
          await importDataUrl(await blobToDataUrl(result.blob), core.batchName(item.name, '压缩', mime === 'image/webp' ? 'webp' : 'jpg'), result.bytes)
          done += 1
        }
      } catch (error) { kitRef.current?.toast(`${item.name}：${error.message}`, 'error') }
      setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, busy: false } : row)))
      setBulkProgress(core.batchProgress(index + 1, total).text)
      await core.yieldFrame()
    }
    setStatusText(`批量压缩完成 ${done}/${total} 张`)
    kitRef.current?.toast(done === total ? `批量压缩完成（${done} 张）` : `批量压缩完成 ${done}/${total} 张`, done ? 'success' : 'info')
    setTimeout(() => setBulkProgress(''), 2400)
  })
  const bulkConvert = () => void run(async () => {
    const rows = itemsRef.current
    const total = rows.length
    let done = 0
    setBulkProgress(core.batchProgress(0, total).text)
    for (const [index, item] of rows.entries()) {
      setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, busy: true } : row)))
      try {
        const image = await loadImage(await itemData(item))
        const canvas = drawScaled(image, item.width, item.height)
        const blob = await canvasToBlob(canvas, 'image/webp', 0.9)
        await importDataUrl(await blobToDataUrl(blob), core.batchName(item.name, '', 'webp'), blob.size)
        done += 1
      } catch (error) { kitRef.current?.toast(`${item.name}：${error.message}`, 'error') }
      setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, busy: false } : row)))
      setBulkProgress(core.batchProgress(index + 1, total).text)
      await core.yieldFrame()
    }
    setStatusText(`已批量转换 ${done} 张为 WebP`)
    kitRef.current?.toast(done ? `已转换 ${done} 张为 WebP` : '没有可转换的图片', done ? 'success' : 'info')
    setTimeout(() => setBulkProgress(''), 2400)
  })
  const exportAll = () => void run(async () => {
    const rows = itemsRef.current
    const total = rows.length
    setBulkProgress(core.batchProgress(0, total).text)
    let done = 0
    for (const [index, item] of rows.entries()) {
      const ext = item.mime === 'image/webp' ? 'webp' : item.mime === 'image/jpeg' ? 'jpg' : 'png'
      try { await kitRef.current?.saveFile(`${stripExt(item.name)}.${ext}`, await itemData(item)); done += 1 } catch (error) { kitRef.current?.toast(`${item.name}：${error.message}`, 'error') }
      setBulkProgress(core.batchProgress(index + 1, total).text)
      await core.yieldFrame()
    }
    setStatusText(`已依次另存 ${done}/${total} 张`)
    setTimeout(() => setBulkProgress(''), 2400)
  })
  const clearQueue = () => {
    setItems([]); setActiveId(''); thumbsMapRef.current.clear(); publishThumbs()
    setLastResult(null); setStatusText('队列已清空')
    void persist([])
  }
  const removeFromQueue = (id) => {
    thumbsMapRef.current.delete(id)
    const next = itemsRef.current.filter((entry) => entry.id !== id)
    setItems(next)
    if (activeId === id) { setActiveId(''); setLastResult(null) }
    publishThumbs()
    void persist(next)
  }

  /* ---------- Quick 行为（latest-ref 桥接 PluginKit） ---------- */
  const onQueryRef = useRef(null)
  onQueryRef.current = (value) => {
    if (kitRef.current?.mode === 'quick' && value && /^data:image\//.test(value)) void run(() => importDataUrl(value, 'Quick 图片', null))
  }
  const onActionRef = useRef(null)
  onActionRef.current = (action) => {
    if (action !== 'submit') return
    const item = currentItem()
    if (!item) { run(importClipboard); return }
    void run(async () => {
      const image = await loadImage(await itemData(item))
      const mime = kitRef.current?.settings.quickFormat || 'image/jpeg'
      const canvas = drawScaled(image, item.width, item.height)
      const targetBytes = Math.max(20, Number(kitRef.current?.settings.targetKb) || 200) * 1024
      const result = await core.compressToTarget({ encode: (q) => canvasToBlob(canvas, mime, q).then((blob) => (blob ? { blob, bytes: blob.size } : null)), targetBytes })
      if (!result) throw new Error('快速压缩失败')
      const dataUrl = await blobToDataUrl(result.blob)
      await importDataUrl(dataUrl, `${stripExt(item.name)} · 快速压缩`, result.bytes)
      kitRef.current?.toast(`已压缩至 ${core.formatBytes(result.bytes)}`, 'success')
      if (kitRef.current?.settings.autoPin && api?.pin?.open) await api.pin.open({ dataUrl, width: 360, title: '快速压缩' })
    })
  }

  /* ---------- Quick 高度自适应（等价原 MutationObserver + syncHeight） ---------- */
  const queueHeight = useCallback(() => {
    clearTimeout(queueHeight.timer)
    queueHeight.timer = setTimeout(() => {
      if (kitRef.current?.mode !== 'quick') return
      const height = Math.min(640, Math.max(320, Math.round(document.body.scrollHeight + 8)))
      void run(async () => { await api?.ui?.setHeight?.(height) })
    }, 120)
  }, [run])
  useEffect(() => {
    const observer = new MutationObserver(queueHeight)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [queueHeight])

  /* ---------- 初始化（可重入，等价原 init；hooks 规则：置于条件 return 之前） ---------- */
  const initRef = useRef(null)
  useEffect(() => {
    const kit = window.PluginKit.create({
      title: '图片工具箱',
      height: 520,
      quickPlaceholder: '添加图片压缩、转格式、加水印…',
      defaults: { followShellTheme: true, targetKb: 200, quickFormat: 'image/jpeg', autoPin: false },
      onQuery: (value) => onQueryRef.current?.(value),
      onAction: (action) => onActionRef.current?.(action),
    })
    kitRef.current = kit
    kit.onMode(() => queueHeight())
    kit.onSettings((settings, key) => {
      if (key === 'followShellTheme') {
        document.documentElement.dataset.followTheme = settings.followShellTheme === false ? 'off' : 'on'
      }
    })
    if (api?.onEnter) api.onEnter(async (event) => {
      initRef.current?.()
      // 打开方式：双击图片文件进入，读句柄 dataUrl 导入处理队列
      if (event?.code === 'open-file' && event?.payload?.handles?.length) {
        for (const handle of event.payload.handles.slice(0, 8)) {
          try {
            const dataUrl = await api?.localFiles?.read?.({ handleId: handle.id, encoding: 'dataUrl' })
            if (typeof dataUrl === 'string' && dataUrl) {
              await importDataUrl(dataUrl, handle.name || '打开图片', null)
            }
          } catch (error) {
            kitRef.current?.toast(`打开图片失败：${error?.message ?? error}`, 'error')
          }
        }
        return
      }
      // Quick 粘贴上下文（img 指令）：进入即导入随启动交付的图片。
      for (const pasted of event?.input?.images ?? []) {
        try { await importDataUrl(pasted.dataUrl, `粘贴图片 ${new Date().toLocaleString('sv-SE')}`, null) }
        catch (error) { kitRef.current?.toast(`粘贴图片导入失败：${error?.message ?? error}`, 'error') }
      }
    })
    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      try {
        const saved = await kit.load('imagetools_queue_v1', [])
        if (Array.isArray(saved)) {
          const restored = []
          for (const raw of saved.slice(0, 24)) {
            if (!raw?.id || !raw.name) continue
            const item = { id: raw.id, name: raw.name, mime: raw.mime || 'image/png', bytes: raw.bytes || 0, width: raw.width || 0, height: raw.height || 0, blobId: raw.blobId || '', dataUrl: raw.dataUrl || '', busy: false }
            if (!item.blobId && !item.dataUrl) continue
            try {
              const image = await loadImage(await itemData(item))
              thumbsMapRef.current.set(item.id, makeThumb(image))
              restored.push(item)
            } catch { /* 缓存失效的条目跳过 */ }
          }
          if (!alive) return
          thumbsMapRef.current.size && publishThumbs()
          setItems((prev) => [...restored, ...prev])
          setStatusText(restored.length ? `已恢复 ${restored.length} 张图片` : '添加图片开始处理')
        }
      } catch { /* 首次运行无历史 */ }
    })()
    return () => { alive = false }
  }, [publishThumbs, queueHeight])

  initRef.current = () => void run(async () => { /* 恢复逻辑已并入初始化 effect；onEnter 重入时无副作用 */ })

  const hasItems = items.length > 0
  const disabledBulk = !hasItems || busy

  return (
    <main className={'image-app' + (dragging ? ' dragging' : '')} ref={appRef}
      onDragOver={onAppDragOver} onDragLeave={onAppDragLeave} onDrop={onAppDrop}>
      <header className="app-head">
        <div><span className="eyebrow">图片处理</span><h1>图片工具箱</h1></div>
        <span id="status" role="status">{statusText}</span>
        <button id="add-files" type="button" className="pk-btn pk-btn-primary" onClick={pickFiles}>添加图片</button>
        <button id="from-clipboard" type="button" className="pk-btn" onClick={pickClipboard}>从剪贴板</button>
        <input id="file-input" ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden />
      </header>

      <div className="drop-hint" id="drop-hint" aria-hidden="true"><span>松开以导入图片</span></div>

      <section id="empty-state" className="empty-state" hidden={hasItems}>
        <div className="drop-zone" id="drop-zone" tabIndex={0} role="button" aria-label="拖拽或点击添加图片" onClick={pickFiles}
          onKeyDown={(e) => {
            if (e.defaultPrevented || e.isComposing || e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles() }
          }}>
          <div className="drop-mark" aria-hidden="true"></div>
          <h2>把图片拖到这里</h2>
          <p>支持 PNG、JPEG、WebP，可多选；也可从剪贴板粘贴截图</p>
          <div className="empty-actions">
            <button id="empty-add" type="button" className="pk-btn pk-btn-primary"
              onClick={(e) => { e.stopPropagation(); pickFiles() }}>选择文件</button>
            <button id="empty-clipboard" type="button" className="pk-btn"
              onClick={(e) => { e.stopPropagation(); pickClipboard() }}>读剪贴板</button>
          </div>
        </div>
      </section>

      <div className="work-layout" id="work-layout" hidden={!hasItems}>
        <section className="queue-panel" aria-label="图片队列">
          <div className="section-head">
            <h2>队列</h2><span id="queue-count" className="pk-muted">{`${items.length} 张`}</span>
            <MoreMenu
              label="⋯"
              ariaLabel="队列操作"
              buttonClassName="pk-btn-sm queue-more"
              items={[
                { key: 'clear', label: '清空队列', danger: true, disabled: !hasItems, onSelect: clearQueue },
              ]}
            />
          </div>
          <div id="thumb-grid" className="thumb-grid" aria-label="图片缩略图">
            {items.map((item) => (
              <div key={item.id} role="button" data-row-actions
                className={`thumb${item.id === activeId ? ' selected' : ''}${item.busy ? ' processing' : ''}`}
                tabIndex={0} aria-label={`选择 ${item.name}`} onClick={() => void run(() => openItem(item))}
                onKeyDown={(e) => {
                  if (e.defaultPrevented || e.isComposing || e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void run(() => openItem(item)) }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  PluginKit.openMenu(event, [
                    ['open', '打开编辑'],
                    ['remove', '移出队列', { danger: true }],
                  ], (key) => {
                    if (key === 'open') void run(() => openItem(item))
                    if (key === 'remove') removeFromQueue(item.id)
                  }, { align: 'end' })
                }}>
                <span className="box"><img src={thumbs[item.id] || ''} alt="" /></span>
                <span className="meta">
                  <span className="name">{item.name}</span>
                  <span className="info">
                    <span className="fmt">{core.FORMAT_LABEL[item.mime] || 'IMG'}</span>
                    {`${item.width}×${item.height} · ${core.formatBytes(item.bytes)}`}
                  </span>
                </span>
                <span className="pk-row-actions thumb-actions" onClick={(event) => event.stopPropagation()}>
                  <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" aria-label={`移出队列 ${item.name}`}
                    onClick={() => removeFromQueue(item.id)}>×</button>
                </span>
              </div>
            ))}
          </div>
          <div className="bulk-bar">
            <span className="bulk-label">批量操作</span>
            <span id="bulk-progress" className="pk-mono pk-muted bulk-progress" role="status">{bulkProgress}</span>
            <div className="bulk-actions">
              <button id="bulk-shrink" type="button" className="pk-btn" disabled={disabledBulk} onClick={bulkShrink}>批量压缩</button>
              <MoreMenu
                label="更多"
                ariaLabel="批量更多操作"
                buttonClassName="pk-btn-sm"
                items={[
                  { key: 'convert', label: '转 WebP', disabled: disabledBulk, onSelect: bulkConvert },
                  { key: 'export', label: '全部另存', disabled: disabledBulk, onSelect: exportAll },
                ]}
              />
            </div>
          </div>
        </section>

        <section className="editor-panel" aria-label="操作面板" id="editor-panel">
          <div className="panel-empty" id="panel-empty" hidden={Boolean(activeItem)}><p>在队列中选择一张图片开始编辑</p></div>
          <div id="panel-body" hidden={!activeItem}>
            <div className="preview-stage">
              <img id="preview" alt="当前图片预览" src={wmPreview ? undefined : previewSrc} ref={(el) => { if (el && !wmPreview && el.src !== previewSrc) el.src = previewSrc }} />
              <div className="compare-row">
                <span id="file-meta" className="pk-muted pk-mono">{fileMeta}</span>
                <span id="compare-meta" className="pk-mono" hidden></span>
              </div>
            </div>

            <nav className="tabs" aria-label="工具页">
              {TABS.map((name) => (
                <button key={name} type="button" data-tab={name} aria-pressed={tab === name}
                  onClick={() => setTab(name)}>{{
                    compress: '压缩', convert: '格式', resize: '缩放', transform: '旋转裁剪',
                    watermark: '水印', exif: 'EXIF', palette: '色板',
                  }[name]}</button>
              ))}
            </nav>

            <section id="tab-compress" className="tool-tab" aria-label="压缩" hidden={tab !== 'compress'}>
              <div className="mode-seg" role="radiogroup" aria-label="压缩模式">
                <button type="button" data-mode="target" aria-pressed={compressMode === 'target'}
                  onClick={() => setCompressMode('target')}>目标体积</button>
                <button type="button" data-mode="quality" aria-pressed={compressMode === 'quality'}
                  onClick={() => setCompressMode('quality')}>固定质量</button>
              </div>
              <label className="field" id="target-field" htmlFor="target-range" hidden={compressMode !== 'target'}>
                <span className="field-label">目标体积上限 <output id="target-kb">{targetKb}</output> KB</span>
                <input id="target-range" type="range" min="20" max="2048" step="20" value={targetKb}
                  onChange={(e) => setTargetKb(Number(e.target.value))} />
              </label>
              <label className="field" id="quality-field" htmlFor="quality-range" hidden={compressMode !== 'quality'}>
                <span className="field-label">质量 <output id="quality-value">{quality}</output>%</span>
                <input id="quality-range" type="range" min="5" max="100" step="5" value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))} />
              </label>
              <div className="action-row">
                <button id="run-compress" type="button" className="pk-btn pk-btn-primary" onClick={runCompress}>开始压缩</button>
                <span id="compress-progress" className="pk-muted" role="status">{compressProgress}</span>
              </div>
              <p className="error" id="compress-error" role="alert" hidden></p>
            </section>

            <section id="tab-convert" className="tool-tab" hidden={tab !== 'convert'} aria-label="格式转换">
              <span className="field-label">目标格式</span>
              <div className="mode-seg" role="radiogroup" aria-label="目标格式">
                {[['image/png', 'PNG'], ['image/jpeg', 'JPEG'], ['image/webp', 'WebP']].map(([value, label]) => (
                  <button key={value} type="button" data-format={value} aria-pressed={convertFormat === value}
                    onClick={() => setConvertFormat(value)}>{label}</button>
                ))}
              </div>
              <label className="field" htmlFor="convert-quality">
                <span className="field-label">质量（JPEG / WebP）<output id="convert-quality-value">{convertQuality}</output>%</span>
                <input id="convert-quality" type="range" min="5" max="100" step="5" value={convertQuality}
                  onChange={(e) => setConvertQuality(Number(e.target.value))} />
              </label>
              <div className="action-row"><button id="run-convert" type="button" className="pk-btn pk-btn-primary" onClick={runConvert}>转换格式</button></div>
            </section>

            <section id="tab-resize" className="tool-tab" hidden={tab !== 'resize'} aria-label="批量缩放">
              <div className="mode-seg" role="radiogroup" aria-label="缩放方式">
                <button type="button" data-resize="long" aria-pressed={resizeMode === 'long'}
                  onClick={() => { setResizeMode('long'); resizeModeRef.current = 'long'; syncResizeRange() }}>最长边</button>
                <button type="button" data-resize="percent" aria-pressed={resizeMode === 'percent'}
                  onClick={() => { setResizeMode('percent'); resizeModeRef.current = 'percent'; syncResizeRange() }}>百分比</button>
              </div>
              <label className="field" htmlFor="resize-range">
                <span className="field-label"><span id="resize-label">{resizeMode === 'percent' ? '缩放比例' : '最长边'}</span> <output id="resize-value">{resizeValue}</output> px</span>
                <input id="resize-range" type="range" min="16" max={resizeMode === 'percent' ? 200 : 4000}
                  step={resizeMode === 'percent' ? '5' : '16'} value={resizeValue}
                  onChange={(e) => setResizeValue(Number(e.target.value))} />
              </label>
              <div className="preset-row" id="preset-row" aria-label="导出尺寸预设">
                {core.EXPORT_PRESETS.map((preset) => (
                  <button key={preset.id} type="button" className="preset-chip" onClick={() => applyPreset(preset)}>{preset.label}</button>
                ))}
              </div>
              <div className="action-row">
                <button id="run-resize" type="button" className="pk-btn pk-btn-primary" onClick={runResize}>应用缩放</button>
                <button id="preview-resize" type="button" className="pk-btn" onClick={previewResize}>预览尺寸</button>
              </div>
              <p id="resize-preview" className="helper pk-mono">{resizePreview}</p>
            </section>

            <section id="tab-transform" className="tool-tab" hidden={tab !== 'transform'} aria-label="旋转与裁剪">
              <div className="action-row">
                <button id="rotate-cw" type="button" className="pk-btn" title="顺时针 90°" onClick={() => setRotate((r) => (r + 90) % 360)}>旋转 90°</button>
                <button id="flip-x" type="button" className="pk-btn" title="水平翻转" onClick={() => setFlipX((v) => !v)}>翻转 ⇄</button>
                <button id="flip-y" type="button" className="pk-btn" title="垂直翻转" onClick={() => setFlipY((v) => !v)}>翻转 ⇅</button>
                <MoreMenu
                  label="⋯"
                  ariaLabel="变换更多操作"
                  items={[{ key: 'reset', label: '复位变换', onSelect: resetTransformState }]}
                />
              </div>
              <span className="field-label">裁剪：在预览图上拖出框选区域（松开完成）</span>
              <div className="crop-stage" id="crop-stage" ref={cropStageRef}
                onPointerDown={onCropPointerDown} onPointerMove={onCropPointerMove}
                onPointerUp={endCrop} onPointerCancel={endCrop}>
                <img id="crop-image" ref={cropImageRef} alt="裁剪预览" src={previewSrc} />
                <div id="crop-box" className="crop-box" hidden={!cropBox}
                  style={cropBox ? {
                    left: `${cropBox.left}px`, top: `${cropBox.top}px`,
                    width: `${cropBox.width}px`, height: `${cropBox.height}px`,
                  } : undefined}></div>
              </div>
              <div className="action-row">
                <span id="crop-info" className="pk-muted pk-mono">{cropInfo}</span>
                <button id="apply-crop" type="button" className="pk-btn" disabled={!(crop && crop.width > 1 && crop.height > 1)} onClick={applyCrop}>应用裁剪</button>
              </div>
            </section>

            <section id="tab-watermark" className="tool-tab" hidden={tab !== 'watermark'} aria-label="文字水印">
              <label className="field"><span className="field-label">水印文字</span>
                <input id="wm-text" maxLength={60} placeholder="例如：@eNest" value={wmText}
                  onChange={(e) => setWmText(e.target.value)} /></label>
              <div className="grid-2">
                <label className="field" htmlFor="wm-opacity"><span className="field-label">透明度 <output id="wm-opacity-value">{wmOpacity}</output>%</span>
                  <input id="wm-opacity" type="range" min="5" max="100" step="5" value={wmOpacity}
                    onChange={(e) => setWmOpacity(Number(e.target.value))} /></label>
                <label className="field" htmlFor="wm-size"><span className="field-label">字号 <output id="wm-size-value">{wmSize}</output> px</span>
                  <input id="wm-size" type="range" min="10" max="200" step="2" value={wmSize}
                    onChange={(e) => setWmSize(Number(e.target.value))} /></label>
              </div>
              <span className="field-label">位置（九宫格）</span>
              <div id="wm-grid" className="wm-grid" role="radiogroup" aria-label="水印位置">
                {core.WATERMARK_SLOTS.map((slot) => (
                  <button key={slot} type="button" data-slot={slot} aria-pressed={slot === wmSlot} aria-label={slot}
                    onClick={() => setWmSlot(slot)}></button>
                ))}
              </div>
              <div className="action-row">
                <button id="wm-toggle" type="button" className="pk-btn" aria-pressed={wmPreview} onClick={toggleWmPreview}>{wmPreview ? '关闭预览' : '叠加预览'}</button>
                <button id="wm-apply" type="button" className="pk-btn pk-btn-primary" onClick={applyWatermark}>写入水印</button>
              </div>
            </section>

            <section id="tab-exif" className="tool-tab" hidden={tab !== 'exif'} aria-label="EXIF 元数据">
              <div className="action-row">
                <button id="exif-read" type="button" className="pk-btn" onClick={readExif}>读取 EXIF</button>
                <MoreMenu
                  label="⋯"
                  ariaLabel="EXIF 更多操作"
                  items={[{ key: 'export', label: '清除元数据导出', onSelect: exportNoExif }]}
                />
              </div>
              <div id="exif-list" className="exif-list" aria-live="polite">
                {exifRows && (exifRows.length === 0
                  ? <div className="exif-empty">未发现 EXIF 信息（可能已被清除，或该格式不携带）</div>
                  : exifRows.map(([label, value]) => (
                    <div key={label} className="exif-row"><dt>{label}</dt><dd>{value}</dd></div>
                  )))}
              </div>
              <p className="helper">清除元数据导出会重绘像素，剥离全部 EXIF / GPS 信息。</p>
            </section>

            <section id="tab-palette" className="tool-tab" hidden={tab !== 'palette'} aria-label="色板提取">
              <div className="action-row"><button id="palette-run" type="button" className="pk-btn pk-btn-primary" onClick={runPalette}>提取主色</button></div>
              <div id="palette-list" className="palette-list" aria-live="polite">
                {palette && (palette.length === 0
                  ? <p className="helper">点击「提取主色」生成 6 色色板。</p>
                  : palette.map((entry) => (
                    <button key={entry.hex} type="button" className="swatch" onClick={() => copyHex(entry.hex)}>
                      <span className="color" style={{ background: entry.hex }}></span>
                      <span className="hex">{entry.hex}</span>
                      <span className="share">{`${Math.round(entry.count / palette.reduce((sum, e) => sum + e.count, 0) * 100)}% 占比`}</span>
                    </button>
                  )))}
              </div>
            </section>

            <div className="result-bar" id="result-bar" hidden={!lastResult}>
              <span id="result-badge" className={'badge ' + (resultRatio && resultRatio.startsWith('-') ? 'ok' : 'bad')} hidden={!lastResult}>
                {lastResult ? (resultRatio ? `体积 ${resultRatio}` : '完成') : ''}
              </span>
              <span id="result-meta" className="pk-muted pk-mono">
                {lastResult ? `${lastResult.width}×${lastResult.height} · ${core.formatBytes(lastResult.bytes)} · ${lastResult.label}` : ''}
              </span>
              <span className="result-actions">
                <button id="use-result" type="button" className="pk-btn pk-btn-primary" disabled={busy} onClick={useResult}>替换当前图</button>
                <MoreMenu
                  label="更多"
                  ariaLabel="结果另存"
                  buttonClassName="pk-btn-sm"
                  items={[
                    { key: 'save', label: '另存结果', disabled: busy, onSelect: saveResult },
                    { key: 'pin', label: '贴图', disabled: busy, onSelect: pinResult },
                  ]}
                />
              </span>
            </div>
          </div>
        </section>
      </div>

      <footer><span id="footer-hint"></span><button type="button" className="text-button" data-open-settings>图片工具箱设置</button></footer>
    </main>
  )
}
