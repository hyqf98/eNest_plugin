import { bindFileInput, readDroppedFiles } from '@enest/plugin-kit/file-inputs'
/* 图片工具箱：队列 + 操作面板。导入走 click（localFiles.pick → 句柄）与 FileReader，
   拖拽走 localFiles.fromDrop（返回句柄），剪贴板走 clipboard.readImage。
   重处理（压缩迭代 / 色板 / 缩放）分帧让出主线程。 */
;(function () {
  const api = window.enest || window.zapi
  const core = window.ImageCore
  const $ = (id) => document.getElementById(id)
  const kit = PluginKit.create({
    title: '图片工具箱',
    height: 520,
    quickPlaceholder: '添加图片压缩、转格式、加水印…',
    defaults: { followShellTheme: true, targetKb: 200, quickFormat: 'image/jpeg', autoPin: false },
    onQuery,
    onAction
  })
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const status = (text) => { $('status').textContent = text }
  const fail = (error) => { const text = String(error?.message || error); status(text); kit.toast(text, 'error') }
  const run = (fn) => Promise.resolve().then(fn).catch(fail)

  let items = [], activeId = '', busy = false
  let saveQueue = Promise.resolve(), initialized = false
  let lastResult = null, tab = 'compress'
  let compressMode = 'target', convertFormat = 'image/jpeg', resizeMode = 'long'
  let rotate = 0, flipX = false, flipY = false
  let crop = null, cropDrag = null, wmSlot = 'bottom-right', wmPreview = false, paletteCache = null

  // ---------- 持久化（仅元数据，不含大图；原图按需重读 blob） ----------
  function persist() {
    const snapshot = items.map(({ id, name, mime, bytes, width, height, blobId, dataUrl }) => ({
      id, name, mime, bytes, width, height, blobId: blobId || '', dataUrl: blobId ? '' : (dataUrl || '')
    }))
    saveQueue = saveQueue.catch(() => {}).then(() => kit.save('imagetools_queue_v1', snapshot))
    saveQueue.catch(() => {})
    return saveQueue
  }

  async function itemData(item) {
    if (!item.blobId) return item.dataUrl
    const blob = await api?.storage?.blobs?.get?.(item.blobId)
    if (!blob?.dataUrl) throw new Error('原图缓存已失效，请重新导入该图片')
    return blob.dataUrl
  }

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
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(`${core.FORMAT_LABEL[mime] || mime} 编码失败`)), mime, quality)
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

  // ---------- 导入三通道 ----------
  const ACCEPT = ['.png', '.jpg', '.jpeg', '.webp']
  function checkName(name) {
    const lower = String(name || '').toLowerCase()
    return ACCEPT.some(ext => lower.endsWith(ext))
  }

  async function importDataUrl(dataUrl, name, bytes) {
    const image = await loadImage(dataUrl)
    const mime = /^data:([^;]+)/.exec(dataUrl)?.[1] || 'image/png'
    if (!core.SUPPORTED_MIME.includes(mime)) throw new Error(`不支持的格式：${mime}（仅 PNG / JPEG / WebP）`)
    const item = {
      id: uid(), name: String(name || '图片').slice(0, 80), mime, bytes: bytes || Math.round(dataUrl.length * 0.75),
      width: image.naturalWidth, height: image.naturalHeight, blobId: '', dataUrl: ''
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
    const thumb = makeThumb(image)
    items = [item, ...items.filter(entry => entry.name !== item.name || entry.bytes !== item.bytes)].slice(0, 24)
    thumbs.set(item.id, thumb)
    render()
    void persist()
    return item
  }

  const thumbs = new Map()
  function makeThumb(image) {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 200 / image.naturalWidth)
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.72)
  }

  async function importFiles(files) {
    const list = Array.from(files || []).filter(file => file)
    if (!list.length) return
    let done = 0
    status(`正在导入 ${list.length} 张…`)
    for (const file of list) {
      if (!checkName(file.name)) { kit.toast(`不支持的格式：${file.name}（仅 PNG / JPEG / WebP）`, 'error'); continue }
      try { await importDataUrl(await readFileAsDataUrl(file), file.name, file.size); done += 1 } catch (error) { kit.toast(`${file.name}：${error.message}`, 'error') }
      if (done % 3 === 0) await core.yieldFrame()
    }
    status(done ? `已导入 ${done} 张图片` : '未导入图片')
  }

  async function importClipboard() {
    if (!api?.clipboard?.readImage) throw new Error('剪贴板图片需要在 eNest 中使用')
    const image = await api.clipboard.readImage()
    if (!image?.dataUrl) { status('剪贴板中没有图片'); kit.toast('剪贴板中没有图片', 'error'); return }
    await importDataUrl(image.dataUrl, `剪贴板图片 ${new Date().toLocaleString('sv-SE')}`, null)
    status('已从剪贴板导入')
  }

  // ---------- 队列渲染 ----------
  function render() {
    $('empty-state').hidden = items.length > 0
    $('work-layout').hidden = !items.length
    $('queue-count').textContent = `${items.length} 张`
    $('clear-queue').disabled = !items.length
    for (const id of ['bulk-shrink', 'bulk-convert', 'export-all']) $(id).disabled = !items.length || busy
    const grid = $('thumb-grid'); grid.replaceChildren()
    items.forEach(item => {
      const card = document.createElement('button')
      card.className = `thumb${item.id === activeId ? ' selected' : ''}${item.busy ? ' processing' : ''}`
      card.setAttribute('aria-label', `选择 ${item.name}`)
      const box = document.createElement('span'); box.className = 'box'
      const img = document.createElement('img'); img.src = thumbs.get(item.id) || ''; img.alt = ''
      box.append(img)
      const meta = document.createElement('span'); meta.className = 'meta'
      const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name
      const info = document.createElement('span'); info.className = 'info'
      const fmt = document.createElement('span'); fmt.className = 'fmt'; fmt.textContent = core.FORMAT_LABEL[item.mime] || 'IMG'
      info.append(fmt, document.createTextNode(`${item.width}×${item.height} · ${core.formatBytes(item.bytes)}`))
      meta.append(name, info)
      card.append(box, meta)
      card.onclick = () => { activeId = item.id; void run(() => openItem(item)) }
      grid.append(card)
    })
    syncPanel()
    syncResult()
  }

  function syncPanel() {
    const item = currentItem()
    const has = Boolean(item)
    $('panel-empty').hidden = has
    $('panel-body').hidden = !has
    if (has && item.id !== activeId) activeId = item.id
  }

  function currentItem() { return items.find(item => item.id === activeId) }

  async function openItem(item) {
    resetTransformState()
    paletteCache = null
    $('result-bar').hidden = true; lastResult = null; syncResult()
    try { await loadImage(await itemData(item)); renderPreview(item); render() }
    catch (error) { fail(error); render() }
  }

  function renderPreview(item) {
    $('panel-empty').hidden = true; $('panel-body').hidden = false
    const data = thumbs.get(item.id) || ''
    if (data) { $('preview').src = data; $('crop-image').src = data }
    $('file-meta').textContent = `${item.name} · ${item.width}×${item.height} · ${core.formatBytes(item.bytes)}`
    renderCropInfo()
  }

  function resetTransformState() {
    rotate = 0; flipX = false; flipY = false; crop = null; cropDrag = null
    $('crop-box').hidden = true
    renderCropInfo()
  }

  // ---------- 工具页切换 ----------
  function showTab(next) {
    tab = next
    for (const name of ['compress', 'convert', 'resize', 'transform', 'watermark', 'exif', 'palette']) {
      $(`tab-${name}`).hidden = name !== next
    }
    document.querySelectorAll('.tabs [data-tab]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tab === next)))
  }
  document.querySelectorAll('.tabs [data-tab]').forEach(button => { button.onclick = () => showTab(button.dataset.tab) })

  // ---------- 压缩 ----------
  function syncCompressMode() {
    $('target-field').hidden = compressMode !== 'target'
    $('quality-field').hidden = compressMode !== 'quality'
    document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === compressMode)))
  }
  document.querySelectorAll('[data-mode]').forEach(button => { button.onclick = () => { compressMode = button.dataset.mode; syncCompressMode() } })
  $('target-range').oninput = () => { $('target-kb').value = $('target-range').value }
  $('quality-range').oninput = () => { $('quality-value').value = $('quality-range').value }

  function drawScaled(image, width, height) {
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    canvas.getContext('2d').drawImage(image, 0, 0, width, height)
    return canvas
  }

  async function withItem(fn) {
    const item = currentItem()
    if (!item) throw new Error('请先在队列中选择一张图片')
    if (busy) return
    busy = true; item.busy = true; render()
    try { await fn(item) } finally { busy = false; item.busy = false; render() }
  }

  $('run-compress').onclick = () => void run(() => withItem(async item => {
    const image = await loadImage(await itemData(item))
    const mime = item.mime === 'image/png' ? 'image/jpeg' : item.mime
    const canvas = drawScaled(image, item.width, item.height)
    const encode = quality => canvasToBlob(canvas, mime, quality).then(blob => blob ? { blob, bytes: blob.size } : null)
    $('compress-progress').textContent = '正在迭代质量…'
    let result
    if (compressMode === 'target') {
      const targetBytes = Number($('target-range').value) * 1024
      result = await core.compressToTarget({ encode, targetBytes })
      if (!result) throw new Error('压缩失败：无法编码')
    } else {
      const quality = Number($('quality-range').value) / 100
      const encoded = await encode(quality)
      if (!encoded) throw new Error('压缩失败：无法编码')
      result = { ...encoded, quality, saturated: false }
    }
    const dataUrl = await blobToDataUrl(result.blob)
    setResult({
      dataUrl, mime, bytes: result.bytes,
      width: item.width, height: item.height,
      label: `质量 ${Math.round(result.quality * 100)}%${result.saturated ? ' · 已到质量上限' : ''}`,
      before: item.bytes
    })
    $('compress-progress').textContent = `完成：${core.formatBytes(item.bytes)} → ${core.formatBytes(result.bytes)}`
  }))

  // ---------- 格式转换 ----------
  document.querySelectorAll('[data-format]').forEach(button => {
    button.onclick = () => {
      convertFormat = button.dataset.format
      document.querySelectorAll('[data-format]').forEach(entry => entry.setAttribute('aria-pressed', String(entry.dataset.format === convertFormat)))
    }
  })
  $('convert-quality').oninput = () => { $('convert-quality-value').value = $('convert-quality').value }

  $('run-convert').onclick = () => void run(() => withItem(async item => {
    const image = await loadImage(await itemData(item))
    const canvas = drawScaled(image, item.width, item.height)
    const quality = Number($('convert-quality').value) / 100
    const blob = await canvasToBlob(canvas, convertFormat, quality)
    setResult({
      dataUrl: await blobToDataUrl(blob), mime: convertFormat, bytes: blob.size,
      width: item.width, height: item.height,
      label: `${core.FORMAT_LABEL[convertFormat]} · 质量 ${Math.round(quality * 100)}%`,
      before: item.bytes
    })
    status(`已转换为 ${core.FORMAT_LABEL[convertFormat]}`)
  }))

  // ---------- 缩放 ----------
  document.querySelectorAll('[data-resize]').forEach(button => {
    button.onclick = () => {
      resizeMode = button.dataset.resize
      document.querySelectorAll('[data-resize]').forEach(entry => entry.setAttribute('aria-pressed', String(entry.dataset.resize === resizeMode)))
      syncResizeRange()
    }
  })
  function syncResizeRange() {
    const item = currentItem()
    const max = resizeMode === 'percent' ? 200 : 4000
    $('resize-range').max = String(max)
    $('resize-range').step = resizeMode === 'percent' ? '5' : '16'
    $('resize-range').value = resizeMode === 'percent' ? '50' : String(Math.min(1280, item?.width || 1280))
    $('resize-label').textContent = resizeMode === 'percent' ? '缩放比例' : '最长边'
    $('resize-value').value = $('resize-range').value
  }
  $('resize-range').oninput = () => { $('resize-value').value = $('resize-range').value }
  // 导出尺寸预设：一键落到滑条并预览
  for (const preset of core.EXPORT_PRESETS) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'preset-chip'; button.textContent = preset.label
    button.onclick = () => {
      const item = currentItem()
      if (!item) { kit.toast('请先选择图片', 'error'); return }
      if (preset.id === 'original') {
        resizeMode = 'long'
        document.querySelectorAll('[data-resize]').forEach(entry => entry.setAttribute('aria-pressed', String(entry.dataset.resize === resizeMode)))
        syncResizeRange()
        $('resize-range').value = String(Math.max(item.width, item.height))
      } else {
        resizeMode = 'long'
        document.querySelectorAll('[data-resize]').forEach(entry => entry.setAttribute('aria-pressed', String(entry.dataset.resize === resizeMode)))
        syncResizeRange()
        $('resize-range').value = String(preset.id === 'icon' ? 256 : preset.id === 'cover' ? 1200 : preset.id === 'hd' ? 1280 : 1920)
      }
      $('resize-value').value = $('resize-range').value
      $('preview-resize').click()
    }
    $('preset-row').append(button)
  }
  $('preview-resize').onclick = () => {
    const item = currentItem(); if (!item) { kit.toast('请先选择图片', 'error'); return }
    try {
      const next = core.scaleSize(item.width, item.height, resizeMode, Number($('resize-range').value))
      $('resize-preview').textContent = `${item.width}×${item.height} → ${next.width}×${next.height}`
    } catch (error) { $('resize-preview').textContent = error.message }
  }
  $('run-resize').onclick = () => void run(() => withItem(async item => {
    const next = core.scaleSize(item.width, item.height, resizeMode, Number($('resize-range').value))
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

  // ---------- 旋转 / 翻转 / 裁剪 ----------
  $('rotate-cw').onclick = () => { rotate = (rotate + 90) % 360; renderCropInfo() }
  $('flip-x').onclick = () => { flipX = !flipX; renderCropInfo() }
  $('flip-y').onclick = () => { flipY = !flipY; renderCropInfo() }
  $('reset-transform').onclick = () => { resetTransformState() }

  function renderCropInfo() {
    const plan = core.transformPlan({ rotate, flipX, flipY, width: currentItem()?.width || 0, height: currentItem()?.height || 0 })
    const parts = []
    if (rotate) parts.push(`旋转 ${rotate}°`)
    if (flipX) parts.push('水平翻转')
    if (flipY) parts.push('垂直翻转')
    const base = parts.length ? parts.join(' · ') + ' · ' : ''
    $('crop-info').textContent = crop ? `${base}裁剪 ${crop.width}×${crop.height}` : `${base || '变换：'}未框选`
    $('apply-crop').disabled = !(crop && crop.width > 1 && crop.height > 1)
  }

  // 框选坐标基于显示图 → 原图映射
  function stageRect() { return $('crop-image').getBoundingClientRect() }
  function toNatural(point) {
    const rect = stageRect(), item = currentItem()
    if (!rect.width || !item) return { x: 0, y: 0 }
    return {
      x: Math.round(Math.max(0, Math.min(item.width, (point.x - rect.left) / rect.width * item.width))),
      y: Math.round(Math.max(0, Math.min(item.height, (point.y - rect.top) / rect.height * item.height)))
    }
  }
  function renderCropBox() {
    const box = $('crop-box'), rect = stageRect(), item = currentItem()
    if (!crop || !rect.width || !item) { box.hidden = true; return }
    box.hidden = false
    box.style.left = `${(crop.x / item.width) * rect.width}px`
    box.style.top = `${(crop.y / item.height) * rect.height}px`
    box.style.width = `${(crop.width / item.width) * rect.width}px`
    box.style.height = `${(crop.height / item.height) * rect.height}px`
  }
  $('crop-stage').addEventListener('pointerdown', event => {
    if (event.button !== 0 || !currentItem()) return
    cropDrag = toNatural({ x: event.clientX, y: event.clientY })
    crop = { x: cropDrag.x, y: cropDrag.y, width: 0, height: 0 }
    $('crop-stage').classList.add('armed'); $('crop-stage').setPointerCapture(event.pointerId)
  })
  $('crop-stage').addEventListener('pointermove', event => {
    if (!cropDrag) return
    const point = toNatural({ x: event.clientX, y: event.clientY })
    const x1 = Math.min(cropDrag.x, point.x), x2 = Math.max(cropDrag.x, point.x)
    const y1 = Math.min(cropDrag.y, point.y), y2 = Math.max(cropDrag.y, point.y)
    crop = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
    renderCropBox(); renderCropInfo()
  })
  const endCrop = () => { cropDrag = null; $('crop-stage').classList.remove('armed') }
  $('crop-stage').addEventListener('pointerup', endCrop)
  $('crop-stage').addEventListener('pointercancel', endCrop)

  $('apply-crop').onclick = () => void run(() => withItem(async item => {
    if (!crop) throw new Error('请先在预览图上框选区域')
    const image = await loadImage(await itemData(item))
    const canvas = document.createElement('canvas')
    canvas.width = crop.width; canvas.height = crop.height
    const ctx = canvas.getContext('2d')
    ctx.save()
    core.applyTransform(ctx, image, core.transformPlan({ rotate, flipX, flipY, width: item.width, height: item.height }), flipX, flipY)
    ctx.restore()
    // applyTransform 以中心为轴；裁剪坐标也随旋转/翻转映射到该坐标系
    const plan = core.transformPlan({ rotate, flipX, flipY, width: item.width, height: item.height })
    const mapped = mapCropToTransformed(crop, item, plan)
    const output = document.createElement('canvas')
    output.width = mapped.width; output.height = mapped.height
    output.getContext('2d').drawImage(canvas, -mapped.x, -mapped.y)
    const blob = await canvasToBlob(output, item.mime, 0.95)
    setResult({
      dataUrl: await blobToDataUrl(blob), mime: item.mime, bytes: blob.size,
      width: mapped.width, height: mapped.height,
      label: `裁剪 ${crop.width}×${crop.height}`,
      before: item.bytes
    })
  }))

  function mapCropToTransformed(cropRect, item, plan) {
    // 在“变换后的图像坐标系”中求包围盒
    const corners = [[cropRect.x, cropRect.y], [cropRect.x + cropRect.width, cropRect.y], [cropRect.x, cropRect.y + cropRect.height], [cropRect.x + cropRect.width, cropRect.y + cropRect.height]]
    const w = item.width, h = item.height
    const transformed = corners.map(([x, y]) => {
      let px = x - w / 2, py = y - h / 2
      for (let i = 0; i < plan.quarter; i += 1) { const temp = px; px = -py; py = temp } // 逆推：绘制时正向旋转
      if (flipX) px = -px
      if (flipY) py = -py
      return [px + plan.width / 2, py + plan.height / 2]
    })
    const xs = transformed.map(p => p[0]), ys = transformed.map(p => p[1])
    const x1 = Math.max(0, Math.floor(Math.min(...xs))), y1 = Math.max(0, Math.floor(Math.min(...ys)))
    const x2 = Math.min(plan.width, Math.ceil(Math.max(...xs))), y2 = Math.min(plan.height, Math.ceil(Math.max(...ys)))
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  }

  // ---------- 水印 ----------
  const wmGrid = $('wm-grid')
  core.WATERMARK_SLOTS.forEach(slot => {
    const button = document.createElement('button')
    button.dataset.slot = slot
    button.setAttribute('aria-pressed', String(slot === wmSlot))
    button.setAttribute('aria-label', slot)
    button.onclick = () => {
      wmSlot = slot
      wmGrid.querySelectorAll('button').forEach(entry => entry.setAttribute('aria-pressed', String(entry.dataset.slot === slot)))
      if (wmPreview) renderWatermarkPreview()
    }
    wmGrid.append(button)
  })
  $('wm-opacity').oninput = () => { $('wm-opacity-value').value = $('wm-opacity').value; if (wmPreview) renderWatermarkPreview() }
  $('wm-size').oninput = () => { $('wm-size-value').value = $('wm-size').value; if (wmPreview) renderWatermarkPreview() }
  $('wm-text').oninput = () => { if (wmPreview) renderWatermarkPreview() }

  function drawWatermark(canvas) {
    const text = $('wm-text').value.trim()
    if (!text) return
    const { alpha, size } = core.watermarkStyle({ opacity: $('wm-opacity').value, fontSize: $('wm-size').value })
    const ctx = canvas.getContext('2d')
    const anchor = core.watermarkAnchor(wmSlot)
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
  }

  async function renderWatermarkPreview() {
    const item = currentItem(); if (!item) return
    const image = await loadImage(thumbs.get(item.id) || await itemData(item))
    const canvas = drawScaled(image, image.naturalWidth, image.naturalHeight)
    drawWatermark(canvas)
    $('preview').src = canvas.toDataURL('image/png')
    $('wm-toggle').textContent = '关闭预览'
  }
  $('wm-toggle').onclick = () => {
    wmPreview = !wmPreview
    $('wm-toggle').setAttribute('aria-pressed', String(wmPreview))
    if (wmPreview) void run(renderWatermarkPreview)
    else { const item = currentItem(); if (item) { $('preview').src = thumbs.get(item.id) || '' }; $('wm-toggle').textContent = '叠加预览' }
  }
  $('wm-apply').onclick = () => void run(() => withItem(async item => {
    const text = $('wm-text').value.trim()
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

  // ---------- EXIF ----------
  async function readArrayBuffer(item) {
    const dataUrl = await itemData(item)
    const base64 = dataUrl.split(',')[1] || ''
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  $('exif-read').onclick = () => void run(() => withItem(async item => {
    if (item.mime !== 'image/jpeg') { renderExif({}); kit.toast('EXIF 主要存在于 JPEG；PNG / WebP 通常无此信息', 'info'); return }
    renderExif(core.exifSummary(core.parseExif(await readArrayBuffer(item))))
    status('EXIF 读取完成')
  }))
  function renderExif(summary) {
    const list = $('exif-list'); list.replaceChildren()
    const labels = { camera: '相机', time: '拍摄时间', orientation: '方向', exposure: '曝光', aperture: '光圈', iso: '感光度', focal: '焦距', gps: 'GPS' }
    const entries = Object.entries(summary)
    if (!entries.length) { list.append(Object.assign(document.createElement('div'), { className: 'exif-empty', textContent: '未发现 EXIF 信息（可能已被清除，或该格式不携带）' })); return }
    for (const [key, value] of entries) {
      const row = document.createElement('div'); row.className = 'exif-row'
      const dt = document.createElement('dt'); dt.textContent = labels[key] || key
      const dd = document.createElement('dd'); dd.textContent = String(value)
      row.append(dt, dd); list.append(row)
    }
  }
  $('exif-export').onclick = () => void run(() => withItem(async item => {
    const image = await loadImage(await itemData(item))
    const canvas = drawScaled(image, item.width, item.height)
    const dataUrl = canvas.toDataURL('image/png')
    setResult({ dataUrl, mime: 'image/png', bytes: Math.round(dataUrl.length * 0.75), width: item.width, height: item.height, label: '已清除元数据（PNG 重绘）', before: item.bytes })
    status('已重绘并剥离元数据')
  }))

  // ---------- 色板 ----------
  $('palette-run').onclick = () => void run(() => withItem(async item => {
    status('正在提取主色…')
    const image = await loadImage(await itemData(item))
    const canvas = drawScaled(image, Math.min(120, item.width), Math.max(1, Math.round(Math.min(120, item.width) * item.height / item.width)))
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    await core.yieldFrame()
    paletteCache = core.paletteFromPixels(data, 6)
    renderPalette()
    status(`已提取 ${paletteCache.length} 个主色，点击复制 HEX`)
  }))
  function renderPalette() {
    const list = $('palette-list'); list.replaceChildren()
    const palette = paletteCache || []
    if (!palette.length) { list.append(Object.assign(document.createElement('p'), { className: 'helper', textContent: '点击「提取主色」生成 6 色色板。' })); return }
    const total = palette.reduce((sum, entry) => sum + entry.count, 0)
    for (const entry of palette) {
      const button = document.createElement('button'); button.className = 'swatch'
      const color = document.createElement('span'); color.className = 'color'; color.style.background = entry.hex
      const hex = document.createElement('span'); hex.className = 'hex'; hex.textContent = entry.hex
      const share = document.createElement('span'); share.className = 'share'; share.textContent = `${Math.round(entry.count / total * 100)}% 占比`
      button.append(color, hex, share)
      button.onclick = () => void run(async () => { await kit.copy(entry.hex); status(`已复制 ${entry.hex}`) })
      list.append(button)
    }
  }

  // ---------- 结果条 ----------
  function setResult(result) {
    lastResult = result
    syncResult()
  }
  function syncResult() {
    const has = Boolean(lastResult)
    $('result-bar').hidden = !has
    if (!has) return
    for (const id of ['use-result', 'save-result', 'pin-result']) $(id).disabled = busy
    const badge = $('result-badge'); badge.hidden = false
    const ratio = core.ratioText(lastResult.before, lastResult.bytes)
    if (ratio && ratio.startsWith('-')) { badge.className = 'badge ok'; badge.textContent = `体积 ${ratio}` }
    else if (ratio) { badge.className = 'badge bad'; badge.textContent = `体积 ${ratio}` }
    else { badge.className = 'badge ok'; badge.textContent = '完成'; badge.hidden = false }
    $('result-meta').textContent = `${lastResult.width}×${lastResult.height} · ${core.formatBytes(lastResult.bytes)} · ${lastResult.label}`
  }
  $('use-result').onclick = () => void run(async () => {
    if (!lastResult) return
    const base = currentItem()?.name || '图片'
    const item = await importDataUrl(lastResult.dataUrl, `${base} · ${lastResult.label || '输出'}`, lastResult.bytes)
    activeId = item.id
    lastResult = null; $('result-bar').hidden = true
    status('输出已替换为当前图片')
  })
  $('save-result').onclick = () => void run(async () => {
    if (!lastResult) return
    const ext = lastResult.mime === 'image/webp' ? 'webp' : lastResult.mime === 'image/jpeg' ? 'jpg' : 'png'
    await kit.saveFile(`imagetools-${Date.now()}.${ext}`, lastResult.dataUrl)
  })
  $('pin-result').onclick = () => void run(async () => {
    if (!lastResult) return
    if (!api?.pin?.open) throw new Error('贴图需要在 eNest 中使用')
    await api.pin.open({ dataUrl: lastResult.dataUrl, width: 380, title: '图片工具箱' })
    status('已创建贴图')
  })

  // ---------- 批量（带进度反馈与逐项状态） ----------
  function progressText(text) { $('bulk-progress').textContent = text }
  $('bulk-shrink').onclick = () => void run(async () => {
    const targetBytes = Number($('target-range').value) * 1024
    const total = items.length
    let done = 0
    progressText(core.batchProgress(0, total).text)
    for (const [index, item] of items.entries()) {
      item.busy = true; render()
      try {
        const image = await loadImage(await itemData(item))
        const mime = item.mime === 'image/png' ? 'image/jpeg' : item.mime
        const canvas = drawScaled(image, item.width, item.height)
        const result = await core.compressToTarget({ encode: q => canvasToBlob(canvas, mime, q).then(blob => blob ? { blob, bytes: blob.size } : null), targetBytes })
        if (result) {
          await importDataUrl(await blobToDataUrl(result.blob), core.batchName(item.name, '压缩', mime === 'image/webp' ? 'webp' : 'jpg'), result.bytes)
          done += 1
        }
      } catch (error) { kit.toast(`${item.name}：${error.message}`, 'error') }
      item.busy = false
      progressText(core.batchProgress(index + 1, total).text)
      render()
      await core.yieldFrame()
    }
    status(`批量压缩完成 ${done}/${total} 张`)
    kit.toast(done === total ? `批量压缩完成（${done} 张）` : `批量压缩完成 ${done}/${total} 张`, done ? 'success' : 'info')
    setTimeout(() => progressText(''), 2400)
  })
  $('bulk-convert').onclick = () => void run(async () => {
    const total = items.length
    let done = 0
    progressText(core.batchProgress(0, total).text)
    for (const [index, item] of items.entries()) {
      item.busy = true; render()
      try {
        const image = await loadImage(await itemData(item))
        const canvas = drawScaled(image, item.width, item.height)
        const blob = await canvasToBlob(canvas, 'image/webp', 0.9)
        await importDataUrl(await blobToDataUrl(blob), core.batchName(item.name, '', 'webp'), blob.size)
        done += 1
      } catch (error) { kit.toast(`${item.name}：${error.message}`, 'error') }
      item.busy = false
      progressText(core.batchProgress(index + 1, total).text)
      render()
      await core.yieldFrame()
    }
    status(`已批量转换 ${done} 张为 WebP`)
    kit.toast(done ? `已转换 ${done} 张为 WebP` : '没有可转换的图片', done ? 'success' : 'info')
    setTimeout(() => progressText(''), 2400)
  })
  const stripExt = name => String(name || '图片').replace(/\.[^.]+$/, '')
  $('export-all').onclick = () => void run(async () => {
    const total = items.length
    progressText(core.batchProgress(0, total).text)
    let done = 0
    for (const [index, item] of items.entries()) {
      const ext = item.mime === 'image/webp' ? 'webp' : item.mime === 'image/jpeg' ? 'jpg' : 'png'
      try { await kit.saveFile(`${stripExt(item.name)}.${ext}`, await itemData(item)); done += 1 } catch (error) { kit.toast(`${item.name}：${error.message}`, 'error') }
      progressText(core.batchProgress(index + 1, total).text)
      await core.yieldFrame()
    }
    status(`已依次另存 ${done}/${total} 张`)
    setTimeout(() => progressText(''), 2400)
  })
  $('clear-queue').onclick = () => {
    items = []; activeId = ''; thumbs.clear()
    $('panel-empty').hidden = false; $('panel-body').hidden = true
    render(); void persist(); status('队列已清空')
  }

  // ---------- 导入接线 ----------
  bindFileInput(document.getElementById('file-input'), { api, onError: error => kit.toast(error.message, 'error') })
  $('add-files').onclick = $('empty-add').onclick = () => $('file-input').click()
  $('from-clipboard').onclick = $('empty-clipboard').onclick = () => void run(importClipboard)
  $('file-input').onchange = () => {
    const files = Array.from($('file-input').files || [])
    $('file-input').value = ''
    void run(() => importFiles(files))
  }

  // 拖拽先确认句柄，再读取宿主授权返回的字节。
  const app = document.querySelector('.image-app')
  let dragDepth = 0
  app.addEventListener('dragover', event => { event.preventDefault(); app.classList.add('dragging'); $('drop-zone')?.classList.add('armed') })
  app.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { app.classList.remove('dragging'); $('drop-zone')?.classList.remove('armed') } })
  app.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0
    app.classList.remove('dragging'); $('drop-zone')?.classList.remove('armed')
    const files = Array.from(event.dataTransfer?.files || [])
    if (!files.length) return
    void run(async () => {
      await importFiles(await readDroppedFiles(files, { api }))
    })
  })

  // ---------- Quick 行为 ----------
  function onQuery(value) { if (kit.mode === 'quick' && value && /^data:image\//.test(value)) void run(() => importDataUrl(value, 'Quick 图片', null)) }
  function onAction(action) {
    if (action !== 'submit') return
    const item = currentItem()
    if (!item) { run(importClipboard); return }
    void run(async () => {
      const image = await loadImage(await itemData(item))
      const mime = kit.settings.quickFormat || 'image/jpeg'
      const canvas = drawScaled(image, item.width, item.height)
      const targetBytes = Math.max(20, Number(kit.settings.targetKb) || 200) * 1024
      const result = await core.compressToTarget({ encode: q => canvasToBlob(canvas, mime, q).then(blob => blob ? { blob, bytes: blob.size } : null), targetBytes })
      if (!result) throw new Error('快速压缩失败')
      const dataUrl = await blobToDataUrl(result.blob)
      await importDataUrl(dataUrl, `${stripExt(item.name)} · 快速压缩`, result.bytes)
      kit.toast(`已压缩至 ${core.formatBytes(result.bytes)}`, 'success')
      if (kit.settings.autoPin && api?.pin?.open) await api.pin.open({ dataUrl, width: 360, title: '快速压缩' })
    })
  }

  // ---------- 模式与设置 ----------
  function syncHeight() {
    if (kit.mode !== 'quick') return
    const height = Math.min(640, Math.max(320, Math.round(document.body.scrollHeight + 8)))
    void run(async () => { await api?.ui?.setHeight?.(height) })
  }
  let heightTimer = 0
  const queueHeight = () => { clearTimeout(heightTimer); heightTimer = setTimeout(syncHeight, 120) }
  new MutationObserver(queueHeight).observe(document.body, { childList: true, subtree: true })

  kit.onMode(() => { render(); queueHeight() })
  kit.onSettings((settings, key) => {
    if (key === 'followShellTheme') applyThemePreference(settings.followShellTheme)
  })

  function applyThemePreference(follow) {
    // followShellTheme=true 时壳子已注入 token；false 时由壳子按 preferredColorScheme 强制，两者均无需本地覆盖。
    document.documentElement.dataset.followTheme = follow === false ? 'off' : 'on'
  }

  // ---------- 初始化（可重入） ----------
  async function init() {
    if (initialized) return
    initialized = true
    if (!core) { fail('核心模块加载失败'); return }
    showTab('compress'); syncCompressMode(); syncResizeRange()
    try {
      const saved = await kit.load('imagetools_queue_v1', [])
      if (Array.isArray(saved)) {
        for (const raw of saved.slice(0, 24)) {
          if (!raw?.id || !raw.name) continue
          const item = { id: raw.id, name: raw.name, mime: raw.mime || 'image/png', bytes: raw.bytes || 0, width: raw.width || 0, height: raw.height || 0, blobId: raw.blobId || '', dataUrl: raw.dataUrl || '', busy: false }
          if (!item.blobId && !item.dataUrl) continue
          try {
            const image = await loadImage(await itemData(item))
            thumbs.set(item.id, makeThumb(image))
            items.push(item)
          } catch { /* 缓存失效的条目跳过 */ }
        }
      }
    } catch { /* 首次运行无历史 */ }
    render()
    status(items.length ? `已恢复 ${items.length} 张图片` : '添加图片开始处理')
  }
  if (api?.onEnter) api.onEnter(() => void run(init))
  void run(init)
})()
