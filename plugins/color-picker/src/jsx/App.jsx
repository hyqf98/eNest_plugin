/**
 * 取色器主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 color-math.js（parse/hex/rgb/hsl/oklch/contrast/harmony）原样复用；
 * 截图画布 / 放大镜取色保持原命令式实现，经 ref 桥接。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { bindFileInput } from '@enest/plugin-kit/file-inputs'
import { MoreMenu } from '../ui/index.jsx'

const math = globalThis.ColorMath
const api = window.enest || window.zapi
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`

const VIEWS = ['recent', 'harmony', 'contrast', 'palette', 'pick']
const HARMONIES = [
  { kind: 'complement', label: '互补' },
  { kind: 'analogous', label: '类似' },
  { kind: 'triadic', label: '三角' },
  { kind: 'square', label: '四方' },
]

export function App() {
  const kitRef = useRef(null)
  const shotRef = useRef(null)
  const magnifierRef = useRef(null)
  const imageFileRef = useRef(null)
  const paletteFileRef = useRef(null)

  const [statusText, setStatusText] = useState('选取颜色或输入色值')
  const [modeHint, setModeHint] = useState('')
  const [view, setView] = useState('recent')
  const [currentColor, setCurrentColor] = useState(() => math.parse('#447766'))
  const [background, setBackground] = useState(() => math.parse('#FFFFFF'))
  const [colorInput, setColorInput] = useState('#447766')
  const [backgroundInput, setBackgroundInput] = useState('#FFFFFF')
  const [inputError, setInputError] = useState(false)
  const [backgroundError, setBackgroundError] = useState(false)
  const [harmonyKind, setHarmonyKind] = useState('triadic')
  const [history, setHistory] = useState([])
  const [palettes, setPalettes] = useState([])
  const [activePaletteId, setActivePaletteId] = useState('')
  const [selected, setSelected] = useState(0)
  const [recentCount, setRecentCount] = useState('0 色')
  const [paletteCount, setPaletteCount] = useState('0 组')
  const [captureDisabled, setCaptureDisabled] = useState(false)
  const [confirmPickDisabled, setConfirmPickDisabled] = useState(true)
  const [sampleValue, setSampleValue] = useState('移入图片选取颜色')
  const [samplePosition, setSamplePosition] = useState('')
  const [clearText, setClearText] = useState('清空')
  const [deleteText, setDeleteText] = useState('删除')
  const [alphaPercent, setAlphaPercent] = useState(100)

  const currentRef = useRef(currentColor)
  currentRef.current = currentColor
  const backgroundRef = useRef(background)
  backgroundRef.current = background
  const historyRef = useRef(history)
  historyRef.current = history
  const palettesRef = useRef(palettes)
  palettesRef.current = palettes
  const activeIdRef = useRef(activePaletteId)
  activeIdRef.current = activePaletteId
  const harmonyRef = useRef(harmonyKind)
  harmonyRef.current = harmonyKind
  const viewRef = useRef(view)
  viewRef.current = view
  const queryRef = useRef('')
  const selectedRef = useRef(0)
  const pickingRef = useRef(false)
  const pixelRef = useRef(null)
  const lastPickRef = useRef(null)
  const captureRevisionRef = useRef(0)
  const saveQueueRef = useRef(Promise.resolve())
  const clearArmedRef = useRef(false)
  const deleteArmedRef = useRef(false)

  const status = useCallback((text) => setStatusText(text), [])
  const fail = useCallback((error) => {
    const text = String(error?.message || error)
    setStatusText(text)
    kitRef.current?.toast(text, 'error')
  }, [])
  const run = useCallback((fn) => Promise.resolve().then(fn).catch(fail), [fail])
  const format = useCallback((color, type) => (math[type || kitRef.current?.settings.copyFormat || 'hex'] || math.hex)(color), [])
  const historyLimit = useCallback(() => Math.max(12, Math.min(120, Number(kitRef.current?.settings.historyLimit) || 48)), [])
  const activePalette = useCallback(() => palettesRef.current.find((p) => p.id === activeIdRef.current) || palettesRef.current[0], [])

  // ---------- 持久化（key 与旧版一致，向后兼容） ----------
  const persist = useCallback(() => {
    const data = structuredClone({
      palettes: palettesRef.current, activePaletteId: activeIdRef.current,
      history: historyRef.current, current: currentRef.current, background: backgroundRef.current,
      harmonyKind: harmonyRef.current,
    })
    saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(() => kitRef.current.save('color_workspace_v2', data))
    saveQueueRef.current.catch(fail)
    return saveQueueRef.current
  }, [fail])

  // ---------- 当前颜色（所有调整 1:1 实时反映） ----------
  const setCurrent = useCallback((color, syncInput = true) => {
    const normalized = math.normalized(color)
    currentRef.current = normalized
    setCurrentColor(normalized)
    if (syncInput) {
      const hex = math.hex(normalized)
      setColorInput(hex)
    }
    setInputError(false)
    setAlphaPercent(Math.round(normalized.a * 100))
  }, [])

  // ---------- 和谐色派生 ----------
  const harmonyList = math.harmony(currentColor, harmonyKind)

  // ---------- 对比度派生 ----------
  const contrastRatio = math.contrast(currentColor, background)
  const contrastBg = math.composite(background)
  const contrastFg = math.composite(currentColor, contrastBg)
  const contrastSummary = contrastRatio >= 7 ? '适合正文阅读' : contrastRatio >= 4.5 ? '正文达到 AA' : contrastRatio >= 3 ? '仅大字达到 AA' : '建议提高明暗差异'

  // ---------- 最近颜色 ----------
  const filteredHistory = useCallback(() => {
    const q = queryRef.current.trim().toLowerCase()
    return !q || math.parse(q)
      ? historyRef.current
      : historyRef.current.filter((c) => [math.hex(c), math.rgb(c), math.hsl(c), math.oklch(c)].some((s) => s.toLowerCase().includes(q)))
  }, [])

  const remember = useCallback((color = currentRef.current) => {
    const entry = math.normalized(color)
    const key = math.hex(entry)
    const limit = historyLimit()
    setHistory((prev) => [entry, ...prev.filter((c) => math.hex(c) !== key)].slice(0, limit))
    void persist()
  }, [historyLimit, persist])

  const copyColor = useCallback(async (color, type) => {
    const text = format(color, type)
    await kitRef.current.copy(text)
    status(`已复制 ${text}`)
  }, [format, status])

  // ---------- 工作区视图切换 ----------
  const showView = useCallback((next) => {
    setView(next)
    if (next !== 'pick') {
      // 离开取色视图时保持 picking 状态语义与原版一致（仅由 stopPick 复位）
    }
  }, [])

  // ---------- 图片取色（放大镜 + 键盘微调，等价原命令式实现） ----------
  const stopPick = useCallback(() => {
    captureRevisionRef.current += 1
    pickingRef.current = false
    pixelRef.current = null
    lastPickRef.current = null
    showView('pick')
    document.body.classList.remove('picking')
    const shot = shotRef.current
    if (shot) { shot.width = 1; shot.height = 1 }
    setConfirmPickDisabled(true)
    void api?.ui?.setInputContext?.('workbench')
    status('已退出取色')
  }, [showView, status])

  const sampleAt = useCallback((x, y) => {
    if (!pickingRef.current) return
    const canvas = shotRef.current
    if (!canvas) return
    x = Math.max(0, Math.min(canvas.width - 1, Math.round(x)))
    y = Math.max(0, Math.min(canvas.height - 1, Math.round(y)))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = ctx.getImageData(x, y, 1, 1).data
    pixelRef.current = { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] / 255 }
    lastPickRef.current = { x, y }
    setSampleValue(math.hex(pixelRef.current))
    setSamplePosition(`${x}, ${y}`)
    setConfirmPickDisabled(false)
    const mag = magnifierRef.current.getContext('2d')
    mag.clearRect(0, 0, 110, 110)
    mag.imageSmoothingEnabled = false
    mag.fillStyle = '#dfe3df'
    mag.fillRect(0, 0, 110, 110)
    mag.drawImage(canvas, x - 5, y - 5, 11, 11, 0, 0, 110, 110)
    mag.strokeStyle = '#fff'
    mag.lineWidth = 2
    mag.strokeRect(49, 49, 12, 12)
    mag.strokeStyle = '#192a20'
    mag.lineWidth = 1
    mag.strokeRect(50, 50, 10, 10)
  }, [])

  const loadShot = useCallback(async (dataUrl, revision) => {
    const image = new Image()
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('图片无法读取')); image.src = dataUrl })
    if (revision !== captureRevisionRef.current) return
    if (image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024) throw new Error('图片像素过大，请使用小于 6400 万像素的图片')
    const canvas = shotRef.current
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0)
    showView('pick')
    pickingRef.current = true
    document.body.classList.add('picking')
    void api?.ui?.setInputContext?.('overlay')
    status(`${canvas.width} × ${canvas.height} · 点击图片收录颜色`)
    canvas.focus()
  }, [showView, status])

  const commitPick = useCallback(() => {
    if (!pixelRef.current) return
    setCurrent(pixelRef.current)
    remember()
    status(`已收录 ${math.hex(pixelRef.current)}`)
    if (kitRef.current.settings.autoCopy !== false) void run(() => copyColor(pixelRef.current))
  }, [copyColor, remember, run, setCurrent, status])

  const onShotPointerMove = useCallback((event) => {
    const box = event.currentTarget.getBoundingClientRect()
    sampleAt((event.clientX - box.left) * event.currentTarget.width / box.width, (event.clientY - box.top) * event.currentTarget.height / box.height)
  }, [sampleAt])

  const onShotKeyDown = useCallback((event) => {
    if (event.isComposing) return
    const pos = lastPickRef.current || { x: Math.floor(shotRef.current.width / 2), y: Math.floor(shotRef.current.height / 2) }
    const step = event.shiftKey ? 10 : 1
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
    if (delta) { event.preventDefault(); sampleAt(pos.x + delta[0], pos.y + delta[1]) }
    if (event.key === 'Enter') { event.preventDefault(); commitPick() }
  }, [commitPick, sampleAt])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && pickingRef.current) {
        event.preventDefault()
        event.stopPropagation()
        stopPick()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [stopPick])

  // ---------- 输入接线（颜色输入 / alpha / 背景） ----------
  const onColorInputChange = (event) => {
    const value = event.target.value
    setColorInput(value)
    const color = math.parse(value)
    setInputError(!color)
    if (color) setCurrent(color, false)
  }
  const onColorInputKeyDown = (event) => {
    if (event.key === 'Enter' && !event.isComposing && math.parse(event.target.value)) {
      remember()
      void run(() => copyColor(currentRef.current))
      void persist()
    }
  }
  const onColorInputBlur = () => { if (math.parse(colorInput)) void persist() }
  const onAlphaInput = (event) => setCurrent({ ...currentRef.current, a: Number(event.target.value) / 100 })
  const onAlphaChange = () => void persist()
  const onBackgroundChange = (event) => {
    const value = event.target.value
    setBackgroundInput(value)
    const color = math.parse(value)
    setBackgroundError(!color)
    if (color) {
      backgroundRef.current = color
      setBackground(color)
      void persist()
    }
  }
  const swapColors = () => {
    const previous = currentRef.current
    setCurrent(backgroundRef.current)
    backgroundRef.current = previous
    setBackground(previous)
    setBackgroundInput(math.hex(previous))
    void persist()
  }

  // ---------- 色板操作 ----------
  const palette = activePalette()

  const createPalette = () => {
    const input = document.getElementById('palette-name')
    const name = (input?.value || '').trim()
    if (!name) { input?.focus(); return }
    if (palettesRef.current.length >= 30) return kitRef.current.toast('最多保存 30 组色板，请先导出并整理', 'warn')
    const next = { id: uid(), name, colors: [] }
    setPalettes((prev) => [...prev, next])
    palettesRef.current = [...palettesRef.current, next]
    setActivePaletteId(next.id)
    activeIdRef.current = next.id
    if (input) input.value = ''
    void persist()
  }
  const addColor = () => {
    const target = activePalette()
    if (!target) return
    if (target.colors.length >= 100) return kitRef.current.toast('每组色板最多 100 色', 'warn')
    const nameInput = document.getElementById('color-name')
    const next = { id: uid(), name: nameInput?.value.trim() || '', color: { ...currentRef.current } }
    target.colors.push(next)
    setPalettes((prev) => prev.slice())
    if (nameInput) nameInput.value = ''
    void persist()
  }
  const deletePalette = () => {
    if (!deleteArmedRef.current) {
      deleteArmedRef.current = true
      setDeleteText('再次点击删除')
      return
    }
    const rest = palettesRef.current.filter((p) => p.id !== activeIdRef.current)
    const next = rest.length ? rest : [{ id: uid(), name: '我的色板', colors: [] }]
    setPalettes(next)
    palettesRef.current = next
    setActivePaletteId(next[0].id)
    activeIdRef.current = next[0].id
    deleteArmedRef.current = false
    setDeleteText('删除')
    void persist()
  }
  const renameColor = (entry, name) => {
    entry.name = name.trim().slice(0, 40)
    void persist()
  }
  const removeColor = (entry) => {
    const target = activePalette()
    if (!target) return
    target.colors = target.colors.filter((c) => c.id !== entry.id)
    setPalettes((prev) => prev.slice())
    void persist()
  }
  const clearHistory = () => {
    if (!clearArmedRef.current) {
      clearArmedRef.current = true
      setClearText('确认清空')
      return
    }
    historyRef.current = []
    setHistory([])
    clearArmedRef.current = false
    setClearText('清空')
    void persist()
  }
  const harmonyToPalette = () => {
    const target = activePalette()
    if (!target) return
    const list = math.harmony(currentRef.current, harmonyRef.current)
    if (target.colors.length + list.length > 100) return kitRef.current.toast('每组色板最多 100 色', 'warn')
    target.colors.push(...list.map((item, index) => ({ id: uid(), name: `${item.role} ${index + 1}`, color: { ...item.color } })))
    setPalettes((prev) => prev.slice())
    void persist()
    status(`已加入 ${list.length} 个和谐色`)
  }
  const harmonyCss = () => void run(async () => {
    const list = math.harmony(currentRef.current, harmonyRef.current)
    const css = `:root {\n${list.map((item) => `  --harmony-${item.role}: ${math.rgb(item.color)}; /* ${math.hex(item.color)} */`).join('\n')}\n}\n`
    await kitRef.current.copy(css)
    status('已复制和谐色 CSS 变量')
  })
  const exportCss = () => void run(() => {
    const p = activePalette()
    return kitRef.current.saveText(`${p.name}.css`, math.cssPalette(p.name, p.colors))
  })
  const exportJson = () => void run(() => {
    const p = activePalette()
    return kitRef.current.saveText(`${p.name}.json`, JSON.stringify({ version: 1, name: p.name, colors: p.colors.map(({ name, color }) => ({ name, color: math.hex(color) })) }, null, 2))
  })

  const onPaletteFileChange = () => void run(async () => {
    const input = paletteFileRef.current
    const file = input?.files[0]
    if (input) input.value = ''
    if (!file) return
    if (file.size > 1024 * 1024) throw new Error('色板文件需小于 1 MB')
    const data = JSON.parse(await file.text())
    if (!data || typeof data.name !== 'string' || !Array.isArray(data.colors) || data.colors.length > 100 || palettesRef.current.length >= 30) throw new Error('色板格式无效：需要名称和不超过 100 个颜色')
    const colors = data.colors.map((item) => {
      const color = math.parse(typeof item === 'string' ? item : item?.color)
      if (!color) throw new Error('色板包含无效色值')
      return { id: uid(), name: typeof item?.name === 'string' ? item.name.slice(0, 40) : '', color }
    })
    const next = { id: uid(), name: data.name.trim().slice(0, 40) || '导入色板', colors }
    const list = [...palettesRef.current, next]
    setPalettes(list)
    palettesRef.current = list
    setActivePaletteId(next.id)
    activeIdRef.current = next.id
    await persist()
    status(`已导入 ${colors.length} 色`)
  })

  // ---------- 屏幕取色 / 打开图片 ----------
  const capture = () => void run(async () => {
    const revision = ++captureRevisionRef.current
    setCaptureDisabled(true)
    status('正在获取屏幕…')
    try {
      if (!api?.screen?.capture) throw new Error('屏幕取色需在 eNest 中使用')
      const shot = await api.screen.capture()
      await loadShot(shot.dataUrl, revision)
    } finally {
      setCaptureDisabled(false)
    }
  })
  const openImage = () => imageFileRef.current?.click()
  const onImageFileChange = () => void run(async () => {
    const input = imageFileRef.current
    const file = input?.files[0]
    if (input) input.value = ''
    if (!file) return
    if (file.size > 32 * 1024 * 1024) throw new Error('图片需小于 32 MB')
    const revision = ++captureRevisionRef.current
    const url = URL.createObjectURL(file)
    try { await loadShot(url, revision) } finally { URL.revokeObjectURL(url) }
  })

  // ---------- Quick 查询（kit 回调 latest-ref 桥接） ----------
  const onQuery = useCallback((value) => {
    queryRef.current = value
    selectedRef.current = 0
    const parsed = math.parse(value)
    if (parsed) setCurrent(parsed)
    setHistory((prev) => prev.slice()) // 触发重渲染过滤
  }, [setCurrent])

  const onAction = useCallback((action) => {
    const name = typeof action === 'string' ? action : action?.action
    const q = queryRef.current.trim().toLowerCase()
    const all = historyRef.current
    const entries = !q || math.parse(q) ? all : all.filter((c) => [math.hex(c), math.rgb(c), math.hsl(c), math.oklch(c)].some((s) => s.toLowerCase().includes(q)))
    if (name === 'next' || name === 'previous') {
      selectedRef.current = Math.max(0, Math.min(entries.length - 1, selectedRef.current + (name === 'next' ? 1 : -1)))
      setSelected(selectedRef.current)
      setHistory((prev) => prev.slice())
      requestAnimationFrame(() => {
        document.getElementById('recent-colors')?.children[selectedRef.current]?.scrollIntoView({ block: 'nearest' })
      })
    } else if (name === 'submit') {
      const c = math.parse(queryRef.current) || entries[selectedRef.current] || currentRef.current
      setCurrent(c)
      remember(c)
      void run(() => copyColor(c))
    } else if (name === 'clear') {
      queryRef.current = ''
      setHistory((prev) => prev.slice())
    }
  }, [copyColor, remember, run, setCurrent])

  useEffect(() => {
    const kit = PluginKit.create({
      title: '取色器',
      height: 470,
      quickPlaceholder: '输入 HEX、RGB、HSL，或查找颜色…',
      defaults: { copyFormat: 'hex', autoCopy: true, historyLimit: 48 },
      onQuery,
      onAction,
    })
    kitRef.current = kit
    kit.onMode((mode) => {
      setModeHint(mode === 'quick' ? 'Enter 复制 · ↑ ↓ 选择最近颜色' : '')
      if (mode === 'quick') showView('recent')
    })
    kit.onSettings(() => {
      const limit = historyLimit()
      setHistory((prev) => prev.slice(0, limit))
    })
    const offOut = api?.onOut?.(() => { if (pickingRef.current) stopPick() })
    api?.onBeforeClose?.(() => saveQueueRef.current)

    // 隐藏文件输入接 host 授权选择器（等价原 bindFileInput）
    if (imageFileRef.current) bindFileInput(imageFileRef.current, { api, onError: (error) => kit.toast(error.message, 'error') })
    if (paletteFileRef.current) bindFileInput(paletteFileRef.current, { api, maxBytes: 1024 * 1024, onError: (error) => kit.toast(error.message, 'error') })

    let alive = true
    void run(async () => {
      await kit.ready
      if (!alive) return
      const state = await kit.load('color_workspace_v2', null)
      if (!alive) return
      const valid = (color) => color && ['r', 'g', 'b'].every((k) => Number.isFinite(color[k])) && Number.isFinite(color.a ?? 1)
      let nextHistory = []
      let nextPalettes = []
      let nextActiveId = ''
      let nextCurrent = math.parse('#447766')
      let nextBackground = math.parse('#FFFFFF')
      let nextHarmony = 'triadic'
      if (state && typeof state === 'object') {
        nextHistory = Array.isArray(state.history) ? state.history.filter(valid).map(math.normalized).slice(0, historyLimit()) : []
        nextPalettes = Array.isArray(state.palettes)
          ? state.palettes.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.colors)).slice(0, 30)
            .map((p) => ({ id: String(p.id || uid()), name: p.name.slice(0, 40), colors: p.colors.filter((c) => c && valid(c.color)).slice(0, 100).map((c) => ({ id: String(c.id || uid()), name: String(c.name || '').slice(0, 40), color: math.normalized(c.color) })) }))
          : []
        nextActiveId = String(state.activePaletteId || '')
        if (valid(state.current)) nextCurrent = math.normalized(state.current)
        if (valid(state.background)) nextBackground = math.normalized(state.background)
        if (['complement', 'analogous', 'triadic', 'square'].includes(state.harmonyKind)) nextHarmony = state.harmonyKind
      } else {
        const legacy = await kit.load('colors_v1', [])
        if (!alive) return
        nextHistory = Array.isArray(legacy) ? legacy.filter((c) => c && ['r', 'g', 'b'].every((k) => Number.isFinite(c[k]))).map(math.normalized).slice(0, historyLimit()) : []
      }
      if (!nextPalettes.length) nextPalettes = [{ id: uid(), name: '我的色板', colors: [] }]
      if (!alive) return
      historyRef.current = nextHistory
      palettesRef.current = nextPalettes
      activeIdRef.current = nextActiveId || nextPalettes[0].id
      setHistory(nextHistory)
      setPalettes(nextPalettes)
      setActivePaletteId(activeIdRef.current)
      setHarmonyKind(nextHarmony)
      harmonyRef.current = nextHarmony
      backgroundRef.current = nextBackground
      setBackground(nextBackground)
      setBackgroundInput(math.hex(nextBackground))
      setCurrent(nextCurrent)
      showView('recent')
    })
    return () => {
      alive = false
      offOut?.()
      kit.destroy?.()
    }
  }, [historyLimit, onAction, onQuery, run, setCurrent, showView, stopPick])

  // 最近颜色渲染派生（等价原 renderHistory）
  const recentEntries = filteredHistory()
  const clampedSelected = Math.max(0, Math.min(selected, recentEntries.length - 1))

  const pickRecent = (color, index) => {
    selectedRef.current = index
    setSelected(index)
    setCurrent(color)
    setHistory((prev) => prev.slice())
    void run(() => copyColor(color))
    void persist()
  }

  const onPaletteSelectChange = (event) => {
    activeIdRef.current = event.target.value
    setActivePaletteId(event.target.value)
    deleteArmedRef.current = false
    setDeleteText('删除')
    void persist()
  }

  const activeColors = palette?.colors || []

  return (
    <main className="color-app">
      <header className="app-head">
        <div><span className="eyebrow">颜色工作台</span><h1>取色器</h1></div>
        <span id="status" role="status">{statusText}</span>
        <button id="capture" className="pk-btn primary" disabled={captureDisabled} onClick={capture}>屏幕取色</button>
        <button id="open-image" className="pk-btn desktop" onClick={openImage}>从图片取色</button>
        <input id="image-file" ref={imageFileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden />
      </header>

      <div className="color-layout">
        {/* 左：当前颜色控制面板（预览即所见所得） */}
        <aside className="control-panel" aria-label="当前颜色">
          <div className="color-stage checker">
            <div className="swatch-card"><div id="swatch" style={{ background: math.rgb(currentColor) }}></div></div>
            <span id="swatch-label" className="swatch-chip pk-mono">{math.hex(currentColor)}</span>
          </div>
          <div className="control-body">
            <label className="field-label" htmlFor="color-input">输入颜色</label>
            <div className="input-row">
              <input id="color-input" value={colorInput} spellCheck={false} autoComplete="off" aria-describedby="input-error"
                placeholder="HEX、RGB(A) 或 HSL(A)" aria-invalid={inputError ? 'true' : undefined}
                onChange={onColorInputChange} onKeyDown={onColorInputKeyDown} onBlur={onColorInputBlur} />
              <button id="remember" className="pk-btn" onClick={() => { if (!math.parse(colorInput)) return; remember(); status('已收录到最近颜色') }}>收录</button>
            </div>
            <p id="input-error" className="error" role="alert" hidden={!inputError}>请输入有效的 HEX、RGB(A) 或 HSL(A)</p>
            <label className="alpha-row" htmlFor="alpha"><span>透明度</span>
              <input id="alpha" type="range" min="0" max="100" value={alphaPercent} onInput={onAlphaInput} onChange={onAlphaChange} />
              <output id="alpha-value">{alphaPercent}%</output>
            </label>
            <div className="formats" aria-label="点击复制颜色格式">
              {['hex', 'rgb', 'hsl', 'oklch'].map((type) => (
                <button key={type} data-format={type} onClick={() => void run(() => copyColor(currentColor, type))}>
                  <span>{type.toUpperCase()}</span><code id={`value-${type}`}>{math[type](currentColor)}</code><small>复制</small>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* 右：工作区（分段控件切换子模式） */}
        <section className="work-panel" aria-label="颜色工作区">
          <nav className="work-seg" role="tablist" aria-label="工作区视图">
            {VIEWS.map((name) => (
              <button key={name} data-view={name} role="tab" aria-selected={view === name}
                onClick={() => showView(name)}>{ { recent: '最近颜色', harmony: '和谐色', contrast: '对比度', palette: '色板', pick: '取色' }[name] }</button>
            ))}
          </nav>

          <section id="view-recent" className="view" role="tabpanel" aria-label="最近颜色" hidden={view !== 'recent'}>
            <div className="view-head"><h2>最近颜色</h2><span id="recent-count" className="count">{history.length} 色</span>
              <button id="clear-history" className="pk-btn ghost text-button" disabled={!history.length} onClick={clearHistory}>{clearText}</button></div>
            <div id="recent-colors" className="recent-colors">
              {!recentEntries.length ? (
                <p className="empty">{queryRef.current ? '没有匹配的颜色，支持直接输入色值。' : '屏幕取色或点击「收录」，建立你的常用颜色。'}</p>
              ) : (
                recentEntries.map((color, index) => (
                  <button key={math.hex(color) + index}
                    className={`recent-color checker${index === clampedSelected ? ' selected' : ''}`}
                    title={math.hex(color)} aria-label={`选择并复制 ${math.hex(color)}`}
                    aria-pressed={String(index === clampedSelected)}
                    onClick={() => pickRecent(color, index)}>
                    <span style={{ background: math.rgb(color) }}></span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section id="view-harmony" className="view" role="tabpanel" aria-label="和谐色" hidden={view !== 'harmony'}>
            <div className="view-head">
              <h2>和谐色</h2>
              <div className="seg small" role="radiogroup" aria-label="和谐方式">
                {HARMONIES.map((h) => (
                  <button key={h.kind} data-harmony={h.kind} aria-pressed={harmonyKind === h.kind}
                    onClick={() => { setHarmonyKind(h.kind); harmonyRef.current = h.kind; void persist() }}>{h.label}</button>
                ))}
              </div>
              <MoreMenu
                ariaLabel="和谐色操作"
                items={[
                  { key: 'to-palette', label: '整组加入当前色板', onSelect: harmonyToPalette },
                  { key: 'css', label: '复制 CSS 变量', onSelect: harmonyCss },
                ]}
              />
            </div>
            <div id="harmony-grid" className="harmony-grid checker-batch">
              {harmonyList.map((item) => (
                <div key={item.role} className="harmony-card">
                  <span className="paint" style={{ background: math.rgb(item.color) }}></span>
                  <span className="row">
                    <span className="role">{item.role}</span>
                    <button className="code pk-mono" title="复制 HEX" onClick={() => void run(() => copyColor(item.color, 'hex'))}>{math.hex(item.color)}</button>
                  </span>
                  <button className="pick" onClick={() => { setCurrent(item.color); remember(item.color) }}>设为当前色</button>
                </div>
              ))}
            </div>
            <p className="helper">调整左侧颜色即时重算。点击色卡设为当前色，点击色值复制。</p>
          </section>

          <section id="view-contrast" className="view" role="tabpanel" aria-label="对比度检查" hidden={view !== 'contrast'}>
            <div className="view-head"><h2>对比度检查</h2><span className="count">WCAG 2</span></div>
            <p className="helper">当前颜色作为文字色；透明颜色按背景合成。</p>
            <label className="field-label" htmlFor="background">背景颜色</label>
            <div className="input-row"><input id="background" value={backgroundInput} spellCheck={false} onChange={onBackgroundChange} />
              <button id="swap" className="pk-btn" onClick={swapColors}>交换</button></div>
            <p className="error" id="background-error" hidden={!backgroundError}>背景色格式无效</p>
            <div id="contrast-preview" style={{ background: math.rgb(contrastBg), color: math.rgb(contrastFg) }}>
              <span>Aa</span><p>读起来清楚，才是好颜色。</p>
            </div>
            <div className="contrast-result"><strong id="contrast-ratio">{contrastRatio.toFixed(2)}:1</strong><span id="contrast-summary">{contrastSummary}</span></div>
            <div className="contrast-checks">
              {[['aa-normal', 4.5, '正文 AA'], ['aa-large', 3, '大字 AA'], ['aaa-normal', 7, '正文 AAA']].map(([id, threshold, label]) => {
                const pass = contrastRatio >= threshold
                return <span key={id} id={id} className={pass ? 'pass' : 'fail'}>{label} {pass ? '通过' : '未通过'}</span>
              })}
            </div>
          </section>

          <section id="view-palette" className="view" role="tabpanel" aria-label="命名色板" hidden={view !== 'palette'}>
            <div className="view-head"><h2>命名色板</h2><span id="palette-count" className="count">{palettes.length} 组</span>
              <MoreMenu
                ariaLabel="色板导入导出"
                items={[
                  { key: 'export-css', label: '导出 CSS', disabled: !palette, onSelect: exportCss },
                  { key: 'export-json', label: '导出 JSON', disabled: !palette, onSelect: exportJson },
                  { key: 'import-json', label: '导入 JSON', onSelect: () => paletteFileRef.current?.click() },
                ]}
              />
            </div>
            <label className="field-label" htmlFor="palette-select">当前色板</label>
            <div className="input-row">
              <select id="palette-select" value={activePaletteId} onChange={onPaletteSelectChange}>
                {palettes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button id="delete-palette" className="pk-btn danger" onClick={deletePalette}>{deleteText}</button>
            </div>
            <div className="input-row create-row">
              <input id="palette-name" maxLength={40} placeholder="新色板名称" aria-label="新色板名称" />
              <button id="create-palette" className="pk-btn" onClick={createPalette}>新建</button>
            </div>
            <div className="input-row create-row">
              <input id="color-name" maxLength={40} placeholder="当前颜色名称（可选）" aria-label="颜色名称" />
              <button id="add-color" className="pk-btn" onClick={addColor}>添加当前色</button>
            </div>
            <div id="palette-colors" className="palette-colors">
              {!activeColors.length ? <p className="empty">添加当前颜色，为配色方案留下名字。</p> : null}
              {activeColors.map((entry) => (
                <div key={entry.id} className="palette-row" data-row-actions>
                  <button className="palette-swatch checker" aria-label={`选取 ${entry.name || math.hex(entry.color)}`}
                    onClick={() => { setCurrent(entry.color); void persist() }}>
                    <span style={{ background: math.rgb(entry.color) }}></span>
                  </button>
                  <input defaultValue={entry.name} maxLength={40} key={entry.id + entry.name}
                    aria-label={`${math.hex(entry.color)} 的颜色名称`} placeholder="未命名"
                    onChange={(e) => renameColor(entry, e.target.value)} />
                  <span className="pk-row-actions">
                    <button className="palette-code pk-mono" title="复制颜色" onClick={() => void run(() => copyColor(entry.color))}>{math.hex(entry.color)}</button>
                    <button className="remove-color" aria-label={`移除 ${entry.name || math.hex(entry.color)}`} onClick={() => removeColor(entry)}>×</button>
                  </span>
                </div>
              ))}
            </div>
            <input id="palette-file" ref={paletteFileRef} type="file" accept="application/json,.json" hidden onChange={onPaletteFileChange} />
            <p className="helper">修改颜色名称自动保存；点击色值按默认格式复制。</p>
          </section>

          <section id="view-pick" className="view" role="tabpanel" aria-label="截图取色" hidden={view !== 'pick'}>
            <div className="view-head"><h2>像素取色</h2><button id="stop-pick" className="pk-btn" onClick={stopPick}>完成取色</button></div>
            <p className="helper">移动鼠标预览，点击收录。聚焦截图后可用方向键微调，Enter 确认。</p>
            <div className="shot-scroll">
              <canvas id="shot" ref={shotRef} tabIndex="0" aria-label="截图取色画布，方向键移动取样点，Enter 收录"
                onPointerMove={onShotPointerMove} onClick={commitPick} onKeyDown={onShotKeyDown}></canvas>
            </div>
            <div className="sample-row">
              <canvas id="magnifier" ref={magnifierRef} width="110" height="110" aria-label="取样点放大镜"></canvas>
              <div>
                <code id="sample-value">{sampleValue}</code>
                <p id="sample-position" className="helper">{samplePosition}</p>
                <button id="confirm-pick" className="pk-btn primary" disabled={confirmPickDisabled} onClick={commitPick}>收录此色</button>
              </div>
            </div>
          </section>
        </section>
      </div>

      <footer><span id="mode-hint">{modeHint || '输入颜色后 Enter 复制'}</span><button className="pk-btn ghost text-button" data-open-settings>取色设置</button></footer>
    </main>
  )
}
