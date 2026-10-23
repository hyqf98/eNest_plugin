/**
 * 文本对比主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 diffLines/countChanges/pairHunks/diffChars/unifiedDiff/hexDump/normalizeJsonPair
 * 复用 core.mjs（未改动）。
 * 差异渲染区（#diff-view）沿用批 1 约定：原版等价 HTML 字符串 + dangerouslySetInnerHTML。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuItem } from '../ui/index.jsx'
import {
  diffLines,
  countChanges,
  pairHunks,
  diffChars,
  unifiedDiff,
  hexDump,
  normalizeJsonPair,
} from '../js/core.mjs'

const api = window.enest || window.zapi
const esc = PluginKit.escape

const HEX_KEY = 'diff_hex_mode_v1'
const PREF_KEY = 'diff_prefs_v2'

export function App() {
  const kitRef = useRef(null)
  const sourceRef = useRef(null)
  const targetRef = useRef(null)
  const diffViewRef = useRef(null)

  /* —— 与原版模块级变量等价的状态 —— */
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [prefs, setPrefs] = useState({
    inline: true,
    ignoreWhitespace: false,
    ignoreCase: false,
    ignoreBlank: false,
    jsonNormalize: false,
  })
  const [view, setView] = useState('split') // split | unified
  const [hexMode, setHexMode] = useState(false)
  const [statsHtml, setStatsHtml] = useState('')
  const [navPos, setNavPos] = useState({ visible: false, text: '' })
  const [diffHtml, setDiffHtml] = useState('')
  const [noticeText, setNoticeText] = useState('')
  const [navDisabled, setNavDisabled] = useState(true)
  const [exportDisabled, setExportDisabled] = useState(true)

  /* 命令式管线 ref 镜像（等价原闭包变量） */
  const opsRef = useRef([]) // 渲染行模型：{ el, change }
  const currentChangeRef = useRef(-1)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const viewRef = useRef('split')
  viewRef.current = view
  const hexRef = useRef(false)
  hexRef.current = hexMode
  const sourceRefV = useRef('')
  sourceRefV.current = source
  const targetRefV = useRef('')
  targetRefV.current = target
  const debounceRef = useRef(0)

  const options = useCallback(
    () => ({
      ignoreWhitespace: prefsRef.current.ignoreWhitespace,
      ignoreCase: prefsRef.current.ignoreCase,
      ignoreBlank: prefsRef.current.ignoreBlank,
    }),
    [],
  )

  /* ── 渲染（等价原 render/renderLines/renderHex） ── */
  const render = useCallback(() => {
    let a = sourceRefV.current
    let b = targetRefV.current
    const p = prefsRef.current
    const unified = viewRef.current === 'unified' && !hexRef.current
    opsRef.current = []
    currentChangeRef.current = -1
    let jsonNotice = ''

    const box = diffViewRef.current
    box?.classList.toggle('hex', hexRef.current)
    box?.classList.toggle('unified', unified)

    if (!a && !b) {
      setDiffHtml(
        '<div class="diff-empty">在两侧粘贴文本开始对比；也可以把本地文件拖到任意一侧。<br>选项支持字符级细化 / 忽略空白 / 忽略大小写 / 忽略空行；JSON 规范化会按键排序后对比；统一视图切换单栏差异流。</div>',
      )
      setStatsHtml('')
      setNavPos({ visible: false, text: '' })
      setNavDisabled(true)
      setExportDisabled(true)
      setNoticeText('')
      return
    }

    let html = ''
    if (hexRef.current) {
      html = renderHexHtml(a, b)
    } else {
      // JSON 规范化：两侧都解析成功才启用，否则原文对比并提示
      if (p.jsonNormalize) {
        const pair = normalizeJsonPair(a, b)
        if (pair) {
          a = pair.a
          b = pair.b
        } else {
          jsonNotice = 'JSON 规范化未生效：至少一侧不是合法 JSON，已按原文对比'
        }
      }
      html = renderLinesHtml(a, b, unified, p.inline)
    }
    setDiffHtml(html)
    setNoticeText(jsonNotice)
    // DOM 挂载后回填 ops el 引用
    requestAnimationFrame(() => {
      const rows = diffViewRef.current?.querySelectorAll('.diff-row') || []
      const prev = opsRef.current
      for (let i = 0; i < prev.length && i < rows.length; i++) prev[i].el = rows[i]
      syncStatsRef.current()
      updateNavRef.current()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const renderLinesHtml = (a, b, unified, inline) => {
    const aLines = a.split('\n')
    const bLines = b.split('\n')
    const script = diffLines(a, b, options())
    const counts = countChanges(script)
    const hunks = pairHunks(script)
    let html = ''
    const splitRow = (cls, aNo, aHtml, bNo, bHtml) =>
      `<div class="diff-row${cls ? ' ' + cls : ''}"><span class="gutter">${aNo ? esc(aNo) : ''}</span><span class="cell">${aHtml ?? ''}</span><span class="gutter">${bNo ? esc(bNo) : ''}</span><span class="cell">${bHtml ?? ''}</span></div>`
    const unifiedRow = (cls, sign, aNo, bNo, cellHtml) =>
      `<div class="diff-row${cls ? ' ' + cls : ''}"><span class="sign">${sign}</span><span class="gutter">${aNo ? esc(aNo) : ''}</span><span class="gutter">${bNo ? esc(bNo) : ''}</span><span class="cell">${cellHtml}</span></div>`
    const register = (rowHtml) => {
      opsRef.current.push({ el: null, change: opsRef.current.length })
      return rowHtml
    }
    const inlineSegs = (aText, bText) => {
      const segs = diffChars(aText, bText)
      return {
        left: segs
          .filter((s) => s.kind !== 'ins')
          .map((s) => (s.kind === 'del' ? `<del>${esc(s.value)}</del>` : esc(s.value)))
          .join(''),
        right: segs
          .filter((s) => s.kind !== 'del')
          .map((s) => (s.kind === 'ins' ? `<ins>${esc(s.value)}</ins>` : esc(s.value)))
          .join(''),
      }
    }

    for (const hunk of hunks) {
      if (hunk.type === 'same') {
        const text = esc(aLines[hunk.line.aIndex] ?? '')
        if (unified) html += unifiedRow('', '&nbsp;', hunk.line.aIndex + 1, hunk.line.bIndex + 1, text)
        else html += splitRow('', hunk.line.aIndex + 1, text, hunk.line.bIndex + 1, text)
      } else if (hunk.type === 'del-only') {
        for (const d of hunk.dels) {
          const row = unified
            ? unifiedRow('del', '−', d.aIndex + 1, '', esc(aLines[d.aIndex] ?? ''))
            : splitRow('del', d.aIndex + 1, esc(aLines[d.aIndex] ?? ''), '', '')
          html += register(row)
        }
      } else if (hunk.type === 'add-only') {
        for (const ad of hunk.adds) {
          const row = unified
            ? unifiedRow('add', '+', '', ad.bIndex + 1, esc(bLines[ad.bIndex] ?? ''))
            : splitRow('add', '', '', ad.bIndex + 1, esc(bLines[ad.bIndex] ?? ''))
          html += register(row)
        }
      } else {
        // change：可选行内字符细化
        const pairs = Math.max(hunk.dels.length, hunk.adds.length)
        for (let i = 0; i < pairs; i++) {
          const d = hunk.dels[i]
          const ad = hunk.adds[i]
          const aText = d ? (aLines[d.aIndex] ?? '') : ''
          const bText = ad ? (bLines[ad.bIndex] ?? '') : ''
          let left = d ? esc(aText) : ''
          let right = ad ? esc(bText) : ''
          if (inline && d && ad) {
            const segs = inlineSegs(aText, bText)
            left = segs.left
            right = segs.right
          }
          if (unified) {
            if (d) html += register(unifiedRow('del', '−', d.aIndex + 1, '', left))
            if (ad) html += register(unifiedRow('add', '+', '', ad.bIndex + 1, right))
          } else {
            html += register(
              splitRow(d && ad ? 'del add' : d ? 'del' : 'add', d ? d.aIndex + 1 : '', d ? left : '', ad ? ad.bIndex + 1 : '', ad ? right : ''),
            )
          }
        }
      }
    }
    void counts
    return html
  }

  const renderHexHtml = (a, b) => {
    const dumpA = hexDump(a)
    const dumpB = hexDump(b)
    const linesA = dumpA ? dumpA.split('\n') : []
    const linesB = dumpB ? dumpB.split('\n') : []
    const rows = Math.max(linesA.length, linesB.length)
    let html = ''
    let changeIndex = 0
    for (let i = 0; i < rows; i++) {
      const la = linesA[i] ?? ''
      const lb = linesB[i] ?? ''
      const same = la === lb
      const cls =
        'diff-row hex-line ' + (same ? '' : la && !lb ? 'del' : lb && !la ? 'add' : la !== lb ? 'del add' : '')
      if (!same) html += `<div class="${cls}" data-change="${changeIndex++}">`
      else html += `<div class="${cls}">`
      html +=
        `<span class="gutter">${i + 1}</span><span class="cell">${esc(la)}</span>` +
        `<span class="gutter">${i + 1}</span><span class="cell">${esc(lb)}</span></div>`
      opsRef.current.push({ el: null, change: same ? -1 : changeIndex - 1 })
    }
    return html
  }

  const syncStats = useCallback(() => {
    if (hexRef.current) {
      const diffRows = opsRef.current.filter((o) => o.change >= 0).length
      setStatsHtml(diffRows ? `<span class="del">${diffRows} 行不同</span>` : '<span class="add">字节完全一致</span>')
      setExportDisabled(true)
      return
    }
    let a = sourceRefV.current
    let b = targetRefV.current
    if (prefsRef.current.jsonNormalize) {
      const pair = normalizeJsonPair(a, b)
      if (pair) {
        a = pair.a
        b = pair.b
      }
    }
    const counts = countChanges(diffLines(a, b, options()))
    const sameCounts = !counts.adds && !counts.dels
    setStatsHtml(
      sameCounts ? '<span class="same">两栏一致</span>' : `<span class="add">+${counts.adds}</span><span class="del">−${counts.dels}</span>`,
    )
    setExportDisabled(sameCounts)
  }, [options])
  const syncStatsRef = useRef(syncStats)
  syncStatsRef.current = syncStats

  /* ── 导航 ── */
  const changeRows = useCallback(() => opsRef.current.filter((o) => o.change >= 0), [])

  const updateNav = useCallback(() => {
    const rows = changeRows()
    setNavDisabled(!rows.length)
    if (!rows.length) {
      setNavPos({ visible: false, text: '' })
      currentChangeRef.current = -1
      return
    }
    if (currentChangeRef.current < 0) currentChangeRef.current = 0
    setNavPos({ visible: true, text: `${currentChangeRef.current + 1} / ${rows.length} 处` })
  }, [changeRows])
  const updateNavRef = useRef(updateNav)
  updateNavRef.current = updateNav

  const jump = useCallback(
    (step) => {
      const rows = changeRows()
      if (!rows.length) return
      currentChangeRef.current = (currentChangeRef.current + step + rows.length) % rows.length
      const target = rows[currentChangeRef.current].el
      for (const row of diffViewRef.current.querySelectorAll('.diff-row.current')) row.classList.remove('current')
      target?.classList.add('current')
      target?.scrollIntoView({ block: 'center' })
      setNavPos({ visible: true, text: `${currentChangeRef.current + 1} / ${rows.length} 处` })
    },
    [changeRows],
  )
  const jumpRef = useRef(jump)
  jumpRef.current = jump

  /* ── 导出 ── */
  const diffText = useCallback(() => {
    let a = sourceRefV.current
    let b = targetRefV.current
    if (prefsRef.current.jsonNormalize) {
      const pair = normalizeJsonPair(a, b)
      if (pair) {
        a = pair.a
        b = pair.b
      }
    }
    return unifiedDiff(a, b, { options: options() })
  }, [options])

  /* ── hex 切换 ── */
  const toggleHex = useCallback(async () => {
    setHexMode((prev) => !prev)
    hexRef.current = !hexRef.current
    try {
      await kitRef.current?.save(HEX_KEY, hexRef.current)
    } catch {
      /* 持久化失败不阻塞 */
    }
    renderRef.current()
    kitRef.current?.toast(hexRef.current ? '已切换 hex 字节对比' : '已切回行级对比')
  }, [])
  const renderRef = useRef(render)
  renderRef.current = render

  /* ── 拖入 / 选择文件（经宿主 localFiles 句柄，零额外权限） ── */
  const readFileToArea = useCallback(async (file, area) => {
    if (file.size > 2 * 1024 * 1024) {
      kitRef.current?.toast('文件超过 2MB，请粘贴文本片段', 'error')
      return
    }
    try {
      const text = await file.text()
      if (area === 'source') setSource(text)
      else setTarget(text)
      kitRef.current?.toast(`已载入 ${file.name}`, 'success')
    } catch (e) {
      kitRef.current?.toast(e.message, 'error')
    }
  }, [])

  const wrapDragHandlers = (area) => ({
    onDragOver: (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault()
        e.currentTarget.classList.add('dragover')
        e.currentTarget.querySelector('.drop-hint').hidden = false
      }
    },
    onDragLeave: (e) => {
      e.currentTarget.classList.remove('dragover')
      e.currentTarget.querySelector('.drop-hint').hidden = true
    },
    onDrop: (e) => {
      e.currentTarget.classList.remove('dragover')
      e.currentTarget.querySelector('.drop-hint').hidden = true
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      e.preventDefault()
      void readFileToArea(file, area)
    },
  })

  const pickFile = useCallback((area) => {
    api.localFiles
      .pick({ kind: 'file', access: 'read' })
      .then(async (handles) => {
        const handle = handles?.[0]
        if (!handle) return
        const file = await api.localFiles.read({ handleId: handle.id, encoding: 'text', maxBytes: 2 * 1024 * 1024 })
        const text = String(file ?? '')
        if (area === 'source') setSource(text)
        else setTarget(text)
        kitRef.current?.toast(`已载入 ${handle.name}`, 'success')
      })
      .catch((error) => kitRef.current?.toast(error.message, 'error'))
  }, [])

  const pasteTo = useCallback(async (area) => {
    try {
      const text = await api.clipboard.readText()
      const value = String(text ?? '')
      if (area === 'source') setSource(value)
      else setTarget(value)
    } catch (e) {
      kitRef.current?.toast(e.message, 'error')
    }
  }, [])

  const clearArea = useCallback((area) => {
    if (area === 'source') setSource('')
    else setTarget('')
    requestAnimationFrame(() => (area === 'source' ? sourceRef : targetRef).current?.focus())
  }, [])

  /* ── 事件：输入防抖渲染（等价原 scheduleRender 200ms） ── */
  const scheduleRender = useCallback(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => renderRef.current(), 200)
  }, [])

  const onSourceChange = useCallback(
    (e) => {
      setSource(e.target.value)
      scheduleRender()
    },
    [scheduleRender],
  )
  const onTargetChange = useCallback(
    (e) => {
      setTarget(e.target.value)
      scheduleRender()
    },
    [scheduleRender],
  )

  const togglePref = useCallback((key) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      prefsRef.current = next
      void kitRef.current?.save(PREF_KEY, next).catch(() => {})
      return next
    })
    renderRef.current()
  }, [])

  const setViewMode = useCallback((next) => {
    setView(next)
    viewRef.current = next
    renderRef.current()
  }, [])

  const swap = useCallback(() => {
    const a = sourceRefV.current
    setSource(targetRefV.current)
    setTarget(a)
    renderRef.current()
  }, [])

  /* ── ⋯ 溢出菜单里的低频动作（复制 / 导出 unified patch） ── */
  const copyDiff = useCallback(() => {
    const text = diffText()
    if (!text) {
      kitRef.current?.toast('两栏内容一致，没有可复制的差异')
      return
    }
    kitRef.current?.copy(text).catch((e) => kitRef.current?.toast(e.message, 'error'))
  }, [diffText])

  const exportPatch = useCallback(() => {
    const text = diffText()
    if (!text) {
      kitRef.current?.toast('两栏内容一致，没有可导出的差异')
      return
    }
    kitRef.current?.saveText('diff.patch', text + '\n').catch((e) => kitRef.current?.toast(e.message, 'error'))
  }, [diffText])

  /* 勾选项用 CheckboxItem：点选后菜单保持打开，可连续切换多个开关 */
  const prefOptions = [
    { key: 'inline', label: '字符级', title: '行内字符级高亮' },
    { key: 'ignoreWhitespace', label: '忽略空白', title: '比较前折叠空白并去首尾' },
    { key: 'ignoreCase', label: '忽略大小写', title: '比较前转为小写' },
    { key: 'ignoreBlank', label: '忽略空行', title: '空行不参与比较' },
    { key: 'jsonNormalize', label: 'JSON 规范化', title: '两侧都为合法 JSON 时按键排序规范化再比' },
  ]

  /* ⌘/Ctrl+↑↓ 导航（编辑器内仅 Alt 组合生效） */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const nav = e.metaKey || e.ctrlKey || e.altKey
      if (!nav) return
      const inEditor = ['TEXTAREA', 'INPUT'].includes(e.target.tagName)
      if (inEditor && !(e.altKey && !e.metaKey && !e.ctrlKey)) return
      e.preventDefault()
      jumpRef.current(e.key === 'ArrowDown' ? 1 : -1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /* ⌘/Ctrl+Shift+H hex 模式（等价原 keydown + result-mode dblclick） */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        void toggleHexRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const toggleHexRef = useRef(toggleHex)
  toggleHexRef.current = toggleHex

  /* —— 生命周期：PluginKit 一次初始化 —— */
  useEffect(() => {
    let alive = true
    const kit = PluginKit.create({
      title: '文本对比',
      quickPlaceholder: '两栏粘贴文本，实时对比差异',
      height: 480,
      defaults: { inline: true, ignoreWhitespace: false, ignoreCase: false, hexMode: false },
      onAction: (action) => {
        if (action === 'clear') {
          setSource('')
          setTarget('')
          requestAnimationFrame(() => renderRef.current())
        } else if (action === 'submit') targetRef.current?.focus()
      },
    })
    kitRef.current = kit
    void (async () => {
      await kit.ready
      if (!alive) return
      const saved = await kit.load(PREF_KEY, {})
      if (!alive) return
      let next = {
        inline: true,
        ignoreWhitespace: false,
        ignoreCase: false,
        ignoreBlank: false,
        jsonNormalize: false,
      }
      if (saved && typeof saved === 'object') next = { ...next, ...saved }
      prefsRef.current = next
      setPrefs(next)
      const hex = !!(await kit.load(HEX_KEY, false))
      if (!alive) return
      hexRef.current = hex
      setHexMode(hex)
      renderRef.current()
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 首次渲染（等价原脚本尾部 render()） */
  useEffect(() => {
    renderRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paneFor = (area, label, id, value, onChange, areaRef) => (
    <div className="pane" data-pane={area}>
      <div className="pane-head">
        <label htmlFor={id}>{label}</label>
        <span className="pane-actions">
          <button id={`pick-${id}`} onClick={() => pickFile(area)}>文件…</button>
          <button id={`paste-${id}`} onClick={() => void pasteTo(area)}>粘贴</button>
          <button id={`clear-${id}`} onClick={() => clearArea(area)}>清空</button>
        </span>
      </div>
      <div className="editor-wrap" id={`${area}-drop`} {...wrapDragHandlers(area)}>
        <textarea
          id={id}
          ref={areaRef}
          className="mono"
          spellcheck="false"
          placeholder={`粘贴${label}，或把文件拖进来`}
          value={value}
          onChange={onChange}
        ></textarea>
        <div className="drop-hint" hidden>松开以读取文件</div>
      </div>
    </div>
  )

  return (
    <main className="diff-app">
      <header className="topbar">
        <h1>文本对比</h1>
        <span id="stats" className="stats mono" role="status" aria-live="polite" dangerouslySetInnerHTML={{ __html: statsHtml }}></span>
        <span id="nav-pos" className="nav-pos mono" hidden={!navPos.visible}>{navPos.text}</span>
        <div className="toolbar">
          <div className="seg" role="group" aria-label="视图切换">
            <button id="view-split" aria-pressed={view === 'split'} onClick={() => setViewMode('split')}>并排</button>
            <button id="view-unified" aria-pressed={view === 'unified'} onClick={() => setViewMode('unified')}>统一</button>
          </div>
          <Button id="nav-prev" variant="ghost" size="sm" disabled={navDisabled} title="上一处差异 (Ctrl/⌘+↑)" onClick={() => jump(-1)}>↑ 上一处</Button>
          <Button id="nav-next" variant="ghost" size="sm" disabled={navDisabled} title="下一处差异 (Ctrl/⌘+↓)" onClick={() => jump(1)}>↓ 下一处</Button>
          <Button id="swap" variant="ghost" size="sm" title="交换两栏" onClick={swap}>⇄ 交换</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="pk-btn pk-btn-ghost" aria-label="对比选项与导出">⋯</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {prefOptions.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.key}
                  checked={!!prefs[opt.key]}
                  title={opt.title}
                  onSelect={(e) => { e.preventDefault(); togglePref(opt.key) }}
                >{opt.label}</DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={exportDisabled} onSelect={copyDiff}>复制 diff</DropdownMenuItem>
              <DropdownMenuItem disabled={exportDisabled} onSelect={exportPatch}>导出 patch</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <section className="editor" id="editor">
        {paneFor('source', '源文本', 'source', source, onSourceChange, sourceRef)}
        {paneFor('target', '目标文本', 'target', target, onTargetChange, targetRef)}
      </section>

      <section className="result" id="result">
        <div className="pane-head result-head">
          <h2>差异结果 <span id="result-mode" className="hint" onDoubleClick={() => void toggleHex()}>{hexMode ? 'hex 字节对比' : '行级'}</span></h2>
          <span className="hint" id="result-hint">Ctrl/⌘+↑ ↓ 导航差异；导出为 unified patch</span>
        </div>
        {noticeText ? <div className="diff-notice" id="diff-notice">{noticeText}</div> : null}
        <div id="diff-view" ref={diffViewRef} className="diff-view mono" tabIndex={0}
          dangerouslySetInnerHTML={{ __html: diffHtml }}></div>
      </section>
    </main>
  )
}
