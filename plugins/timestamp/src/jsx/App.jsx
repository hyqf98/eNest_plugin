/**
 * 时间戳主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 parseTime/timeRows/formatZoned/formatTemplates/durationText/zoneOffsetText
 * 复用 core.mjs（未改动）；原生 select 仍由 plugin-kit upgradeSelects 接管。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseTime, timeRows, formatZoned, formatTemplates, durationText, zoneOffsetText } from '../js/core.mjs'

const api = window.enest || window.zapi
const WORLD_KEY = 'timestamp.worldZones.v1'
const RECENT_KEY = 'timestamp.recents.v1'

export function App() {
  const kitRef = useRef(null)
  const inputRef = useRef(null)
  const zoneAddRef = useRef(null)

  const [tab, setTab] = useState('convert')
  const [input, setInput] = useState('')
  const [unit, setUnit] = useState('auto')
  const [zone, setZone] = useState('Asia/Shanghai')
  const [paused, setPaused] = useState(false)
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState('')
  const [templates, setTemplates] = useState([])
  const [clock, setClock] = useState('--:--:--')
  const [clockZone, setClockZone] = useState('--')
  const [clockOffset, setClockOffset] = useState('')
  const [nowSec, setNowSec] = useState('--')
  const [nowMs, setNowMs] = useState('--')
  const [footerClock, setFooterClock] = useState('')
  const [worldZones, setWorldZones] = useState([])
  const [zoneAdd, setZoneAdd] = useState('')
  const [batchInput, setBatchInput] = useState('')
  const [batchFormat, setBatchFormat] = useState('date')
  const [batchResult, setBatchResult] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [dateEnd, setDateEnd] = useState('')
  const [dateResult, setDateResult] = useState('')
  const [dateAddStart, setDateAddStart] = useState('')
  const [dateOffset, setDateOffset] = useState('+1d')
  const [addResult, setAddResult] = useState('')

  const nowRef = useRef(Date.now())
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const visibleRef = useRef(true)
  const timerRef = useRef(null)
  const stateRef = useRef({})
  stateRef.current = { input, unit, zone, rows, selected, dateStart, dateEnd, dateAddStart, dateOffset, batchFormat, batchInput, worldZones }

  const copy = useCallback((text) => {
    return kitRef.current.copy(text).catch((error) => {
      kitRef.current.toast(error.message, 'error')
      return false
    })
  }, [])

  const saveText = useCallback((name, content) => {
    return kitRef.current.saveText(name, content).catch((error) => {
      kitRef.current.toast(error.message, 'error')
      return null
    })
  }, [])

  /* —— 收藏 / 历史转换（等价原 remember/loadRecents） —— */
  const recentsRef = useRef([])
  const remember = useCallback((expr, value) => {
    if (!expr || /^(now|现在)$/i.test(expr)) return
    recentsRef.current = recentsRef.current.filter((r) => r.expr !== expr)
    recentsRef.current.unshift({ expr, value, at: Date.now() })
    recentsRef.current = recentsRef.current.slice(0, 20)
    kitRef.current?.save(RECENT_KEY, recentsRef.current).catch(() => {})
  }, [])

  /* —— 结果行 + 格式模板（等价原 render/paint/renderTemplates） —— */
  const render = useCallback(() => {
    const s = stateRef.current
    try {
      const nextRows = timeRows(parseTime(s.input, s.unit, s.zone, nowRef.current), s.zone, nowRef.current)
      setRows(nextRows)
      setError('')
      setTemplates(formatTemplates(parseTime(s.input, s.unit, s.zone, nowRef.current), s.zone, nowRef.current))
    } catch (e) {
      setRows([])
      setTemplates([])
      setError(e instanceof RangeError ? '未知时区，请使用 Asia/Shanghai 等 IANA 名称' : e.message)
    }
  }, [])

  /* —— 时钟心跳（等价原 tick/start） —— */
  const tick = useCallback(() => {
    const s = stateRef.current
    if (!pausedRef.current) nowRef.current = Date.now()
    try {
      const zoned = formatZoned(nowRef.current, s.zone)
      setClock(zoned)
      setClockZone(s.zone)
      setClockOffset(zoneOffsetText(nowRef.current, s.zone))
      setNowSec(String(Math.floor(nowRef.current / 1000)))
      setNowMs(String(nowRef.current))
      setFooterClock(zoned)
      if (!s.input.trim() || /^(now|现在)$/i.test(s.input.trim())) render()
    } catch {
      /* 转换器已展示无效时区错误 */
    }
  }, [render])

  const start = useCallback(() => {
    clearInterval(timerRef.current)
    if (visibleRef.current && !pausedRef.current) timerRef.current = setInterval(tick, 1000)
    tick()
  }, [tick])

  /* —— 添加世界时钟时区（等价原 addWorldZone） —— */
  const addWorldZone = useCallback(() => {
    const value = stateRef.current.zoneAddText?.trim()
    if (!value) return
    try {
      formatZoned(nowRef.current, value)
    } catch {
      kitRef.current.toast('未知时区，请使用 IANA 名称', 'error')
      return
    }
    if (value === stateRef.current.zone || stateRef.current.worldZones.includes(value)) {
      kitRef.current.toast('该时区已在列表中', 'info')
      setZoneAdd('')
      return
    }
    setWorldZones((prev) => {
      const next = [...prev, value]
      if (next.length > 6) return next.slice(-6)
      kitRef.current?.save(WORLD_KEY, next).catch(() => {})
      return next
    })
    setZoneAdd('')
  }, [])

  /* —— 批量（等价原 batch-run/copy/save） —— */
  const runBatch = useCallback(() => {
    const lines = stateRef.current.batchInput.split(/\r?\n/).filter((v) => v.trim())
    if (lines.length > 1000) return kitRef.current.toast('每批最多 1000 行', 'warn')
    const snapshot = Date.now()
    const result = lines
      .map((line) => {
        try {
          const ms = parseTime(line, stateRef.current.unit, stateRef.current.zone, snapshot),
            f = stateRef.current.batchFormat
          return (
            line +
            '\t' +
            (f === 'iso'
              ? new Date(ms).toISOString()
              : f === 's'
                ? Math.floor(ms / 1000)
                : f === 'ms'
                  ? ms
                  : formatZoned(ms, stateRef.current.zone))
          )
        } catch (e) {
          return line + '\t错误：' + e.message
        }
      })
      .join('\n')
    setBatchResult(result)
  }, [])

  /* —— 日期计算（等价原 dateDiff/dateAdd，随输入实时） —— */
  const dateDiff = useCallback(() => {
    const s = stateRef.current
    try {
      const start = parseTime(s.dateStart, s.unit, s.zone, nowRef.current)
      const end = parseTime(s.dateEnd, s.unit, s.zone, nowRef.current)
      const diff = end - start
      setDateResult(durationText(diff) + '\n' + diff + ' 毫秒 / ' + (diff / 3600000).toFixed(4) + ' 小时')
    } catch (e) {
      setDateResult(e.message)
    }
  }, [])

  const dateAdd = useCallback(() => {
    const s = stateRef.current
    try {
      const offset = s.dateOffset.trim()
      if (!/^[+-]?\d+(?:\.\d+)?[smhdw]$/i.test(offset)) throw new Error('偏移使用 +1d、-2h 或 +30m')
      const baseText = s.dateAddStart.trim() || s.dateStart
      const start = parseTime(baseText, s.unit, s.zone, nowRef.current)
      const end = parseTime(offset, 'auto', s.zone, start)
      setAddResult(formatZoned(end, s.zone) + '\n' + end + ' 毫秒')
    } catch (e) {
      setAddResult(e.message)
    }
  }, [])

  /* —— 键盘选择（等价原 quick onAction next/prev 语义，输入框 ↑ ↓） —— */
  const move = useCallback((delta) => {
    setSelected((prev) => Math.max(0, Math.min(stateRef.current.rows.length - 1, prev + delta)))
  }, [])

  /* —— 生命周期：PluginKit 一次初始化 + latest-ref 桥接 —— */
  const renderRef = useRef(render)
  renderRef.current = render
  const tickRef = useRef(tick)
  tickRef.current = tick
  const moveRef = useRef(move)
  moveRef.current = move
  const startRef = useRef(start)
  startRef.current = start
  const copyRef = useRef(copy)
  copyRef.current = copy

  useEffect(() => {
    const kit = PluginKit.create({
      title: '时间戳',
      quickPlaceholder: '时间戳、日期或 +30m',
      height: 480,
      defaults: {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        defaultUnit: 'auto',
        batchFormat: 'date',
      },
      onQuery(value) {
        setInput(value)
      },
      onAction(action) {
        if (action === 'submit') {
          const row = stateRef.current.rows[stateRef.current.selected]
          if (row) copyRef.current(row.value)
        } else if (action === 'clear') {
          setInput('')
        } else {
          moveRef.current(action === 'next' ? 1 : -1)
        }
      },
    })
    kitRef.current = kit
    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      const tz = kit.settings.timeZone || 'UTC'
      setZone(tz)
      try {
        formatZoned(nowRef.current, tz)
      } catch {
        setZone('UTC')
        kit.toast('默认时区无效，已使用 UTC', 'warn')
      }
      setUnit(kit.settings.defaultUnit || 'auto')
      setBatchFormat(kit.settings.batchFormat || 'date')
      const savedZones = await kit.load(WORLD_KEY, [])
      if (!alive) return
      if (Array.isArray(savedZones)) setWorldZones(savedZones.filter((z) => typeof z === 'string' && z.includes('/')).slice(0, 6))
      const saved = await kit.load(RECENT_KEY, [])
      if (!alive) return
      if (Array.isArray(saved)) recentsRef.current = saved.filter((r) => r && r.expr).slice(0, 20)
      const s = kit.settings.timeZone || 'UTC'
      setDateStart(formatZoned(nowRef.current, s))
      setDateEnd(formatZoned(nowRef.current + 86400000, s))
      kit.onSettings((settings) => {
        setZone(settings.timeZone || 'UTC')
        setUnit(settings.defaultUnit || 'auto')
      })
    })()
    api?.onOut?.(() => {
      visibleRef.current = false
      clearInterval(timerRef.current)
    })
    api?.onDestroy?.(() => clearInterval(timerRef.current))
    api?.onEnter?.(({ payload }) => {
      visibleRef.current = true
      const text = typeof payload === 'string' ? payload : payload?.text
      if (text) {
        setInput(text)
        setTab('convert')
      }
      startRef.current()
    })
    return () => {
      alive = false
      clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* —— 时钟启动（等价原 boot start()） —— */
  useEffect(() => {
    start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* —— 输入/单位/时区变化 → 重新渲染（等价原 oninput/onchange） —— */
  useEffect(() => {
    render()
  }, [input, unit, zone, render])

  /* —— 时区变化 → 心跳刷新 —— */
  useEffect(() => {
    tick()
  }, [zone, tick])

  /* —— 日期计算实时（等价原 input 监听） —— */
  useEffect(() => {
    dateDiff()
  }, [dateStart, dateEnd, dateDiff])
  useEffect(() => {
    dateAdd()
  }, [dateAddStart, dateOffset, dateDiff])

  const pauseToggle = () => {
    const next = !paused
    setPaused(next)
    start()
  }

  return (
    <main className="time-studio">
      <header>
        <h1>时间戳</h1>
        <span className="live-dot" id="live-dot" aria-hidden="true" data-state={paused ? 'paused' : 'running'}></span>
        <span id="live-state" className="live-label">{paused ? '时钟已暂停' : '时钟运行中'}</span>
        <nav role="tablist" aria-label="功能区">
          <button type="button" data-tab="convert" role="tab" aria-selected={tab === 'convert'} onClick={() => setTab('convert')}>转换</button>
          <button type="button" data-tab="batch" role="tab" aria-selected={tab === 'batch'} onClick={() => setTab('batch')}>批量</button>
          <button type="button" data-tab="date" role="tab" aria-selected={tab === 'date'} onClick={() => setTab('date')}>日期计算</button>
        </nav>
        <button id="pause" type="button" className="ghost" aria-pressed={paused} onClick={pauseToggle}>{paused ? '继续' : '暂停'}</button>
      </header>
      <div className="workspace">
        <aside className="clock-panel">
          <p className="eyebrow">当前时间</p>
          <time id="clock">{clock}</time>
          <div className="clock-meta">
            <span id="clock-zone">{clockZone}</span>
            <span id="clock-offset" className="pk-badge-mini">{clockOffset}</span>
          </div>
          <div className="now-values">
            <button id="copy-now-s" type="button" className="now-chip" onClick={() => copy(String(Math.floor(nowRef.current / 1000)))}>
              <span className="now-label">Unix 秒</span>
              <span className="now-num mono">{nowSec}</span>
            </button>
            <button id="copy-now-ms" type="button" className="now-chip" onClick={() => copy(String(nowRef.current))}>
              <span className="now-label">Unix 毫秒</span>
              <span className="now-num mono">{nowMs}</span>
            </button>
          </div>
          <button
            id="use-now"
            type="button"
            className="ghost-wide"
            onClick={() => {
              setInput('')
              nowRef.current = Date.now()
              setTab('convert')
              render()
            }}
          >
            使用现在作为输入
          </button>
          <div className="world">
            <p className="eyebrow">时区速览</p>
            <div id="world-clocks">
              {[zone, ...worldZones.filter((z) => z !== zone)].map((z) => (
                <div key={z} className={'world-row' + (z === zone ? ' primary' : '')}>
                  <button
                    type="button"
                    className="world-name"
                    title={z + ' · 点击设为转换时区'}
                    onClick={() => {
                      setZone(z)
                      renderRef.current()
                      tickRef.current()
                    }}
                  >
                    {z.split('/').pop().replace(/_/g, ' ')}
                  </button>
                  <span className="world-right">
                    <time className="mono">{safeZone(() => formatZoned(nowRef.current, z), '').slice(11)}</time>
                    <span className="world-offset">{safeZone(() => zoneOffsetText(nowRef.current, z), '').replace('UTC', '')}</span>
                  </span>
                  <button
                    type="button"
                    className="world-del"
                    aria-label={'移除 ' + z}
                    tabIndex={z === zone ? -1 : 0}
                    onClick={() => {
                      if (z === zone) return
                      setWorldZones((prev) => {
                        const next = prev.filter((x) => x !== z)
                        kitRef.current?.save(WORLD_KEY, next).catch(() => {})
                        return next
                      })
                    }}
                  >
                    ⌫
                  </button>
                </div>
              ))}
            </div>
            <div className="zone-picker">
              <input
                id="zone-add"
                ref={zoneAddRef}
                list="zones"
                placeholder="添加时区，如 Asia/Tokyo"
                aria-label="添加时区"
                value={zoneAdd}
                onChange={(e) => setZoneAdd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addWorldZone()
                  }
                }}
              />
              <button id="zone-add-btn" type="button" aria-label="添加时区" onClick={addWorldZone}>添加</button>
            </div>
            <p className="zone-hint">点击城市跳到换算 · ⌫ 删除</p>
          </div>
        </aside>
        <section className="pane-scroll">
          <section className="converter" data-page="convert" hidden={tab !== 'convert'}>
            <div className="query">
              <label className="eyebrow" htmlFor="input">时间戳 / 日期 / 相对时间</label>
              <input
                id="input"
                ref={inputRef}
                placeholder="例如 1720000000、2026-10-13 09:30、+2h"
                autoComplete="off"
                spellCheck="false"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.isComposing) return
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    move(e.key === 'ArrowDown' ? 1 : -1)
                  } else if (e.key === 'Enter') {
                    const row = stateRef.current.rows[selected]
                    if (row) {
                      copy(row.value)
                      remember(stateRef.current.input.trim(), row.value)
                      setSelected(stateRef.current.selected)
                    }
                  }
                }}
              />
              <div className="options">
                <label>
                  单位
                  <select id="unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                    <option value="auto">自动</option>
                    <option value="s">秒</option>
                    <option value="ms">毫秒</option>
                  </select>
                </label>
                <label>
                  时区
                  <input id="zone" list="zones" aria-label="目标时区" value={zone} onChange={(e) => setZone(e.target.value)} />
                </label>
              </div>
              <div className="presets">
                {[
                  ['-1h', '一小时前'],
                  ['+30m', '半小时后'],
                  ['+1d', '一天后'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    data-relative={value}
                    onClick={() => {
                      setInput(value)
                      nowRef.current = Date.now()
                      renderRef.current()
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p id="error" role="alert">{error}</p>
            </div>
            <div id="results" className="results">
              {rows.map((row, i) => (
                <button
                  key={row.label + String(i)}
                  type="button"
                  className={'result-row' + (i === selected ? ' selected' : '')}
                  onClick={() => {
                    setSelected(i)
                    copy(row.value)
                    remember(stateRef.current.input.trim(), row.value)
                  }}
                >
                  <span className="label">{row.label}</span>
                  <span className="value mono">{row.value}</span>
                  <span className="copy-hint">复制</span>
                </button>
              ))}
            </div>
            <div className="templates">
              <p className="eyebrow">格式模板 · 点击复制</p>
              <div id="template-grid" className="template-grid">
                {templates.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    className="template-card"
                    onClick={() => {
                      copy(t.value)
                      remember(stateRef.current.input.trim(), t.value)
                    }}
                  >
                    <span className="t-label">{t.label}</span>
                    <span className="t-value mono">{t.value}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="batch" data-page="batch" hidden={tab !== 'batch'}>
            <div className="section-title">
              <h2>逐行转换</h2>
              <select id="batch-format" aria-label="输出格式" value={batchFormat} onChange={(e) => setBatchFormat(e.target.value)}>
                <option value="date">所选时区日期</option>
                <option value="iso">ISO UTC</option>
                <option value="s">Unix 秒</option>
                <option value="ms">Unix 毫秒</option>
              </select>
            </div>
            <textarea
              id="batch-input"
              placeholder="每行一个时间戳或日期，沿用转换页的单位和时区"
              aria-label="批量输入"
              value={batchInput}
              onChange={(e) => setBatchInput(e.target.value)}
            ></textarea>
            <div className="actions">
              <button id="batch-run" type="button" className="pk-btn primary" onClick={runBatch}>转换</button>
              <button id="batch-copy" type="button" className="pk-btn" onClick={() => batchResult && copy(batchResult)}>复制结果</button>
              <button
                id="batch-save"
                type="button"
                className="pk-btn"
                onClick={() => batchResult && saveText('timestamps.tsv', '输入\t结果\n' + batchResult)}
              >
                导出 TSV
              </button>
            </div>
            <pre id="batch-output" aria-live="polite">{batchResult || '先输入需要转换的内容'}</pre>
          </section>
          <section className="date-math" data-page="date" hidden={tab !== 'date'}>
            <h2>时间差</h2>
            <div className="field-grid">
              <label>起点<input id="date-start" placeholder="2026-10-13 09:00:00" value={dateStart} onChange={(e) => setDateStart(e.target.value)} /></label>
              <label>终点<input id="date-end" placeholder="2026-10-14 18:30:00" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)} /></label>
            </div>
            <button id="date-diff" type="button" className="pk-btn primary" onClick={dateDiff}>计算间隔</button>
            <output id="date-result" aria-live="polite">{dateResult}</output>
            <p className="note">按所选时区解析；1 天为精确 24 小时，DST 跳变日按真实秒数计。</p>
            <hr />
            <h2>日期加减</h2>
            <div className="field-grid">
              <label>起点<input id="date-add-start" placeholder="同上，默认使用时间差起点" value={dateAddStart} onChange={(e) => setDateAddStart(e.target.value)} /></label>
              <label>偏移<input id="date-offset" value={dateOffset} placeholder="+1d / -2h / +30m" onChange={(e) => setDateOffset(e.target.value)} /></label>
            </div>
            <output id="add-result" aria-live="polite">{addResult}</output>
            <div className="actions">
              <button id="date-add" type="button" className="pk-btn primary" onClick={dateAdd}>计算偏移</button>
              <button id="add-copy" type="button" className="pk-btn" onClick={() => copy(addResult)}>复制偏移结果</button>
            </div>
          </section>
        </section>
      </div>
      <footer>
        <span>点击结果行复制 · ↑ ↓ 选择 · Enter 复制</span>
        <span className="mono" id="footer-clock">{footerClock}</span>
      </footer>
    </main>
  )
}

/** 时区渲染容错：无效时区返回 fallback（等价原 try/catch 心跳容错） */
function safeZone(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}
