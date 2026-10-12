/* 二维码插件主逻辑：生成（qrcode-generator）+ 解码（jsQR）
 * 仅 UI 编排：分段控件 / 滑杆填充 / swatch 值展示 / 历史缩略。
 * 功能逻辑（生成、解码、历史、剪贴板）与既有版本一致。 */
/* global qrcode, jsQR */
const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)

const QUIET_ZONE = 4 // 四周留白模块数
const HISTORY_MAX = 6 // 生成历史（会话内）
const history = [] // { text, size, ecc, fg, bg }

let debounceTimer = null
let lastGenerated = '' // 当前画布对应的文本（空 = 无有效二维码）
let lastDecoded = ''

const toast = async (message, type = 'info') => {
  try { await api?.ui?.toast?.({ message, type }) } catch {}
}
const isPerm = (err) => String(err?.message || err).includes('permission denied')
const failToast = (e, permName) =>
  toast(isPerm(e) ? '缺少 ' + permName + ' 权限' : String(e?.message || e), 'error')

// —— 分段控件（页签 + 纠错共用）：滑块跟随 active 项 ——
function setupSegmented(root, onChange) {
  const btns = Array.from(root.querySelectorAll('.seg-btn'))
  const thumb = root.querySelector('.seg-thumb')
  const moveThumb = () => {
    const active = root.querySelector('.seg-btn.active')
    if (!active || !thumb) return
    thumb.style.width = active.offsetWidth + 'px'
    thumb.style.transform = 'translateX(' + (active.offsetLeft - 2) + 'px)'
  }
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return
      btns.forEach((b) => {
        b.classList.remove('active')
        if (b.hasAttribute('role')) b.setAttribute('aria-selected', 'false')
      })
      btn.classList.add('active')
      if (btn.hasAttribute('role')) btn.setAttribute('aria-selected', 'true')
      moveThumb()
      onChange?.(btn)
    })
  })
  // 布局稳定后初始化（字体加载 / 容器宽度变化后重算）
  requestAnimationFrame(moveThumb)
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(moveThumb).observe(root)
  }
  window.addEventListener('resize', moveThumb)
}

setupSegmented(document.querySelector('.tabs, [role="tablist"]'), (btn) => {
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'))
  $('panel-' + btn.dataset.tab).classList.add('active')
})

// —— 纠错分段：值存 data-value，与生成逻辑解耦 ——
const eccRoot = $('ecc')
let eccValue = 'M'
setupSegmented(eccRoot, (btn) => {
  eccValue = btn.dataset.ecc || 'M'
  renderGenerate()
})
const setEcc = (val) => {
  const v = ['L', 'M', 'Q', 'H'].includes(val) ? val : 'M'
  eccValue = v
  eccRoot.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset.ecc === v
    b.classList.toggle('active', on)
  })
  syncEccThumb()
}
function syncEccThumb() {
  const active = eccRoot.querySelector('.seg-btn.active')
  const thumb = eccRoot.querySelector('.seg-thumb')
  if (!active || !thumb) return
  thumb.style.width = active.offsetWidth + 'px'
  thumb.style.transform = 'translateX(' + (active.offsetLeft - 2) + 'px)'
}

// —— 生成 ——
function readOpts() {
  return {
    size: clampSize(Number($('size').value) || 256),
    ecc: eccValue,
    fg: $('fg').value || '#000000',
    bg: $('bg').value || '#ffffff'
  }
}

function clampSize(n) {
  return Math.min(512, Math.max(128, Math.round(n / 16) * 16))
}

// —— 滑杆填充 / swatch 值 / 字符计数（纯展示同步） ——
function syncRangeFill() {
  const el = $('size')
  const min = Number(el.min) || 0
  const max = Number(el.max) || 1
  const pct = ((Number(el.value) - min) / (max - min)) * 100
  el.style.setProperty('--fill', pct + '%')
}
function syncColorValue(inputId, labelId) {
  $(labelId).textContent = ($(inputId).value || '').toUpperCase()
}
function syncInputCount() {
  $('input-count').textContent = $('input').value.length + ' 字符'
}

// 画布渲染：quiet zone 4 模块；模块为整数像素，余量均分到边缘
function drawQr(canvas, qr, opts) {
  const count = qr.getModuleCount()
  const quiet = QUIET_ZONE
  const total = count + quiet * 2
  const scale = Math.max(1, Math.floor(opts.size / total))
  const dim = scale * total
  canvas.width = dim
  canvas.height = dim
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = opts.bg
  ctx.fillRect(0, 0, dim, dim)
  ctx.fillStyle = opts.fg
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale)
      }
    }
  }
}

function renderGenerate() {
  const text = $('input').value
  const canvas = $('canvas')
  syncInputCount()
  if (!text.trim()) {
    lastGenerated = ''
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    $('stage').classList.remove('has-qr')
    $('qr-meta').textContent = ''
    return
  }
  const opts = readOpts()
  try {
    // typeNumber 0 → 自动；UTF-8 编码保证中文可解码
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']
    const qr = qrcode(0, opts.ecc)
    qr.addData(text)
    qr.make()
    drawQr(canvas, qr, opts)
    lastGenerated = text
    $('stage').classList.add('has-qr')
    const count = qr.getModuleCount()
    $('qr-meta').textContent =
      text.length + ' 字符 · ' + count + '×' + count + ' 模块 · 纠错 ' + opts.ecc
    pushHistory(text, opts)
  } catch (e) {
    // 超出容量（version 40 上限）等
    lastGenerated = ''
    $('stage').classList.remove('has-qr')
    $('qr-meta').textContent = ''
    toast('生成失败：' + String(e?.message || e), 'error')
  }
}

// —— 生成历史（会话内最近 6 条）——
function pushHistory(text, opts) {
  const prev = history[0]
  if (prev && prev.text === text) {
    prev.size = opts.size
    prev.ecc = opts.ecc
    prev.fg = opts.fg
    prev.bg = opts.bg
    renderHistory()
    return
  }
  history.unshift({ text, size: opts.size, ecc: opts.ecc, fg: opts.fg, bg: opts.bg })
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX
  renderHistory()
}

function renderHistory() {
  const root = $('history')
  root.innerHTML = ''
  if (!history.length) {
    root.innerHTML = '<div class="empty">暂无记录</div>'
    return
  }
  for (const item of history) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'h-item'
    card.title = item.text
    card.setAttribute('aria-label', '恢复：' + (item.text.length > 40 ? item.text.slice(0, 40) + '…' : item.text))
    const thumb = document.createElement('canvas')
    const label = document.createElement('div')
    label.className = 'h-text'
    label.textContent = item.text
    card.append(thumb, label)
    card.onclick = () => {
      $('input').value = item.text
      $('size').value = clampSize(item.size)
      $('size-val').textContent = clampSize(item.size) + 'px'
      syncRangeFill()
      setEcc(item.ecc)
      $('fg').value = item.fg
      $('bg').value = item.bg
      syncColorValue('fg', 'fg-val')
      syncColorValue('bg', 'bg-val')
      renderGenerate()
    }
    root.appendChild(card)
    // 小缩略：固定 96px 画布
    try {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']
      const qr = qrcode(0, item.ecc)
      qr.addData(item.text)
      qr.make()
      drawQr(thumb, qr, { size: 96, fg: item.fg, bg: item.bg })
    } catch {
      thumb.width = 96
      thumb.height = 96
    }
  }
}

// —— 事件：防抖 300ms 实时生成 ——
$('input').addEventListener('input', () => {
  syncInputCount()
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(renderGenerate, 300)
})
$('size').addEventListener('input', () => {
  $('size-val').textContent = clampSize(Number($('size').value)) + 'px'
  syncRangeFill()
  renderGenerate()
})
$('fg').addEventListener('input', () => {
  syncColorValue('fg', 'fg-val')
  renderGenerate()
})
$('bg').addEventListener('input', () => {
  syncColorValue('bg', 'bg-val')
  renderGenerate()
})

$('btn-copy').onclick = async () => {
  if (!lastGenerated) {
    toast('还没有可复制的二维码', 'warn')
    return
  }
  try {
    await api.clipboard.writeImage($('canvas').toDataURL('image/png'))
    toast('已复制二维码图片', 'success')
  } catch (e) {
    failToast(e, 'clipboard.writeImage')
  }
}

$('btn-save').onclick = () => {
  if (!lastGenerated) {
    toast('还没有可保存的二维码', 'warn')
    return
  }
  try {
    const a = document.createElement('a')
    a.href = $('canvas').toDataURL('image/png')
    a.download = 'qrcode-' + Date.now() + '.png'
    document.body.appendChild(a)
    a.click()
    a.remove()
    toast('已触发保存；若未弹出下载，请用「复制图片」', 'info')
  } catch {
    toast('保存失败，请用「复制图片」', 'warn')
  }
}

// —— 解码 ——
function setResult(text, ok) {
  const el = $('result-text')
  el.textContent = text
  el.classList.toggle('placeholder', !text)
  el.classList.toggle('error', !ok)
  lastDecoded = ok ? text : ''
  $('btn-copy-text').disabled = !ok
}

// dataUrl → Image → canvas → getImageData → jsQR
function decodeDataUrl(dataUrl) {
  const img = new Image()
  img.onload = () => {
    try {
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, w, h)
      const code = window.jsQR ? jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' }) : null
      if (code && code.data) {
        setResult(code.data, true)
      } else {
        setResult('未识别到二维码', false)
      }
    } catch (e) {
      setResult('解码失败：' + String(e?.message || e), false)
    }
  }
  img.onerror = () => setResult('图片加载失败', false)
  img.src = dataUrl
}

function showPreview(dataUrl, alt) {
  const preview = $('preview')
  preview.innerHTML = ''
  const img = document.createElement('img')
  img.alt = alt
  img.src = dataUrl
  preview.appendChild(img)
}

$('btn-clip').onclick = async () => {
  try {
    const imgData = await api.clipboard.readImage()
    if (!imgData || !imgData.dataUrl) {
      toast('剪贴板无图片', 'warn')
      return
    }
    showPreview(imgData.dataUrl, '剪贴板图片')
    setResult('识别中…', false)
    decodeDataUrl(imgData.dataUrl)
  } catch (e) {
    failToast(e, 'clipboard.readImage')
  }
}

$('btn-file').onclick = () => $('file-input').click()

$('file-input').onchange = () => {
  const input = $('file-input')
  const file = input.files && input.files[0]
  input.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = String(reader.result || '')
    if (!dataUrl.startsWith('data:image/')) {
      toast('无法读取该图片', 'error')
      return
    }
    showPreview(dataUrl, '本地图片')
    setResult('识别中…', false)
    decodeDataUrl(dataUrl)
  }
  reader.onerror = () => toast('读取文件失败', 'error')
  reader.readAsDataURL(file)
}

$('btn-copy-text').onclick = async () => {
  if (!lastDecoded) return
  try {
    await api.clipboard.writeText(lastDecoded)
    toast('已复制识别文本', 'success')
  } catch (e) {
    failToast(e, 'clipboard.write')
  }
}

// —— 进入载荷 / 标题 ——
api?.onEnter?.(({ payload }) => {
  // Quick 面板透传文本：预填生成输入
  const text =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object' && payload.type === 'text' && typeof payload.text === 'string'
        ? payload.text
        : ''
  if (text) {
    document.querySelector('[data-tab="encode"]').click()
    $('input').value = text
    renderGenerate()
  }
})
api?.ui?.setTitle?.('二维码')

// —— 初始展示同步 ——
syncRangeFill()
syncColorValue('fg', 'fg-val')
syncColorValue('bg', 'bg-val')
syncInputCount()
renderHistory()
