/** Shared calculator state, evaluator, memory and history across all three layouts. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { calculate, formatNumber, parseAssignment, isVariableName } from '../js/core.mjs'
import { TooltipProvider, MoreMenu } from '../ui/index.jsx'
import { PanelView } from './PanelView.jsx'

const VARS_KEY = 'calculator.vars.v1'
const KEYS = [
  'sin(', 'cos(', 'tan(', 'sqrt(', '^', '7', '8', '9', '/', 'AC',
  '4', '5', '6', '*', '⌫', '1', '2', '3', '-', '(', '0', '.', '%', '+', ')',
  'log(', 'ln(', 'π', 'g', '=',
]

const api = window.enest || window.zapi

export function App() {
  const kitRef = useRef(null)
  const exprRef = useRef(null)
  const listRef = useRef(null)

  const [mode, setMode] = useState(() => api?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode') || 'shell')
  const [expr, setExpr] = useState('')
  const [result, setResult] = useState({ text: '即输即算', error: false, value: null })
  const [memoryText, setMemoryText] = useState('M = 0')
  const [history, setHistory] = useState([])
  const [selected, setSelected] = useState(-1)
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  const [search, setSearch] = useState('')
  const [degrees, setDegrees] = useState(false)
  const [group, setGroup] = useState(true)
  const [padOpen, setPadOpen] = useState(false)
  const [settings, setSettings] = useState({ precision: 12, historyLimit: 100, angleUnit: 'rad' })

  const ansRef = useRef(0)
  const memoryRef = useRef(0)
  const varsRef = useRef({})
  const historyRef = useRef([])
  historyRef.current = history
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const fmt = useCallback((value) => formatNumber(value, settingsRef.current.precision, { group: groupRef.current }), [])
  const groupRef = useRef(true)
  groupRef.current = group
  const degreesRef = useRef(false)
  degreesRef.current = degrees

  const computeText = useCallback((source) => {
    try {
      const assign = parseAssignment(source)
      const target = assign ? assign.expr : source
      const value = calculate(target, { ans: ansRef.current, memory: memoryRef.current, degrees: degreesRef.current, vars: varsRef.current })
      return { value, assign }
    } catch (error) {
      return { error }
    }
  }, [])

  /** 计算 + 更新结果区（等价原 compute()） */
  const recompute = useCallback((source) => {
    const { value, assign, error } = computeText(source)
    if (error) {
      setResult({ text: error.message, error: true, value: null })
      return null
    }
    setResult({
      text: assign ? `${assign.name} = ${fmt(value)}` : value == null ? '即输即算' : fmt(value),
      error: false,
      value,
    })
    const vars = varsRef.current
    const memory = memoryRef.current
    setMemoryText(
      Object.keys(vars).length
        ? `M = ${fmt(memory)} · ${Object.entries(vars).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')}`
        : `M = ${fmt(memory)}`
    )
    return value
  }, [computeText, fmt])

  const persist = useCallback(async (rows) => {
    const kit = kitRef.current
    if (!kit) return
    await kit.save('calculator.history.v1', rows).catch((e) => kit.toast('记录保存失败：' + e.message, 'error'))
  }, [])

  /** Enter 记录（等价原 confirmEntry()） */
  const confirmEntry = useCallback(() => {
    const value = recompute(exprRef.current ? exprRef.current.value : expr)
    if (value == null) return
    const source = (exprRef.current ? exprRef.current.value : expr).trim()
    const assign = parseAssignment(source)
    const resultText = fmt(value)
    setHistory((prev) => {
      const previous = prev.find((r) => r.expr === source && r.result === resultText)
      let rows = prev.filter((r) => r !== previous)
      rows.unshift({ id: previous?.id || crypto.randomUUID(), expr: source, result: resultText, favorite: previous?.favorite || false, at: Date.now() })
      const limit = Math.max(20, Math.min(500, Number(settingsRef.current.historyLimit) || 100))
      let kept = 0
      rows = rows.filter((r) => r.favorite || ++kept <= limit)
      void persist(rows)
      return rows
    })
    ansRef.current = value
    if (assign) {
      varsRef.current[assign.name] = value
      kitRef.current?.save(VARS_KEY, varsRef.current).catch(() => {})
    }
    // Group separators are presentation only; continuation must remain a valid expression.
    const nextExpression = formatNumber(value, settingsRef.current.precision, { group: false })
    setExpr(nextExpression)
    kitRef.current?.setQuery(nextExpression)
    setSelected(-1)
    recompute(nextExpression)
  }, [expr, fmt, persist, recompute])

  const records = useMemo(
    () =>
      history.filter(
        (r) => (!onlyFavorites || r.favorite) && (r.expr + ' ' + r.result).toLowerCase().includes(search.toLowerCase())
      ),
    [history, onlyFavorites, search]
  )
  const selectedClamped = Math.min(selected, records.length - 1)

  const move = useCallback((delta) => {
    setSelected((prev) => {
      const rows = historyRef.current
      const q = document.getElementById('history-search')?.value.toLowerCase() ?? ''
      const filtered = rows.filter((r) => r && (!document.getElementById('favorites')?.matches('[aria-pressed="true"]') || r.favorite) && (r.expr + ' ' + r.result).toLowerCase().includes(q))
      if (!filtered.length) return prev
      const current = Math.min(prev, filtered.length - 1)
      return Math.max(0, Math.min(filtered.length - 1, current + delta))
    })
  }, [])

  useEffect(() => {
    if (selectedClamped >= 0) listRef.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selectedClamped])

  /** 键区插入（受控光标管理，等价原 insert()） */
  const insert = useCallback((text) => {
    const input = exprRef.current
    if (!input) return
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const next = input.value.slice(0, start) + text + input.value.slice(end)
    setExpr(next)
    setSelected(-1)
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + text.length, start + text.length) })
  }, [])

  const applyKey = useCallback((key) => {
    const input = exprRef.current
    if (key === '=') { confirmEntry(); return }
    if (key === 'AC') { setExpr(''); setSelected(-1); return }
    if (key === '⌫') {
      if (!input) return
      const start = input.selectionStart ?? input.value.length
      const end = input.selectionEnd ?? start
      const from = start === end ? Math.max(0, start - 1) : start
      const next = input.value.slice(0, from) + input.value.slice(end)
      setExpr(next)
      requestAnimationFrame(() => { input.focus(); input.setSelectionRange(from, from) })
      return
    }
    insert(key)
  }, [confirmEntry, insert])

  const onExprKeyDown = (event) => {
    if (event.isComposing) return
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      if (selectedClamped >= 0 && records[selectedClamped]) {
        setExpr(records[selectedClamped].expr)
        setSelected(-1)
      } else confirmEntry()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const copy = (text) =>
    kitRef.current?.copy(text).catch((error) => {
      kitRef.current?.toast(error.message, 'error')
      return false
    })
  const saveText = (name, content) =>
    kitRef.current?.saveText(name, content).catch((error) => {
      kitRef.current?.toast(error.message, 'error')
      return null
    })

  /** 表达式变化即重算（等价原 oninput → compute） */
  useEffect(() => { recompute(expr) }, [expr, degrees, settings.precision, recompute])
  useEffect(() => { recompute(expr) }, [group]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 宿主适配器：quick 查询 / 动作 / 设置变化 / onEnter（latest-ref 桥接） */
  const confirmRef = useRef(confirmEntry)
  confirmRef.current = confirmEntry
  const recomputeRef = useRef(recompute)
  recomputeRef.current = recompute
  const insertRef = useRef(insert)
  insertRef.current = insert

  useEffect(() => {
    const kit = PluginKit.create({
      title: '计算器',
      quickPlaceholder: '输入表达式，Enter 记录',
      height: 470,
      defaults: { precision: 12, historyLimit: 100, angleUnit: 'rad' },
      onQuery: (value) => { setExpr(value); setSelected(-1) },
      onAction: (action) => {
        if (action === 'submit') confirmRef.current()
        else if (action === 'clear') { setExpr(''); setSelected(-1) }
        else moveRef.current(action === 'next' ? 1 : -1)
      },
    })
    kitRef.current = kit
    setMode(kit.mode)
    const offMode = kit.onMode(setMode)
    kit.onSettings(() => { setSettings({ ...kit.settings }) })
    api?.onEnter?.(({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload?.text
      if (typeof text === 'string' && text) setExpr(text)
      exprRef.current?.focus()
    })
    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      setSettings({ ...kit.settings })
      setDegrees(kit.settings.angleUnit === 'deg')
      const loaded = await kit.load('calculator.history.v1', [])
      if (!alive) return
      setHistory(
        Array.isArray(loaded)
          ? loaded.filter((r) => r && typeof r.expr === 'string' && typeof r.result === 'string').slice(0, 1000)
          : []
      )
      const savedVars = await kit.load(VARS_KEY, {})
      if (!alive) return
      if (savedVars && typeof savedVars === 'object' && !Array.isArray(savedVars)) {
        for (const [k, v] of Object.entries(savedVars)) {
          if (isVariableName(k) && Number.isFinite(Number(v))) varsRef.current[k] = Number(v)
        }
        recomputeRef.current(exprRef.current?.value ?? '')
      }
    })()
    return () => { alive = false; offMode() }
  }, [])
  const moveRef = useRef(move)
  moveRef.current = move

  if (mode === 'panel') {
    return <PanelView
      expr={expr}
      inputRef={exprRef}
      result={result}
      recent={history[0]}
      onChange={(value) => { setExpr(value); setSelected(-1) }}
      onConfirm={confirmEntry}
      onCopy={() => result.value != null && copy(fmt(result.value))}
      onOpen={() => api?.ui?.openInShell?.().catch((error) => kitRef.current?.toast(error.message, 'error'))}
    />
  }

  return (
    <TooltipProvider>
      <main className="calculator">
        <header>
          <h1>计算器</h1>
          <span className="sub">表达式工作台</span>
          <div className="toolbar">
            <button id="angle" type="button" aria-pressed={degrees}
              onClick={() => setDegrees((d) => !d)}>{degrees ? 'DEG' : 'RAD'}</button>
            <button id="group-toggle" type="button" aria-pressed={group} title="结果千分位分组"
              onClick={() => setGroup((g) => !g)}>{group ? '千分位' : '原始'}</button>
            <button id="toggle-pad" type="button" aria-expanded={padOpen}
              onClick={() => setPadOpen((p) => !p)}>键盘</button>
          </div>
        </header>
        <section className="workbench">
          <div className="calculation">
            <label htmlFor="expr" className="caption">表达式</label>
            <input
              id="expr" ref={exprRef} spellCheck="false" autoComplete="off"
              placeholder="输入表达式、x = 5 赋值或 200 × 10%"
              aria-label="计算表达式"
              value={expr}
              onChange={(e) => { setExpr(e.target.value); setSelected(-1) }}
              onKeyDown={onExprKeyDown}
            />
            <div className="answer">
              <output id="result" aria-live="polite" className={result.error ? 'error' : ''}>{result.text}</output>
              <button id="copy" type="button" disabled={result.value == null}
                onClick={() => result.value != null && copy(fmt(result.value))}>复制结果</button>
            </div>
            <p className="status" id="status">Enter 记录 · x = 5 赋值变量 · 10% 百分比 · 10 % 3 取模</p>
            <nav className="memory" aria-label="记忆操作">
              <button type="button" onClick={() => insert('Ans')}>Ans</button>
              <button type="button" onClick={() => insert('M')}>MR</button>
              <button id="memory-add" type="button" onClick={() => {
                const value = recompute(exprRef.current?.value ?? expr)
                if (value != null) {
                  memoryRef.current += value
                  setMemoryText(`M = ${fmt(memoryRef.current)}`)
                }
              }}>M+</button>
              <button id="memory-clear" type="button" onClick={() => {
                memoryRef.current = 0
                setMemoryText(`M = ${fmt(memoryRef.current)}`)
              }}>MC</button>
              <span id="memory-value">{memoryText}</span>
            </nav>
            <div id="keypad" className={'keypad' + (padOpen ? ' expanded' : '')}>
              {KEYS.map((key) => (
                <button key={key} type="button" className={key === '=' ? 'equal' : undefined}
                  title={key === 'π' ? '圆周率' : key === 'g' ? '重力加速度 9.80665' : undefined}
                  onClick={() => applyKey(key)}>{key}</button>
              ))}
            </div>
            <div className="function-guide">
              <span>sqrt / pow / abs</span><span>sin / cos / tan</span><span>ln / log / π / e / g</span>
            </div>
          </div>
          <aside className="history">
            <div className="history-head">
              <h2>计算记录</h2>
              <span id="history-count">{history.length ? String(history.length) : ''}</span>
              <MoreMenu
                ariaLabel="历史记录操作"
                items={[
                  { key: 'export', label: '导出全部可见记录', disabled: !records.length, onSelect: () => saveText('calculations.txt', records.map((r) => r.expr + ' = ' + r.result).join('\n')) },
                  { key: 'clear', label: '清空未收藏', danger: true, disabled: !history.some((r) => !r.favorite), onSelect: () => {
                    const rows = history.filter((r) => r.favorite)
                    setHistory(rows)
                    void persist(rows)
                  } },
                ]}
              />
            </div>
            <div className="filters">
              <input id="history-search" placeholder="搜索表达式或结果" aria-label="搜索记录"
                value={search} onChange={(e) => { setSearch(e.target.value); setSelected(-1) }} />
              <button id="favorites" type="button" aria-pressed={onlyFavorites}
                onClick={() => { setOnlyFavorites((f) => !f); setSelected(-1) }}>收藏</button>
            </div>
            <div id="history-list" className="history-list" ref={listRef}>
              {records.length === 0 ? (
                <p className="empty">还没有计算记录<br />输入表达式后按 Enter，随时回填继续计算。</p>
              ) : (
                records.map((r, i) => (
                  <article key={r.id} data-row-actions className={'record' + (i === selectedClamped ? ' selected' : '')}>
                    <button type="button" className="recall" title="回填表达式"
                      onClick={() => { setExpr(r.expr); exprRef.current?.focus() }}>
                      <span className="expression">{r.expr} =</span>
                      <span className="value">{r.result}</span>
                    </button>
                    <span className="pk-row-actions">
                      <button type="button" className="star" aria-pressed={r.favorite}
                        onClick={() => {
                          const rows = historyRef.current.map((row) => row.id === r.id ? { ...row, favorite: !row.favorite } : row)
                          setHistory(rows)
                          void persist(rows)
                        }}>{r.favorite ? '已收藏' : '收藏'}</button>
                      <button type="button" onClick={() => copy(r.result)}>复制</button>
                    </span>
                  </article>
                ))
              )}
            </div>
          </aside>
        </section>
        <footer>
          <span id="selection-hint">↑ ↓ 选择历史 · Enter 回填</span>
        </footer>
      </main>
    </TooltipProvider>
  )
}
