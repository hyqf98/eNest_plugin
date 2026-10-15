import { bindFileInput } from '@enest/plugin-kit/file-inputs'
/* The color tool keeps its own layout; PluginKit supplies only host integration. */
;(function () {
  const api = window.enest || window.zapi
  const math = window.ColorMath
  const $ = (id) => document.getElementById(id)
  let current = math.parse('#447766'), background = math.parse('#FFFFFF'), history = [], palettes = []
  let activePaletteId = '', query = '', selected = 0, pixel = null, picking = false, captureRevision = 0
  let lastPick = null, saveQueue = Promise.resolve(), clearArmed = false, deleteArmed = false
  let harmonyKind = 'triadic', view = 'recent'
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const kit = PluginKit.create({ title: '取色器', height: 470, quickPlaceholder: '输入 HEX、RGB、HSL，或查找颜色…', defaults: { copyFormat: 'hex', autoCopy: true, historyLimit: 48 }, onQuery, onAction })
  const status = (text) => { $('status').textContent = text }
  const fail = (error) => { const text = String(error?.message || error); status(text); kit.toast(text, 'error') }
  const run = (fn) => Promise.resolve().then(fn).catch(fail)
  const format = (color, type = kit.settings.copyFormat) => (math[type] || math.hex)(color)
  const historyLimit = () => Math.max(12, Math.min(120, Number(kit.settings.historyLimit) || 48))
  const activePalette = () => palettes.find((p) => p.id === activePaletteId) || palettes[0]

  // ---------- 持久化（key 与旧版一致，向后兼容） ----------
  function persist() {
    const data = structuredClone({ palettes, activePaletteId, history, current, background, harmonyKind })
    saveQueue = saveQueue.catch(() => {}).then(() => kit.save('color_workspace_v2', data))
    saveQueue.catch(fail)
    return saveQueue
  }

  // ---------- 工作区视图切换 ----------
  function showView(next) {
    view = next
    for (const name of ['recent', 'harmony', 'contrast', 'palette', 'pick']) {
      $(`view-${name}`).hidden = name !== next
    }
    document.querySelectorAll('.work-seg [data-view]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.view === next)))
  }
  document.querySelectorAll('.work-seg [data-view]').forEach((button) => { button.onclick = () => showView(button.dataset.view) })

  // ---------- 当前颜色（所有调整 1:1 实时反映） ----------
  function setCurrent(color, syncInput = true) {
    current = math.normalized(color)
    if (syncInput) $('color-input').value = math.hex(current)
    $('input-error').hidden = true
    $('color-input').removeAttribute('aria-invalid')
    renderCurrent()
  }
  function renderCurrent() {
    $('swatch').style.background = math.rgb(current)
    $('swatch-label').textContent = math.hex(current)
    for (const type of ['hex', 'rgb', 'hsl', 'oklch']) $(`value-${type}`).textContent = math[type](current)
    $('alpha').value = String(Math.round(current.a * 100))
    $('alpha-value').value = `${Math.round(current.a * 100)}%`
    renderContrast()
    renderHarmony()
  }

  // ---------- 和谐色 ----------
  function renderHarmony() {
    const grid = $('harmony-grid'); grid.replaceChildren()
    document.querySelectorAll('[data-harmony]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.harmony === harmonyKind)))
    const list = math.harmony(current, harmonyKind)
    for (const item of list) {
      const card = document.createElement('div'); card.className = 'harmony-card'
      const paint = document.createElement('span'); paint.className = 'paint'; paint.style.background = math.rgb(item.color)
      const row = document.createElement('span'); row.className = 'row'
      const role = document.createElement('span'); role.className = 'role'; role.textContent = item.role
      const code = document.createElement('button'); code.className = 'code pk-mono'; code.textContent = math.hex(item.color); code.title = '复制 HEX'
      code.onclick = () => void run(() => copyColor(item.color, 'hex'))
      row.append(role, code)
      const pick = document.createElement('button'); pick.className = 'pick'; pick.textContent = '设为当前色'
      pick.onclick = () => { setCurrent(item.color); remember(item.color) }
      card.append(paint, row, pick)
      grid.append(card)
    }
  }
  document.querySelectorAll('[data-harmony]').forEach((button) => { button.onclick = () => { harmonyKind = button.dataset.harmony; renderHarmony(); void persist() } })
  $('harmony-to-palette').onclick = () => {
    const palette = activePalette(); if (!palette) return
    const list = math.harmony(current, harmonyKind)
    if (palette.colors.length + list.length > 100) return kit.toast('每组色板最多 100 色', 'warn')
    palette.colors.push(...list.map((item, index) => ({ id: uid(), name: `${item.role} ${index + 1}`, color: { ...item.color } })))
    renderPalettes(); void persist(); status(`已加入 ${list.length} 个和谐色`)
  }
  $('harmony-css').onclick = () => void run(async () => {
    const list = math.harmony(current, harmonyKind)
    const css = `:root {\n${list.map((item) => `  --harmony-${item.role}: ${math.rgb(item.color)}; /* ${math.hex(item.color)} */`).join('\n')}\n}\n`
    await kit.copy(css)
    status('已复制和谐色 CSS 变量')
  })

  // ---------- 对比度 ----------
  function renderContrast() {
    const ratio = math.contrast(current, background)
    const bg = math.composite(background), fg = math.composite(current, bg)
    $('contrast-preview').style.background = math.rgb(bg)
    $('contrast-preview').style.color = math.rgb(fg)
    $('contrast-ratio').textContent = `${ratio.toFixed(2)}:1`
    $('contrast-summary').textContent = ratio >= 7 ? '适合正文阅读' : ratio >= 4.5 ? '正文达到 AA' : ratio >= 3 ? '仅大字达到 AA' : '建议提高明暗差异'
    for (const [id, threshold, label] of [['aa-normal', 4.5, '正文 AA'], ['aa-large', 3, '大字 AA'], ['aaa-normal', 7, '正文 AAA']]) {
      const pass = ratio >= threshold
      $(id).textContent = `${label} ${pass ? '通过' : '未通过'}`
      $(id).className = pass ? 'pass' : 'fail'
    }
  }

  async function copyColor(color, type) {
    const text = format(color, type)
    await kit.copy(text)
    status(`已复制 ${text}`)
  }
  function remember(color = current) {
    const entry = math.normalized(color), key = math.hex(entry)
    history = [entry, ...history.filter((c) => math.hex(c) !== key)].slice(0, historyLimit())
    renderHistory()
    void persist()
  }

  // ---------- 最近颜色 ----------
  function filteredHistory() {
    const q = query.trim().toLowerCase()
    return !q || math.parse(q) ? history : history.filter((c) => [math.hex(c), math.rgb(c), math.hsl(c), math.oklch(c)].some((s) => s.toLowerCase().includes(q)))
  }
  function renderHistory() {
    const root = $('recent-colors'); root.replaceChildren()
    const entries = filteredHistory(); selected = Math.max(0, Math.min(selected, entries.length - 1))
    $('recent-count').textContent = `${history.length} 色`
    $('clear-history').disabled = !history.length
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = query ? '没有匹配的颜色，支持直接输入色值。' : '屏幕取色或点击「收录」，建立你的常用颜色。'; root.append(empty); return }
    entries.forEach((color, index) => {
      const button = document.createElement('button'); button.className = `recent-color checker${index === selected ? ' selected' : ''}`
      button.title = math.hex(color); button.setAttribute('aria-label', `选择并复制 ${math.hex(color)}`); button.setAttribute('aria-pressed', String(index === selected))
      const swatch = document.createElement('span'); swatch.style.background = math.rgb(color); button.append(swatch)
      button.onclick = () => { selected = index; setCurrent(color); renderHistory(); void run(() => copyColor(color)); void persist() }
      root.append(button)
    })
  }

  // ---------- 命名色板 ----------
  function renderPalettes() {
    const select = $('palette-select'); select.replaceChildren()
    palettes.forEach((palette) => { const option = document.createElement('option'); option.value = palette.id; option.textContent = palette.name; select.append(option) })
    const active = activePalette(); activePaletteId = active?.id || ''; select.value = activePaletteId
    PluginKit.upgradeSelects() // 重建 option 并程序化赋值后，立即同步自定义下拉触发器标签
    $('palette-count').textContent = `${palettes.length} 组`
    const root = $('palette-colors'); root.replaceChildren()
    if (!active?.colors.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '添加当前颜色，为配色方案留下名字。'; root.append(empty) }
    for (const entry of active?.colors || []) {
      const row = document.createElement('div'); row.className = 'palette-row'
      const swatch = document.createElement('button'); swatch.className = 'palette-swatch checker'; swatch.setAttribute('aria-label', `选取 ${entry.name || math.hex(entry.color)}`)
      const paint = document.createElement('span'); paint.style.background = math.rgb(entry.color); swatch.append(paint)
      swatch.onclick = () => { setCurrent(entry.color); void persist() }
      const name = document.createElement('input'); name.value = entry.name; name.maxLength = 40; name.setAttribute('aria-label', `${math.hex(entry.color)} 的颜色名称`); name.placeholder = '未命名'
      name.onchange = () => { entry.name = name.value.trim().slice(0, 40); void persist() }
      const code = document.createElement('button'); code.className = 'palette-code pk-mono'; code.textContent = math.hex(entry.color); code.title = '复制颜色'; code.onclick = () => void run(() => copyColor(entry.color))
      const remove = document.createElement('button'); remove.className = 'remove-color'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${entry.name || math.hex(entry.color)}`)
      remove.onclick = () => { active.colors = active.colors.filter((c) => c.id !== entry.id); renderPalettes(); void persist() }
      row.append(swatch, name, code, remove); root.append(row)
    }
  }

  // ---------- Quick 查询 ----------
  function onQuery(value) {
    query = value; selected = 0
    const parsed = math.parse(value)
    if (parsed) setCurrent(parsed)
    renderHistory()
  }
  function onAction(action) {
    const name = typeof action === 'string' ? action : action?.action
    const entries = filteredHistory()
    if (name === 'next' || name === 'previous') {
      selected = Math.max(0, Math.min(entries.length - 1, selected + (name === 'next' ? 1 : -1))); renderHistory()
      $('recent-colors').children[selected]?.scrollIntoView({ block: 'nearest' })
    } else if (name === 'submit') {
      const c = math.parse(query) || entries[selected] || current
      setCurrent(c); remember(c); void run(() => copyColor(c))
    } else if (name === 'clear') { query = ''; renderHistory() }
  }

  // ---------- 输入接线 ----------
  $('color-input').addEventListener('input', (event) => {
    const color = math.parse(event.target.value)
    $('input-error').hidden = !!color; event.target.setAttribute('aria-invalid', String(!color))
    if (color) setCurrent(color, false)
  })
  $('color-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing && math.parse(event.target.value)) { remember(); void run(() => copyColor(current)); void persist() } })
  $('color-input').addEventListener('change', () => { if (math.parse($('color-input').value)) void persist() })
  $('alpha').oninput = () => setCurrent({ ...current, a: Number($('alpha').value) / 100 })
  $('alpha').onchange = () => void persist()
  document.querySelectorAll('[data-format]').forEach((button) => { button.onclick = () => void run(() => copyColor(current, button.dataset.format)) })
  $('remember').onclick = () => { if (!math.parse($('color-input').value)) return; remember(); status('已收录到最近颜色') }
  $('background').oninput = () => { const color = math.parse($('background').value); $('background-error').hidden = !!color; if (color) { background = color; renderContrast(); void persist() } }
  $('swap').onclick = () => { const previous = current; setCurrent(background); background = previous; $('background').value = math.hex(background); renderContrast(); void persist() }
  $('palette-select').onchange = () => { activePaletteId = $('palette-select').value; deleteArmed = false; $('delete-palette').textContent = '删除'; renderPalettes(); void persist() }
  $('create-palette').onclick = () => {
    const name = $('palette-name').value.trim()
    if (!name) { $('palette-name').focus(); return }
    if (palettes.length >= 30) return kit.toast('最多保存 30 组色板，请先导出并整理', 'warn')
    const palette = { id: uid(), name, colors: [] }; palettes.push(palette); activePaletteId = palette.id; $('palette-name').value = ''; renderPalettes(); void persist()
  }
  $('add-color').onclick = () => {
    const palette = activePalette()
    if (!palette) return
    if (palette.colors.length >= 100) return kit.toast('每组色板最多 100 色', 'warn')
    palette.colors.push({ id: uid(), name: $('color-name').value.trim(), color: { ...current } }); $('color-name').value = ''; renderPalettes(); void persist()
  }
  $('delete-palette').onclick = () => {
    if (!deleteArmed) { deleteArmed = true; $('delete-palette').textContent = '再次点击删除'; return }
    palettes = palettes.filter((p) => p.id !== activePaletteId)
    if (!palettes.length) palettes.push({ id: uid(), name: '我的色板', colors: [] })
    activePaletteId = palettes[0].id; deleteArmed = false; $('delete-palette').textContent = '删除'; renderPalettes(); void persist()
  }
  $('clear-history').onclick = () => {
    if (!clearArmed) { clearArmed = true; $('clear-history').textContent = '确认清空'; return }
    history = []; clearArmed = false; $('clear-history').textContent = '清空'; renderHistory(); void persist()
  }
  $('export-css').onclick = () => void run(() => { const p = activePalette(); return kit.saveText(`${p.name}.css`, math.cssPalette(p.name, p.colors)) })
  $('export-json').onclick = () => void run(() => { const p = activePalette(); return kit.saveText(`${p.name}.json`, JSON.stringify({ version: 1, name: p.name, colors: p.colors.map(({ name, color }) => ({ name, color: math.hex(color) })) }, null, 2)) })
  bindFileInput(document.getElementById('image-file'), { api, onError: error => kit.toast(error.message, 'error') })
  bindFileInput(document.getElementById('palette-file'), { api, maxBytes: 1024 * 1024, onError: error => kit.toast(error.message, 'error') })
  $('import-palette').onclick = () => $('palette-file').click()
  $('palette-file').onchange = () => void run(async () => {
    const file = $('palette-file').files[0]; $('palette-file').value = ''; if (!file) return
    if (file.size > 1024 * 1024) throw new Error('色板文件需小于 1 MB')
    const data = JSON.parse(await file.text())
    if (!data || typeof data.name !== 'string' || !Array.isArray(data.colors) || data.colors.length > 100 || palettes.length >= 30) throw new Error('色板格式无效：需要名称和不超过 100 个颜色')
    const colors = data.colors.map((item) => { const color = math.parse(typeof item === 'string' ? item : item?.color); if (!color) throw new Error('色板包含无效色值'); return { id: uid(), name: typeof item?.name === 'string' ? item.name.slice(0, 40) : '', color } })
    const palette = { id: uid(), name: data.name.trim().slice(0, 40) || '导入色板', colors }; palettes.push(palette); activePaletteId = palette.id; renderPalettes(); await persist(); status(`已导入 ${colors.length} 色`)
  })

  // ---------- 图片取色（放大镜 + 键盘微调） ----------
  function stopPick() {
    captureRevision += 1; picking = false; pixel = null; lastPick = null
    showView('pick')
    document.body.classList.remove('picking'); $('shot').width = 1; $('shot').height = 1; $('confirm-pick').disabled = true
    void api?.ui?.setInputContext?.('workbench')
    status('已退出取色')
  }
  async function loadShot(dataUrl, revision) {
    const image = new Image()
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('图片无法读取')); image.src = dataUrl })
    if (revision !== captureRevision) return
    if (image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024) throw new Error('图片像素过大，请使用小于 6400 万像素的图片')
    const canvas = $('shot'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0)
    showView('pick'); picking = true; document.body.classList.add('picking')
    void api?.ui?.setInputContext?.('overlay')
    status(`${canvas.width} × ${canvas.height} · 点击图片收录颜色`)
    canvas.focus()
  }
  $('capture').onclick = () => void run(async () => {
    const revision = ++captureRevision; $('capture').disabled = true; status('正在获取屏幕…')
    try { if (!api?.screen?.capture) throw new Error('屏幕取色需在 eNest 中使用'); const shot = await api.screen.capture(); await loadShot(shot.dataUrl, revision) } finally { $('capture').disabled = false }
  })
  $('open-image').onclick = () => $('image-file').click()
  $('image-file').onchange = () => void run(async () => {
    const file = $('image-file').files[0]; $('image-file').value = ''; if (!file) return
    if (file.size > 32 * 1024 * 1024) throw new Error('图片需小于 32 MB')
    const revision = ++captureRevision
    const url = URL.createObjectURL(file)
    try { await loadShot(url, revision) } finally { URL.revokeObjectURL(url) }
  })
  function sampleAt(x, y) {
    if (!picking) return
    const canvas = $('shot'); x = Math.max(0, Math.min(canvas.width - 1, Math.round(x))); y = Math.max(0, Math.min(canvas.height - 1, Math.round(y)))
    const ctx = canvas.getContext('2d', { willReadFrequently: true }), rgba = ctx.getImageData(x, y, 1, 1).data
    pixel = { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] / 255 }; lastPick = { x, y }
    $('sample-value').textContent = math.hex(pixel); $('sample-position').textContent = `${x}, ${y}`; $('confirm-pick').disabled = false
    const mag = $('magnifier').getContext('2d'); mag.clearRect(0, 0, 110, 110); mag.imageSmoothingEnabled = false
    mag.fillStyle = '#dfe3df'; mag.fillRect(0, 0, 110, 110)
    mag.drawImage(canvas, x - 5, y - 5, 11, 11, 0, 0, 110, 110)
    mag.strokeStyle = '#fff'; mag.lineWidth = 2; mag.strokeRect(49, 49, 12, 12); mag.strokeStyle = '#192a20'; mag.lineWidth = 1; mag.strokeRect(50, 50, 10, 10)
  }
  $('shot').onpointermove = (event) => { const box = event.currentTarget.getBoundingClientRect(); sampleAt((event.clientX - box.left) * event.currentTarget.width / box.width, (event.clientY - box.top) * event.currentTarget.height / box.height) }
  function commitPick() { if (!pixel) return; setCurrent(pixel); remember(); status(`已收录 ${math.hex(pixel)}`); if (kit.settings.autoCopy !== false) void run(() => copyColor(pixel)) }
  $('shot').onclick = commitPick; $('confirm-pick').onclick = commitPick; $('stop-pick').onclick = stopPick
  $('shot').onkeydown = (event) => {
    if (event.isComposing) return
    const pos = lastPick || { x: Math.floor($('shot').width / 2), y: Math.floor($('shot').height / 2) }, step = event.shiftKey ? 10 : 1
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
    if (delta) { event.preventDefault(); sampleAt(pos.x + delta[0], pos.y + delta[1]) }
    if (event.key === 'Enter') { event.preventDefault(); commitPick() }
  }
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && picking) { event.preventDefault(); event.stopPropagation(); stopPick() } }, true)

  // ---------- 模式与初始化 ----------
  kit.onMode((mode) => {
    $('mode-hint').textContent = mode === 'quick' ? 'Enter 复制 · ↑ ↓ 选择最近颜色' : ''
    if (mode === 'quick') showView('recent')
  })
  kit.onSettings(() => { history = history.slice(0, historyLimit()); renderHistory() })
  api?.onOut?.(() => { if (picking) stopPick() })
  api?.onBeforeClose?.(() => saveQueue)
  run(async () => {
    await kit.ready
    const state = await kit.load('color_workspace_v2', null)
    if (state && typeof state === 'object') {
      const valid = (color) => color && ['r', 'g', 'b'].every((k) => Number.isFinite(color[k])) && Number.isFinite(color.a ?? 1)
      history = Array.isArray(state.history) ? state.history.filter(valid).map(math.normalized).slice(0, historyLimit()) : []
      palettes = Array.isArray(state.palettes) ? state.palettes.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.colors)).slice(0, 30).map((p) => ({ id: String(p.id || uid()), name: p.name.slice(0, 40), colors: p.colors.filter((c) => c && valid(c.color)).slice(0, 100).map((c) => ({ id: String(c.id || uid()), name: String(c.name || '').slice(0, 40), color: math.normalized(c.color) })) })) : []
      activePaletteId = String(state.activePaletteId || '')
      if (valid(state.current)) current = math.normalized(state.current)
      if (valid(state.background)) background = math.normalized(state.background)
      if (['complement', 'analogous', 'triadic', 'square'].includes(state.harmonyKind)) harmonyKind = state.harmonyKind
    } else {
      const legacy = await kit.load('colors_v1', [])
      history = Array.isArray(legacy) ? legacy.filter((c) => c && ['r', 'g', 'b'].every((k) => Number.isFinite(c[k]))).map(math.normalized).slice(0, historyLimit()) : []
    }
    if (!palettes.length) palettes = [{ id: uid(), name: '我的色板', colors: [] }]
    setCurrent(current); $('background').value = math.hex(background); renderHistory(); renderPalettes(); showView('recent')
  })
  renderCurrent(); renderHistory(); renderPalettes(); showView('recent')
})()
