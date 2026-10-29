/**
 * Anything 文件搜索主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心复用：backend.js（backend.call 封装）、query.js（语法/格式化）、icons.js（SVG）、
 * preview.js（预览面板 DOM 工厂，原样保留）。backend 目录与 API 调用代码未改动。
 * 结果数据流（backend 回调 → React state）经 latest-ref 桥接，避免闭包陷阱。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreMenu } from '../ui/index.jsx'
import { backend, backendReady } from '../js/backend.js'
import { fileIcon } from '../js/icons.js'
import { formatSize, formatWhen, highlightName, parseQuery } from '../js/query.js'
import { createPreview } from '../js/preview.js'
import { PanelView } from './PanelView.jsx'

const api = () => window.enest || window.zapi
const escape = PluginKit.escape
const PROVIDER_LABEL = { spotlight: 'Spotlight', everything: 'Everything' }

/** escape 后按 include 词包 <mark> 的名字 HTML（原 renderList 逻辑镜像） */
function nameHtml(file, tokens) {
  return highlightName(escape(file.name), tokens)
}

export function App() {
  const kitRef = useRef(null)
  const queryRef = useRef(null)   // input DOM（quick 推送 / Esc 清空直接写回）
  const listRef = useRef(null)    // 结果列表容器
  const previewRef = useRef(null) // preview 面板容器
  const previewApiRef = useRef(null)
  const dlgRef = useRef(null)
  const trashTargetRef = useRef(null)

  // —— 与原 state 对象一一对应 ——
  const [query, setQuery] = useState('')
  const [directory, setDirectory] = useState('')
  const [scopeLabel, setScopeLabel] = useState('范围：全盘')
  const [scopeTitle, setScopeTitle] = useState('限定搜索目录（Spotlight 内限定该目录索引）')
  const [sort, setSort] = useState('relevance')
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(-1)
  const [hasMore, setHasMore] = useState(false)
  const [status, setStatus] = useState({ text: '正在检测搜索引擎…', kind: '' })
  const [booted, setBooted] = useState(false)
  const [trashText, setTrashText] = useState('')
  const [mode, setMode] = useState(() => api()?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode') || 'shell')

  // latest-ref 桥接：可变搜索状态供回调读取最新值
  const stateRef = useRef({})
  stateRef.current = {
    query, directory, sort, results, selected, mode, booted,
    settings: kitRef.current?.settings ?? { resultLimit: 100, everythingPort: 0, everythingAuth: '' },
  }
  const seqRef = useRef(0)
  const timerRef = useRef(0)
  const resultsRef = useRef(results)
  resultsRef.current = results
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const offsetRef = useRef(0)
  const searchingRef = useRef(false)
  const reportRef = useRef(null)
  const providerCacheRef = useRef({ query: '', items: [] })
  const directoryRef = useRef(directory)
  directoryRef.current = directory
  const sortRef = useRef(sort)
  sortRef.current = sort

  // —— 预览面板（原 preview.js 工厂原样复用）——
  useEffect(() => {
    if (mode !== 'shell' || !previewRef.current) return
    const preview = createPreview(previewRef.current)
    previewApiRef.current = preview
    const file = resultsRef.current[selectedRef.current]
    if (file?.path) void preview.load(file)
    return () => { preview.destroy(); previewApiRef.current = null }
  }, [mode])

  const statusText = (label, kind = '') => setStatus({ text: label, kind })

  const previewSelected = useCallback(() => {
    const file = resultsRef.current[selectedRef.current]
    if (file && stateRef.current.mode === 'shell') previewApiRef.current?.load(file)
  }, [])

  const renderIdle = useCallback(() => {
    setResults([])
    setSelected(-1)
    setHasMore(false)
    offsetRef.current = 0
    const label = reportRef.current?.active ? (PROVIDER_LABEL[reportRef.current.active] || '') : ''
    statusText(label ? `引擎 ${label} 就绪，输入开始搜索` : '输入开始搜索')
    previewApiRef.current?.placeholder('选择左侧文件查看预览')
  }, [])

  // —— 搜索流（等价原 runSearch）——
  const runSearch = useCallback(async (reset) => {
    const st = stateRef.current
    const q = st.query.trim()
    if (!q) return
    const seq = ++seqRef.current
    searchingRef.current = true
    statusText(`搜索中 · ${q}`, 'busy')
    const settings = st.settings
    const limit = Math.max(20, Math.min(Number(settings.resultLimit) || 100, 500))
    const offset = reset ? 0 : offsetRef.current
    try {
      const res = await backend.search(q, {
        directory: directoryRef.current || undefined,
        limit, offset, sort: sortRef.current,
        everythingPort: Number(settings.everythingPort) || 0,
        everythingAuth: String(settings.everythingAuth || '') || undefined
      })
      if (seq !== seqRef.current) return
      if (reset) {
        setResults(res.results)
        setSelected(res.results.length ? 0 : -1)
      } else {
        setResults((prev) => {
          const merged = prev.concat(res.results)
          offsetRef.current = offset + res.results.length
          return merged
        })
      }
      if (reset) offsetRef.current = res.results.length
      setHasMore(Boolean(res.truncated))
      searchingRef.current = false
      const label = PROVIDER_LABEL[res.provider] || res.provider
      const truncatedNote = res.truncated ? '（已截断）' : ''
      statusText(
        offsetRef.current
          ? `${label} · ${reset ? res.total : offsetRef.current} 条 · ${res.elapsedMs} ms${truncatedNote}`
          : `${label} · ${res.total} 条 · ${res.elapsedMs} ms${truncatedNote}`
      )
      if (reset) setTimeout(previewSelected, 0)
    } catch (error) {
      if (seq !== seqRef.current) return
      searchingRef.current = false
      if (reset) {
        setResults([])
        setSelected(-1)
        setHasMore(false)
        offsetRef.current = 0
      }
      statusText(error.message, 'error')
    }
  }, [previewSelected])

  // —— 输入防抖（等价原 onQueryInput）——
  const onQueryInput = useCallback((value) => {
    const text = String(value ?? '')
    setQuery(text)
    stateRef.current = { ...stateRef.current, query: text }
    clearTimeout(timerRef.current)
    // Invalidate before the debounce window: Enter must never open the previous query's file.
    seqRef.current++
    resultsRef.current = []
    selectedRef.current = -1
    searchingRef.current = Boolean(text.trim())
    setResults([])
    setSelected(-1)
    setHasMore(false)
    offsetRef.current = 0
    if (!text.trim()) {
      renderIdle()
      return
    }
    statusText(`搜索中 · ${text.trim()}`, 'busy')
    previewApiRef.current?.placeholder('正在搜索…')
    timerRef.current = setTimeout(() => void runSearch(true), stateRef.current.mode === 'quick' ? 120 : 220)
  }, [renderIdle, runSearch])

  // —— 列表滚动定位 ——
  useEffect(() => {
    if (selected < 0) return
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected, results])

  // —— 文件操作 ——
  const dismissQuick = useCallback(() => {
    if (stateRef.current.mode === 'quick' && typeof api()?.ui?.dismissQuick === 'function') {
      api().ui.dismissQuick().catch(() => {})
    }
  }, [])

  const openTarget = useCallback(async (path, dismissAfter) => {
    try {
      await backend.open(path)
      kitRef.current?.toast('已打开', 'success')
      if (dismissAfter) dismissQuick()
    } catch (error) {
      kitRef.current?.toast(error.message, 'error')
    }
  }, [dismissQuick])

  const activateSelected = useCallback(async () => {
    if (searchingRef.current) return
    const file = resultsRef.current[selectedRef.current]
    if (file) await openTarget(file.path, true)
  }, [openTarget])

  const revealSelected = useCallback(async () => {
    const file = resultsRef.current[selectedRef.current]
    if (!file) return
    try {
      await backend.reveal(file.path)
      kitRef.current?.toast('已在文件管理器中定位', 'success')
      dismissQuick()
    } catch (error) {
      kitRef.current?.toast(error.message, 'error')
    }
  }, [dismissQuick])

  const copySelectedPath = useCallback(() => {
    const file = resultsRef.current[selectedRef.current]
    if (file) void kitRef.current?.copy(file.path)
  }, [])

  const askTrashFor = useCallback((file) => {
    if (!file?.path) return
    trashTargetRef.current = file
    setTrashText(`${file.name}（${file.path}）将移入系统废纸篓，可在废纸篓中恢复。`)
    if (dlgRef.current) {
      dlgRef.current.returnValue = ''
      dlgRef.current.showModal()
    }
  }, [])
  const askTrash = () => askTrashFor(resultsRef.current[selectedRef.current])

  const confirmTrash = useCallback(async () => {
    const file = trashTargetRef.current
    trashTargetRef.current = null
    if (!file) return
    try {
      await backend.trash(file.path)
      kitRef.current?.toast('已移入废纸篓', 'success')
      const current = resultsRef.current
      const selectedPath = current[selectedRef.current]?.path
      const next = current.filter((row) => row.path !== file.path)
      const nextIndex = next.findIndex((row) => row.path === selectedPath)
      setResults(next)
      setSelected(nextIndex >= 0 ? nextIndex : Math.min(selectedRef.current, next.length - 1))
      setTimeout(previewSelected, 0)
    } catch (error) {
      kitRef.current?.toast(error.message, 'error')
    }
  }, [previewSelected])

  // —— 选择 / 导航 ——
  const move = useCallback((delta) => {
    const rows = resultsRef.current
    if (!rows.length) return
    setSelected((prev) => Math.max(0, Math.min(prev + delta, rows.length - 1)))
    if (stateRef.current.mode === 'shell') setTimeout(previewSelected, 0)
  }, [previewSelected])

  // —— 引擎探测（等价原 probeProviders）——
  const probeProviders = useCallback(async () => {
    const kit = kitRef.current
    if (!backendReady()) {
      statusText('后端接口不可用，请更新 eNest 壳子', 'error')
      return
    }
    try {
      const settings = kit?.settings ?? {}
      const report = await backend.providers({
        everythingPort: Number(settings.everythingPort) || 0,
        everythingAuth: String(settings.everythingAuth || '') || undefined
      })
      reportRef.current = report
      if (!report.active) {
        // renderNoEngine：无引擎时列表给引导面板
        setResults([{ __idle: 'no-engine', platform: report.platform || '' }])
        setSelected(-1)
        setHasMore(false)
        statusText(report.platform === 'win32' ? '未检测到 Everything HTTP 服务' : '无可用引擎', 'error')
      }
    } catch (error) {
      statusText(`引擎探测失败：${error.message}`, 'error')
    }
  }, [])

  // —— Quick provider 注册（等价原 registerProvider）——
  const registerProvider = useCallback(() => {
    if (!api()?.contribute || !backendReady()) return
    api().contribute.registerQuickProvider?.({ id: 'anything', explain: '全盘文件搜索' }).catch(() => {})
    api().contribute.onQuickQuery?.(({ reqId, query: text }) => {
      const keyword = String(text || '').trim()
      const respond = (items) => { api().contribute.respondQuickQuery?.(reqId, items).catch(() => {}) }
      const st = stateRef.current
      const settings = st.settings
      if (!st.booted || keyword.length < 2) return respond([])
      if (providerCacheRef.current.query === keyword) return respond(providerCacheRef.current.items)
      backend.search(keyword, {
        limit: 8, sort: 'relevance',
        everythingPort: Number(settings.everythingPort) || 0,
        everythingAuth: String(settings.everythingAuth || '') || undefined
      })
        .then((res) => {
          const items = res.results.map((file) => ({
            id: file.path,
            title: file.name,
            subtitle: file.dir,
            explain: file.isDirectory ? '目录' : (file.ext ? `.${file.ext}` : '文件'),
            code: 'open-file',
            payload: { path: file.path }
          }))
          providerCacheRef.current = { query: keyword, items }
          respond(items)
        })
        .catch(() => respond([]))
    })
  }, [])

  // —— PluginKit 初始化 + 启动序列（latest-ref 桥接，hooks 规则：无条件执行）——
  const searchRef = useRef(runSearch)
  searchRef.current = runSearch
  const probeRef = useRef(probeProviders)
  probeRef.current = probeProviders
  const idleRef = useRef(renderIdle)
  idleRef.current = renderIdle
  const moveRef = useRef(move)
  moveRef.current = move
  const activateRef = useRef(activateSelected)
  activateRef.current = activateSelected
  const revealRef = useRef(revealSelected)
  revealRef.current = revealSelected
  const queryInputRef = useRef(onQueryInput)
  queryInputRef.current = onQueryInput

  useEffect(() => {
    const kit = PluginKit.create({
      title: 'Anything 文件搜索',
      height: 490,
      quickPlaceholder: '搜索全盘文件，如 报告 pdf…',
      defaults: { resultLimit: 100, everythingPort: 0, everythingAuth: '' },
      onQuery: (value) => queryInputRef.current(value),
      onAction: (action) => {
        if (action === 'next') moveRef.current(1)
        else if (action === 'previous') moveRef.current(-1)
        else if (action === 'submit') void activateRef.current()
        else if (action === 'clear') { setQuery(''); idleRef.current() }
      }
    })
    kitRef.current = kit
    setMode(kit.mode)

    kit.onSettings(async (_settings, key) => {
      if (key === 'everythingPort' || key === 'everythingAuth') await probeRef.current()
    })
    kit.onMode((m) => {
      setMode(m)
      if (m === 'shell' && stateRef.current.query.trim() && !resultsRef.current.length) void searchRef.current(true)
      if (m === 'shell') setTimeout(() => {
        const file = resultsRef.current[selectedRef.current]
        if (file) previewApiRef.current?.load(file)
      }, 0)
    })

    api()?.onEnter?.(({ code, payload }) => {
      if (code === 'open-file' && payload && typeof payload === 'object' && typeof payload.path === 'string') {
        void openTargetRef.current(payload.path, true)
        return
      }
      const text = typeof payload === 'string' ? payload : payload?.type === 'text' && typeof payload.text === 'string' ? payload.text : ''
      if ((code === 'find' || code === 'find-selection') && text) {
        setQuery(text)
        const input = queryRef.current
        if (input) input.value = text
        kit.setQuery(text)
        stateRef.current = { ...stateRef.current, query: text }
        void searchRef.current(true)
      } else if ((code === 'find' || code === 'find-selection') && kit.mode === 'shell') {
        queryRef.current?.focus()
      }
    })

    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      idleRef.current()
      await probeRef.current()
      if (!alive) return
      setBooted(true)
      registerProvider()
    })()
    return () => { alive = false; clearTimeout(timerRef.current); seqRef.current++; kit.destroy?.() }
  }, [idleRef, moveRef, probeRef, registerProvider, renderIdle, searchRef])
  const openTargetRef = useRef(openTarget)
  openTargetRef.current = openTarget

  // —— 渲染辅助 ——
  const tokens = parseQuery(query)
  const engineReport = reportRef.current
  const engineActive = engineReport?.providers?.find((item) => item.id === engineReport?.active)
  const rows = results
  const idleView = rows.length === 1 && rows[0]?.__idle === 'no-engine'
  const showIdle = rows.length === 0 || idleView

  const inputHandlers = {
    onInput: (e) => onQueryInput(e.target.value),
    onKeyDown: (e) => {
      if (e.isComposing) return
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) void revealSelected()
        else void activateSelected()
      } else if (e.key === 'Escape' && e.target.value) {
        e.preventDefault()
        e.target.value = ''
        onQueryInput('')
      }
    }
  }

  const pickScope = async () => {
    if (directoryRef.current) {
      setDirectory('')
      setScopeLabel('范围：全盘')
      setScopeTitle('限定搜索目录（Spotlight 内限定该目录索引）')
      if (stateRef.current.query.trim()) void runSearch(true)
      return
    }
    const [picked] = await api()?.localFiles?.pick?.({ kind: 'directory' }) ?? []
    if (picked?.displayPath) {
      setDirectory(picked.displayPath)
      setScopeLabel(`范围：${picked.name || picked.displayPath}`)
      setScopeTitle(`点击清除范围（当前 ${picked.displayPath}）`)
      if (stateRef.current.query.trim()) void runSearch(true)
    }
  }

  const onSortChange = (e) => {
    setSort(e.target.value)
    sortRef.current = e.target.value
    if (stateRef.current.query.trim()) void runSearch(true)
  }

  if (mode === 'panel') return <PanelView query={query} results={results} status={status} booted={booted}
    onQuery={onQueryInput} onOpen={path => { if (!searchingRef.current && resultsRef.current.some(file => file.path === path)) void openTarget(path, false) }}
    onOpenShell={() => Promise.resolve(api()?.ui?.openInShell?.()).catch(error => kitRef.current?.toast(error.message, 'error'))}
  />

  return (
    <main className="app">
      <header className="shell-only">
        <div>
          <h1>Anything 文件搜索</h1>
          <span className="muted">Spotlight / Everything 全盘即时搜索</span>
        </div>
        {engineActive ? (
          <span id="engine-badge" className="engine-badge" title={engineActive.detail}>{engineActive.label}</span>
        ) : (
          <span id="engine-badge" className="engine-badge" hidden></span>
        )}
        <button type="button" className="pk-btn pk-btn-ghost anything-settings-button" onClick={() => Promise.resolve(api()?.ui?.openSettings?.()).catch(error => kitRef.current?.toast(error.message, 'error'))}>偏好设置</button>
      </header>
      <section className="searchbar shell-only">
        <input
          id="query" ref={queryRef} type="search" defaultValue={query}
          placeholder='搜索文件名，如 报告 pdf　"精确"　-排除　*.sketch'
          aria-label="搜索文件" data-input-context="editor" {...inputHandlers}
        />
        <button id="scope-pick" className="pk-btn pk-btn-ghost pk-btn-sm" title={scopeTitle} onClick={pickScope}>{scopeLabel}</button>
        <select id="sort" aria-label="排序" value={sort} onChange={onSortChange}>
          <option value="relevance">相关度</option>
          <option value="name">名称</option>
          <option value="mtime">修改时间</option>
          <option value="size">大小</option>
        </select>
      </section>
      <div id="status" className="status" role="status" data-kind={status.kind}>{status.text}</div>
      <div className="workspace">
        <section className="results-col">
          <div
            id="list" ref={listRef} role="listbox" tabIndex={0} aria-label="搜索结果"
            onKeyDown={(e) => {
              if (e.defaultPrevented || e.isComposing || e.target.closest('button, [role="menu"], [role="menuitem"]')) return
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
              else if (e.key === 'Enter') { e.preventDefault(); void activateSelected() }
            }}
          >
            {showIdle ? (
              idleView ? (
                <div className="idle">
                  <p className="idle-title">
                    {rows[0].platform === 'win32' ? '需要 Everything 提供搜索引擎' : '当前平台暂无可用搜索引擎'}
                  </p>
                  <p className="idle-text">
                    {rows[0].platform === 'win32'
                      ? '安装 Everything（voidtools.com），在 选项 → HTTP 服务器 中开启服务，然后回到本插件的偏好设置填入端口。'
                      : 'Linux 支持将在后续版本提供。'}
                  </p>
                </div>
              ) : (
                <div className="idle">
                  <p className="idle-title">输入关键词即搜全盘文件</p>
                  <dl>
                    <dt>多个关键词</dt><dd>同时命中文件名，顺序不限：报告 pdf</dd>
                    <dt>"精确短语"</dt><dd>引号内连续匹配："年度报告"</dd>
                    <dt>-排除词</dt><dd>剔除命中：logo -png</dd>
                    <dt>* 通配符</dt><dd>*.sketch 或 report-*-final</dd>
                  </dl>
                </div>
              )
            ) : (
              rows.map((file, index) => (
                <div
                  key={file.path + '#' + index}
                  className={'row' + (index === selected ? ' active' : '')}
                  role="option"
                  aria-selected={index === selected ? 'true' : 'false'}
                  data-row-actions
                  style={{ '--i': Math.min(index, 16) }}
                  onClick={() => {
                    if (mode === 'quick') {
                      setSelected(index)
                      selectedRef.current = index
                      void activateSelected()
                    } else {
                      setSelected(index)
                      selectedRef.current = index
                      setTimeout(previewSelected, 0)
                    }
                  }}
                  onDoubleClick={() => { if (mode !== 'quick') void activateSelected() }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setSelected(index)
                    selectedRef.current = index
                    PluginKit.openMenu(event, [
                      ['open', '打开'],
                      ['reveal', '在文件夹中定位'],
                      ['copy-path', '复制路径'],
                      { sep: true },
                      ['trash', '移入废纸篓', { danger: true }],
                    ], (key) => {
                      if (key === 'open') void openTarget(file.path, true)
                      if (key === 'reveal') void backend.reveal(file.path).then(() => kitRef.current?.toast('已在文件管理器中定位', 'success')).catch((error) => kitRef.current?.toast(error.message, 'error'))
                      if (key === 'copy-path') void kitRef.current?.copy(file.path)
                      if (key === 'trash') askTrashFor(file)
                    }, { align: 'end' })
                  }}
                >
                  <span className="ficon-slot" dangerouslySetInnerHTML={{ __html: fileIcon(file) }}></span>
                  <span className="row-main">
                    <span className="name" dangerouslySetInnerHTML={{ __html: nameHtml(file, tokens) }}></span>
                    <span className="where">{file.dir}</span>
                  </span>
                  <span className="meta">
                    {[formatWhen(file.mtimeMs), formatSize(file.size, file.isDirectory)].filter(Boolean).join(' · ')}
                  </span>
                  <span className="pk-row-actions row-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                    <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" onClick={() => void openTarget(file.path, true)}>打开</button>
                  </span>
                </div>
              ))
            )}
          </div>
          <button id="more" className="pk-btn" hidden={!hasMore} onClick={() => void runSearch(false)}>载入更多</button>
        </section>
        <aside id="preview" className="shell-only" ref={previewRef}>
          <div className="empty">选择左侧文件查看预览</div>
        </aside>
      </div>
      <footer>
        <div className="hint">
          <span className="shell-only"><kbd>↵</kbd> 打开　<kbd>⌘↵</kbd> 所在目录　<kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span className="quick-only"><kbd>↵</kbd> 打开　<kbd>↑</kbd><kbd>↓</kbd> 选择　<kbd>Esc</kbd> 收起</span>
        </div>
        <div className="actions">
          <MoreMenu
            label="更多"
            ariaLabel="文件更多操作"
            buttonClassName="footer-more shell-only"
            items={[
              { key: 'copy-path', label: '复制路径', onSelect: copySelectedPath },
              { key: 'trash', label: '移入废纸篓', danger: true, onSelect: askTrash },
            ]}
          />
          <button id="reveal" className="pk-btn" onClick={() => void revealSelected()}>所在目录</button>
          <button id="open" className="pk-btn pk-btn-primary" onClick={() => void activateSelected()}>打开 <kbd>↵</kbd></button>
        </div>
      </footer>
      <dialog id="confirm-trash" ref={dlgRef} onClose={(event) => {
        if (event.currentTarget.returnValue === 'ok') void confirmTrash()
        else trashTargetRef.current = null
      }}>
        <h2>移入废纸篓</h2>
        <p id="trash-text">{trashText}</p>
        <div className="dialog-actions">
          <button id="trash-cancel" className="pk-btn" onClick={() => dlgRef.current?.close('')}>取消</button>
          <button id="trash-ok" className="pk-btn pk-btn-danger" onClick={() => dlgRef.current?.close('ok')}>移入废纸篓</button>
        </div>
      </dialog>
    </main>
  )
}
