/**
 * 翻译主界面：翻译请求、历史记录与 Quick/桌面模式交互。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreMenu } from '../ui/index.jsx'

const api = window.enest || window.zapi
const KEY = 'translate_history_v2'
const LANGS = {
  auto: '自动检测',
  'zh-CN': '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
}
const LANG_OPTIONS = Object.entries(LANGS).map(([value, label]) => ({ value, label }))
const LANG_OPTIONS_NO_AUTO = LANG_OPTIONS.filter((o) => o.value !== 'auto')
const ENGINE_OPTIONS = [
  { value: 'auto', label: '自动引擎' },
  { value: 'google', label: 'Google' },
  { value: 'mymemory', label: 'MyMemory' },
]
const ENGINE_TAG = { google: 'Google', mymemory: 'MyMemory', local: '相同语言' }

/* ── 网络请求逻辑（原样复用，未改动） ── */
async function fetchJSON(url, label) {
  if (!api?.net?.fetch) throw Error('网络接口不可用')
  const res = await api.net.fetch({ url, method: 'GET', timeoutMs: 10000 })
  if (res.status < 200 || res.status >= 300)
    throw Error(`${label} HTTP ${res.status}`)
  try {
    return JSON.parse(res.body)
  } catch {
    throw Error(`${label} 返回了无法解析的内容`)
  }
}

async function google(q, src, tgt) {
  const data = await fetchJSON(
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
      encodeURIComponent(src) +
      '&tl=' +
      encodeURIComponent(tgt) +
      '&dt=t&q=' +
      encodeURIComponent(q),
    'Google',
  )
  if (!Array.isArray(data?.[0])) throw Error('Google 响应格式异常')
  const text = data[0]
    .filter((s) => Array.isArray(s) && typeof s[0] === 'string')
    .map((s) => s[0])
    .join('')
  if (!text) throw Error('Google 没有返回译文')
  return {
    text,
    detected: typeof data[2] === 'string' ? data[2] : '',
    engine: 'google',
  }
}

async function mymemory(q, src, tgt) {
  if (src === 'auto') throw Error('MyMemory 需要手动选择源语言')
  if (new TextEncoder().encode(q).length > 500)
    throw Error('MyMemory 单次最多支持 500 字节，请缩短原文或选择 Google')
  const data = await fetchJSON(
    'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(q) +
      '&langpair=' +
      encodeURIComponent(src + '|' + tgt),
    'MyMemory',
  )
  const text = data?.responseData?.translatedText
  if (
    typeof text !== 'string' ||
    !text ||
    /^(MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID )/i.test(text)
  )
    throw Error(text || 'MyMemory 没有返回译文')
  return { text, detected: src, engine: 'mymemory' }
}

async function translate(q, src, tgt, engine) {
  if (engine === 'google') return google(q, src, tgt)
  if (engine === 'mymemory') return mymemory(q, src, tgt)
  try {
    return await google(q, src, tgt)
  } catch (e) {
    if (String(e.message).includes('permission denied')) throw e
    if (src === 'auto')
      throw Error('Google 暂时不可用。请选择源语言后，可使用 MyMemory 重试。')
    return mymemory(q, src, tgt)
  }
}

/* —— 空结果对象（等价原 result 为 null 的展示态） —— */
const IDLE = {
  text: '译文会显示在这里',
  cls: 'placeholder',
  engineTag: '',
  detected: '',
}

export function App() {
  const kitRef = useRef(null)
  const inputRef = useRef(null)

  const [input, setInput] = useState('')
  const [src, setSrc] = useState('auto')
  const [tgt, setTgt] = useState('zh-CN')
  const [engine, setEngine] = useState('auto')
  const [result, setResult] = useState(null)
  const [output, setOutput] = useState(IDLE)
  const [busy, setBusy] = useState(false)
  const [runLabel, setRunLabel] = useState('翻译')
  const [runDisabled, setRunDisabled] = useState(false)
  const [hint, setHint] = useState('输入即翻译 · Enter 立即 · Shift+Enter 换行')
  const [history, setHistory] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyFilter, setHistoryFilter] = useState('all')
  const [historyQuery, setHistoryQuery] = useState('')
  const [loaded, setLoaded] = useState(false)
  /* 导出文本原本带 .shell-only（quick 隐藏）；收进 ⋯ 后按模式决定是否给出该项 */
  const [quickMode, setQuickMode] = useState(
    () => (api?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode')) === 'quick',
  )

  /* —— ref 桥接的命令式状态 —— */
  const stateRef = useRef({})
  const inputRefValue = useRef('')
  inputRefValue.current = input
  const srcRef = useRef(src); srcRef.current = src
  const tgtRef = useRef(tgt); tgtRef.current = tgt
  const engineRef = useRef(engine); engineRef.current = engine
  const resultRef = useRef(result); resultRef.current = result
  const historyRef = useRef(history); historyRef.current = history
  const loadedRef = useRef(loaded); loadedRef.current = loaded
  const detectedRef = useRef('')
  const requestRef = useRef(0)
  const timerRef = useRef(0)
  const preferenceQueueRef = useRef(Promise.resolve())
  const autoTranslateRef = useRef(false)
  const engineTagRef = useRef('')

  const invalidate = useCallback(() => {
    requestRef.current++
    clearTimeout(timerRef.current)
    setRunDisabled(false)
    setRunLabel('翻译')
    setHint('输入即翻译 · Enter 立即 · Shift+Enter 换行')
  }, [])

  const syncButtons = useCallback(() => {
    // copy/copy-both/favorite/export-current 的 disabled 由渲染表达式给出，这里只同步收藏文案
  }, [])

  const clear = useCallback(() => {
    invalidate()
    setInput('')
    kitRef.current?.setQuery('')
    setResult(null)
    detectedRef.current = ''
    setOutput({ text: '译文会显示在这里', cls: 'placeholder', engineTag: '', detected: '' })
    syncButtons()
  }, [invalidate, syncButtons])

  const inputChanged = useCallback((updateHost = true) => {
    invalidate()
    detectedRef.current = ''
    setResult(null)
    setOutput({ text: '原文已更新，正在翻译', cls: 'placeholder', engineTag: '', detected: '' })
    syncButtons()
    if (updateHost) kitRef.current?.setQuery(inputRefValue.current)
    // 即时翻译：停 350ms 自动联网翻译（防抖；autoTranslate 设置为暂停开关）
    if (!autoTranslateRef.current && inputRefValue.current.trim())
      timerRef.current = setTimeout(() => stateRef.current.run?.(), 350)
  }, [invalidate, syncButtons])

  const saveHistory = useCallback(async (rows) => {
    if (!loadedRef.current) return
    try {
      await kitRef.current?.save(KEY, { version: 2, history: rows })
    } catch (e) {
      kitRef.current?.toast('历史保存失败：' + e.message, 'error')
    }
  }, [])

  /* ── 翻译主流程（等价原 run） ── */
  const run = useCallback(async () => {
    await stateRef.current.initialized
    clearTimeout(timerRef.current)
    const source = inputRefValue.current.trim()
    if (!source) {
      stateRef.current.clear?.()
      return
    }
    const srcV = srcRef.current
    const tgtV = tgtRef.current
    const engineV = engineRef.current
    const id = ++requestRef.current
    setResult(null)
    setRunDisabled(true)
    setRunLabel('翻译中…')
    setOutput({ text: '', cls: 'placeholder busy', engineTag: '', detected: '' })
    const stateText = engineV === 'mymemory' ? 'MyMemory 正在翻译…' : '正在获取译文…'
    try {
      const translated =
        srcV === tgtV
          ? { text: source, detected: srcV, engine: 'local' }
          : await translate(source, srcV, tgtV, engineV)
      if (id !== requestRef.current) return
      detectedRef.current = translated.detected
      const prev = historyRef.current.find(
        (h) => h.source === source && h.src === srcV && h.tgt === tgtV,
      )
      const entry = {
        id: prev?.id || crypto.randomUUID(),
        source,
        text: translated.text,
        src: srcV,
        tgt: tgtV,
        detected: translated.detected,
        engine: translated.engine,
        ts: Date.now(),
        starred: prev?.starred || false,
      }
      let rows = [entry, ...historyRef.current.filter((h) => h.id !== entry.id)]
      let unstarred = 0
      rows = rows.filter((h) => h.starred || ++unstarred <= 300)
      setHistory(rows)
      setResult(entry)
      setOutput({
        text: entry.text,
        cls: '',
        engineTag: ENGINE_TAG[entry.engine] || '',
        detected: detectedRef.current ? '识别为 ' + (LANGS[detectedRef.current] || detectedRef.current) : '',
      })
      void saveHistory(rows)
    } catch (e) {
      if (id !== requestRef.current) return
      setResult(null)
      setOutput({ text: '翻译失败：' + e.message, cls: 'error', engineTag: '', detected: '' })
      setHint('调整语言或引擎后重试')
    } finally {
      if (id === requestRef.current) {
        setRunDisabled(false)
        setRunLabel('翻译')
      }
    }
  }, [saveHistory])

  const savePrefs = useCallback(() => {
    const prefs = { srcLang: srcRef.current, tgtLang: tgtRef.current, engine: engineRef.current }
    if (kitRef.current) Object.assign(kitRef.current.settings, prefs)
    preferenceQueueRef.current = preferenceQueueRef.current
      .catch(() => {})
      .then(async () => {
        for (const [key, value] of Object.entries(prefs))
          await api.settings.set(key, value)
      })
      .catch((e) => kitRef.current?.toast('偏好保存失败：' + e.message, 'error'))
  }, [])

  const changeDirection = useCallback(({ rerun = true } = {}) => {
    invalidate()
    setResult(null)
    syncButtons()
    savePrefs()
    if (rerun && inputRefValue.current.trim()) void run()
  }, [invalidate, savePrefs, run, syncButtons])

  /* —— 语言快捷 chips：当前目标语言高亮；原文即该语言时禁用 —— */
  const chipState = (lang) => ({
    active: lang === tgt,
    disabled: lang === src,
    title: lang === src ? '与源语言相同' : `译为${LANGS[lang]}`,
  })

  const recall = useCallback((id) => {
    const h = historyRef.current.find((h) => h.id === id)
    if (!h) return
    invalidate()
    setResult(h)
    detectedRef.current = h.detected || ''
    setInput(h.source)
    kitRef.current?.setQuery(h.source)
    setSrc(h.src)
    setTgt(h.tgt)
    setOutput({
      text: h.text,
      cls: '',
      engineTag: h.engine === 'google' ? 'Google' : h.engine === 'mymemory' ? 'MyMemory' : '本地',
      detected: detectedRef.current ? '识别为 ' + (LANGS[detectedRef.current] || detectedRef.current) : '',
    })
    setHistoryOpen(false)
    syncButtons()
  }, [invalidate, syncButtons])

  /* ── 设置驱动的语言/引擎/字号（等价原 applyPrefs） ── */
  const applyPrefs = useCallback(() => {
    const kit = kitRef.current
    if (!kit) return
    if (LANGS[kit.settings.srcLang]) setSrc(kit.settings.srcLang)
    if (kit.settings.tgtLang !== 'auto' && LANGS[kit.settings.tgtLang]) setTgt(kit.settings.tgtLang)
    if (['auto', 'google', 'mymemory'].includes(kit.settings.engine)) setEngine(kit.settings.engine)
    document.documentElement.style.setProperty(
      '--translation-font',
      Math.max(14, Math.min(24, Number(kit.settings.resultFontSize) || 18)) + 'px',
    )
  }, [])

  /* ── 宿主适配器（latest-ref 桥接，PluginKit.create 仅一次） ── */
  stateRef.current = { run, clear }

  /* 首帧前同步 data-mode：旧版由 kit 同步脚本在渲染前设置 html[data-mode]，
     React 挂载晚于该时序会丢掉首帧的 quick/shell 网格切换 */
  useEffect(() => {
    const mode = new URLSearchParams(location.search).get('mode')
    if (mode && !document.documentElement.dataset.mode) {
      document.documentElement.dataset.mode = mode === 'quick' ? 'quick' : 'shell'
    }
  }, [])

  useEffect(() => {
    const kit = PluginKit.create({
      title: '翻译',
      quickPlaceholder: '输入要翻译的文字 · Enter 翻译',
      height: 510,
      defaults: {
        srcLang: 'auto',
        tgtLang: 'zh-CN',
        engine: 'auto',
        autoTranslate: false,
        resultFontSize: 18,
      },
      onQuery: (value) => {
        setInput(String(value).slice(0, 10000))
        stateRef.current.inputChanged?.(false)
      },
      onAction: (action) => {
        if (action === 'submit') void stateRef.current.run?.()
        if (action === 'clear') stateRef.current.clear?.()
      },
    })
    kitRef.current = kit
    autoTranslateRef.current = !!kit.settings.autoTranslate

    let alive = true
    void (async () => {
      try {
        await kit.ready
        if (!alive) return
        renderChipsRef.current?.()
        const migrated = await kit.load('translate_prefs_v2_migrated', false)
        if (!migrated) {
          const old = {
            srcLang: await kit.load('srcLang', null),
            tgtLang: await kit.load('tgtLang', null),
            engine: await kit.load('engine', null),
          }
          /* 迁移写入失败不阻塞初始化（无宿主存储时 save 会 reject） */
          await kit.save('translate_prefs_v1_backup', old).catch(() => {})
          for (const [key, value] of Object.entries(old)) {
            if (
              value &&
              (key === 'engine'
                ? ['auto', 'google', 'mymemory'].includes(value)
                : LANGS[value] && (key !== 'tgtLang' || value !== 'auto'))
            ) {
              await api.settings.set(key, value)
              kit.settings[key] = value
            }
          }
          await kit.save('translate_prefs_v2_migrated', true).catch(() => {})
        }
        applyPrefs()
        const saved = await kit.load(KEY, { version: 2, history: [] })
        if (!alive) return
        if (saved.version !== 2 || !Array.isArray(saved.history))
          throw Error('翻译历史格式异常，原数据已保留')
        setHistory(
          saved.history.filter(
            (h) =>
              h &&
              typeof h.source === 'string' &&
              typeof h.text === 'string' &&
              typeof h.id === 'string',
          ),
        )
        setLoaded(true)
      } catch (e) {
        kitRef.current?.toast(e.message, 'error')
        setHistory([]) // 空列表由渲染层显示失败占位
      }
    })()
    return () => { alive = false }
  }, [applyPrefs])

  /* onSettings：设置变化即时生效（等价原 kit.onSettings） */
  useEffect(() => {
    const kit = kitRef.current
    if (!kit) return
    kit.onSettings((_settings, key) => {
      autoTranslateRef.current = !!kit.settings.autoTranslate
      const changed =
        (key === 'srcLang' && srcRef.current !== kit.settings.srcLang) ||
        (key === 'tgtLang' && tgtRef.current !== kit.settings.tgtLang) ||
        (key === 'engine' && engineRef.current !== kit.settings.engine)
      applyPrefs()
      if (loadedRef.current && changed) {
        invalidate()
        setResult(null)
        syncButtons()
      }
    })
    kit.onMode((next) => { setQuickMode(next === 'quick'); syncButtons() })
  }, [applyPrefs, invalidate, syncButtons])

  /* api.onEnter：快捷面板带入文本（等价原逻辑） */
  useEffect(() => {
    api?.onEnter?.(async ({ payload }) => {
      await stateRef.current.initialized
      const text =
        typeof payload === 'string'
          ? payload
          : payload?.type === 'text'
            ? payload.text
            : ''
      if (text) {
        setInput(text.slice(0, 10000))
        stateRef.current.inputChanged?.()
        void stateRef.current.run?.()
      }
    })
    api?.onBeforeClose?.(async () => {
      await stateRef.current.initialized
      invalidate()
      return preferenceQueueRef.current
    })
  }, [invalidate])

  /* initialized promise（首次 ready 后 resolve；与原版等价的时序护栏） */
  const initializedRef = useRef(Promise.resolve())
  useEffect(() => {
    initializedRef.current = kitRef.current?.ready ?? Promise.resolve()
    stateRef.current.initialized = initializedRef.current
  })

  /* —— 派生：历史过滤与按钮可用态 —— */
  const historyRows = history.filter(
    (h) =>
      (historyFilter !== 'starred' || h.starred) &&
      `${h.source} ${h.text}`
        .toLowerCase()
        .includes(historyQuery.toLowerCase()),
  )
  const hasResult = !!result
  const starred = hasResult && !!history.find((h) => h.id === result.id)?.starred
  const bilingual = () => (result ? result.source + '\n\n' + result.text : '')

  const paste = async () => {
    try {
      const text = await api.clipboard.readText()
      setInput(String(text || '').slice(0, 10000))
      inputChanged()
      inputRef.current?.focus()
    } catch (e) {
      kitRef.current?.toast(e.message, 'error')
    }
  }

  const swap = () => {
    const srcV = src === 'auto' ? detectedRef.current : src
    if (!srcV || !LANGS[srcV]) {
      kitRef.current?.toast('先翻译一次以检测源语言')
      return
    }
    setSrc(tgt)
    setTgt(srcV)
    if (result) {
      setInput(result.text)
      kitRef.current?.setQuery(result.text)
    }
    detectedRef.current = ''
    changeDirection()
  }

  /* renderLangChips 在原版是命令式刷新；React 下 chips 由渲染派生，保留空实现兼容初始化调用 */
  const renderChipsRef = useRef(null)
  renderChipsRef.current = () => {}

  return (
    <div className="app">
      <header>
        <h1>翻译</h1>
        <p>读懂另一种表达</p>
        <button id="history-toggle" onClick={() => setHistoryOpen((o) => !o)}>历史与收藏</button>
        <button data-open-settings>设置</button>
      </header>
      <main className="workspace">
        <section className="translator">
          <div className="language-bar">
            {/* 原生 select + plugin-kit upgradeSelects 自动升级（复刻原版机制，内容自适应宽） */}
            <select id="src" className="lang-pick" aria-label="源语言" value={src}
              onChange={(e) => { setSrc(e.target.value); changeDirection() }}>
              {LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button id="swap" aria-label="交换语言" onClick={swap}>⇄</button>
            <select id="tgt" className="lang-pick" aria-label="目标语言" value={tgt}
              onChange={(e) => { setTgt(e.target.value); changeDirection() }}>
              {LANG_OPTIONS_NO_AUTO.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div className="common">
              {['zh-CN', 'en', 'ja', 'ko', 'fr'].map((lang) => {
                const st = chipState(lang)
                return (
                  <button
                    key={lang} data-lang={lang}
                    className={st.active ? 'active' : undefined}
                    disabled={st.disabled} title={st.title}
                    onClick={() => { setTgt(lang); changeDirection() }}
                  >{lang === 'zh-CN' ? '中' : lang === 'en' ? '英' : lang === 'ja' ? '日' : lang === 'ko' ? '韩' : '法'}</button>
                )
              })}
            </div>
            <span className="spacer"></span>
            <select id="engine" aria-label="翻译引擎" value={engine}
              onChange={(e) => { setEngine(e.target.value); changeDirection() }}>
              {ENGINE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button className="quick-only" id="quick-history" onClick={() => setHistoryOpen(true)}>历史</button>
          </div>
          <div className="panes">
            <section className="pane">
              <div className="pane-label">
                <span>原文</span>
                <div>
                  <button id="paste" onClick={paste}>粘贴</button>
                  <button id="clear" onClick={clear}>清空</button>
                </div>
              </div>
              <textarea
                id="input" ref={inputRef}
                spellcheck="false"
                placeholder="输入或粘贴文本，点击翻译"
                aria-label="待翻译文本"
                maxlength="10000"
                value={input}
                onChange={(e) => { setInput(e.target.value); inputChanged() }}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.metaKey &&
                    !e.ctrlKey &&
                    !e.altKey &&
                    !e.isComposing
                  ) {
                    e.preventDefault()
                    void run()
                  }
                }}
              />
              <div className="pane-bottom">
                <span className="counter" id="counter">{input.length} / 10000</span>
                <span className="spacer"></span>
                <span id="detected">{output.detected}</span>
              </div>
            </section>
            <section className="pane">
              <div className="pane-label">
                <span>译文</span><span id="engine-tag">{output.engineTag}</span>
              </div>
              <div id="output" role="status" aria-live="polite" className={output.cls}>
                {output.text}
              </div>
              <div className="pane-bottom">
                <div className="output-row" id="output-state" hidden={!busy}>
                  <span className="dot blink" aria-hidden="true"></span>
                  <span className="busy-text" id="output-state-text">正在获取译文…</span>
                </div>
                <button id="copy" disabled={!hasResult}
                  onClick={() => hasResult && kitRef.current?.copy(result.text).catch((e) => kitRef.current?.toast(e.message, 'error'))}>复制译文</button>
                <span className="spacer"></span>
                <MoreMenu
                  ariaLabel="译文操作"
                  items={[
                    { key: 'favorite', label: starred ? '★ 已收藏' : '☆ 收藏', disabled: !hasResult, onSelect: () => {
                      if (!result) return
                      setHistory((rows) => {
                        const next = rows.map((h) => h.id === result.id ? { ...h, starred: !h.starred } : h)
                        void saveHistory(next)
                        return next
                      })
                      syncButtons()
                    } },
                    { key: 'copy-both', label: '复制双语', disabled: !hasResult, onSelect: () => hasResult && kitRef.current?.copy(bilingual()).catch((e) => kitRef.current?.toast(e.message, 'error')) },
                    ...(quickMode ? [] : [{ key: 'export-current', label: '导出文本', disabled: !hasResult, onSelect: () => kitRef.current?.saveText('翻译结果.txt', bilingual()).catch((e) => kitRef.current?.toast(e.message, 'error')) }]),
                  ]}
                />
              </div>
            </section>
          </div>
          <div className="actions">
            <span className="hint" id="hint">{hint}</span>
            <span className="grow"></span>
            <button id="run" className="primary" disabled={runDisabled} onClick={() => void run()}>{runLabel}</button>
          </div>
        </section>
        <aside className={'history shell-only' + (historyOpen ? ' open' : '')} id="history">
          <div className="history-head">
            <button data-history="all" className={historyFilter === 'all' ? 'active' : undefined}
              onClick={() => setHistoryFilter('all')}>最近翻译</button>
            <button data-history="starred" className={historyFilter === 'starred' ? 'active' : undefined}
              onClick={() => setHistoryFilter('starred')}>收藏</button>
            <button id="close-history" aria-label="关闭历史面板" onClick={() => setHistoryOpen(false)}>×</button>
          </div>
          <div className="history-search">
            <input
              id="history-search" type="search"
              placeholder="搜索原文或译文"
              aria-label="搜索翻译历史"
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
            />
          </div>
          <div id="history-list">
            {historyRows.length === 0 ? (
              <div className="empty">还没有翻译记录<br />成功的译文会保存在本机</div>
            ) : (
              historyRows.map((h) => (
                <article key={h.id} className="entry" data-id={h.id} tabIndex={0}
                  onClick={(e) => {
                    if (e.target.closest('[data-star]')) {
                      setHistory((rows) => {
                        const next = rows.map((x) => x.id === h.id ? { ...x, starred: !x.starred } : x)
                        void saveHistory(next)
                        return next
                      })
                      return
                    }
                    if (e.target.closest('[data-delete]')) {
                      setHistory((rows) => {
                        const next = rows.filter((x) => x.id !== h.id)
                        void saveHistory(next)
                        return next
                      })
                      return
                    }
                    recall(h.id)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') recall(h.id) }}
                >
                  <div className="entry-source">{h.source}</div>
                  <div className="entry-result">{h.text}</div>
                  <div className="entry-meta">
                    <span>{LANGS[h.src] || h.src} → {LANGS[h.tgt] || h.tgt} · {new Date(h.ts).toLocaleDateString()}</span>
                    <button data-star={h.id} aria-label={h.starred ? '取消收藏' : '收藏'}>{h.starred ? '★' : '☆'}</button>
                    <button data-delete={h.id} aria-label="删除历史">×</button>
                  </div>
                </article>
              ))
            )}
          </div>
          <div className="history-foot">
            <button id="export-history"
              onClick={() => kitRef.current?.saveText('翻译历史.json', JSON.stringify({ version: 2, history }, null, 2)).catch((e) => kitRef.current?.toast(e.message, 'error'))}>导出历史</button>
            <button id="clear-history"
              onClick={() => {
                if (confirm('清空所有未收藏的翻译历史？')) {
                  setHistory((rows) => {
                    const next = rows.filter((h) => h.starred)
                    void saveHistory(next)
                    return next
                  })
                }
              }}>清空未收藏</button>
          </div>
        </aside>
      </main>
    </div>
  )
}
