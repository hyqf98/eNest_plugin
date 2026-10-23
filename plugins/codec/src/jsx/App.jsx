/**
 * 编解码主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 convert/convertLines/locateError/Data URL/历史记录 复用 core.mjs（未改动）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, MoreMenu, Select } from '../ui/index.jsx'
import {
  MODES,
  convert,
  convertLines,
  locateError,
  encodeDataUrl,
  parseDataUrl,
  mimeToExt,
  guessMime,
  HISTORY_KEY,
  pushHistory,
  normalizeHistory,
  formatHistoryTime,
} from '../js/core.mjs'

const api = window.enest || window.zapi
const FILE_LIMIT = 8 * 1024 * 1024
const DEBOUNCE = 150

const count = (text) =>
  text.length + ' 字符 · ' + new TextEncoder().encode(text).length + ' B'
const bytesLabel = (n) =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'

export function App() {
  const kitRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)

  const [mode, setMode] = useState('base64')
  const [direction, setDirection] = useState('encode')
  const [live, setLive] = useState(true)
  const [batch, setBatch] = useState(false)
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [inSize, setInSize] = useState('')
  const [outSize, setOutSize] = useState('')
  const [error, setError] = useState(null) // { message, index }
  const [batchRows, setBatchRows] = useState(null)
  const [status, setStatus] = useState('所有转换均在本地完成')
  const [copyDisabled, setCopyDisabled] = useState(true)
  const [saveDisabled, setSaveDisabled] = useState(true)
  const [saveFileHidden, setSaveFileHidden] = useState(true)
  const [fileChip, setFileChip] = useState(null) // { name, size }
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState([])

  const resultRef = useRef('')
  const dataUrlResultRef = useRef(null)
  const fileMetaRef = useRef(null)
  const historyRef = useRef([])
  historyRef.current = history
  const historyTimerRef = useRef(null)

  const saveText = useCallback(
    (name, content) =>
      kitRef.current.saveText(name, content).catch((e) => {
        kitRef.current.toast(e.message, 'error')
        return null
      }),
    []
  )

  /** 复制 + 记入最近转换（等价原 copy/remember） */
  const copy = useCallback(async (text) => {
    try {
      await kitRef.current.copy(text)
      remember(text)
    } catch (error) {
      kitRef.current.toast(error.message, 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remember = useCallback(
    (text) => {
      const result = resultRef.current
      if (!text || !result) return
      const entry = { text: text.slice(0, 4000), mode: modeRef.current, direction: dirRef.current, at: Date.now() }
      setHistory((prev) => {
        const rows = pushHistory(prev, entry)
        clearTimeout(historyTimerRef.current)
        historyTimerRef.current = setTimeout(() => {
          kitRef.current?.save(HISTORY_KEY, rows).catch(() => {})
        }, 400)
        return rows
      })
    },
    []
  )
  const modeRef = useRef(mode)
  modeRef.current = mode
  const dirRef = useRef(direction)
  dirRef.current = direction

  /** 复位结果区（等价原 reset；fileMeta 由调用方决定去留） */
  const resetResult = useCallback((keepFile = false) => {
    resultRef.current = ''
    setOutput('')
    setCopyDisabled(true)
    setSaveDisabled(true)
    setOutSize('')
    setSaveFileHidden(true)
    setBatchRows(null)
    if (!keepFile && fileMetaRef.current) resetFile()
  }, [])

  const resetFile = useCallback(() => {
    fileMetaRef.current = null
    dataUrlResultRef.current = null
    setFileChip(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const showError = useCallback((message, index = 0) => {
    setError({ message, index })
    setStatus('请检查输入内容')
  }, [])

  /** 转换主流程（等价原 run） */
  const run = useCallback(
    (source) => {
      const text = source ?? inputRef.current?.value ?? ''
      setInSize(text ? count(text) : '')
      setError(null)
      resetResult(true)
      if (!text) {
        setStatus('所有转换均在本地完成')
        return
      }
      const options = { strictUtf8: kitRef.current.settings.strictUtf8 !== false }
      try {
        const started = performance.now()
        if (batchRef.current) {
          const rows = convertLines(text, modeRef.current, dirRef.current, options)
          resultRef.current = rows.map((r) => (r.ok ? r.value : `[第 ${r.line} 行错误] ${r.value}`)).join('\n')
          setBatchRows(rows)
          setStatus(rows.filter((r) => r.ok).length + '/' + rows.length + ' 行成功')
        } else {
          resultRef.current = convert(text, modeRef.current, dirRef.current, options)
          setStatus('本地转换 · ' + (performance.now() - started).toFixed(1) + ' ms')
        }
        setOutput(resultRef.current)
        setOutSize(count(resultRef.current))
        setCopyDisabled(!resultRef.current)
        setSaveDisabled(!resultRef.current)
      } catch (e) {
        const located = locateError(text, modeRef.current, dirRef.current, options)
        showError(located ? located.message : e.message, located?.index || 0)
      }
    },
    [resetResult, showError]
  )
  const batchRef = useRef(batch)
  batchRef.current = batch

  /** 模式/方向切换派生 UI 参数（等价原 updateMode） */
  const decodable = mode !== 'jwt'
  const modeHelp =
    mode === 'jwt'
      ? '只查看，不验证签名'
      : mode === 'query'
        ? '解码 URL；编码二维字符串数组'
        : mode === 'dataurl'
          ? '解码 Data URL；编码文本'
          : 'UTF-8'
  const placeholder =
    mode === 'query'
      ? direction === 'decode'
        ? 'https://example.com/?key=value'
        : '[["key","value"]]'
      : mode === 'jwt'
        ? '粘贴 JWT，离线查看 Header / Payload'
        : mode === 'dataurl'
          ? '输入 Data URL 解析；或用右上角「文件转 Data URL」'
          : '输入或粘贴需要转换的内容'

  const pickMode = useCallback((key) => {
    setMode(key)
    modeRef.current = key
    if (key === 'jwt' || key === 'query') {
      setDirection('decode')
      dirRef.current = 'decode'
    }
  }, [])

  const pickDirection = useCallback((dir) => {
    setDirection(dir)
    dirRef.current = dir
  }, [])

  const clear = useCallback(() => {
    setInput('')
    setInSize('')
    setError(null)
    resetResult(true)
    inputRef.current?.focus()
  }, [resetResult])

  const swap = useCallback(() => {
    if (!resultRef.current) return
    setInput(resultRef.current)
    const next = dirRef.current === 'encode' ? 'decode' : 'encode'
    setDirection(next)
    dirRef.current = next
  }, [])

  const onInputChange = useCallback(
    (value) => {
      setInput(value)
      setInSize(count(value))
      setError(null)
      resetResult(true)
      clearTimeout(debounceRef.current)
      if (liveRef.current) debounceRef.current = setTimeout(() => runRef.current(value), DEBOUNCE)
    },
    [resetResult]
  )
  const debounceRef = useRef(null)
  const liveRef = useRef(live)
  liveRef.current = live
  const runRef = useRef(run)
  runRef.current = run

  /* ── 文件 → Data URL（宿主文件选择即授权） ── */
  const saveDataUrlFile = useCallback(() => {
    if (!dataUrlResultRef.current || !fileMetaRef.current) return
    return kitRef.current
      .saveFile(fileMetaRef.current.name + '.txt', dataUrlResultRef.current)
      .catch((e) => kitRef.current.toast(e.message, 'error'))
  }, [])

  const importFile = useCallback(
    async (file) => {
      if (file.size > FILE_LIMIT) {
        kitRef.current.toast('文件超过 8 MB，无法生成 Data URL', 'error')
        return
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const mime = file.type || guessMime(file.name)
        const url = encodeDataUrl(bytes, mime)
        const meta = { name: file.name, size: file.size, mime }
        // 先复位旧态，再落新值
        resetResult(false)
        fileMetaRef.current = meta
        dataUrlResultRef.current = url
        setDirection('encode')
        dirRef.current = 'encode'
        setInput('')
        setInSize('')
        resultRef.current = url
        setOutput(url)
        setOutSize(meta.name + ' · ' + bytesLabel(meta.size))
        setCopyDisabled(false)
        setSaveDisabled(false)
        setSaveFileHidden(false)
        setFileChip(meta)
        setStatus('Data URL 生成完毕（本地，未经过网络）')
      } catch (e) {
        kitRef.current.toast('读取文件失败：' + e.message, 'error')
      }
    },
    [resetResult]
  )

  const onSaveFile = useCallback(() => {
    if (!resultRef.current) return
    if (dataUrlResultRef.current) return saveDataUrlFile()
    if (/^data:([^;,]+);base64,/.test(resultRef.current)) {
      const info = parseDataUrl(resultRef.current)
      return kitRef.current
        .saveFile('dataurl.' + mimeToExt(info.mime), resultRef.current)
        .catch((e) => kitRef.current.toast(e.message, 'error'))
    }
    saveText('codec-dataurl.txt', resultRef.current)
  }, [saveDataUrlFile, saveText])

  /* ── 最近转换记录面板 ── */
  const openHistory = useCallback((open) => {
    setHistoryOpen(open)
  }, [])

  const recallHistory = useCallback((row) => {
    setHistoryOpen(false)
    pickMode(row.mode)
    setDirection(row.direction)
    dirRef.current = row.direction
    setInput(row.text)
    runRef.current(row.text)
    inputRef.current?.focus()
  }, [pickMode])

  /* ── 快捷键（等价原 document keydown） ── */
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        runRef.current()
        if (!e.shiftKey && resultRef.current) copy(resultRef.current)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        setHistoryOpen((open) => !open)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [copy])

  /* ── 历史面板外点关闭（等价原 document click） ── */
  useEffect(() => {
    if (!historyOpen) return
    const onClick = (e) => {
      if (!e.target.closest('#history-panel') && !e.target.closest('#history')) setHistoryOpen(false)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [historyOpen])

  /** 宿主适配器：quick 查询 / 动作 / onEnter / 设置（latest-ref 桥接） */
  useEffect(() => {
    const kit = PluginKit.create({
      title: '编解码',
      quickPlaceholder: '输入待转换文本',
      height: 490,
      defaults: { defaultMode: 'base64', liveConversion: true, strictUtf8: true },
      onQuery(value) {
        setInput(value)
        runRef.current(value)
      },
      onAction(action) {
        if (action === 'submit') {
          runRef.current()
          if (resultRef.current) copyRef.current(resultRef.current)
        } else if (action === 'clear') {
          clearRef.current()
        }
      },
    })
    kitRef.current = kit
    kit.onSettings(() => {
      setLive(kit.settings.liveConversion !== false)
      runRef.current()
    })
    let routed = false
    api?.onEnter?.(({ code, payload }) => {
      if (code && MODES[code]) {
        routed = true
        setMode(code)
        modeRef.current = code
        if (['jwt', 'query'].includes(code)) {
          setDirection('decode')
          dirRef.current = 'decode'
        }
      }
      const text = typeof payload === 'string' ? payload : payload?.text
      if (text) {
        setInput(text)
        runRef.current(text)
      }
      inputRef.current?.focus()
    })
    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      if (!routed && MODES[kit.settings.defaultMode]) {
        setMode(kit.settings.defaultMode)
        modeRef.current = kit.settings.defaultMode
      }
      if (['jwt', 'query'].includes(modeRef.current)) {
        setDirection('decode')
        dirRef.current = 'decode'
      }
      setLive(kit.settings.liveConversion !== false)
      const loaded = normalizeHistory(await kit.load(HISTORY_KEY, []))
      if (!alive) return
      setHistory(loaded)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 输入/模式/方向/批量/即时 → 重新转换（等价原 onclick/onchange → run） */
  const bootRef = useRef(false)
  useEffect(() => {
    if (!bootRef.current) {
      bootRef.current = true
      return
    }
    run(input)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, direction, batch])

  useEffect(() => {
    if (live) run(input)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  const copyRef = useRef(copy)
  copyRef.current = copy
  const clearRef = useRef(clear)
  clearRef.current = clear

  return (
    <main className="codec">
      <div className="chrome">
        <header className="topbar">
          <h1>编解码</h1>
          <Select
            className="modes"
            minWidth={150}
            ariaLabel="转换类型"
            value={mode}
            options={Object.entries(MODES).map(([key, label]) => ({ value: key, label }))}
            onChange={pickMode}
          />
        </header>
        <div className="toolbar">
          <div className="segmented dir" role="group" aria-label="方向">
            <button
              id="dir-enc"
              type="button"
              className={decodable && direction === 'encode' ? 'active' : undefined}
              aria-pressed={decodable && direction === 'encode'}
              disabled={!decodable}
              onClick={() => pickDirection('encode')}
            >
              编码 →
            </button>
            <button
              id="dir-dec"
              type="button"
              className={decodable && direction === 'decode' ? 'active' : undefined}
              aria-pressed={decodable && direction === 'decode'}
              disabled={!decodable}
              onClick={() => pickDirection('decode')}
            >
              ← 解码
            </button>
          </div>
          <label className="opt" title="输入后自动转换">
            <input id="live" type="checkbox" checked={live} onChange={(e) => { setLive(e.target.checked); }} />
            <span>即时</span>
          </label>
          <label className="opt" title="多行输入逐行独立转换，失败行单独标出">
            <input id="batch" type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} />
            <span>逐行</span>
          </label>
          <span id="mode-help" className="hint">{modeHelp}</span>
          <span className="flex"></span>
          <Button
            id="history"
            variant="ghost"
            aria-haspopup="true"
            aria-expanded={historyOpen}
            onClick={() => openHistory(!historyOpen)}
          >
            最近
          </Button>
          <Button
            id="file-btn"
            variant="ghost"
            title="选择文件，生成 Data URL"
            hidden={mode !== 'dataurl'}
            onClick={() => fileInputRef.current?.click()}
          >
            文件转 Data URL
          </Button>
          <Button id="run" variant="primary" onClick={() => run()}>执行</Button>
          <input
            id="file-input"
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void importFile(file)
            }}
          />
          <div id="history-panel" className="history" hidden={!historyOpen}>
            <div className="history-head">
              <span className="history-title">最近转换</span>
              <Button
                id="history-clear"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setHistory([])
                  kitRef.current?.save(HISTORY_KEY, []).catch(() => {})
                }}
              >
                清空记录
              </Button>
            </div>
            <ul id="history-list">
              {history.map((row, i) => (
                <li key={row.at + '-' + i} className="history-item" onClick={() => recallHistory(row)}>
                  <code className="history-text">{row.text.replace(/\s+/g, ' ').slice(0, 60)}</code>
                  <span className="history-meta">
                    {MODES[row.mode]} · {row.direction === 'encode' ? '编码' : '解码'} · {formatHistoryTime(row.at)}
                  </span>
                </li>
              ))}
            </ul>
            <p id="history-empty" className="hint history-empty" hidden={history.length > 0}>
              暂无记录。复制、导出或回填结果后，会自动记下内容片段与所用模式。
            </p>
          </div>
        </div>
      </div>

      <section className="panes">
        <div className="pane">
          <div className="pane-head">
            <label htmlFor="input">输入</label>
            <button
              id="file-chip"
              type="button"
              className="chipfile"
              hidden={!fileChip}
              onClick={() => fileChip && saveDataUrlFile()}
            >
              {fileChip ? fileChip.name + ' · ' + bytesLabel(fileChip.size) + ' · 点击另存' : ''}
            </button>
            <span id="in-size" className="hint num">{inSize}</span>
            <Button
              id="paste"
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  const text = await api.clipboard.readText()
                  setInput(text)
                  runRef.current(text)
                } catch (e) {
                  kitRef.current.toast('无法读取剪贴板：' + e.message, 'error')
                }
              }}
            >
              粘贴
            </Button>
            <Button id="clear" size="sm" variant="ghost" onClick={clear}>清空</Button>
          </div>
          <textarea
            id="input"
            ref={inputRef}
            spellCheck="false"
            placeholder={placeholder}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
          ></textarea>
        </div>
        <div className="pane">
          <div className="pane-head">
            <label htmlFor="output">结果</label>
            <span id="out-size" className="hint num">{outSize}</span>
            <Button id="copy" size="sm" variant="ghost" disabled={copyDisabled} onClick={() => resultRef.current && copy(resultRef.current)}>
              复制
            </Button>
            <MoreMenu
              ariaLabel="结果操作"
              items={[
                { key: 'swap', label: '回填反转', disabled: !output, onSelect: swap },
                { key: 'save-file', label: '存为文件', disabled: saveFileHidden || saveDisabled, onSelect: onSaveFile },
                { key: 'export', label: '导出', disabled: saveDisabled, onSelect: () => resultRef.current && saveText('codec-' + modeRef.current + '.txt', resultRef.current) },
              ]}
            />
          </div>
          <textarea
            id="output"
            readOnly
            spellCheck="false"
            placeholder="转换结果"
            aria-live="polite"
            value={output}
          ></textarea>
          <div id="batch-list" className="batch" hidden={!batchRows}>
            {(batchRows || []).map((r) => (
              <div key={r.line} className={'batch-row' + (r.ok ? '' : ' bad')}>
                <span className="batch-line num">{String(r.line)}</span>
                <code>{r.value}</code>
              </div>
            ))}
          </div>
        </div>
      </section>

      {error && (
        <div id="error" role="alert">
          <span>转换失败：{error.message}</span>
          {error.index > 0 && (
            <button
              type="button"
              className="err-locate"
              onClick={() => {
                const field = inputRef.current
                field?.focus()
                field?.setSelectionRange(error.index, error.index + 1)
              }}
            >
              定位第 {error.index + 1} 个字符
            </button>
          )}
        </div>
      )}
      <footer>
        <span id="status">{status}</span>
        <span className="keys">
          <kbd>⌘/Ctrl</kbd> <kbd>⇧</kbd> <kbd>Enter</kbd> 执行
        </span>
      </footer>
    </main>
  )
}
