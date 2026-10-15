import { bindFileInput } from '@enest/plugin-kit/file-inputs'
/* Screen capture, edit, recording and pins share data, not an imposed page layout. */
;(function () {
  const api = window.enest || window.zapi
  const { selection, EditHistory, elapsed } = window.ScreenEditorCore
  const $ = (id) => document.getElementById(id)
  const edits = new EditHistory(40)
  let history = [], recordings = [], drafts = {}, pinNames = {}, activeId = '', original = null
  let tab = 'capture', tool = 'arrow', query = '', selected = 0, busy = false, drawStart = null, pointerId = null
  let recSession = null, recStartedAt = 0, recTimer = null, recBusy = false, hidden = false, closePinsArmed = false, clearArmed = false
  let saveQueue = Promise.resolve(), imageRevision = 0, initialized = false, pendingCode = null
  const kit = PluginKit.create({ title: '屏幕助手', height: 480, quickPlaceholder: '查找截图名称或日期…', defaults: { historyLimit: 24, captureAction: 'preview', withAudio: false }, onQuery: onQuery, onAction: onAction })
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const stamp = () => new Date().toLocaleString('sv-SE').replaceAll(':', '-')
  const status = (text) => { $('status').textContent = text }
  const fail = (error) => { const text = String(error?.message || error); status(text); kit.toast(text, 'error') }
  const run = (fn) => Promise.resolve().then(fn).catch(fail)
  const maxHistory = () => Math.max(8, Math.min(80, Number(kit.settings.historyLimit) || 24))
  const currentItem = () => history.find((item) => item.id === activeId)
  const empty = (text) => { const el = document.createElement('p'); el.className = 'empty'; el.textContent = text; return el }
  function persist() {
    const snapshot = structuredClone({ history, recordings, drafts, activeId, pinNames })
    saveQueue = saveQueue.catch(() => {}).then(() => kit.save('screen_workspace_v2', snapshot))
    saveQueue.catch(fail)
    return saveQueue
  }
  function saveDraft() {
    if (!activeId) return
    if (edits.operations.length) drafts[activeId] = { operations: edits.operations, cursor: edits.cursor }
    else delete drafts[activeId]
    void persist()
  }
  function syncControls() {
    for (const id of ['copy-image', 'pin-image', 'export-image']) $(id).disabled = !original || busy
    $('undo').disabled = !edits.canUndo || busy; $('redo').disabled = !edits.canRedo || busy
    $('reset-edits').disabled = !edits.canUndo || busy; $('save-edit').disabled = !edits.canUndo || busy
    for (const id of ['capture', 'capture-full', 'empty-capture', 'import-image', 'pin-capture']) $(id).disabled = busy
    document.querySelectorAll('[data-tool]').forEach((button) => { button.disabled = !original || busy })
    $('edit-state').textContent = edits.cursor ? `${edits.cursor} 步编辑 · 原图保留` : currentItem()?.legacy ? '旧版压缩缩略图' : '原始图片'
  }
  async function work(fn) {
    if (busy) return
    busy = true; syncControls()
    try { return await fn() } finally { busy = false; syncControls() }
  }
  function showTab(next) {
    tab = next
    for (const name of ['capture', 'record', 'pin', 'history']) $(`${name}-panel`).hidden = next !== name
    document.querySelectorAll('[data-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tab === next)))
    if (next === 'pin') void run(refreshPins)
    if (next === 'history') renderHistory()
    if (next === 'record') renderRecording()
  }
  document.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => showTab(button.dataset.tab) })
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => { if (image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024) reject(new Error('图片需小于 6400 万像素')); else resolve(image) }; image.onerror = () => reject(new Error('图片无法读取')); image.src = dataUrl })
  }
  function thumbnail(image) {
    const canvas = document.createElement('canvas'), scale = Math.min(1, 240 / image.naturalWidth, 160 / image.naturalHeight)
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.7)
  }
  async function originalData(item) {
    if (item.legacy) return item.thumb
    if (!api?.storage?.blobs?.get) throw new Error('当前宿主不支持读取原图，请更新 eNest')
    const blob = await api.storage.blobs.get(item.blobId)
    if (!blob?.dataUrl) throw new Error('原图文件已不存在，可删除此记录')
    return blob.dataUrl
  }
  async function openHistory(item) {
    const revision = ++imageRevision
    const image = await loadImage(await originalData(item))
    if (revision !== imageRevision) return
    original = image; activeId = item.id; edits.clear()
    const draft = drafts[item.id]
    if (draft && Array.isArray(draft.operations)) {
      edits.operations = draft.operations.filter((op) => validOperation(op)).slice(0, edits.limit)
      edits.cursor = Math.max(0, Math.min(edits.operations.length, Number(draft.cursor) || 0))
    }
    $('canvas-wrap').hidden = false; $('canvas-empty').hidden = true
    renderCanvas(); showTab('capture'); syncControls(); renderRecent()
    status(item.legacy ? '这是旧版缩略图；新截图会保存完整原图' : `已打开 ${item.name}`)
    void persist()
  }
  function validOperation(op) {
    if (!op || !['crop', 'arrow', 'rect', 'text', 'mosaic'].includes(op.type)) return false
    if (op.type === 'text') return Number.isFinite(op.x) && Number.isFinite(op.y) && typeof op.text === 'string' && Number.isFinite(op.size) && op.size >= 12 && op.size <= 160 && /^#[\da-f]{6}$/i.test(op.color)
    if (op.type === 'arrow') return op.start && op.end && ['x', 'y'].every((key) => Number.isFinite(op.start[key]) && Number.isFinite(op.end[key])) && Number.isFinite(op.lineWidth) && /^#[\da-f]{6}$/i.test(op.color)
    return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(op[key])) && op.width > 0 && op.height > 0 && (op.type !== 'rect' || /^#[\da-f]{6}$/i.test(op.color))
  }
  function arrow(ctx, op) {
    const { start, end } = op, angle = Math.atan2(end.y - start.y, end.x - start.x), length = Math.max(14, op.lineWidth * 4)
    ctx.strokeStyle = op.color; ctx.fillStyle = op.color; ctx.lineWidth = op.lineWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(end.x - length * Math.cos(angle - Math.PI / 6), end.y - length * Math.sin(angle - Math.PI / 6)); ctx.lineTo(end.x - length * Math.cos(angle + Math.PI / 6), end.y - length * Math.sin(angle + Math.PI / 6)); ctx.closePath(); ctx.fill()
  }
  function applyOperation(canvas, op) {
    const ctx = canvas.getContext('2d')
    if (op.type === 'crop') {
      const box = selection({ x: op.x, y: op.y }, { x: op.x + op.width, y: op.y + op.height }, canvas.width, canvas.height)
      if (!box.width || !box.height) return
      const pixels = ctx.getImageData(box.x, box.y, box.width, box.height)
      canvas.width = box.width; canvas.height = box.height; canvas.getContext('2d').putImageData(pixels, 0, 0)
    } else if (op.type === 'arrow') arrow(ctx, op)
    else if (op.type === 'rect') { ctx.strokeStyle = op.color; ctx.lineWidth = op.lineWidth || 6; ctx.strokeRect(op.x, op.y, op.width, op.height) }
    else if (op.type === 'text') { ctx.fillStyle = op.color; ctx.font = `600 ${op.size}px -apple-system, "Segoe UI", sans-serif`; ctx.textBaseline = 'top'; ctx.fillText(op.text, op.x, op.y) }
    else if (op.type === 'mosaic') {
      const box = selection({ x: op.x, y: op.y }, { x: op.x + op.width, y: op.y + op.height }, canvas.width, canvas.height)
      if (!box.width || !box.height) return
      const small = document.createElement('canvas'), block = 18
      small.width = Math.max(1, Math.ceil(box.width / block)); small.height = Math.max(1, Math.ceil(box.height / block))
      small.getContext('2d').drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, small.width, small.height)
      ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, small.width, small.height, box.x, box.y, box.width, box.height); ctx.restore()
    }
  }
  function renderCanvas() {
    if (!original) return
    const canvas = $('image-canvas'); canvas.width = original.naturalWidth; canvas.height = original.naturalHeight
    canvas.getContext('2d').drawImage(original, 0, 0)
    for (const operation of edits.current()) applyOperation(canvas, operation)
    const overlay = $('overlay-canvas'); overlay.width = canvas.width; overlay.height = canvas.height
    $('image-meta').textContent = `${canvas.width} × ${canvas.height}${currentItem()?.legacy ? ' · 旧版缩略图' : ''}`
    syncControls()
  }
  function commit(operation) {
    if (!edits.push(operation)) { kit.toast('当前图片已达到 40 步编辑，请先保存标注版本后继续', 'warn'); return }
    renderCanvas(); saveDraft()
  }
  function point(event) {
    const canvas = $('overlay-canvas'), bounds = canvas.getBoundingClientRect()
    return { x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)), y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)) }
  }
  function paintPreview(end) {
    const canvas = $('overlay-canvas'), ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!drawStart) return
    const color = $('annotation-color').value, lineWidth = Number($('annotation-width').value)
    if (tool === 'arrow') arrow(ctx, { start: drawStart, end, color, lineWidth })
    else {
      const box = selection(drawStart, end, canvas.width, canvas.height)
      ctx.strokeStyle = color; ctx.lineWidth = lineWidth
      if (tool === 'crop') ctx.setLineDash([8, 6])
      if (tool === 'mosaic') { ctx.fillStyle = 'rgba(95,112,125,.5)'; ctx.fillRect(box.x, box.y, box.width, box.height) }
      ctx.strokeRect(box.x, box.y, box.width, box.height); ctx.setLineDash([])
    }
  }
  function cancelDraw() {
    drawStart = null
    if (pointerId !== null && $('overlay-canvas').hasPointerCapture(pointerId)) $('overlay-canvas').releasePointerCapture(pointerId)
    pointerId = null
    const canvas = $('overlay-canvas'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
    void api?.ui?.setInputContext?.('workbench')
  }
  $('overlay-canvas').onpointerdown = (event) => {
    if (!original || busy || event.button !== 0) return
    const pos = point(event)
    if (tool === 'text') {
      const text = $('annotation-text').value.trim()
      if (!text) { $('annotation-text').focus(); kit.toast('先输入要放置的文字', 'info'); return }
      commit({ type: 'text', x: pos.x, y: pos.y, text, color: $('annotation-color').value, size: Math.max(12, Math.min(160, Number($('text-size').value) || 32)) }); return
    }
    drawStart = pos; pointerId = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId)
    void api?.ui?.setInputContext?.('overlay')
  }
  $('overlay-canvas').onpointermove = (event) => { if (drawStart) paintPreview(point(event)) }
  $('overlay-canvas').onpointerup = (event) => {
    if (!drawStart) return
    const end = point(event), start = drawStart, box = selection(start, end, $('image-canvas').width, $('image-canvas').height)
    cancelDraw()
    if (tool === 'arrow' && Math.hypot(start.x - end.x, start.y - end.y) > 3) commit({ type: tool, start, end, color: $('annotation-color').value, lineWidth: Number($('annotation-width').value) })
    else if (tool !== 'arrow' && box.width >= 3 && box.height >= 3) commit({ type: tool, ...box, color: $('annotation-color').value, lineWidth: Number($('annotation-width').value) })
  }
  $('overlay-canvas').onpointercancel = cancelDraw
  function chooseTool(value) {
    tool = value
    document.querySelectorAll('[data-tool]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tool === value)))
    $('text-options').hidden = value !== 'text'
    $('tool-hint').textContent = { arrow: '在图片上拖动，添加箭头。', rect: '拖动框选需要标出的区域。', text: '输入文字后，点击图片放置。', mosaic: '拖动框选打码区域；导出前请确认敏感信息已遮挡。', crop: '拖动选择保留区域，松开完成裁剪。' }[value]
    if (value === 'text') document.documentElement.dataset.editing = 'true'
  }
  document.querySelectorAll('[data-tool]').forEach((button) => { button.onclick = () => chooseTool(button.dataset.tool) })
  $('toggle-editor').onclick = () => { const open = document.documentElement.dataset.editing !== 'true'; document.documentElement.dataset.editing = String(open); if (open && tool === 'text') $('text-options').hidden = false; $('toggle-editor').textContent = open ? '收起标注' : '标注' }
  $('undo').onclick = () => { edits.undo(); renderCanvas(); saveDraft() }
  $('redo').onclick = () => { edits.redo(); renderCanvas(); saveDraft() }
  $('reset-edits').onclick = () => { edits.clear(); renderCanvas(); saveDraft() }
  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'Escape' && drawStart) { event.preventDefault(); event.stopPropagation(); cancelDraw(); return }
    if (event.target.matches('input,textarea,select') || !original || busy || tab !== 'capture') return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) edits.redo(); else edits.undo(); renderCanvas(); saveDraft(); return }
    // 标注工具快捷键：A 箭头 / R 矩形 / T 文字 / M 马赛克 / C 裁剪（无修饰键，与撤销/重做共存）
    if (!event.metaKey && !event.ctrlKey && !event.altKey && document.documentElement.dataset.editing === 'true') {
      const key = event.key.toLowerCase()
      const toolKeys = { a: 'arrow', r: 'rect', t: 'text', m: 'mosaic', c: 'crop' }
      if (toolKeys[key]) { event.preventDefault(); chooseTool(toolKeys[key]) }
    }
  }, true)
  async function rememberImage(dataUrl, name) {
    if (!api?.storage?.blobs?.put) throw new Error('保存原图需要新版 eNest，请更新宿主后再截图')
    const image = await loadImage(dataUrl), blob = await api.storage.blobs.put({ dataUrl, name })
    const item = { id: uid(), blobId: blob.id, name, ts: Date.now(), width: image.naturalWidth, height: image.naturalHeight, bytes: blob.bytes, thumb: thumbnail(image) }
    const previous = history; history = [item, ...history].slice(0, maxHistory())
    try { await persist() } catch (error) { history = previous; await api.storage.blobs.remove(blob.id).catch(() => {}); throw error }
    const retained = new Set(history.map((entry) => entry.id))
    for (const removed of previous.filter((entry) => !retained.has(entry.id))) { delete drafts[removed.id]; if (removed.blobId) await api.storage.blobs.remove(removed.blobId).catch(() => {}) }
    renderHistory(); renderRecent(); await openHistory(item)
    return item
  }
  async function capture(kind, pinAfter = false) {
    await work(async () => {
      if (!api?.screen?.capture) throw new Error('截图需在 eNest 中使用')
      status(kind === 'region' ? '请选择截图区域…' : '正在截取屏幕…')
      const bounds = kind === 'region' ? await api.screen.selectRegion() : undefined
      if (kind === 'region' && !bounds) { status('已取消截图'); return }
      const shot = await api.screen.capture({ bounds })
      await rememberImage(shot.dataUrl, `截图 ${stamp()}`)
      if (pinAfter || kit.settings.captureAction === 'pin') await pinImage(shot.dataUrl, currentItem()?.name)
      else if (kit.settings.captureAction === 'copy') { await api.clipboard.writeImage(shot.dataUrl); status('原图已保存并复制') }
      else status('原图已保存，可标注、复制或导出')
    })
  }
  $('capture').onclick = () => void run(() => capture('region')); $('empty-capture').onclick = $('capture').onclick
  $('capture-full').onclick = () => void run(() => capture('full'))
  $('copy-image').onclick = () => void run(async () => { await api.clipboard.writeImage($('image-canvas').toDataURL('image/png')); status('已复制当前图片'); kit.toast('已复制图片', 'success') })
  $('export-image').onclick = () => void run(() => kit.saveFile(`${currentItem()?.name || '截图'}.png`, $('image-canvas').toDataURL('image/png')))
  $('save-edit').onclick = () => void run(() => work(async () => { const name = `${currentItem()?.name || '截图'} 标注`; await rememberImage($('image-canvas').toDataURL('image/png'), name); status('已保存独立的标注版本') }))
  function readFile(file) {
    return new Promise((resolve, reject) => { if (file.size > 32 * 1024 * 1024) return reject(new Error('图片需小于 32 MB')); const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file) })
  }
  bindFileInput(document.getElementById('image-file'), { api, onError: error => kit.toast(error.message, 'error') })
  bindFileInput(document.getElementById('pin-file-input'), { api, onError: error => kit.toast(error.message, 'error') })
  $('import-image').onclick = () => $('image-file').click()
  $('image-file').onchange = () => void run(() => work(async () => { const file = $('image-file').files[0]; $('image-file').value = ''; if (file) await rememberImage(await readFile(file), file.name.replace(/\.[^.]+$/, '')) }))
  function filtered() { const value = query.toLowerCase().trim(); return history.filter((item) => !value || `${item.name} ${new Date(item.ts).toLocaleString()}`.toLowerCase().includes(value)) }
  function renderRecent() {
    const root = $('recent-list'); root.replaceChildren()
    for (const item of history.slice(0, 5)) {
      const button = document.createElement('button'); button.className = 'recent-item'; button.title = item.name
      const image = document.createElement('img'); image.src = item.thumb; image.alt = item.name
      const text = document.createElement('span'), title = document.createElement('strong'), meta = document.createElement('small'); title.textContent = item.name; meta.textContent = `${item.width} × ${item.height}${item.legacy ? ' · 缩略图' : ''}`; text.append(title, meta); button.append(image, text); button.onclick = () => void run(() => work(() => openHistory(item))); root.append(button)
    }
    if (!history.length) root.append(empty('截图后可在这里找回原图。'))
    $('history-count').textContent = String(history.length)
  }
  async function removeItem(item) {
    history = history.filter((entry) => entry.id !== item.id); delete drafts[item.id]
    if (activeId === item.id) { activeId = ''; original = null; edits.clear(); $('canvas-wrap').hidden = true; $('canvas-empty').hidden = false; $('image-meta').textContent = '尚无截图'; syncControls() }
    await persist()
    if (item.blobId) await api.storage.blobs.remove(item.blobId)
    renderHistory(); renderRecent()
  }
  function renderHistory() {
    const root = $('history-list'); root.replaceChildren(); const entries = filtered()
    selected = Math.max(0, Math.min(entries.length - 1, selected)); $('clear-history').disabled = !history.length
    if (!entries.length) { root.append(empty(query ? '没有匹配的截图。' : '暂无截图。新截图会保存完整原图。')); return }
    entries.forEach((item, index) => {
      const card = document.createElement('article'); card.className = `history-card${selected === index ? ' selected' : ''}`
      const preview = document.createElement('button'); preview.className = 'history-preview'; preview.title = `打开 ${item.name}`
      const img = document.createElement('img'); img.src = item.thumb; img.alt = item.name; preview.append(img); preview.onclick = () => void run(() => work(() => openHistory(item)))
      const body = document.createElement('div'); body.className = 'history-card-body'
      const title = document.createElement('input'); title.value = item.name; title.maxLength = 100; title.setAttribute('aria-label', '截图名称'); title.onchange = () => { item.name = title.value.trim() || '未命名截图'; title.value = item.name; void persist(); renderRecent() }
      const meta = document.createElement('p'); meta.textContent = `${new Date(item.ts).toLocaleDateString()} · ${item.width}×${item.height} · ${item.legacy ? '旧版缩略图' : `${Math.round((item.bytes || 0) / 1024)} KB 原图`}`
      const actions = document.createElement('div'); actions.className = 'history-card-actions'
      const addAction = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => void run(fn); actions.append(b) }
      addAction('复制', async () => { await api.clipboard.writeImage(await originalData(item)); kit.toast('已复制图片', 'success') })
      addAction('贴图', async () => pinImage(await originalData(item), item.name))
      addAction('导出', async () => kit.saveFile(`${item.name}.png`, await originalData(item)))
      addAction('删除', () => work(() => removeItem(item)))
      body.append(title, meta, actions); card.append(preview, body); root.append(card)
    })
  }
  $('all-history').onclick = () => showTab('history')
  $('history-search').oninput = () => { query = $('history-search').value; selected = 0; renderHistory(); kit.setQuery(query) }
  $('clear-history').onclick = () => {
    if (!clearArmed) { clearArmed = true; $('clear-history').textContent = '确认清空原图'; return }
    clearArmed = false; $('clear-history').textContent = '清空历史'
    void run(() => work(async () => {
      const removed = [...history]; history = []; drafts = {}; activeId = ''; original = null; edits.clear(); $('canvas-wrap').hidden = true; $('canvas-empty').hidden = false; $('image-meta').textContent = '尚无截图'
      await persist(); renderHistory(); renderRecent(); syncControls()
      for (const item of removed) if (item.blobId) await api.storage.blobs.remove(item.blobId)
      status('已清空截图历史')
    }))
  }
  function onQuery(value) { query = value; $('history-search').value = value; selected = 0; if (value.trim()) showTab('history'); renderHistory() }
  function onAction(action) {
    const name = typeof action === 'string' ? action : action?.action
    if (name === 'clear') { query = ''; $('history-search').value = ''; renderHistory(); return }
    if (tab !== 'history') { if (name === 'submit' && !original) void run(() => capture('region')); return }
    const entries = filtered()
    if (name === 'next' || name === 'previous') { selected = Math.max(0, Math.min(entries.length - 1, selected + (name === 'next' ? 1 : -1))); renderHistory(); $('history-list').children[selected]?.scrollIntoView({ block: 'nearest' }) }
    if (name === 'submit' && entries[selected]) void run(() => work(() => openHistory(entries[selected])))
  }
  async function pinImage(dataUrl, name = '贴图') {
    if (!api?.pin?.open) throw new Error('贴图需在 eNest 中使用')
    const result = await api.pin.open({ dataUrl, title: name, width: 420 }); pinNames[result.pinId] = name; await persist(); status('已贴到屏幕'); kit.toast('已创建贴图', 'success'); await refreshPins()
  }
  $('pin-image').onclick = () => void run(() => pinImage($('image-canvas').toDataURL('image/png'), currentItem()?.name))
  $('pin-capture').onclick = () => void run(() => capture('region', true))
  $('pin-clipboard').onclick = () => void run(async () => { const image = await api?.clipboard?.readImage?.(); if (!image?.dataUrl) throw new Error('剪贴板中没有图片'); await pinImage(image.dataUrl, '剪贴板图片') })
  $('pin-file').onclick = () => $('pin-file-input').click()
  $('pin-file-input').onchange = () => void run(async () => { const file = $('pin-file-input').files[0]; $('pin-file-input').value = ''; if (file) { const data = await readFile(file); await loadImage(data); await pinImage(data, file.name) } })
  async function refreshPins() {
    const root = $('pin-list'); root.replaceChildren()
    if (!api?.pin?.list) { root.append(empty('请在 eNest 中查看当前贴图。')); return }
    const pins = await api.pin.list(); $('pin-count').textContent = `${pins.length} 张`; $('close-pins').disabled = !pins.length
    const ids = new Set(pins.map((pin) => pin.pinId)); for (const id of Object.keys(pinNames)) if (!ids.has(id)) delete pinNames[id]
    if (!pins.length) { root.append(empty('暂无贴图。创建后可在这里关闭；拖动贴图窗口可调整位置。')); return }
    pins.forEach((pin, index) => {
      const row = document.createElement('div'); row.className = 'pin-row'
      const title = document.createElement('strong'); title.textContent = pinNames[pin.pinId] || `贴图 ${index + 1}`
      const meta = document.createElement('small'); meta.textContent = String(pin.pinId).slice(0, 8)
      const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => void run(async () => { await api.pin.close(pin.pinId); delete pinNames[pin.pinId]; await persist(); await refreshPins() })
      row.append(title, meta, close); root.append(row)
    })
  }
  $('refresh-pins').onclick = () => void run(refreshPins)
  $('close-pins').onclick = () => {
    if (!closePinsArmed) { closePinsArmed = true; $('close-pins').textContent = '确认全部关闭'; return }
    closePinsArmed = false; $('close-pins').textContent = '全部关闭'; void run(async () => { await api.pin.closeAll(); pinNames = {}; await persist(); await refreshPins() })
  }
  function renderRecording() {
    $('record-timer').textContent = recSession ? elapsed(Date.now() - recStartedAt) : '00:00'
    $('record-label').textContent = recSession ? '正在录制' : '尚未开始录制'
    document.body.classList.toggle('recording', !!recSession); $('record-dot').hidden = !recSession
    $('record-start').disabled = !!recSession || recBusy; $('record-stop').disabled = !recSession || recBusy; $('record-cancel').disabled = !recSession || recBusy; $('record-audio').disabled = !!recSession || recBusy
    clearInterval(recTimer); recTimer = null
    if (recSession && !hidden) recTimer = setInterval(() => { $('record-timer').textContent = elapsed(Date.now() - recStartedAt) }, 500)
  }
  function renderRecordings() {
    const root = $('record-list'); root.replaceChildren()
    if (!recordings.length) { root.append(empty('录制完成后，文件路径与时长会保留在这里。')); return }
    for (const recording of recordings) {
      const row = document.createElement('article'); row.className = 'record-row'
      const title = document.createElement('strong'); title.textContent = `${new Date(recording.ts).toLocaleString()} · ${elapsed(recording.durationMs)} · ${(recording.size / 1024 / 1024).toFixed(1)} MB`
      const path = document.createElement('p'); path.textContent = recording.path
      const copy = document.createElement('button'); copy.textContent = '复制文件路径'; copy.onclick = () => void run(() => kit.copy(recording.path))
      row.append(title, path, copy); root.append(row)
    }
  }
  $('record-start').onclick = () => void run(async () => {
    if (recBusy || recSession) return
    if (!api?.screen?.record) throw new Error('录屏需在 eNest 中使用')
    recBusy = true; renderRecording()
    try {
      const bounds = await api.screen.selectRegion(); if (!bounds) { status('已取消录制'); return }
      const result = await api.screen.record.start({ bounds, withAudio: $('record-audio').checked }); recSession = result.sessionId; recStartedAt = Date.now(); $('record-info').textContent = `录制区域 ${bounds.width} × ${bounds.height}`; status('正在录制，可切换窗口继续工作')
    } finally { recBusy = false; renderRecording() }
  })
  $('record-stop').onclick = () => void run(async () => {
    if (!recSession || recBusy) return
    recBusy = true; renderRecording(); const id = recSession
    try {
      const result = await api.screen.record.stop(id); recSession = null; recordings.unshift({ ...result, ts: Date.now() }); recordings = recordings.slice(0, 30); await persist(); renderRecordings(); $('record-info').textContent = `已保存：${result.path}`; status('录制完成，文件已保存')
    } catch (error) { recSession = null; $('record-info').textContent = '录制未能保存，请检查权限与磁盘空间。'; throw error }
    finally { recBusy = false; renderRecording() }
  })
  $('record-cancel').onclick = () => void run(async () => {
    if (!recSession || recBusy) return
    recBusy = true; renderRecording()
    try { await api.screen.record.cancel(recSession); recSession = null; $('record-info').textContent = '已取消，本次录制不保存。'; status('已取消录制') } finally { recBusy = false; renderRecording() }
  })
  kit.onMode(() => { cancelDraw(); renderRecording() })
  kit.onSettings(() => { if (!recSession) $('record-audio').checked = kit.settings.withAudio === true })
  api?.onOut?.(() => { hidden = true; clearInterval(recTimer); recTimer = null; cancelDraw() })
  function enterCode(code) { if (code === 'record') showTab('record'); else if (code === 'pin') showTab('pin'); else if (code === 'capture') void run(() => capture('region')) }
  api?.onEnter?.(({ code }) => { hidden = false; renderRecording(); if (!initialized) { pendingCode = code; return } enterCode(code) })
  api?.onBeforeClose?.(() => { clearInterval(recTimer); return saveQueue })
  api?.onDestroy?.(() => { clearInterval(recTimer); original = null; $('image-canvas').width = 1; $('overlay-canvas').width = 1 })
  run(async () => {
    await kit.ready
    const state = await kit.load('screen_workspace_v2', null)
    if (state && typeof state === 'object') {
      history = Array.isArray(state.history) ? state.history.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.thumb === 'string' && (typeof item.blobId === 'string' || item.legacy === true)).slice(0, 80) : []
      recordings = Array.isArray(state.recordings) ? state.recordings.filter((item) => item && typeof item.path === 'string' && Number.isFinite(item.durationMs) && Number.isFinite(item.size)).slice(0, 30) : []
      drafts = state.drafts && typeof state.drafts === 'object' ? state.drafts : {}; pinNames = state.pinNames && typeof state.pinNames === 'object' ? state.pinNames : {}; activeId = String(state.activeId || '')
    } else {
      const legacy = await kit.load('sa_history_v1', [])
      history = Array.isArray(legacy) ? legacy.filter((item) => item && typeof item.thumb === 'string').map((item) => ({ id: item.id || uid(), name: '旧版截图', thumb: item.thumb, ts: Number(item.ts) || Date.now(), width: Number(item.w) || 0, height: Number(item.h) || 0, legacy: true })) : []
    }
    $('record-audio').checked = kit.settings.withAudio === true
    renderHistory(); renderRecent(); renderRecordings(); syncControls()
    const item = history.find((entry) => entry.id === activeId)
    if (item) { try { await work(() => openHistory(item)) } catch (error) { fail(error) } }
    initialized = true
    if (pendingCode) { const code = pendingCode; pendingCode = null; enterCode(code) }
  })
  renderRecent(); renderHistory(); renderRecordings(); syncControls()
})()
