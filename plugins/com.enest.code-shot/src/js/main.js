/* 代码截图：粘贴代码 → 轻量 tokenizer 高亮 → canvas 渲染 mac 窗口栏卡片。
   配色全部派生自主题 token（getThemeTokens / onThemeChange）；配置记忆在 storage.local。 */
;(function () {
  const api = window.enest || window.zapi
  const core = window.CodeCore
  const $ = (id) => document.getElementById(id)
  const kit = PluginKit.create({
    title: '代码截图',
    height: 470,
    quickPlaceholder: '粘贴代码生成截图…',
    defaults: { followShellTheme: true, autoDetect: true, scale2x: true },
    onQuery,
    onAction
  })
  const status = (text) => { $('status').textContent = text }
  const fail = (error) => { const text = String(error?.message || error); status(text); kit.toast(text, 'error') }
  const run = (fn) => Promise.resolve().then(fn).catch(fail)

  const PREF_KEY = 'codeshot_config_v1'
  let language = 'javascript', themeMode = 'dark', themeTokens = {}
  let lastDataUrl = null, saveQueue = Promise.resolve(), dirtyTimer = 0, initialized = false

  // ---------- 设置持久化 ----------
  function currentConfig() {
    return {
      language, code: $('code').value,
      title: $('card-title').value,
      background: document.querySelector('[data-bg][aria-pressed="true"]')?.dataset.bg || 'surface',
      padding: Number($('padding').value), radius: Number($('radius').value),
      shadow: Number($('shadow').value), fontSize: Number($('font-size').value),
      showLines: $('show-lines').checked, scale2x: $('scale2x').checked
    }
  }
  function persist() {
    saveQueue = saveQueue.catch(() => {}).then(() => kit.save(PREF_KEY, currentConfig()))
    saveQueue.catch(() => {})
    return saveQueue
  }
  function applyConfig(config) {
    if (!config || typeof config !== 'object') return
    if (config.code && typeof config.code === 'string') $('code').value = config.code.slice(0, 100000)
    if (config.title) $('card-title').value = String(config.title).slice(0, 60)
    if (core.LANGUAGES.some(entry => entry.id === config.language)) language = config.language
    if (['surface', 'plain', 'transparent'].includes(config.background)) setBackground(config.background)
    for (const [id, key] of [['padding', 'padding'], ['radius', 'radius'], ['shadow', 'shadow'], ['font-size', 'fontSize']]) {
      if (Number.isFinite(config[key])) { $(id).value = String(config[key]); syncRangeOutput(id) }
    }
    if (typeof config.showLines === 'boolean') $('show-lines').checked = config.showLines
    $('scale2x').checked = typeof config.scale2x === 'boolean' ? config.scale2x : Boolean(kit.settings.scale2x)
    $('language').value = language
  }

  // ---------- 语言下拉与识别 ----------
  for (const entry of core.LANGUAGES) {
    const option = document.createElement('option')
    option.value = entry.id; option.textContent = entry.label
    $('language').append(option)
  }
  $('language').onchange = () => { language = $('language').value; $('detect-hint').textContent = ''; scheduleRender(); persist() }

  function detect() {
    if (!kit.settings.autoDetect) return
    const found = core.detectLanguage($('code').value, '')
    if (found !== 'plaintext' && found !== language) {
      language = found
      $('language').value = found
      $('detect-hint').textContent = `已识别 ${core.LANGUAGES.find(entry => entry.id === found)?.label || found}`
    } else {
      $('detect-hint').textContent = ''
    }
  }

  // ---------- 主题 token ----------
  function applyTokens(mode, tokens) {
    themeMode = mode === 'light' ? 'light' : 'dark'
    themeTokens = tokens || {}
    scheduleRender()
  }
  void run(async () => {
    try {
      const result = await (api?.theme?.getTokens ? api.theme.getTokens() : api?.ui?.getThemeTokens?.())
      if (result?.mode) applyTokens(result.mode, result.tokens)
    } catch { /* 浏览器直开时用兜底色 */ }
  })
  if (api?.ui?.onThemeChange) api.ui.onThemeChange(({ mode, tokens }) => applyTokens(mode, tokens))

  // ---------- 画布渲染 ----------
  const canvas = $('shot-canvas')
  const ctx = canvas.getContext('2d')

  function setBackground(value) {
    document.querySelectorAll('[data-bg]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.bg === value)))
  }
  document.querySelectorAll('[data-bg]').forEach(button => {
    button.onclick = () => { setBackground(button.dataset.bg); scheduleRender(); persist() }
  })
  function currentBackground() {
    return document.querySelector('[data-bg][aria-pressed="true"]')?.dataset.bg || 'surface'
  }

  function parseColor(value, fallback) {
    const canvasProbe = document.createElement('canvas').getContext('2d')
    if (typeof value !== 'string' || !value.trim()) return fallback
    try { canvasProbe.fillStyle = value.trim() } catch { return fallback }
    return canvasProbe.fillStyle || fallback
  }

  function hexToRgb(value) {
    const raw = parseColor(value, '#000000')
    if (typeof raw !== 'string') return [0, 0, 0]
    const named = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim())
    if (!named) return [0, 0, 0]
    const hex = named[1].length === 3 ? named[1].split('').map(ch => ch + ch).join('') : named[1]
    return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
  }
  function mixOver(base, overlay, alpha) {
    return `rgb(${base.map((channel, index) => Math.round(channel * (1 - alpha) + overlay[index] * alpha)).join(', ')})`
  }

  function renderShot() {
    const code = $('code').value.replace(/\s+$/, '')
    const empty = !code.trim()
    const palette = core.syntaxPalette(themeTokens, themeMode)
    const bgMode = currentBackground()
    const fontSize = Number($('font-size').value)
    const padding = Number($('padding').value)
    const radius = Number($('radius').value)
    const shadowAlpha = Number($('shadow').value) / 100 * 0.45
    const dpr = 2
    const lineHeight = Math.round(fontSize * 1.6)
    const headerHeight = 40
    const gutterWidth = $('show-lines').checked ? Math.round(fontSize * 1.1) * (core.gutterWidth(code.split('\n').length) + 1.5) : 0

    const tokens = core.tokenize(code, language)
    const columns = Math.max(20, core.measure(code))
    const charWidth = Math.round(fontSize * 0.62)
    const bodyWidth = Math.min(1100, columns * charWidth)
    const rows = core.layoutLines(tokens, Math.max(12, Math.floor((bodyWidth - gutterWidth) / charWidth)))
    const width = Math.max(280, Math.round(bodyWidth + padding * 2 + gutterWidth + fontSize * 1.2))
    const contentHeight = Math.max(rows.length, empty ? 2 : rows.length) * lineHeight
    const height = Math.round(headerHeight + padding + contentHeight + padding * 0.6)

    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${Math.min(width, 640)}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    // 卡片底与阴影
    const pageBg = hexToRgb(parseColor(themeTokens['--bg'], themeMode === 'dark' ? '#17191b' : '#f6f6f4'))
    const surfaceRgb = hexToRgb(palette.background)
    ctx.save()
    ctx.shadowColor = `rgba(8, 12, 20, ${shadowAlpha.toFixed(3)})`
    ctx.shadowBlur = 28; ctx.shadowOffsetY = 12
    ctx.fillStyle = bgMode === 'transparent' ? 'transparent' : bgMode === 'plain' ? mixOver(surfaceRgb, [18, 22, 28], themeMode === 'dark' ? 0.18 : 0.03) : palette.background
    roundRect(ctx, 0, 0, width, height, radius)
    if (bgMode !== 'transparent') { ctx.fill(); ctx.shadowColor = 'transparent' }
    ctx.restore()
    if (bgMode === 'transparent') {
      // 透明模式：仅窗口栏有底，代码区透明
      ctx.save(); ctx.fillStyle = palette.header; roundRect(ctx, 0, 0, width, headerHeight, radius); ctx.fill(); ctx.fillRect(0, headerHeight - radius, width, radius); ctx.restore()
    }
    if (bgMode !== 'transparent' && radius > 0) {
      ctx.strokeStyle = palette.border; ctx.lineWidth = 1
      roundRect(ctx, 0.5, 0.5, width - 1, height - 1, radius); ctx.stroke()
    }

    // 窗口栏：mac 三点（中性色）+ 标题
    const dotY = headerHeight / 2
    const dotRadius = 5.5
    paletteDot(palette.dot)
    ;[20, 20 + dotRadius * 3, 20 + dotRadius * 6].forEach(x => { ctx.beginPath(); ctx.arc(x, dotY, dotRadius, 0, Math.PI * 2); ctx.fill() })
    const title = $('card-title').value.trim() || (core.LANGUAGES.find(entry => entry.id === language)?.label || '代码')
    ctx.fillStyle = palette.title
    ctx.font = `500 12px ${monoFont()}`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(title, width / 2, dotY, Math.min(width / 2, 280))

    // 代码体
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.font = `400 ${fontSize}px ${monoFont()}`
    const baseline = headerHeight + padding + fontSize
    rows.forEach((row, index) => {
      const y = baseline + index * lineHeight
      if ($('show-lines').checked && row.number) {
        ctx.fillStyle = palette.gutter
        const label = String(row.number)
        ctx.fillText(label, padding, y)
      }
      let x = padding + gutterWidth
      for (const token of row.tokens) {
        ctx.fillStyle = token.kind === 'plain' ? palette.plain : palette[token.kind] || palette.plain
        ctx.fillText(token.text, x, y)
        x += token.text.length * charWidth
      }
    })

    if (empty) {
      ctx.fillStyle = palette.gutter
      ctx.font = `400 ${fontSize}px ${monoFont()}`
      ctx.fillText('// 在左侧粘贴代码，这里会实时渲染截图卡片', padding + gutterWidth, baseline)
    }

    try { lastDataUrl = canvas.toDataURL('image/png') } catch { lastDataUrl = null }
    for (const id of ['copy-shot', 'save-shot', 'copy-again', 'save-again', 'pin-shot']) $(id).disabled = !lastDataUrl
    status(empty ? '粘贴代码即刻生成' : `已生成 ${width}×${height} 卡片 · ${language}`)
    if (kit.mode === 'quick') syncHeight()
  }
  function paletteDot(value) {
    ctx.fillStyle = parseColor(value, 'rgba(140,146,152,.5)')
  }
  function monoFont() {
    const mono = String(themeTokens['--mono'] || getComputedStyle(document.documentElement).getPropertyValue('--mono') || '').trim()
    return mono ? mono : 'ui-monospace, "SF Mono", Menlo, monospace'
  }
  function roundRect(context, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2))
    context.beginPath()
    context.moveTo(x + r, y)
    context.arcTo(x + width, y, x + width, y + height, r)
    context.arcTo(x + width, y + height, x, y + height, r)
    context.arcTo(x, y + height, x, y, r)
    context.arcTo(x, y, x + width, y, r)
    context.closePath()
  }

  let renderTimer = 0
  function scheduleRender() {
    clearTimeout(renderTimer)
    renderTimer = setTimeout(() => run(renderShot), 140)
  }
  function syncRangeOutput(id) {
    const map = { padding: 'pad-value', radius: 'radius-value', shadow: 'shadow-value', 'font-size': 'font-value' }
    $(map[id]).value = $(id).value
  }
  for (const id of ['padding', 'radius', 'shadow', 'font-size']) {
    $(id).oninput = () => { syncRangeOutput(id); scheduleRender() }
    $(id).onchange = () => persist()
  }
  $('card-title').oninput = () => { scheduleRender() }
  $('card-title').onchange = () => persist()
  $('show-lines').onchange = () => { scheduleRender(); persist() }
  $('scale2x').onchange = () => persist()
  $('code').addEventListener('input', () => { detect(); renderGutter(); scheduleRender(); queuePersist() })
  function queuePersist() { clearTimeout(dirtyTimer); dirtyTimer = setTimeout(persist, 800) }

  function renderGutter() {
    const lines = $('code').value.split('\n').length
    $('line-gutter').textContent = Array.from({ length: lines }, (_, index) => index + 1).join('\n')
  }

  // ---------- 导出 ----------
  function exportDataUrl() {
    if (!lastDataUrl) renderShot()
    return lastDataUrl
  }
  async function copyShot() {
    const dataUrl = exportDataUrl()
    if (!dataUrl) throw new Error('画布尚未生成')
    if (!api?.clipboard?.writeImage) throw new Error('复制图片需要在 eNest 中使用')
    await api.clipboard.writeImage(dataUrl)
    kit.toast('已复制图片', 'success')
    status('图片已复制到剪贴板')
  }
  async function saveShot() {
    const dataUrl = exportDataUrl()
    if (!dataUrl) throw new Error('画布尚未生成')
    const title = $('card-title').value.trim().replace(/[\\/:*?"<>|\s]+/g, '-') || 'code'
    await kit.saveFile(`code-shot-${title}-${Date.now()}.png`, dataUrl)
  }
  async function pinShot() {
    const dataUrl = exportDataUrl()
    if (!dataUrl) throw new Error('画布尚未生成')
    if (!api?.pin?.open) throw new Error('贴图需要在 eNest 中使用')
    await api.pin.open({ dataUrl, width: 460, title: '代码截图' })
    status('已创建贴图')
  }
  $('copy-shot').onclick = $('copy-again').onclick = () => void run(copyShot)
  $('save-shot').onclick = $('save-again').onclick = () => void run(saveShot)
  $('pin-shot').onclick = () => void run(pinShot)
  $('paste-code').onclick = () => void run(async () => {
    if (!api?.clipboard?.readText) throw new Error('读剪贴板需要在 eNest 中使用')
    const text = await api.clipboard.readText()
    if (!text?.trim()) { kit.toast('剪贴板中没有文本', 'error'); return }
    $('code').value = text
    detect(); renderGutter(); scheduleRender(); persist()
    status('已从剪贴板导入代码')
  })
  $('clear-code').onclick = () => { $('code').value = ''; $('detect-hint').textContent = ''; renderGutter(); scheduleRender(); persist() }
  document.addEventListener('keydown', event => {
    if (event.isComposing) return
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void run(copyShot) }
  })

  // ---------- Quick ----------
  function onQuery(value) {
    if (kit.mode !== 'quick' || !value) return
    $('code').value = value.slice(0, 100000)
    detect(); renderGutter(); scheduleRender()
  }
  function onAction(action) {
    if (action === 'submit') void run(copyShot)
    if (action === 'clear') { $('code').value = ''; renderGutter(); scheduleRender() }
  }
  function syncHeight() {
    const height = Math.min(640, Math.max(320, Math.round(document.body.scrollHeight + 8)))
    void run(async () => { await api?.ui?.setHeight?.(height) })
  }
  let heightTimer = 0
  new MutationObserver(() => { clearTimeout(heightTimer); heightTimer = setTimeout(syncHeight, 150) }).observe(document.body, { childList: true, subtree: true })

  kit.onMode(() => { if (kit.mode === 'quick') syncHeight() })
  kit.onSettings((settings, key) => {
    if (key === 'autoDetect') { if (settings.autoDetect) detect() }
  })

  // ---------- 初始化（可重入） ----------
  async function init() {
    if (initialized) return
    initialized = true
    if (!core) { fail('核心模块加载失败'); return }
    try {
      const saved = await kit.load(PREF_KEY, null)
      applyConfig(saved)
    } catch { /* 首次运行 */ }
    $('language').value = language
    renderGutter()
    run(renderShot)
  }
  if (api?.onEnter) api.onEnter(() => void run(init))
  void run(init)
})()
