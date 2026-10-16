/**
 * 正则工作台主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心（FLAG_DEFS/CHEATSHEET/TEMPLATE_LIBRARY/compilePattern/collectMatches/
 * groupRows/parseReplacement/replaceAll/diffSegments）复用 core.mjs（未改动）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FLAG_DEFS,
  CHEATSHEET,
  TEMPLATE_LIBRARY,
  templateGroups,
  compilePattern,
  collectMatches,
  groupRows,
  parseReplacement,
  replaceAll,
  diffSegments,
} from '../js/core.mjs'

const esc = PluginKit.escape

const SAMPLE_TEXT = [
  '订单号：20260915，下单时间 2026-09-15 08:30。',
  '用户 alice@example.com 于 2026-10-01 注册。',
  '联系电话 13812345678，备用 15987654321。',
  '金额合计 1,299,000.00 元，见 https://example.com/invoice/2026。',
].join('\n')

const FLAG_BUTTONS = FLAG_DEFS.map((f) => ({
  key: f.key,
  detail: f.detail,
  label: f.label,
  html: `${f.key}<span class="flag-name">${esc(f.label)}</span>`,
}))
const SHEET_HTML = CHEATSHEET.map(
  (group) =>
    `<h3>${esc(group.title)}</h3><table class="cheat-table"><tbody>` +
    group.rows.map(([token, desc]) => `<tr><td class="mono">${esc(token)}</td><td>${esc(desc)}</td></tr>`).join('') +
    '</tbody></table>',
).join('')
const TEMPLATE_HTML = templateGroups()
  .map(
    (group) =>
      `<h3>${esc(group.name)}</h3><ul class="template-group">` +
      group.items
        .map(
          (t) =>
            `<li><button type="button" class="template-item" data-tpl="${esc(t.body)}" data-sample="${esc(t.sample)}" title="${esc(t.body)}"><span class="tpl-name">${esc(t.name)}</span><span class="tpl-body mono">${esc(t.body)}</span></button></li>`,
        )
        .join('') +
      '</ul>',
  )
  .join('')

function formatElapsed(ms) {
  if (ms < 1) return '<1ms'
  if (ms < 100) return `${ms.toFixed(1)}ms`
  return `${Math.round(ms)}ms`
}

export function App() {
  const kitRef = useRef(null)
  const patternRef = useRef(null)
  const samplesRef = useRef(null)
  const highlightRef = useRef(null)
  const matchListRef = useRef(null)

  const [pattern, setPattern] = useState('')
  const [samples, setSamples] = useState('')
  const [replacement, setReplacement] = useState('')
  const [flags, setFlags] = useState('g')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [debounced, setDebounced] = useState({ pattern: '', samples: '', replacement: '' })

  /* ── 匹配计算（等价原 render 的纯计算部分；输入防抖 120ms） ── */
  const result = useMemo(() => {
    const source = debounced.pattern
    const flagsStr = flags.split('').sort().join('')
    const text = debounced.samples
    let matches = []
    let error = null
    const t0 = performance.now()
    if (source) {
      let regexp
      try {
        regexp = compilePattern(source, flagsStr)
      } catch (e) {
        error = e
      }
      if (regexp) {
        try {
          matches = collectMatches(regexp, text)
        } catch (e) {
          error = e
        }
      }
    }
    const elapsed = performance.now() - t0
    return { source, text, matches, error, elapsed }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, flags])

  const { matches, error } = result

  /* ── 输入防抖（等价原 scheduleRender） ── */
  const timerRef = useRef(null)
  const scheduleRender = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setDebounced({
        pattern: patternRef.current?.value ?? '',
        samples: samplesRef.current?.value ?? '',
        replacement: replacementRef.current?.value ?? '',
      })
    }, 120)
  }, [])
  const replacementRef = useRef(replacement)
  replacementRef.current = replacement

  /* ── 启动：PluginKit 一次初始化 + latest-ref 桥接 ── */
  useEffect(() => {
    const kit = PluginKit.create({
      title: '正则工作台',
      quickPlaceholder: '输入正则，实时匹配下方样例',
      height: 480,
      defaults: { flags: 'g' },
      onQuery: (value) => {
        setPattern(String(value))
        setDebounced((prev) => ({ ...prev, pattern: String(value) }))
      },
      onAction: (action) => {
        if (action === 'submit') samplesRef.current?.focus()
        if (action === 'clear') {
          setPattern('')
          setDebounced((prev) => ({ ...prev, pattern: '' }))
        }
      },
    })
    kitRef.current = kit
    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      const saved = typeof kit.settings.flags === 'string' ? kit.settings.flags : 'g'
      setFlags(FLAG_DEFS.map((f) => f.key).filter((k) => saved.includes(k)).join(''))
      if (!(samplesRef.current?.value.trim()) && kit.mode === 'shell') {
        setSamples(SAMPLE_TEXT)
        setDebounced((prev) => ({ ...prev, samples: SAMPLE_TEXT }))
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── shell 模式默认样例（kit.ready 前 mode 已知） ── */
  useEffect(() => {
    const mode = new URLSearchParams(location.search).get('mode') || 'shell'
    if (!samples && mode === 'shell' && !samplesRef.current?.dataset.booted) {
      samplesRef.current.dataset.booted = '1'
      setSamples(SAMPLE_TEXT)
      setDebounced((prev) => ({ ...prev, samples: SAMPLE_TEXT }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── 文档标题（等价原 document.title） ── */
  useEffect(() => {
    document.title = result.source && !error ? `正则工作台 · ${matches.length} 处匹配` : '正则工作台'
  }, [result.source, error, matches.length])

  const runStats = result.source
    ? error
      ? '表达式有误'
      : `${matches.length} 处匹配 · ${formatElapsed(result.elapsed)}`
    : ''

  /* ── 高亮预览 HTML（等价原 highlightHtml） ── */
  const highlightHtml = useMemo(() => {
    const text = result.text
    if (!text) return ''
    if (!matches.length) return esc(text)
    let html = ''
    let cursor = 0
    matches.forEach((m, i) => {
      html += esc(text.slice(cursor, m.index))
      const textContent = esc(m.text) || '&#8203;'
      html += i === activeIndex ? `<mark class="active" data-index="${m.index}">${textContent}</mark>` : `<mark data-index="${m.index}">${textContent}</mark>`
      cursor = m.end
    })
    html += esc(text.slice(cursor))
    return html
  }, [result.text, matches, activeIndex])

  /* ── 分组表（等价原 renderGroups） ── */
  const groupsView = useMemo(() => {
    const pick = matches[activeIndex >= 0 ? activeIndex : 0]
    const shown = pick ? (matches.indexOf(pick) >= 0 ? matches.indexOf(pick) : 0) : -1
    if (shown < 0) return { which: '', html: '<p class="empty-note">有匹配结果后，此处展开捕获分组。</p>' }
    const rows = groupRows(pick)
    if (!rows.length) return { which: '', html: '<p class="empty-note">当前正则没有捕获分组，用 ( ) 包住子模式试试。</p>' }
    let html =
      '<table class="group-table"><thead><tr><th>引用</th><th class="num">组号</th><th>值</th></tr></thead><tbody>' +
      rows
        .map((r) => {
          const num = r.ref.startsWith('$<') ? '' : r.ref.slice(1)
          return `<tr><td class="mono">${esc(r.ref)}</td><td class="num">${esc(num)}</td><td class="mono">${esc(r.value ?? '未参与匹配')}</td></tr>`
        })
        .join('') +
      '</tbody></table>'
    if (matches.length > 1) html += '<p class="empty-note">点击匹配列表可切换查看。</p>'
    return { which: `第 ${shown + 1} 处`, html }
  }, [matches, activeIndex])

  /* ── 替换 diff（等价原 renderReplace） ── */
  const replaceView = useMemo(() => {
    const text = result.text
    if (!matches.length) return '<span class="empty-note">有匹配结果后展示替换 diff。</span>'
    const parts = parseReplacement(debounced.replacement)
    const after = replaceAll(matches, parts, text)
    const segments = diffSegments(text, after)
    return segments
      .map((s) => (s.type === 'same' ? esc(s.value) : s.type === 'ins' ? `<ins>${esc(s.value)}</ins>` : `<del>${esc(s.value)}</del>`))
      .join('')
  }, [matches, debounced.replacement, result.text])

  /* ── 匹配选择（等价原 selectMatch） ── */
  const selectMatch = useCallback(
    (i, scrollHighlight) => {
      setActiveIndex(i)
      const m = matches[i]
      if (!m) return
      if (scrollHighlight) {
        requestAnimationFrame(() => {
          highlightRef.current?.querySelector(`mark[data-index="${m.index}"]`)?.scrollIntoView({ block: 'nearest' })
          matchListRef.current?.children[i]?.scrollIntoView({ block: 'nearest' })
        })
      }
      if (kitRef.current?.mode === 'quick') samplesRef.current?.focus()
    },
    [matches],
  )

  const onHighlightClick = useCallback(
    (e) => {
      const mark = e.target.closest('mark[data-index]')
      if (!mark) return
      const i = matches.findIndex((m) => m.index === Number(mark.dataset.index))
      if (i < 0) return
      selectMatch(i, false)
    },
    [matches, selectMatch],
  )

  /* ── 模板库选择（等价原 template-list click） ── */
  const onTemplateClick = useCallback((e) => {
    const item = e.target.closest('[data-tpl]')
    if (!item) return
    setPattern(item.dataset.tpl)
    setDebounced((prev) => ({ ...prev, pattern: item.dataset.tpl }))
    if (item.dataset.sample) {
      setSamples(item.dataset.sample)
      setDebounced((prev) => ({ ...prev, samples: item.dataset.sample }))
    }
    setSnippetsOpen(false)
    requestAnimationFrame(() => patternRef.current?.focus())
  }, [])

  const toggleFlag = useCallback((key) => {
    setFlags((prev) => (prev.includes(key) ? prev.replace(key, '') : prev + key))
  }, [])

  const fillSample = useCallback(() => {
    setSamples(SAMPLE_TEXT)
    setDebounced((prev) => ({ ...prev, samples: SAMPLE_TEXT }))
    setPattern((prevPattern) => {
      if (prevPattern) return prevPattern
      setDebounced((prev) => ({ ...prev, pattern: '(\\d{4})-(\\d{2})-(\\d{2})' }))
      return '(\\d{4})-(\\d{2})-(\\d{2})'
    })
  }, [])

  const copyResult = useCallback(() => {
    const parts = parseReplacement(debounced.replacement)
    kitRef.current.copy(replaceAll(matches, parts, debounced.samples)).catch((e) => kitRef.current.toast(e.message, 'error'))
  }, [debounced, matches])

  /* ── 抽屉 Escape 关闭（等价原 drawer keydown） ── */
  const onDrawerKeyDown = useCallback((e, which) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (which === 'sheet') setSheetOpen(false)
      else setSnippetsOpen(false)
    }
  }, [])

  return (
    <main className="regex-app">
      <header className="topbar">
        <div className="brand">
          <h1>正则工作台</h1>
          <span className="sub">输入即时匹配 · 分组 · 替换</span>
        </div>
        <div className="toolbar">
          <button id="toggle-snippets" type="button" className="shell-only" aria-expanded={snippetsOpen} onClick={() => setSnippetsOpen((v) => !v)}>
            模板库
          </button>
          <button id="toggle-sheet" type="button" className="shell-only" aria-expanded={sheetOpen} onClick={() => setSheetOpen((v) => !v)}>
            速查表
          </button>
        </div>
      </header>

      <div className="workbench">
        {/* 左栏：模板库 + 表达式 + 标志位 + 替换 */}
        <section className="pane pane-input" aria-label="表达式与选项">
          <div className="field">
            <label htmlFor="pattern">正则表达式</label>
            <div className="pattern-row">
              <div className="pattern-delimiter" aria-hidden="true">/</div>
              <textarea
                id="pattern"
                ref={patternRef}
                rows={2}
                spellCheck={false}
                placeholder="(\d{4})-(\d{2})-(\d{2})"
                value={pattern}
                onInput={(e) => {
                  setPattern(e.target.value)
                  scheduleRender()
                }}
              ></textarea>
              <div className="pattern-delimiter" aria-hidden="true">/</div>
            </div>
            <div id="pattern-error" className="error-bar" role="alert" hidden={!error}>
              {error ? '非法正则：' + error.message : ''}
            </div>
          </div>

          <div className="field">
            <label htmlFor="flags">标志位</label>
            <div id="flags" className="flags" role="group" aria-label="匹配标志">
              {FLAG_BUTTONS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  data-flag={f.key}
                  aria-pressed={flags.includes(f.key)}
                  title={f.detail}
                  onClick={() => toggleFlag(f.key)}
                  dangerouslySetInnerHTML={{ __html: f.html }}
                />
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="samples">
              测试文本 <span id="match-count" className="mono">{matches.length ? `· ${matches.length} 处` : ''}</span>
            </label>
            <div className="sample-wrap">
              <textarea
                id="samples"
                ref={samplesRef}
                rows={7}
                spellCheck={false}
                placeholder="粘贴一段文本，或点击「填入示例」"
                value={samples}
                onInput={(e) => {
                  setSamples(e.target.value)
                  scheduleRender()
                }}
              ></textarea>
              <div id="sample-highlight" className="sample-highlight mono" aria-hidden="true"></div>
            </div>
            <button id="fill-sample" type="button" className="ghost sample-fill" onClick={fillSample}>
              填入示例
            </button>
          </div>

          <div className="field">
            <label htmlFor="replacement">
              替换表达式 <span className="label-hint">支持 $1 与 $&lt;name&gt;</span>
            </label>
            <div className="replace-row">
              <input
                id="replacement"
                className="mono"
                ref={replacementRef}
                spellCheck={false}
                placeholder="$<y>年$<m>月$<d>日"
                value={replacement}
                onInput={(e) => {
                  setReplacement(e.target.value)
                  scheduleRender()
                }}
                onChange={() => {}}
              />
              <button id="copy-result" type="button" disabled={!matches.length} onClick={copyResult}>
                复制结果
              </button>
            </div>
            <div
              id="replace-output"
              className="replace-output mono"
              aria-live="polite"
              dangerouslySetInnerHTML={{ __html: replaceView }}
            ></div>
          </div>
        </section>

        {/* 右栏：匹配高亮预览 + 匹配列表 + 分组 */}
        <section className="pane pane-result" aria-label="匹配结果">
          <div className="result-head">
            <h2>匹配预览</h2>
            <span id="run-stats" className="mono" role="status">
              {runStats}
            </span>
          </div>
          <div
            id="highlight-view"
            ref={highlightRef}
            className="highlight-view mono"
            tabIndex={0}
            aria-label="匹配高亮预览"
            onClick={onHighlightClick}
            dangerouslySetInnerHTML={{ __html: highlightHtml }}
          ></div>

          <div className="result-split">
            <section className="result-panel">
              <h2>
                匹配列表 <span id="match-badge" className="badge">{matches.length ? String(matches.length) : ''}</span>
              </h2>
              <ol id="match-list" className="match-list" ref={matchListRef}>
                {!matches.length ? (
                  <li
                    className="empty-note"
                    dangerouslySetInnerHTML={{
                      __html: result.source ? '没有匹配。检查表达式或标志位。' : '在左侧输入正则，或从模板库选一条试试。',
                    }}
                  ></li>
                ) : (
                  matches.map((m, i) => {
                    const empty = m.text === ''
                    return (
                      <li
                        key={i}
                        data-index={i}
                        className={i === activeIndex ? 'active' : ''}
                        onClick={() => selectMatch(i, true)}
                      >
                        <span className="idx mono">#{i + 1}</span>
                        <span className="match-text mono">{empty ? <em>空匹配</em> : m.text}</span>
                        <span className="range mono">
                          行 {m.line} · [{m.index}, {m.end})
                        </span>
                      </li>
                    )
                  })
                )}
              </ol>
            </section>
            <section className="result-panel">
              <h2>
                捕获分组 <span id="group-which" className="badge">{groupsView.which}</span>
              </h2>
              <div id="groups" className="groups" dangerouslySetInnerHTML={{ __html: groupsView.html }}></div>
            </section>
          </div>
        </section>
      </div>

      {/* 模板库抽屉（桌面形态） */}
      <aside
        className="drawer drawer-left"
        id="snippets"
        aria-label="正则模板库"
        hidden={!snippetsOpen}
        onKeyDown={(e) => onDrawerKeyDown(e, 'snippets')}
      >
        <div className="drawer-head">
          <h2>模板库</h2>
          <button id="close-snippets" type="button" aria-label="关闭模板库" onClick={() => setSnippetsOpen(false)}>
            ×
          </button>
        </div>
        <div className="drawer-body" id="template-list" onClick={onTemplateClick} dangerouslySetInnerHTML={{ __html: TEMPLATE_HTML }}></div>
      </aside>

      {/* 速查表抽屉（桌面形态） */}
      <aside
        className="drawer drawer-right"
        id="sheet"
        aria-label="正则速查表"
        hidden={!sheetOpen}
        onKeyDown={(e) => onDrawerKeyDown(e, 'sheet')}
      >
        <div className="drawer-head">
          <h2>正则速查表</h2>
          <button id="close-sheet" type="button" aria-label="关闭速查表" onClick={() => setSheetOpen(false)}>
            ×
          </button>
        </div>
        <div className="drawer-body" id="cheatsheet" dangerouslySetInnerHTML={{ __html: SHEET_HTML }}></div>
      </aside>
    </main>
  )
}
