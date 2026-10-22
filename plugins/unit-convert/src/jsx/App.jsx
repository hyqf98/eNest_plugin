/**
 * 单位与汇率主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心（CATEGORIES / convertAll / formulaText / fx 系列 / rmb 等）复用 core.js（未改动）。
 * 原生 select 仍由 plugin-kit upgradeSelects 接管。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as core from '../js/core.js'

const api = window.enest || window.zapi
const FX_URL = 'https://open.er-api.com/v6/latest/USD'
const FAV_KEY = 'unit-convert.favorites.v1'
const PREF_KEY = 'unit-convert.prefs.v1'
const tabForMode = (tab, mode) =>
  core.TAB_ORDER.includes(tab) && !(mode === 'quick' && tab === 'fx') ? tab : 'length'

export function App() {
  const kitRef = useRef(null)
  const rowsRef = useRef(null)
  const presetFocusRef = useRef(null) // 预设点击后需聚焦并赋值的单位

  const [mode, setMode] = useState(() =>
    api?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode') || 'shell',
  )
  const modeRef = useRef(mode)
  const [activeTab, setActiveTab] = useState('length')
  const [favorites, setFavorites] = useState([])
  const [precision, setPrecision] = useState(12)
  const [scientific, setScientific] = useState(false)
  const [formula, setFormula] = useState({ text: '', hidden: true })
  const [editingField, setEditingField] = useState('')
  const [radixValues, setRadixValues] = useState({ 2: '0', 8: '0', 10: '0', 16: '0' })
  const [fxBase, setFxBase] = useState('USD')
  const [fxAmount, setFxAmount] = useState('1')
  const [fxState, setFxState] = useState('')
  const [fxRates, setFxRates] = useState(null)
  const [fxInfo, setFxInfo] = useState({ fetchedAt: 0, source: '' })
  const [rmbInput, setRmbInput] = useState('')
  const [footNote, setFootNote] = useState('')

  const stateRef = useRef({})
  stateRef.current = { ...stateRef.current, activeTab, favorites, precision, scientific, editingField, fxBase, fxAmount, fxRates, fxInfo }
  const unitValuesRef = useRef({}) // 各单位行当前值（联动写回）

  const isSpecial = (tab) => tab === 'temp' || tab === 'radix' || tab === 'fx'
  const favId = (tab, unit) => `${tab}:${unit}`
  const isFav = useCallback(
    (tab, unit) => stateRef.current.favorites.includes(favId(tab, unit)),
    [],
  )

  const toggleFav = useCallback((tab, unit) => {
    const id = favId(tab, unit)
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
      kitRef.current?.save(FAV_KEY, next).catch(() => {})
      return next
    })
  }, [])

  // —— 数值行（收藏单位置顶） ——//
  const unitRows = useCallback(
    (tab) => {
      if (tab === 'temp') return core.TEMP_UNITS.map((u) => ({ id: u.id, name: u.name }))
      if (tab === 'radix') return core.RADIX_BASES.map((b) => ({ id: String(b), name: `${b} 进制`, radix: b }))
      const units = core.CATEGORIES[tab].units
      return [...units].sort((a, b) => Number(isFav(tab, b.id)) - Number(isFav(tab, a.id)))
    },
    [isFav],
  )

  // —— 换算公式展示：焦点行 → 目标行 ——//
  const computeFormula = useCallback(() => {
    const s = stateRef.current
    if (s.activeTab === 'radix' || s.activeTab === 'fx' || !s.editingField) return { text: '', hidden: true }
    const rows = unitRows(s.activeTab)
    const targets = rows.filter((r) => r.id !== s.editingField).slice(0, 3)
    const lines = targets.map((t) => core.formulaText(s.activeTab, s.editingField, t.id)).filter(Boolean)
    return { text: lines.join('　·　'), hidden: !lines.length }
  }, [unitRows])

  /** 单位行输入联动（等价原 rows input 委托） */
  const onUnitInput = useCallback(
    (unit, value) => {
      const s = stateRef.current
      unitValuesRef.current[unit] = value
      setEditingField(unit)
      const parsed = core.parseInput(core.normalizeDigits(value))
      const results = core.convertAll(s.activeTab, unit, parsed, { precision: s.precision })
      for (const r of unitRows(s.activeTab)) {
        if (r.id === unit) continue
        const v = results[r.id]
        unitValuesRef.current[r.id] = v === undefined || !Number.isFinite(v) ? '' : core.formatNumber(v, { scientific: s.scientific }).replace(/,/g, '')
      }
      setFormula(computeFormula())
    },
    [computeFormula, unitRows],
  )

  const onRadixInput = useCallback(
    (baseId, value) => {
      const base = Number(baseId)
      setEditingField(baseId)
      setRadixValues((prev) => {
        const next = { ...prev, [baseId]: value }
        const n = core.parseRadix(core.normalizeDigits(value), base)
        for (const other of core.RADIX_BASES) {
          if (String(other) === String(baseId)) continue
          next[other] = n === null || Number.isNaN(n) ? '' : core.formatRadix(n, other, { group: other === 2 })
        }
        return next
      })
    },
    [],
  )

  /** 精度/科学计数变化后重放联动（等价原 replayEditing） */
  const replayEditing = useCallback(() => {
    const field = stateRef.current.editingField
    if (!field) return
    if (stateRef.current.activeTab === 'radix') {
      const value = radixValuesRef.current[field]
      if (value !== undefined) onRadixInput(field, value)
    } else {
      const value = unitValuesRef.current[field]
      if (value !== undefined) onUnitInput(field, value)
    }
  }, [onRadixInput, onUnitInput])
  const radixValuesRef = useRef(radixValues)
  radixValuesRef.current = radixValues

  // —— 预设（等价原 presets click） ——//
  const applyPreset = useCallback(
    (value) => {
      const m = value.match(/^([\d.]+)\s+(\S+)\s*=\s*([\d.]+)\s+(\S+)$/)
      if (!m) return
      const [, amount, fromUnit] = m
      for (const [tabId, cat] of Object.entries(core.CATEGORIES)) {
        const src = cat.units?.find((u) => u.id === fromUnit)
        if (src) {
          setActiveTab(tabId)
          presetFocusRef.current = { unit: fromUnit, amount }
          kitRef.current?.save(PREF_KEY, { ...stateRef.current.savedPrefs, lastTab: tabId }).catch(() => {})
          return
        }
      }
    },
    [],
  )

  // —— 汇率（等价原 ensureFx/refreshFx/renderFxRows） ——//
  const ensureFx = useCallback(async () => {
    const cache = await kitRef.current.load('fx_cache', null)
    if (cache?.rates) {
      setFxRates(cache.rates)
      setFxInfo({ fetchedAt: cache.fetchedAt, source: 'cache' })
    } else {
      setFxRates(core.FX_FALLBACK_RATES)
      setFxInfo({ fetchedAt: 0, source: 'fallback' })
    }
    await refreshFx({ background: Boolean(cache?.rates) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshFx = useCallback(async ({ background = false } = {}) => {
    setFxState('更新中…')
    try {
      const res = await api.net.fetch({ url: FX_URL, timeoutMs: 12000 })
      const parsed = core.parseFxResponse(res.body)
      setFxRates(parsed.rates)
      setFxInfo({ fetchedAt: parsed.fetchedAt, source: 'live' })
      await kitRef.current.save('fx_cache', { rates: parsed.rates, fetchedAt: parsed.fetchedAt })
      if (!background) kitRef.current.toast('汇率已更新', 'success')
    } catch {
      const cache = await kitRef.current.load('fx_cache', null)
      if (core.isCacheFresh(cache) || cache?.rates) {
        setFxRates(cache.rates)
        setFxInfo({ fetchedAt: cache.fetchedAt, source: 'cache' })
        if (!background) kitRef.current.toast(`网络失败，使用 ${new Date(cache.fetchedAt).toLocaleString()} 的缓存`, 'info')
      } else {
        setFxRates(core.FX_FALLBACK_RATES)
        setFxInfo({ fetchedAt: 0, source: 'fallback' })
        if (!background) kitRef.current.toast('网络失败，使用静态参考汇率', 'error')
      }
    }
  }, [])

  async function copyText(text, message) {
    try {
      await api.clipboard.writeText(text)
      kitRef.current.toast(message || '已复制', 'success')
    } catch (e) {
      kitRef.current.toast(e.message || '复制失败', 'error')
    }
  }

  // —— 复制全部结果（等价原 copy-all） ——//
  const copyAll = useCallback(() => {
    const rows = unitRows(stateRef.current.activeTab)
    const parts = rows
      .filter((r) => r.id !== 'fx')
      .map((r) => {
        const value = stateRef.current.activeTab === 'radix' ? radixValuesRef.current[r.id] : unitValuesRef.current[r.id]
        return `${r.name}: ${value ?? ''}`
      })
      .join('\n')
    void copyText(parts, '已复制全部结果')
  }, [unitRows])

  // —— 人民币大写（等价原 rmb-input oninput） ——//
  const rmb = useCallback(() => {
    const n = core.parseInput(core.normalizeDigits(rmbInput))
    return { upper: core.toRmbUpper(n), cn: core.toChineseNumber(n) }
  }, [rmbInput])

  // —— Tabs 切换（等价原 tabs click） ——//
  const pickTab = useCallback((tab) => {
    const next = tabForMode(tab, modeRef.current)
    if (next === stateRef.current.activeTab) return
    stateRef.current.activeTab = next
    setActiveTab(next)
    kitRef.current?.save(PREF_KEY, { ...stateRef.current.savedPrefs, lastTab: next }).catch(() => {})
    setEditingField('')
    setFormula({ text: '', hidden: true })
  }, [])

  /* —— 生命周期：PluginKit 一次初始化 + latest-ref 桥接 —— */
  useEffect(() => {
    const kit = PluginKit.create({
      title: '单位与汇率',
      quickPlaceholder: '输入数值即时换算',
      height: 420,
      defaults: { baseCurrency: 'USD' },
    })
    kitRef.current = kit
    const syncMode = (nextMode) => {
      modeRef.current = nextMode
      setMode(nextMode)
      const currentTab = stateRef.current.activeTab
      const nextTab = tabForMode(currentTab, nextMode)
      if (nextTab !== currentTab) {
        const focusHidden = document.activeElement?.closest('#tab-fx, #fx-section, #rmb-section')
        stateRef.current.activeTab = nextTab
        setActiveTab(nextTab)
        setEditingField('')
        setFormula({ text: '', hidden: true })
        if (focusHidden) document.getElementById(`tab-${nextTab}`)?.focus()
      }
    }
    // 初始模式与后续切换都先归一 Tab，不能只隐藏汇率入口。
    const offMode = kit.onMode(syncMode)
    syncMode(kit.mode)
    let alive = true
    let offSettings
    void (async () => {
      const savedFav = await kit.load(FAV_KEY, [])
      if (!alive) return
      const savedPrefs = await kit.load(PREF_KEY, {})
      if (!alive) return
      let prefs = { precision: 12, scientific: false, lastTab: '' }
      if (Array.isArray(savedFav)) setFavorites(savedFav.filter((f) => typeof f === 'string' && f.includes(':')).slice(0, 24))
      if (savedPrefs && typeof savedPrefs === 'object') {
        if (Number.isFinite(Number(savedPrefs.precision))) prefs.precision = Math.max(4, Math.min(15, Number(savedPrefs.precision)))
        prefs.scientific = Boolean(savedPrefs.scientific)
        if (typeof savedPrefs.lastTab === 'string' && core.TAB_ORDER.includes(savedPrefs.lastTab)) prefs.lastTab = savedPrefs.lastTab
      }
      setPrecision(prefs.precision)
      setScientific(prefs.scientific)
      if (prefs.lastTab) {
        const nextTab = tabForMode(prefs.lastTab, modeRef.current)
        stateRef.current.activeTab = nextTab
        setActiveTab(nextTab)
        setEditingField('')
        setFormula({ text: '', hidden: true })
      }
      stateRef.current.savedPrefs = prefs
      await kit.ready
      if (!alive) return
      setFxBase(String(kit.settings.baseCurrency || 'USD'))
      offSettings = kit.onSettings(() => {
        if (stateRef.current.activeTab === 'fx') setFxBase(String(kit.settings.baseCurrency || 'USD'))
      })
    })()
    const offEnter = api?.onEnter?.(async (event) => {
      const payload = event?.payload
      const text = typeof payload === 'string' ? payload : payload?.text
      if (text && !Number.isNaN(core.parseInput(core.normalizeDigits(String(text))))) {
        const first = unitRowsRef.current(stateRef.current.activeTab)[0]
        if (first) onUnitInputRef.current(first.id, String(text))
      }
    })
    return () => {
      alive = false
      offMode()
      offSettings?.()
      offEnter?.()
      kit.destroy()
      if (kitRef.current === kit) kitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const unitRowsRef = useRef(unitRows)
  unitRowsRef.current = unitRows
  const onUnitInputRef = useRef(onUnitInput)
  onUnitInputRef.current = onUnitInput

  /* —— fx 生命周期：切到 fx 时拉取（等价原 renderRows 内 ensureFx） —— */
  const ensureFxRef = useRef(ensureFx)
  ensureFxRef.current = ensureFx
  useEffect(() => {
    if (activeTab === 'fx' && mode !== 'quick') void ensureFxRef.current()
  }, [activeTab, mode])

  /* —— 表格行渲染数据 —— */
  const rows = unitRows(activeTab)
  const isRadix = activeTab === 'radix'
  const isFx = activeTab === 'fx' && mode !== 'quick'

  /* —— 联动值：非受控行使用 unitValuesRef；React 重渲染时保持输入框值 —— */
  const rowValue = (id) => unitValuesRef.current[id] ?? ''

  /* —— fx 行计算（等价原 renderFxRows） ——*/
  const base = String(stateRef.current.fxBase || 'USD')
  const fxAmountValue = core.parseInput(core.normalizeDigits(fxAmount)) || 0
  const fxResult = fxRates ? core.fxConvert(fxRates, base, fxAmountValue) : null
  const rmbText = rmb()

  /* —— 预设聚焦：切 tab 后给目标行赋值并触发联动（等价原 input.dispatchEvent） —— */
  useEffect(() => {
    const pending = presetFocusRef.current
    if (!pending) return
    presetFocusRef.current = null
    const input = rowsRef.current?.querySelector(`[data-unit="${CSS.escape(pending.unit)}"]`)
    if (input) {
      // 原生 setter 保持 React 受控外的 DOM 值同步，再走同一联动管线
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, pending.amount)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    }
  }, [activeTab])

  /* —— 脚注（等价原 foot-note 逻辑） ——*/
  useEffect(() => {
    setFootNote(
      activeTab === 'fx'
        ? fxInfo.source === 'live'
          ? `汇率更新于 ${new Date(fxInfo.fetchedAt).toLocaleString()} · open.er-api.com`
          : fxInfo.source === 'cache'
            ? `网络不可用，展示 ${new Date(fxInfo.fetchedAt).toLocaleString()} 的缓存汇率`
            : '网络不可用且无缓存，展示静态参考汇率（仅供参考）'
        : '修改任一行，其余即时联动 · ★ 置顶常用单位',
    )
  }, [activeTab, fxInfo])

  /* —— 公式随 tab/焦点变化 —— */
  useEffect(() => {
    setFormula(computeFormula())
  }, [activeTab, editingField, computeFormula])

  return (
    <main className="uc">
      <nav className="tabs" id="tabs" role="tablist" aria-label="换算类目">
        {core.TAB_ORDER.map((id) => (
          <button
            key={id}
            id={`tab-${id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls="uc-content"
            hidden={id === 'fx' && mode === 'quick'}
            data-tab={id}
            className={'chip' + (activeTab === id ? ' active' : '') + (core.CATEGORIES[id].units.some((u) => isFav(id, u.id)) ? ' has-fav' : '') + (id === 'fx' ? ' shell-only' : '')}
            onClick={() => pickTab(id)}
          >
            {core.CATEGORIES[id].name}
          </button>
        ))}
      </nav>

      <div className="uc-content" id="uc-content" role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
      <section className="pane" id="pane" hidden={isFx}>
        <div className="display-bar shell-only">
          <label className="ctl">
            精度
            <select
              id="precision"
              aria-label="有效数字位数"
              value={String(precision)}
              onChange={(e) => {
                const n = Number(e.target.value) || 12
                setPrecision(Math.max(4, Math.min(15, n)))
                kitRef.current?.save(PREF_KEY, { ...stateRef.current.savedPrefs, precision: Math.max(4, Math.min(15, n)) }).catch(() => {})
                setTimeout(replayEditing, 0)
              }}
            >
              <option value="6">6 位</option>
              <option value="8">8 位</option>
              <option value="10">10 位</option>
              <option value="12">12 位</option>
              <option value="15">15 位</option>
            </select>
          </label>
          <button
            id="scientific"
            type="button"
            className="ghost"
            aria-pressed={scientific}
            title="科学计数法切换"
            onClick={() => {
              setScientific((prev) => {
                kitRef.current?.save(PREF_KEY, { ...stateRef.current.savedPrefs, scientific: !prev }).catch(() => {})
                return !prev
              })
              setTimeout(replayEditing, 0)
            }}
          >
            科学计数
          </button>
          <span id="formula" className="formula mono" aria-live="polite" hidden={formula.hidden}>
            {formula.text}
          </span>
        </div>
        <div className="rows" id="rows" ref={rowsRef}>
          {isRadix
            ? rows.map((r) => (
                <label key={r.id} className="row">
                  <span className="row-name">{r.name}</span>
                  <input
                    className="mono"
                    data-radix={r.id}
                    spellCheck={false}
                    value={radixValues[r.id] || ''}
                    onInput={(e) => onRadixInput(r.id, e.target.value)}
                    onFocus={() => setEditingField(r.id)}
                    onChange={() => {}}
                  />
                </label>
              ))
            : rows.map((r) => (
                <label key={r.id} className={'row' + (isFav(activeTab, r.id) ? ' faved' : '')}>
                  <button
                    type="button"
                    className={'fav-btn' + (isFav(activeTab, r.id) ? ' on' : '')}
                    title={isFav(activeTab, r.id) ? '取消置顶' : '置顶常用'}
                    aria-label={`${r.name}${isFav(activeTab, r.id) ? '取消置顶' : '置顶常用'}`}
                    aria-pressed={isFav(activeTab, r.id)}
                    onClick={() => toggleFav(activeTab, r.id)}
                  >
                    {isFav(activeTab, r.id) ? '★' : '☆'}
                  </button>
                  <span className="row-name">{r.name}</span>
                  <input
                    className="mono"
                    inputMode="decimal"
                    data-unit={r.id}
                    defaultValue={rowValue(r.id)}
                    key={activeTab + ':' + r.id}
                    placeholder="0"
                    spellCheck={false}
                    onInput={(e) => onUnitInput(r.id, e.target.value)}
                    onFocus={() => setEditingField(r.id)}
                  />
                </label>
              ))}
        </div>
        <div className="presets shell-only" id="presets">
          {activeTab === 'fx' ? null : (
            <>
              <span className="eyebrow">常用换算</span>
              {core.PRESETS.map((p) => (
                <button key={p.value} type="button" className="preset" data-preset={p.value} onClick={() => applyPreset(p.value)}>
                  {p.label}
                </button>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="fx shell-only" id="fx-section" hidden={!isFx}>
        <div className="fx-head">
          <label>
            基准
            <select id="fx-base" value={base} onChange={(e) => {
              setFxBase(e.target.value)
              if (kitRef.current) kitRef.current.settings.baseCurrency = e.target.value
              void api?.settings?.set?.('baseCurrency', e.target.value).catch?.(() => {})
            }}>
              {core.FX_CURRENCIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            金额<input id="fx-amount" className="mono" inputMode="decimal" value={fxAmount} onInput={(e) => setFxAmount(e.target.value)} onChange={() => {}} />
          </label>
          <button id="fx-refresh" type="button" className="pk-btn" onClick={() => void refreshFx()}>刷新汇率</button>
          <span id="fx-state" className="muted">
            {fxState ||
              (fxInfo.source === 'live'
                ? `更新于 ${new Date(fxInfo.fetchedAt).toLocaleTimeString()}`
                : fxInfo.source === 'cache'
                  ? `缓存 · ${new Date(fxInfo.fetchedAt).toLocaleString()}`
                  : '静态参考汇率')}
          </span>
        </div>
        <div className="rows" id="fx-rows">
          {!fxRates ? (
            <div className="empty small">正在获取汇率…</div>
          ) : (
            core.FX_CURRENCIES.map((c) => {
              if (c.id === base) return null
              const v = fxResult[c.id]
              return (
                <div
                  key={c.id}
                  className="row fx-row"
                  data-fx={c.id}
                  tabIndex={0}
                  onClick={() => void copyText(core.formatNumber(v, { scientific }), `${c.id} 已复制`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void copyText(core.formatNumber(v, { scientific }), `${c.id} 已复制`)
                  }}
                >
                  <span className="row-name">
                    {c.id} <span className="muted">{c.name}</span>
                  </span>
                  <span className="row-value mono">{core.formatNumber(v, { scientific })}</span>
                </div>
              )
            })
          )}
        </div>
      </section>

      <section className="rmb shell-only" id="rmb-section" hidden={!isFx}>
        <div className="rmb-head">
          <span className="eyebrow">人民币大写 / 中文数字</span>
          <label>
            金额<input id="rmb-input" className="mono" inputMode="decimal" placeholder="如 1024.50" value={rmbInput} onInput={(e) => setRmbInput(e.target.value)} onChange={() => {}} />
          </label>
        </div>
        <div className="rmb-results">
          <div className="rmb-row">
            <span className="cap">票据大写</span>
            <span id="rmb-upper" className="mono">{rmbText.upper || '—'}</span>
            <button type="button" data-copy-target="rmb-upper" className="pk-btn ghost" onClick={() => rmbText.upper && rmbText.upper !== '—' && copyText(rmbText.upper, '已复制')}>复制</button>
          </div>
          <div className="rmb-row">
            <span className="cap">中文数字</span>
            <span id="rmb-cn" className="mono">{rmbText.cn || '—'}</span>
            <button type="button" data-copy-target="rmb-cn" className="pk-btn ghost" onClick={() => rmbText.cn && rmbText.cn !== '—' && copyText(rmbText.cn, '已复制')}>复制</button>
          </div>
        </div>
      </section>
      </div>

      <footer>
        <span id="foot-note">{footNote}</span>
        <span className="grow"></span>
        <button id="copy-all" type="button" className="pk-btn shell-only" onClick={copyAll}>复制全部结果</button>
      </footer>
    </main>
  )
}
