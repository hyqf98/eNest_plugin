/**
 * Cron 工具主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 表达式解析核心 core.mjs（parseExpression/nextFire/describe/parseCrontabLine…）原样复用；
 * 原生 <select>（时区）保留，plugin-kit upgradeSelects 自动接管；
 * 复选/分段仍为原生按钮（aria-pressed + .active 类驱动，样式不变）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DOMAINS,
  PRESETS,
  FIELD_CHIPS,
  parseExpression,
  nextFire,
  describe,
  parseCrontabLine,
} from '../js/core.mjs'
import { MoreMenu } from '../ui/index.jsx'

const api = window.enest || window.zapi

const PRESET_KEY = 'cron_presets_v1'
const BUILTIN_TAG = 'builtin'
const pad = (n) => String(n).padStart(2, '0')

/** 由值集合反推单域简洁写法（与原版相同） */
function canonicalField(set, domain) {
  const arr = [...set].sort((a, b) => a - b)
  if (arr.length === domain.max - domain.min + 1) return '*'
  if (arr.length === 1) return String(arr[0])
  const diff = arr[1] - arr[0]
  const steady = arr.length > 2 && arr.every((v, i) => i < 2 || v - arr[i - 1] === diff)
  if (steady && arr[0] === domain.min && arr[arr.length - 1] + diff > domain.max) return `*/${diff}`
  if (steady) return `${arr[0]}-${arr[arr.length - 1]}/${diff}`
  return arr.join(',')
}

export function App() {
  const kitRef = useRef(null)

  const [withSeconds, setWithSeconds] = useState(false)
  const [expression, setExpression] = useState('*/5 * * * *')
  const [fieldValues, setFieldValues] = useState({}) // key → 手动输入
  const [previewCount, setPreviewCount] = useState(10)
  const [timezone, setTimezone] = useState('local')
  const [userPresets, setUserPresets] = useState([])
  const [crontabText, setCrontabText] = useState('')
  const [crontabStatus, setCrontabStatus] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const stateRef = useRef({})
  stateRef.current = { withSeconds, expression, fieldValues, previewCount, timezone, userPresets }

  /* 解析结果（render 等价：表达式 + 域值派生全部下游） */
  const order = withSeconds ? DOMAINS : DOMAINS.slice(1)
  const parts = order.map((d) => (fieldValues[d.key] ?? '').trim() || '*')
  const exprFromFields = parts.join(' ')
  const activeExpr = expression
  let schedule = null
  let errorMessage = ''
  const meaningful = parts.some((p) => p !== '*') || exprFromFields.replace(/\*/g, '').trim() === ''
  if (meaningful) {
    try {
      schedule = parseExpression(activeExpr, { withSeconds })
    } catch (e) {
      errorMessage = e.message
    }
  }
  const humanize = schedule ? describe(schedule) : ''

  /* 未来执行（等价原 renderFires / lastFires；30s 轻刷新 + 1s 相对列刷新） */
  const [fireRows, setFireRows] = useState(null)
  useEffect(() => {
    if (!schedule) { setFireRows(null); return }
    try {
      setFireRows(nextFire(schedule, new Date(), previewCount))
    } catch {
      setFireRows(null)
    }
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [schedule?.raw, withSeconds, previewCount]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])
  void now // 相对列随 now 重算

  const utcMode = timezone === 'UTC'
  const formatLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? ':' + pad(d.getSeconds()) : ''}`
  const formatUtc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${withSeconds ? ':' + pad(d.getUTCSeconds()) : ''}`
  function countdown(ms) {
    if (ms < 0) return '已过期'
    const s = Math.round(ms / 1000)
    if (s < 90) return `${s} 秒`
    const m = Math.round(s / 60)
    if (m < 90) return `${m} 分钟`
    const h = Math.round(m / 60)
    if (h < 48) return `${h} 小时`
    const dayCount = Math.round(h / 24)
    if (dayCount < 60) return `${dayCount} 天`
    return `${(dayCount / 365).toFixed(1)} 年`
  }

  document.title = schedule ? `Cron · ${activeExpr}` : 'Cron 工具'

  /* ── 域构建器联动（等价原 syncExpressionFromFields / chip 点击 / 手动输入） ── */
  const setField = useCallback((key, value) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }))
  }, [])

  const applyExpressionToFields = useCallback((source, seconds) => {
    let parsed
    try {
      parsed = parseExpression(source, { withSeconds: seconds })
    } catch {
      return false
    }
    setWithSeconds(seconds)
    const nextOrder = seconds ? DOMAINS : DOMAINS.slice(1)
    const next = {}
    for (const d of nextOrder) next[d.key] = canonicalField(parsed.sets[d.index], d)
    setFieldValues(next)
    return true
  }, [])

  /* ── 预设（storage 复用 PRESET_KEY 契约） ── */
  const persistPresets = useCallback(async (rows) => {
    try { await kitRef.current?.save(PRESET_KEY, rows) } catch (e) { kitRef.current?.toast(e.message, 'error') }
  }, [])

  const onPresetClick = useCallback((preset) => {
    const seconds = preset.expr.trim().split(/\s+/).length === 6
    if (applyExpressionToFields(preset.expr, seconds)) {
      setExpression(preset.expr)
    }
  }, [applyExpressionToFields])

  const savePreset = useCallback(() => {
    const source = stateRef.current.expression.trim()
    const human = humanize || source
    if (!source) return
    setUserPresets((prev) => {
      const next = [{ name: human.slice(0, 30) || source, expr: source }, ...prev.filter((p) => p.expr !== source)].slice(0, 100)
      void persistPresets(next)
      return next
    })
    kitRef.current?.toast('已保存到预设库', 'success')
  }, [humanize, persistPresets])

  const resetPresets = useCallback(() => {
    setUserPresets([])
    void persistPresets([])
    kitRef.current?.toast('已恢复内置预设', 'info')
  }, [persistPresets])

  const deletePreset = useCallback((index) => {
    setUserPresets((prev) => {
      const next = prev.slice()
      next.splice(index, 1)
      void persistPresets(next)
      return next
    })
  }, [persistPresets])

  /* ── crontab（等价原 parse/export） ── */
  const parseCrontab = useCallback(() => {
    const lines = crontabText.split('\n')
    const parsed = []
    const errors = []
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue
      try {
        const expr = parseCrontabLine(line)
        if (expr) {
          parseExpression(expr, { withSeconds: expr.split(/\s+/).length === 6 })
          parsed.push({ line: i + 1, expr })
        }
      } catch (e) {
        errors.push(`第 ${i + 1} 行：${e.message}`)
      }
    }
    if (errors.length) {
      setCrontabStatus(errors.slice(0, 3).join('；'))
      kitRef.current?.toast(errors[0], 'error')
      return
    }
    if (!parsed.length) {
      setCrontabStatus('没有可解析的行（空行与注释会被跳过）')
      return
    }
    const first = parsed[0]
    if (applyExpressionToFields(first.expr, first.expr.split(/\s+/).length === 6)) {
      setExpression(first.expr)
    }
    setCrontabStatus(`已解析 ${parsed.length} 行，构建器载入第 ${first.line} 行`)
    kitRef.current?.toast(`已载入第 ${first.line} 行表达式`, 'success')
  }, [applyExpressionToFields, crontabText])

  const exportCrontab = useCallback(() => {
    const source = stateRef.current.expression
    const lines = crontabText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('@'))
    const body = lines.length ? lines.map((l) => `${l}  # 由构建器保留`).join('\n') : ''
    const entry = `${source}  # ${humanize || 'eNest Cron 构建器'}`
    kitRef.current?.copy(body ? `${body}\n${entry}` : entry).catch((e) => kitRef.current?.toast(e.message, 'error'))
  }, [crontabText, humanize])

  /* ── Quick / 初始化（latest-ref 桥接；hooks 规则：effect 在条件 return 之前） ── */
  const onQueryRef = useRef(null)
  onQueryRef.current = (value) => setExpression(String(value))
  const onActionRef = useRef(null)
  onActionRef.current = (action) => {
    if (action === 'clear') setExpression('')
    else if (action === 'submit') kitRef.current?.copy(stateRef.current.expression)
  }

  useEffect(() => {
    const kit = window.PluginKit.create({
      title: 'Cron 工具',
      quickPlaceholder: '粘贴 cron 表达式，即时解析并预览执行时间',
      height: 460,
      defaults: { withSeconds: false, timezone: 'local', previewCount: '10' },
      onQuery: (value) => onQueryRef.current?.(value),
      onAction: (action) => onActionRef.current?.(action),
    })
    kitRef.current = kit
    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      const saved = await kit.load(PRESET_KEY, null)
      if (Array.isArray(saved)) setUserPresets(saved.slice(0, 100))
      const seconds = Boolean(kit.settings.withSeconds)
      setWithSeconds(seconds)
      if (kit.settings.timezone === 'UTC') setTimezone('UTC')
      const savedCount = Number(kit.settings.previewCount)
      setPreviewCount([5, 10, 20].includes(savedCount) ? savedCount : 10)
      if (!stateRef.current.expression) setExpression('*/5 * * * *')
      /* 域输入留空（显示为 *），与原版 rebuildFields() 的初始空值一致 */
    })()
    return () => { alive = false }
  }, [])

  const copyExpression = useCallback(() => {
    kitRef.current?.copy(stateRef.current.expression.trim()).catch((e) => kitRef.current?.toast(e.message, 'error'))
  }, [])

  return (
    <main className="cron-app">
      <header className="topbar">
        <h1>Cron 工具</h1>
        <span className="sub">五域构建 · 自然语言 · 执行预览</span>
        <div className="toolbar">
          <div className="segmented" id="seconds-switch" role="group" aria-label="域模式">
            <button id="mode-5" type="button" className={withSeconds ? '' : 'active'} aria-pressed={!withSeconds}
              onClick={() => { setWithSeconds(false); applyExpressionToFields(expression, false) }}>5 域</button>
            <button id="mode-6" type="button" className={withSeconds ? 'active' : ''} aria-pressed={withSeconds}
              onClick={() => { setWithSeconds(true); applyExpressionToFields(expression, true) }}>6 域（秒）</button>
          </div>
        </div>
      </header>

      <section className="workbench">
        {/* 预设库侧栏（桌面形态） */}
        <aside className="presets shell-only" id="presets" aria-label="预设库">
          <div className="presets-head">
            <h2>预设库</h2>
            <span className="hint" id="preset-source">{userPresets.length ? `内置 + 自定义 ${userPresets.length}` : BUILTIN_TAG}</span>
          </div>
          <ul id="preset-list" className="preset-list">
            {PRESETS.map((p, i) => (
              <li key={`b${i}`} data-preset={`b${i}`} title={p.expr} onClick={() => onPresetClick(p)}>
                <span className="name">{p.name}</span><span className="expr">{p.expr}</span>
              </li>
            ))}
            {userPresets.map((p, i) => (
              <li key={`u${i}`} data-preset={`u${i}`} title={p.expr} onClick={() => onPresetClick(p)}>
                <span className="name">{p.name}</span>
                <button type="button" className="del" data-del-preset={i} aria-label={`删除 ${p.name}`}
                  onClick={(e) => { e.stopPropagation(); deletePreset(i) }}>×</button>
                <span className="expr">{p.expr}</span>
              </li>
            ))}
          </ul>
          <div className="presets-foot">
            <button id="preset-save" type="button" disabled={!schedule} onClick={savePreset}>保存当前为预设</button>
            <MoreMenu
              ariaLabel="预设库操作"
              items={[
                { key: 'reset', label: '恢复内置', disabled: !userPresets.length, onSelect: resetPresets },
              ]}
            />
          </div>
        </aside>

        <section className="builder">
          {/* 表达式行 */}
          <div className="field">
            <label htmlFor="expression">Cron 表达式</label>
            <div className="expr-row">
              <input id="expression" className="mono" spellCheck="false" placeholder="*/5 * * * *"
                value={expression} onInput={(e) => setExpression(e.target.value)} />
              <button id="copy-expression" type="button" className="ghost" disabled={!schedule} onClick={copyExpression}>复制</button>
            </div>
            <div id="expr-error" className="error-bar" role="alert" hidden={!errorMessage}>{errorMessage}</div>
            <p id="humanize" className="humanize">{humanize}</p>
          </div>

          {/* 五/六域构建器 */}
          <div id="fields" className="fields">
            {order.map((d) => {
              const shown = (fieldValues[d.key] ?? '').trim() || '*'
              return (
                <div className="field-box" key={d.key} data-domain={d.key}>
                  <h3>{d.label}<span className="mono" data-value>{shown}</span></h3>
                  <div className="chips">
                    {(FIELD_CHIPS[d.key] || []).map((c) => (
                      <button key={c.value} type="button" data-chip={c.value} title={c.title || c.label}
                        onClick={() => setField(d.key, c.value)}>{c.label}</button>
                    ))}
                  </div>
                  <input data-input spellCheck="false" placeholder="手动输入：* 或 1-5 或 1,15"
                    value={fieldValues[d.key] ?? ''}
                    onInput={(e) => setField(d.key, e.target.value)} />
                </div>
              )
            })}
          </div>

          {/* 未来执行预览 */}
          <section className="panel">
            <div className="panel-head">
              <h2>未来执行 <span id="upcoming-count" className="mono">{fireRows ? `· 未来 ${fireRows.length} 次` : ''}</span></h2>
              <div className="preview-controls">
                <div className="segmented compact" id="count-switch" role="group" aria-label="预览次数">
                  {[5, 10, 20].map((count) => (
                    <button key={count} type="button" data-count={count}
                      className={previewCount === count ? 'active' : ''} aria-pressed={previewCount === count}
                      onClick={() => {
                        setPreviewCount(count)
                        void api?.storage?.set?.('cron_preview_count', String(count)).catch?.(() => {})
                      }}>{count} 次</button>
                  ))}
                </div>
                <select id="timezone" aria-label="预览时区" value={timezone}
                  onChange={(e) => {
                    setTimezone(e.target.value)
                    void api?.storage?.set?.('cron_tz_preview', e.target.value).catch?.(() => {})
                  }}>
                  <option value="local">本地时区</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>
            </div>
            <div className="table-wrap">
              <table className="fire-table">
                <thead>
                  <tr><th className="idx">#</th><th id="tz-label">{utcMode ? 'UTC 时间' : '本地时间'}</th><th id="tz-alt-label">{utcMode ? '本地对照' : 'UTC 对照'}</th><th className="rel-head">相对</th></tr>
                </thead>
                <tbody id="fire-list">
                  {!schedule ? (
                    <tr><td colSpan={4} className="empty-note">表达式有效后展示未来执行时间。</td></tr>
                  ) : !fireRows ? (
                    <tr><td colSpan={4} className="empty-note">表达式有效后展示未来执行时间。</td></tr>
                  ) : fireRows.map((d, i) => {
                    const primary = utcMode ? formatUtc(d) : formatLocal(d)
                    const alt = utcMode ? formatLocal(d) : formatUtc(d)
                    return (
                      <tr key={i}>
                        <td className="idx mono">{i + 1}</td>
                        <td className="mono">{primary}</td>
                        <td className="mono alt">{alt}</td>
                        <td className="rel">{countdown(d.getTime() - now)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* crontab 粘贴 / 导出 */}
          <section className="panel crontab-panel">
            <h2>crontab 行</h2>
            <div className="crontab-row">
              <textarea id="crontab" rows={3} className="mono" spellCheck="false" value={crontabText}
                placeholder="粘贴 crontab 行，支持 @daily / @hourly 等宏；每行一条，# 开头为注释"
                onInput={(e) => setCrontabText(e.target.value)}></textarea>
            </div>
            <div className="crontab-foot">
              <span id="crontab-status" className="hint">{crontabStatus || (schedule ? `当前：${schedule.raw}` : '表达式无效，无法导出')}</span>
              <span className="spacer"></span>
              <button id="crontab-parse" type="button" onClick={parseCrontab}>解析到构建器</button>
              <MoreMenu
                ariaLabel="crontab 操作"
                items={[
                  { key: 'export', label: '导出复制', disabled: !schedule, onSelect: exportCrontab },
                ]}
              />
            </div>
          </section>
        </section>
      </section>
    </main>
  )
}
