/**
 * Anything 文件搜索主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * 业务核心复用：backend.js（backend.call 封装）、query.js（语法/格式化）、icons.js（SVG）、
 * preview.js（预览面板 DOM 工厂，原样保留）。backend 目录与 API 调用代码未改动。
 * 结果数据流（backend 回调 → React state）经 latest-ref 桥接，避免闭包陷阱。
 * 偏好设置为插件内置（右下悬浮钮 + 弹框），持久化走 enest.storage，不再注册到壳设置页；
 * 首次启动自动把旧壳设置迁移到私有存储。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Dialog, DialogContent, DialogTitle } from '../ui/index.jsx'
import { backend, backendReady } from '../js/backend.js'
import { fileIcon } from '../js/icons.js'
import { formatSize, formatWhen, highlightName, parseQuery } from '../js/query.js'
import { createPreview } from '../js/preview.js'
import { PanelView } from './PanelView.jsx'

const api = () => window.enest || window.zapi
const escape = PluginKit.escape
const PROVIDER_LABEL = { spotlight: 'Spotlight', everything: 'Everything' }

/** 插件私有偏好：defaults 与迁移用的旧壳设置键保持一致 */
const PREFS_KEY = 'anything.prefs'
const PREF_DEFAULTS = { resultLimit: 100, everythingPort: 0, everythingAuth: '' }
const LEGACY_SETTING_KEYS = ['resultLimit', 'everythingPort', 'everythingAuth']

/** data-path 查询用的路径转义（Windows 盘符冒号、引号等） */
const cssPath = (path) => window.CSS?.escape?.(path) ?? String(path).replace(/["\\]/g, '\\$&')

/** escape 后按 include 词包 <mark> 的名字 HTML（原 renderList 逻辑镜像） */
function nameHtml(file, tokens) {
  return highlightName(escape(file.name), tokens)
}

/** 结果按目录分组成一层树：组顺序 = 结果首次出现的顺序 */
function groupByDir(files) {
  const map = new Map()
  for (const file of files) {
    if (!file.path) continue
    if (!map.has(file.dir)) map.set(file.dir, [])
    map.get(file.dir).push(file)
  }
  return Array.from(map, ([dir, items]) => ({ dir, files: items }))
}

export function App() {
  const kitRef = useRef(null)
  const queryRef = useRef(null)   // input DOM（quick 推送 / Esc 清空直接写回）
  const listRef = useRef(null)    // 结果列表容器
  const previewRef = useRef(null) // preview 面板容器
  const previewApiRef = useRef(null)
  const dlgRef = useRef(null)
  const trashTargetRef = useRef(null)

  // —— 与原 state 对象一一对应（selected 改为按路径跟踪，配合树形收起） ——
  const [query, setQuery] = useState('')
  const [directory, setDirectory] = useState('')
  const [scopeLabel, setScopeLabel] = useState('范围：全盘')
  const [scopeTitle, setScopeTitle] = useState('限定搜索目录（Spotlight 内限定该目录索引）')
  const [sort, setSort] = useState('relevance')
  const [results, setResults] = useState([])
  const [selectedPath, setSelectedPath] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [status, setStatus] = useState({ text: '正在检测搜索引擎…', kind: '' })
  const [booted, setBooted] = useState(false)
  const [trashText, setTrashText] = useState('')
  const [mode, setMode] = useState(() => api()?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode') || 'shell')
  /** 查询到结果之间的空档：用于骨架行与搜索进度条，避免"界面卡住"的错觉。 */
  const [pending, setPending] = useState(false)
  /** 插件内置偏好（storage 持久化）与设置弹框草稿 */
  const [prefs, setPrefs] = useState({ ...PREF_DEFAULTS })
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [draft, setDraft] = useState({ ...PREF_DEFAULTS })
  /** 树形视图里收起的目录（dir 字符串集合）；收起只影响展示，不触发重搜 */
  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set())

  // latest-ref 桥接：可变搜索状态供回调读取最新值
  const stateRef = useRef({})
  stateRef.current = {
    query, directory, sort, results, selectedPath, mode, booted,
    settings: prefs,
  }
  const seqRef = useRef(0)
  const timerRef = useRef(0)
  const resultsRef = useRef(results)
  resultsRef.current = results
  const selectedPathRef = useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const collapsedRef = useRef(collapsedDirs)
  collapsedRef.current = collapsedDirs
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
    const file = resultsRef.current.find(row => row.path === selectedPathRef.current)
    if (file?.path) void preview.load(file)
    return () => { preview.destroy(); previewApiRef.current = null }
  }, [mode])

  const statusText = (label, kind = '') => setStatus({ text: label, kind })

  const selectedFile = useCallback(() =>
    resultsRef.current.find(row => row.path === selectedPathRef.current), [])

  const previewSelected = useCallback(() => {
    const file = selectedFile()
    if (file && stateRef.current.mode === 'shell') previewApiRef.current?.load(file)
  }, [selectedFile])

  const renderIdle = useCallback(() => {
    setResults([])
    setSelectedPath(null)
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
        // 范围选择器只在 shell 工具栏出现；quick 小窗与桌面小组件始终搜全盘
        directory: st.mode === 'shell' ? (directoryRef.current || undefined) : undefined,
        limit, offset, sort: sortRef.current,
        everythingPort: Number(settings.everythingPort) || 0,
        everythingAuth: String(settings.everythingAuth || '') || undefined
      })
      if (seq !== seqRef.current) return
      if (reset) {
        setResults(res.results)
        setSelectedPath(res.results.length ? res.results[0].path : null)
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
      setPending(false)
      const label = PROVIDER_LABEL[res.provider] || res.provider
      const truncatedNote = res.truncated ? '（已截断）' : ''
      statusText(
        offsetRef.current
          ? `${label} · ${reset ? res.total : offsetRef.current} 条 · ${res.elapsedMs} ms${truncatedNote}`
          : `${label} · ${res.total} 条 · ${res.elapsedMs} ms${truncatedNote}`
      )
      // 搜索结束后重置预览：有结果就载入首条，没有结果不能继续停在“正在搜索…”。
      if (reset) setTimeout(() => {
        if (res.results.length) previewSelected()
        else previewApiRef.current?.placeholder('选择左侧文件查看预览')
      }, 0)
    } catch (error) {
      if (seq !== seqRef.current) return
      searchingRef.current = false
      setPending(false)
      if (reset) {
        setResults([])
        setSelectedPath(null)
        setHasMore(false)
        offsetRef.current = 0
      }
      statusText(error.message, 'error')
      previewApiRef.current?.placeholder('搜索失败，请调整关键词或检查引擎设置')
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
    selectedPathRef.current = null
    searchingRef.current = Boolean(text.trim())
    setResults([])
    setSelectedPath(null)
    setHasMore(false)
    setPending(Boolean(text.trim()))
    offsetRef.current = 0
    if (!text.trim()) {
      renderIdle()
      return
    }
    statusText(`搜索中 · ${text.trim()}`, 'busy')
    previewApiRef.current?.placeholder('正在搜索…')
    timerRef.current = setTimeout(() => void runSearch(true), stateRef.current.mode === 'quick' ? 120 : 220)
  }, [renderIdle, runSearch])

  // —— 列表滚动定位（树形 DOM 按 data-path 找行）——
  useEffect(() => {
    if (!selectedPath) return
    listRef.current?.querySelector(`[data-path="${cssPath(selectedPath)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedPath, results])

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
    const file = selectedFile()
    if (file) await openTarget(file.path, true)
  }, [openTarget, selectedFile])

  const revealSelected = useCallback(async () => {
    const file = selectedFile()
    if (!file) return
    try {
      await backend.reveal(file.path)
      kitRef.current?.toast('已在文件管理器中定位', 'success')
      dismissQuick()
    } catch (error) {
      kitRef.current?.toast(error.message, 'error')
    }
  }, [dismissQuick, selectedFile])

  const copySelectedPath = useCallback(() => {
    const file = selectedFile()
    if (file) void kitRef.current?.copy(file.path)
  }, [selectedFile])

  const askTrashFor = useCallback((file) => {
    if (!file?.path) return
    trashTargetRef.current = file
    setTrashText(`${file.name}（${file.path}）将移入系统废纸篓，可在废纸篓中恢复。`)
    if (dlgRef.current) {
      dlgRef.current.returnValue = ''
      dlgRef.current.showModal()
    }
  }, [])
  const askTrash = () => askTrashFor(selectedFile())

  const confirmTrash = useCallback(async () => {
    const file = trashTargetRef.current
    trashTargetRef.current = null
    if (!file) return
    try {
      await backend.trash(file.path)
      kitRef.current?.toast('已移入废纸篓', 'success')
      const current = resultsRef.current
      const removedIdx = current.findIndex(row => row.path === file.path)
      const next = current.filter((row) => row.path !== file.path)
      const keepIdx = next.findIndex(row => row.path === selectedPathRef.current)
      const fallbackIdx = Math.min(Math.max(removedIdx, 0), next.length - 1)
      setResults(next)
      setSelectedPath(next.length ? next[keepIdx >= 0 ? keepIdx : fallbackIdx].path : null)
      setTimeout(previewSelected, 0)
    } catch (error) {
      kitRef.current?.toast(error.message, 'error')
    }
  }, [previewSelected])

  // —— 选择 / 导航（按可见顺序移动；收起的目录跳过）——
  const move = useCallback((delta) => {
    const visible = resultsRef.current.filter(row => row.path && !collapsedRef.current.has(row.dir))
    if (!visible.length) return
    const idx = visible.findIndex(row => row.path === selectedPathRef.current)
    const next = visible[Math.max(0, Math.min(idx + delta, visible.length - 1))]
    if (!next || next.path === selectedPathRef.current) return
    setSelectedPath(next.path)
    if (stateRef.current.mode === 'shell') setTimeout(previewSelected, 0)
  }, [previewSelected])

  const toggleGroup = useCallback((dir) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }, [])

  // —— 引擎探测（等价原 probeProviders）——
  const probeProviders = useCallback(async () => {
    if (!backendReady()) {
      statusText('后端接口不可用，请更新 eNest 壳子', 'error')
      return
    }
    try {
      const settings = prefsRef.current ?? PREF_DEFAULTS
      const report = await backend.providers({
        everythingPort: Number(settings.everythingPort) || 0,
        everythingAuth: String(settings.everythingAuth || '') || undefined
      })
      reportRef.current = report
      if (!report.active) {
        // renderNoEngine：无引擎时列表给引导面板
        setResults([{ __idle: 'no-engine', platform: report.platform || '' }])
        setSelectedPath(null)
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

    kit.onMode((m) => {
      setMode(m)
      if (m === 'shell' && stateRef.current.query.trim() && !resultsRef.current.length) void searchRef.current(true)
      if (m === 'shell') setTimeout(() => {
        const file = resultsRef.current.find(row => row.path === selectedPathRef.current)
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
      // 偏好读取：私有 storage 优先；首次启动把旧壳设置一次性迁移过来
      let next = { ...PREF_DEFAULTS }
      let loaded = false
      try {
        const stored = await api()?.storage?.get?.(PREFS_KEY)
        if (stored && typeof stored === 'object') {
          next = { ...next, ...stored }
          loaded = true
        }
      } catch { /* storage 不可用时用默认值 */ }
      if (!loaded) {
        try {
          const legacy = await Promise.all(LEGACY_SETTING_KEYS.map(key =>
            api()?.settings?.get?.(key).catch(() => undefined)))
          const migrated = {}
          LEGACY_SETTING_KEYS.forEach((key, i) => {
            if (legacy[i] !== undefined && legacy[i] !== null) migrated[key] = legacy[i]
          })
          if (Object.keys(migrated).length) {
            next = { ...next, ...migrated }
            void api()?.storage?.set?.(PREFS_KEY, next).catch(() => {})
          }
        } catch { /* 旧设置不可读就用默认值 */ }
      }
      prefsRef.current = next
      setPrefs(next)
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

  // —— 偏好设置弹框：草稿编辑，保存写回私有 storage ——
  const openPrefs = () => {
    setDraft({ ...prefsRef.current })
    setPrefsOpen(true)
  }
  const savePrefs = async (event) => {
    event.preventDefault()
    const clamp = (value, min, max, fallback) => {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.max(min, Math.min(Math.round(n), max))
    }
    const next = {
      resultLimit: clamp(draft.resultLimit, 20, 500, PREF_DEFAULTS.resultLimit),
      everythingPort: clamp(draft.everythingPort, 0, 65535, PREF_DEFAULTS.everythingPort),
      everythingAuth: String(draft.everythingAuth ?? '')
    }
    try {
      await api()?.storage?.set?.(PREFS_KEY, next)
      await api()?.storage?.flush?.().catch(() => {})
    } catch (error) {
      kitRef.current?.toast(`保存失败：${error.message}`, 'error')
      return
    }
    const engineConfigChanged = next.everythingPort !== prefsRef.current.everythingPort
      || next.everythingAuth !== prefsRef.current.everythingAuth
    prefsRef.current = next
    setPrefs(next)
    setPrefsOpen(false)
    kitRef.current?.toast('设置已保存', 'success')
    if (engineConfigChanged) void probeRef.current()
  }

  // —— 渲染辅助 ——
  const tokens = parseQuery(query)
  const engineReport = reportRef.current
  const engineActive = engineReport?.providers?.find((item) => item.id === engineReport?.active)
  const rows = results
  const idleView = rows.length === 1 && rows[0]?.__idle === 'no-engine'
  /** 三种空态互斥：无引擎（提示安装）、还在搜（骨架）、搜完了没命中（换词建议）。 */
  const hasQuery = Boolean(query.trim())
  const noMatch = booted && hasQuery && !pending && rows.length === 0 && !idleView
  const showIdle = rows.length === 0 || idleView
  /** shell 模式结果按目录一层分组；quick 保持紧凑平铺 */
  const groups = mode === 'shell' && !showIdle && !pending ? groupByDir(rows) : null

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

  // —— 文件行（平铺与树形共用）：右键菜单 + 行内打开 ——
  const renderFileRow = (file, index, tree) => (
    <div
      key={file.path + '#' + index}
      data-path={file.path}
      className={'row' + (tree ? ' tree-row' : '') + (file.path === selectedPath ? ' active' : '')}
      role="option"
      aria-selected={file.path === selectedPath ? 'true' : 'false'}
      data-row-actions
      style={{ '--i': Math.min(index, 16) }}
      onClick={() => {
        setSelectedPath(file.path)
        selectedPathRef.current = file.path
        if (mode === 'quick') void activateSelected()
        else setTimeout(previewSelected, 0)
      }}
      onDoubleClick={() => { if (mode !== 'quick') void activateSelected() }}
      onContextMenu={(event) => {
        event.preventDefault()
        setSelectedPath(file.path)
        selectedPathRef.current = file.path
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
  )

  // —— 目录组头：收起/展开 + 右键（定位、复制路径）——
  const renderGroupHead = (dir, count) => {
    const collapsed = collapsedDirs.has(dir)
    return (
      <div className="tree-group-head" key={`g:${dir}`}>
        <button
          type="button"
          className="tree-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `展开 ${dir}` : `收起 ${dir}`}
          title={collapsed ? `展开 ${dir}` : `收起 ${dir}`}
          onClick={() => toggleGroup(dir)}
          onKeyDown={(e) => {
            if (e.isComposing) return
            if (e.key === 'ArrowRight' && collapsed) { e.preventDefault(); toggleGroup(dir) }
            else if (e.key === 'ArrowLeft' && !collapsed) { e.preventDefault(); toggleGroup(dir) }
          }}
        >
          <span className="tree-caret" aria-hidden="true">▾</span>
        </button>
        <span
          className="tree-dir"
          title={dir}
          onContextMenu={(event) => {
            event.preventDefault()
            PluginKit.openMenu(event, [
              ['reveal-dir', '在文件夹中定位'],
              ['copy-dir', '复制路径'],
            ], (key) => {
              if (key === 'reveal-dir') void backend.reveal(dir).then(() => kitRef.current?.toast('已在文件管理器中定位', 'success')).catch((error) => kitRef.current?.toast(error.message, 'error'))
              if (key === 'copy-dir') void kitRef.current?.copy(dir)
            }, { align: 'end' })
          }}
        >{dir}</span>
        <span className="tree-count" aria-hidden="true">{count}</span>
      </div>
    )
  }

  if (mode === 'panel') return <PanelView query={query} results={results} status={status} booted={booted}
    onQuery={onQueryInput} onOpen={path => { if (!searchingRef.current && resultsRef.current.some(file => file.path === path)) void openTarget(path, false) }}
    onOpenShell={() => Promise.resolve(api()?.ui?.openInShell?.()).catch(error => kitRef.current?.toast(error.message, 'error'))}
  />

  return (
    <main className="app">
      {/* 顶部一条工具栏：搜索框在上（主操作），排序与范围在其后同一行，尺寸一致。 */}
      <header className="shell-only">
        <div className="searchbar">
          <input
            id="query" ref={queryRef} type="search" defaultValue={query}
            placeholder='搜索文件名，如 报告 pdf　"精确"　-排除　*.sketch'
            aria-label="搜索文件" data-input-context="editor" {...inputHandlers}
          />
          <select id="sort" aria-label="排序" value={sort} onChange={onSortChange}>
            <option value="relevance">相关度</option>
            <option value="name">名称</option>
            <option value="mtime">修改时间</option>
            <option value="size">大小</option>
          </select>
          <button id="scope-pick" className="pk-btn pk-btn-ghost pk-btn-sm" title={scopeTitle} onClick={pickScope}>{scopeLabel}</button>
        </div>
        <div className="header-meta">
          {engineActive ? (
            <span id="engine-badge" className="engine-badge" title={engineActive.detail}>{engineActive.label}</span>
          ) : (
            <span id="engine-badge" className="engine-badge" hidden></span>
          )}
          <div id="status" className="status" role="status" data-kind={status.kind}>{status.text}</div>
        </div>
      </header>
      {/* 搜索进行中的进度条：确定性动画，不遮挡内容 */}
      <div className="search-progress" data-active={pending ? 'true' : 'false'} aria-hidden="true"><span /></div>
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
            {pending && !rows.length ? (
              /* 搜索中的骨架行：形状与真实结果一致，出结果时位置不跳。 */
              <div className="skeleton-list" aria-hidden="true">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="skeleton-row" style={{ '--i': i }}>
                    <span className="skeleton-block skeleton-icon" />
                    <span className="skeleton-lines">
                      <span className="skeleton-block skeleton-name" />
                      <span className="skeleton-block skeleton-where" />
                    </span>
                    <span className="skeleton-block skeleton-meta" />
                  </div>
                ))}
              </div>
            ) : showIdle ? (
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
              ) : noMatch ? (
                /* 搜完了没命中：给换词方向，而不是重复"输入关键词"的新手引导。 */
                <div className="idle">
                  <p className="idle-title">没有匹配「{query.trim()}」的文件</p>
                  <p className="idle-text">可以试试放宽关键词、去掉排除项，或切换搜索范围。</p>
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
            ) : groups ? (
              /* 树形：目录组头（可收起）+ 组内文件行；目录信息由组头表达，行内不再重复 */
              groups.map(({ dir, files }) => (
                <div className="tree-group" key={`grp:${dir}`} data-collapsed={collapsedDirs.has(dir) ? 'true' : 'false'}>
                  {renderGroupHead(dir, files.length)}
                  {!collapsedDirs.has(dir) && files.map((file) => {
                    const index = rows.indexOf(file)
                    return renderFileRow(file, index, true)
                  })}
                </div>
              ))
            ) : (
              rows.map((file, index) => renderFileRow(file, index, false))
            )}
          </div>
          <button id="more" className="pk-btn" hidden={!hasMore} onClick={() => void runSearch(false)}>载入更多</button>
        </section>
        <aside id="preview" className="shell-only" ref={previewRef}>
          <div className="empty">选择左侧文件查看预览</div>
        </aside>
      </div>
      {/* 右下悬浮设置钮：打开插件内置偏好设置弹框（不注册到壳设置页）。 */}
      <button type="button" className="anything-settings-fab shell-only" aria-label="偏好设置" title="偏好设置" onClick={openPrefs}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Dialog open={prefsOpen} onOpenChange={setPrefsOpen}>
        <DialogContent aria-describedby={undefined} className="prefs-dialog">
          <DialogTitle>偏好设置</DialogTitle>
          <form className="prefs-form" onSubmit={(e) => void savePrefs(e)}>
            <label className="prefs-field">
              <span>单次结果上限（条）</span>
              <Input type="number" min={20} max={500} step={10} value={draft.resultLimit}
                onChange={(e) => setDraft(d => ({ ...d, resultLimit: e.target.value }))} />
            </label>
            <label className="prefs-field">
              <span>Everything HTTP 端口（Windows，0 为不启用）</span>
              <Input type="number" min={0} max={65535} value={draft.everythingPort}
                onChange={(e) => setDraft(d => ({ ...d, everythingPort: e.target.value }))} />
            </label>
            <label className="prefs-field">
              <span>Everything HTTP 认证</span>
              <Input type="text" placeholder="用户名:密码（可空）" value={draft.everythingAuth}
                onChange={(e) => setDraft(d => ({ ...d, everythingAuth: e.target.value }))} />
            </label>
            <p className="prefs-hint">设置保存在本插件私有存储中，端口或认证变更后会立即重新探测引擎。</p>
            <div className="dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setPrefsOpen(false)}>取消</Button>
              <Button type="submit">保存</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
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
