/**
 * JSON 工具主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 parseJson/stringifyJson/highlightJsonHtml/computeJsonFolds 复用 core.mjs，
 * queryJson/jsonStats/toTypeScript 复用 extra.mjs（均未改动）。
 * 生成型 DOM（高亮代码行/树/查询/统计/差异）沿用批 1 约定：原版等价 HTML 字符串 +
 * dangerouslySetInnerHTML + 容器级事件委托；原生 select 仍由 plugin-kit upgradeSelects 接管。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  parseJson,
  stringifyJson,
  childNodes,
  searchJson,
  diffJson,
  unescapeText,
  highlightJsonHtml,
  computeJsonFolds,
  HIGHLIGHT_CHAR_LIMIT,
  HIGHLIGHT_LINE_LIMIT,
} from '../js/core.mjs'
import { queryJson, jsonStats, toTypeScript } from '../js/extra.mjs'
import { MoreMenu } from '../ui/index.jsx'

const api = window.enest || window.zapi
const esc = PluginKit.escape

const INDENT_UNIT = (value) => (value === 'tab' ? '\t' : Number(value) || 2)
const JSON_OUTPUT_MODES = ['format', 'sort', 'check', 'minify']
const TYPE_LABELS = [
  ['object', '对象'],
  ['array', '数组'],
  ['string', '字符串'],
  ['number', '数字'],
  ['boolean', '布尔'],
  ['null', '空值'],
]

function formatBytes(size) {
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / 1024 / 1024).toFixed(2) + ' MB'
}

export function App() {
  const kitRef = useRef(null)
  const inputRef = useRef(null)

  /* —— 与原版模块级变量一一对应 —— */
  const [mode, setMode] = useState('format') // activeMode
  const [indent, setIndent] = useState('2')
  const [wrapOff, setWrapOff] = useState(false) // wrapLines === false
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [outputHidden, setOutputHidden] = useState(false)
  const [codeToolsVisible, setCodeToolsVisible] = useState(false)
  const [codeVisible, setCodeVisible] = useState(false)
  const [codeHtml, setCodeHtml] = useState('') // 行 HTML（不含折叠态 class）
  const [foldHint, setFoldHint] = useState('')
  const [errorText, setErrorText] = useState('')
  const [view, setView] = useState('text') // selectedView
  const [statsLine, setStatsLine] = useState('保留数字原始精度')
  const [resultSize, setResultSize] = useState('离线处理 · 最大 8 MB')
  const [inputSize, setInputSize] = useState('')
  const [editor, setEditor] = useState('source')
  const [emptyVisible, setEmptyVisible] = useState(true)
  const [hlOn, setHlOn] = useState(true)
  const [searchText, setSearchText] = useState('')
  const [searchCount, setSearchCount] = useState('')
  const [queryText, setQueryText] = useState('')
  const [queryHtml, setQueryHtml] = useState('')
  const [tsText, setTsText] = useState('')
  const [tsRootName, setTsRootName] = useState('Root')
  const [statsCardsHtml, setStatsCardsHtml] = useState('')
  const [statsKeysHtml, setStatsKeysHtml] = useState('')
  const [statsTypesHtml, setStatsTypesHtml] = useState('')
  const [compareText, setCompareText] = useState('')
  const [diffHtml, setDiffHtml] = useState('')

  /* 命令式管线 ref 镜像（latest-ref 桥接，等价原闭包变量） */
  const parsedRef = useRef(null)
  const resultRef = useRef('')
  const differencesRef = useRef([])
  const foldStateRef = useRef(new Map()) // startLine -> true
  const codeFoldsByStartRef = useRef(new Map()) // startLine -> folds[]
  const viewRef = useRef('text')
  viewRef.current = view
  const modeRef = useRef('format')
  modeRef.current = mode
  const debounceRef = useRef(0)

  /* —— 通用动作 —— */
  const copy = useCallback(
    (text) =>
      kitRef.current.copy(text).catch((error) => {
        kitRef.current.toast(error.message, 'error')
        return false
      }),
    [],
  )
  const saveText = useCallback(
    (name, content) =>
      kitRef.current.saveText(name, content).catch((error) => {
        kitRef.current.toast(error.message, 'error')
        return null
      }),
    [],
  )

  const inputStats = useCallback((value) => {
    setInputSize(new Blob([value]).size + ' B')
  }, [])

  const selectedViewDirty = useCallback(() => {
    const v = viewRef.current
    if (v === 'tree') return Boolean(treeDirtyRef.current)
    if (v === 'query') return Boolean(queryDirtyRef.current)
    if (v === 'ts') return Boolean(tsTextRef.current)
    if (v === 'stats') return Boolean(statsDirtyRef.current)
    if (v === 'diff') return Boolean(diffDirtyRef.current)
    return false
  }, [])

  const treeDirtyRef = useRef(false)
  const queryDirtyRef = useRef(false)
  const tsTextRef = useRef('')
  tsTextRef.current = tsText
  const statsDirtyRef = useRef(false)
  const diffDirtyRef = useRef(false)

  const updateEmptyState = useCallback(() => {
    setEmptyVisible(!resultRef.current && !selectedViewDirty())
  }, [selectedViewDirty])

  /* —— 失败路径（等价原 error()） —— */
  const showError = useCallback(
    (e) => {
      setErrorText(e.message)
      resultRef.current = ''
      setOutput('')
      foldStateRef.current.clear()
      setCodeVisible(false)
      setCodeToolsVisible(false)
      setOutputHidden(false)
      setFoldHint('')
      updateEmptyState()
      if (Number.isInteger(e.position)) {
        setEditor('source')
        requestAnimationFrame(() => {
          const el = inputRef.current
          el?.focus()
          el?.setSelectionRange(e.position, e.position + 1)
        })
      }
    },
    [updateEmptyState],
  )

  const getParsed = useCallback((source) => {
    const parsed = parseJson(source)
    parsedRef.current = parsed
    const s = parsed.stats
    setStatsLine(`${s.nodes} 节点 · ${s.keys} 键 · ${s.maxDepth} 层`)
    return parsed
  }, [])

  /* —— 文本视图：高亮 + 行号 + 折叠（等价原 renderCode/applyFoldState） —— */
  const buildCodeRows = useCallback(() => {
    const result = resultRef.current
    const lines = result ? result.split('\n') : []
    const usable =
      hlOn &&
      parsedRef.current &&
      JSON_OUTPUT_MODES.includes(modeRef.current) &&
      lines.length > 0 &&
      lines.length <= HIGHLIGHT_LINE_LIMIT &&
      result.length <= HIGHLIGHT_CHAR_LIMIT
    if (!usable) {
      foldStateRef.current.clear()
      setCodeVisible(false)
      setCodeToolsVisible(false)
      setOutputHidden(false)
      return null
    }
    const html = highlightJsonHtml(result)
    const folds = computeJsonFolds(result) || []
    if (!html) {
      setCodeVisible(false)
      setCodeToolsVisible(false)
      setOutputHidden(false)
      return null
    }
    setOutputHidden(true)
    setCodeVisible(true)
    setCodeToolsVisible(true)
    foldStateRef.current.clear()
    // 超过 120 行的大结果默认收拢到第 2 层，小结果保持全展开
    if (lines.length > 120) for (const f of folds) if (f.depth >= 2) foldStateRef.current.set(f.start, true)
    const foldsByStart = new Map()
    for (const f of folds) {
      if (!foldsByStart.has(f.start)) foldsByStart.set(f.start, [])
      foldsByStart.get(f.start).push(f)
    }
    codeFoldsByStartRef.current = foldsByStart
    const collapsed = foldStateRef.current
    return {
      foldsCount: folds.length,
      html: html
        .split('\n')
        .map((lc, i) => {
          const hasFold = foldsByStart.has(i)
          const folded = collapsed.has(i)
          const btn = hasFold
            ? `<button class="fold-btn" data-fold="${i}" aria-expanded="${!folded}" aria-label="折叠第 ${i + 1} 行的块" tabindex="-1"></button>`
            : `<span class="fold-sp"></span>`
          const ell = hasFold
            ? `<span class="fold-ell"${folded ? '' : ' hidden'}> ⋯ ${Math.max(...foldsByStart.get(i).map((f) => f.end)) - i} 行</span>`
            : ''
          return `<span class="cl${folded ? ' folded' : ''}" data-l="${i}"><span class="ln">${i + 1}</span>${btn}<span class="lc">${lc || ' '}</span>${ell}</span>`
        })
        .join(''),
    }
  }, [hlOn])

  const renderCode = useCallback(() => {
    const built = buildCodeRows()
    if (!built) {
      setCodeHtml('')
      setFoldHint('')
      return
    }
    setCodeHtml(built.html)
    const collapsedCount = foldStateRef.current.size
    setFoldHint(collapsedCount ? `已折叠 ${collapsedCount} 处` : built.foldsCount ? `${built.foldsCount} 处可折叠` : '')
  }, [buildCodeRows])

  /* 折叠态变化 → 重排行 HTML（等价原 applyFoldState，数据驱动重渲染） */
  const applyFoldState = useCallback(() => {
    const foldState = foldStateRef.current
    const result = resultRef.current
    const lines = result ? result.split('\n') : []
    const collapsed = [...codeFoldsByStartRef.current.entries()].filter(([start]) => foldState.has(start))
    setCodeHtml(
      lines
        .map((lc, i) => {
          let hide = false
          for (const [, folds] of collapsed)
            if (folds.some((f) => i > f.start && i <= f.end)) {
              hide = true
              break
            }
          const hasFold = codeFoldsByStartRef.current.has(i)
          const folded = foldState.has(i)
          const btn = hasFold
            ? `<button class="fold-btn" data-fold="${i}" aria-expanded="${!folded}" aria-label="折叠第 ${i + 1} 行的块" tabindex="-1"></button>`
            : `<span class="fold-sp"></span>`
          const ell = hasFold
            ? `<span class="fold-ell"${folded ? '' : ' hidden'}> ⋯ ${Math.max(...codeFoldsByStartRef.current.get(i).map((f) => f.end)) - i} 行</span>`
            : ''
          return `<span class="cl${hide ? ' folded' : ''}" data-l="${i}"${hide ? ' hidden' : ''}><span class="ln">${i + 1}</span>${btn}<span class="lc">${lc || ' '}</span>${ell}</span>`
        })
        .join(''),
    )
  }, [])

  const onCodeRenderClick = useCallback(
    (e) => {
      const btn = e.target.closest('.fold-btn')
      if (!btn) return
      const start = Number(btn.dataset.fold)
      const foldState = foldStateRef.current
      if (foldState.has(start)) foldState.delete(start)
      else foldState.set(start, true)
      applyFoldState()
      setFoldHint(foldState.size ? `已折叠 ${foldState.size} 处` : '全展开')
    },
    [applyFoldState],
  )

  /* —— 树视图（等价原 makeNode/renderTree：生成 HTML + toggle 懒加载） —— */
  const buildTreeNodeHtml = useCallback((item, depth) => {
    const children = childNodes(item.node, item.path)
    const valueText = children.length
      ? (item.node.kind === 'array' ? '[' : '{') + children.length + (item.node.kind === 'array' ? ']' : '}')
      : stringifyJson(item.node, 0)
    const copyBtn = `<button class="path-copy" title="${esc(item.path || '(根路径)')}">路径</button>`
    if (!children.length)
      return `<div class="tree-node"><span><span>${esc(item.label)}: </span><span class="node-value">${esc(valueText)}</span>${copyBtn}</span></div>`
    const tag = 'details'
    const open = depth === 0 ? ' open' : ''
    // 子项 JSON 以 data-item 内联，attachLazyLoad 物化子节点时读取（等价原闭包捕获 item）
    const payload = esc(JSON.stringify(item)).replace(/&#39;/g, '&#x27;')
    return `<${tag} class="tree-node" data-depth="${depth}" data-item="${payload}"${open}><summary><span>${esc(item.label)}: </span><span class="node-value">${esc(valueText)}</span>${copyBtn}</summary></${tag}>`
  }, [])

  const attachLazyLoad = useCallback((scope) => {
    // 等价原 makeNode 的 toggle 懒加载：open 的 details 首次物化 100 项子节点
    for (const details of scope.querySelectorAll('details:not([data-ready])')) {
      details.setAttribute('data-ready', '1')
      const depth = Number(details.dataset.depth || 0)
      let item = null
      try {
        item = JSON.parse(details.dataset.item || 'null')
      } catch {
        item = null
      }
      details.__load = () => {
        // React 重渲染会重建 #tree 内容，已脱离文档的旧节点不再物化
        if (!details.isConnected || !item || details.__loaded) return
        // 有「继续加载」按钮 = 已物化过一部分，避免重复（等价原 rendered 标志）
        if (details.querySelector(':scope > .continue-btn')) {
          details.__loaded = true
          return
        }
        if (details.children.length > 1) {
          // 已有子节点（由上一轮物化），只补齐剩余部分
          details.__loaded = true
          return
        }
        details.__loaded = true
        const children = childNodes(item.node, item.path)
        let at = 0
        const add = () => {
          details.querySelector('.continue-btn')?.remove()
          const end = Math.min(children.length, at + 100)
          let html = ''
          while (at < end) html += buildTreeNodeHtml(children[at++], depth + 1)
          details.insertAdjacentHTML('beforeend', html)
          attachLazyLoad(details)
          if (at < children.length) {
            const more = document.createElement('button')
            more.className = 'continue-btn'
            more.textContent = '继续加载 100 项'
            more.addEventListener('click', () => add())
            details.append(more)
          }
        }
        add()
      }
      details.addEventListener('toggle', () => {
        if (details.open) details.__load?.()
      })
      if (details.open) requestAnimationFrame(() => details.__load?.())
    }
  }, [buildTreeNodeHtml])

  const treeBodyRef = useRef(null)
  const [treeSearchHtml, setTreeSearchHtml] = useState('')
  const [treeRootHtml, setTreeRootHtml] = useState('')
  useEffect(() => {
    if (treeBodyRef.current) attachLazyLoad(treeBodyRef.current)
  }, [treeSearchHtml, treeRootHtml, attachLazyLoad])

  const renderTree = useCallback(() => {
    try {
      const source = inputRef.current?.value ?? input
      const parsed = parsedRef.current || getParsed(source)
      const query = searchText.trim()
      if (query) {
        const matches = searchJson(parsed.root, query)
        setSearchCount(matches.length + ' 项')
        let html = ''
        for (const item of matches.slice(0, 500)) {
          const full = stringifyJson(item.node, 0)
          const preview = esc(full.slice(0, 200) + (full.length > 200 ? '…' : ''))
          html += `<button class="search-row" data-full="${esc(full)}"><small>${esc(item.path || '/')}</small><span>${preview}</span></button>`
        }
        if (matches.length > 500) html += `<p class="query-empty">仅展示前 500 项，请缩小搜索范围。</p>`
        setTreeSearchHtml(html)
        setTreeRootHtml('')
        treeDirtyRef.current = matches.length > 0
      } else {
        setSearchCount('')
        setTreeSearchHtml('')
        setTreeRootHtml(buildTreeNodeHtml({ label: '$', path: '', node: parsed.root }, 0))
        treeDirtyRef.current = true
      }
    } catch (e) {
      showError(e)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildTreeNodeHtml, getParsed, searchText, showError])

  /* 全部展开（等价原 expandAllTree：逐轮打开 + _load 同步物化） */
  const expandAllTree = useCallback(() => {
    const parsed = parsedRef.current
    if (!parsed) return
    if (parsed.stats.nodes > 20000) {
      kitRef.current.toast(`共 ${parsed.stats.nodes} 个节点，过多已跳过全部展开`, 'warn')
      return
    }
    const box = treeBodyRef.current
    if (!box) return
    let guard = 0
    const openRound = () => {
      const closed = box.querySelectorAll('details:not([open])')
      if (!closed.length || guard++ > 80) return
      for (const d of closed) {
        d.open = true
        d.__load?.()
      }
      openRound()
    }
    openRound()
  }, [])

  const collapseTree = useCallback(() => {
    treeBodyRef.current?.querySelectorAll('details[open]').forEach((d) => (d.open = false))
  }, [])

  /* —— 查询视图（等价原 runQuery） —— */
  const runQuery = useCallback(() => {
    const query = queryText.trim()
    if (!query) {
      setQueryHtml('<p class="query-empty">输入路径后回车，例如 .users[*].name</p>')
      queryDirtyRef.current = false
      return
    }
    try {
      const source = inputRef.current?.value ?? input
      const parsed = parsedRef.current || getParsed(source)
      const matches = queryJson(parsed.root, query)
      if (!matches.length) {
        setQueryHtml('<p class="query-empty">没有匹配的节点</p>')
        queryDirtyRef.current = false
        return
      }
      let html = ''
      for (const item of matches.slice(0, 500)) {
        const text = stringifyJson(item.node, 0)
        const value = text.length > 300 ? text.slice(0, 300) + '…' : text
        html += `<button class="query-row" data-full="${esc(text)}"><code class="q-path">${esc('$' + item.path)}</code><span class="q-value">${esc(value)}</span></button>`
      }
      if (matches.length > 500) html += `<p class="query-empty">共 ${matches.length} 项命中，仅展示前 500 项。</p>`
      setQueryHtml(html)
      queryDirtyRef.current = true
    } catch (e) {
      setQueryHtml(`<p class="query-empty">${esc(e.message)}</p>`)
      queryDirtyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getParsed, queryText])

  /* —— TS 类型视图（等价原 renderTs） —— */
  const renderTs = useCallback(() => {
    try {
      const source = inputRef.current?.value ?? input
      const parsed = parsedRef.current || getParsed(source)
      const text = toTypeScript(parsed.root, { rootName: tsRootName.trim() || 'Root' })
      setTsText(text)
      tsTextRef.current = text
    } catch (e) {
      setTsText('')
      tsTextRef.current = ''
      showError(e)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getParsed, showError, tsRootName])

  /* —— 统计视图（等价原 renderStats） —— */
  const renderStats = useCallback(() => {
    try {
      const source = inputRef.current?.value ?? input
      const parsed = parsedRef.current || getParsed(source)
      const stats = jsonStats(parsed.root)
      const cards = [
        [parsed.stats.nodes, '节点'],
        [parsed.stats.keys, '键'],
        [parsed.stats.maxDepth, '最大深度'],
        [formatBytes(new Blob([source]).size), '输入体积'],
        [stats.maxArrayLength, '最长数组'],
        [stats.distinctKeys, '去重键数'],
      ]
      setStatsCardsHtml(
        cards.map(([value, label]) => `<div class="stat-card"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`).join(''),
      )
      setStatsKeysHtml(
        stats.topKeys.length
          ? stats.topKeys.map(([key, count]) => `<li><span class="k">${esc(key)}</span><span class="v">× ${count}</span></li>`).join('')
          : '<li class="stat-empty">暂无对象键</li>',
      )
      setStatsTypesHtml(
        TYPE_LABELS.filter(([kind]) => stats.counts[kind])
          .map(([kind, label]) => `<li><span class="k">${esc(label)}</span><span class="v">${stats.counts[kind]}</span></li>`)
          .join(''),
      )
      statsDirtyRef.current = true
    } catch (e) {
      showError(e)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getParsed, showError])

  /* —— 差异（等价原 compare） —— */
  const compare = useCallback(() => {
    setErrorText('')
    try {
      const source = inputRef.current?.value ?? input
      const differences = diffJson(getParsed(source).root, parseJson(compareText).root)
      differencesRef.current = differences
      let html = ''
      if (!differences.length) html = '<p class="diff-empty">两份 JSON 相同（忽略对象键顺序）</p>'
      for (const item of differences.slice(0, 1000)) {
        html += `<article class="diff-row"><strong>${esc(item.type + ' · ' + item.path)}</strong><pre>${esc('− ' + item.before)}</pre><pre class="after">${esc('+ ' + item.after)}</pre></article>`
      }
      if (differences.length > 1000)
        html += `<p>共 ${differences.length} 处差异，显示前 1000 项；复制可取得全部。</p>`
      setDiffHtml(html)
      diffDirtyRef.current = differences.length > 0
    } catch (e) {
      differencesRef.current = []
      setDiffHtml('')
      diffDirtyRef.current = false
      setErrorText('比较失败：' + e.message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareText, getParsed])

  /* —— 全部失效（等价原 invalidate()） —— */
  const invalidate = useCallback(() => {
    parsedRef.current = null
    resultRef.current = ''
    setOutput('')
    foldStateRef.current.clear()
    setCodeVisible(false)
    setCodeToolsVisible(false)
    setOutputHidden(false)
    setFoldHint('')
    setCodeHtml('')
    setTsText('')
    tsTextRef.current = ''
    setErrorText('')
    setTreeSearchHtml('')
    setTreeRootHtml('')
    treeDirtyRef.current = false
    setQueryHtml('')
    queryDirtyRef.current = false
    setStatsCardsHtml('')
    setStatsKeysHtml('')
    setStatsTypesHtml('')
    statsDirtyRef.current = false
    setDiffHtml('')
    diffDirtyRef.current = false
    setStatsLine('保留数字原始精度')
    setResultSize('离线处理 · 最大 8 MB')
    inputStats(inputRef.current?.value ?? '')
    updateEmptyState()
  }, [inputStats, updateEmptyState])

  /* —— 模式执行（等价原 transform(action)） —— */
  const transform = useCallback(
    (action, switchEditor = true) => {
      setErrorText('')
      setMode(action)
      modeRef.current = action
      const source = inputRef.current?.value ?? input
      if (!source.trim()) return
      try {
        if (new Blob([source]).size > 8 * 1024 * 1024) throw new Error('输入超过 8 MB')
        if (new Blob([source]).size > 2 * 1024 * 1024) kitRef.current.toast('输入超过 2 MB，处理可能需要片刻', 'info')
        let result
        if (action === 'escape') result = JSON.stringify(source).slice(1, -1)
        else if (action === 'unescape') result = unescapeText(source)
        else {
          const p = getParsed(source)
          result = stringifyJson(p.root, action === 'minify' ? 0 : INDENT_UNIT(indent), action === 'sort')
          if (action === 'check') kitRef.current.toast('JSON 有效，数字 token 已保留', 'success')
        }
        resultRef.current = result
        setOutput(result)
        setResultSize(new Blob([result]).size + ' B · ' + result.length + ' 字符')
        if (switchEditor) setEditor('result')
        renderCode()
        refreshActiveViewRef.current()
        updateEmptyState()
      } catch (e) {
        parsedRef.current = null
        showError(e)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getParsed, indent, renderCode, showError, updateEmptyState],
  )

  const refreshActiveView = useCallback(() => {
    const v = viewRef.current
    if (v === 'tree') renderTreeRef.current()
    else if (v === 'query') runQueryRef.current()
    else if (v === 'ts') renderTsRef.current()
    else if (v === 'stats') renderStatsRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const refreshActiveViewRef = useRef(refreshActiveView)
  refreshActiveViewRef.current = refreshActiveView
  const runQueryRef = useRef(runQuery)
  runQueryRef.current = runQuery
  const renderTsRef = useRef(renderTs)
  renderTsRef.current = renderTs
  const renderStatsRef = useRef(renderStats)
  renderStatsRef.current = renderStats
  const renderTreeRef = useRef(renderTree)
  renderTreeRef.current = renderTree
  const invalidateRef = useRef(invalidate)
  invalidateRef.current = invalidate
  const transformRef = useRef(transform)
  transformRef.current = transform

  /* —— 视图切换（等价原 view(name)） —— */
  const switchView = useCallback((name) => {
    setView(name)
    viewRef.current = name
    setEmptyVisible(false)
    const source = inputRef.current?.value ?? ''
    if (source.trim()) {
      // 与原版一致的例外：树是切换时唯一强制重渲的视图，其余视图仅在生成动作后刷新
      if (name === 'tree') renderTreeRef.current()
      else if (name === 'query') runQueryRef.current()
      else if (name === 'ts') renderTsRef.current()
      else if (name === 'stats') renderStatsRef.current()
    }
    updateEmptyStateRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const updateEmptyStateRef = useRef(updateEmptyState)
  updateEmptyStateRef.current = updateEmptyState

  /* —— 输入与防抖联动 —— */
  const onSearchInput = useCallback((value) => {
    setSearchText(value)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => renderTreeRef.current(), 180)
  }, [])

  const onTsRootInput = useCallback((value) => {
    setTsRootName(value)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => renderTsRef.current(), 200)
  }, [])

  /* —— 通用清理（等价原 clear()） —— */
  const clearAll = useCallback(() => {
    setInput('')
    setCompareText('')
    setDiffHtml('')
    diffDirtyRef.current = false
    setQueryText('')
    differencesRef.current = []
    invalidateRef.current()
    setEditor('source')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [invalidate])

  const refill = useCallback(() => {
    if (!resultRef.current) return
    setInput(resultRef.current)
    invalidateRef.current()
    setEditor('source')
  }, [invalidate])

  const paste = useCallback(async () => {
    try {
      const text = await api.clipboard.readText()
      setInput(String(text ?? ''))
      requestAnimationFrame(() => {
        invalidateRef.current()
        transformRef.current('format')
      })
    } catch (e) {
      kitRef.current.toast('无法读取剪贴板：' + e.message, 'error')
    }
  }, [])

  /* —— 生成区事件委托（树搜索行 / 查询行 → 复制完整值） —— */
  const onTreeClick = useCallback(
    (e) => {
      const row = e.target.closest('.search-row')
      if (row?.dataset.full) copy(row.dataset.full)
    },
    [copy],
  )
  const onQueryResultsClick = useCallback(
    (e) => {
      const row = e.target.closest('.query-row')
      if (row?.dataset.full) copy(row.dataset.full)
    },
    [copy],
  )

  /* ⌘/Ctrl + Shift + Enter 快速格式化（等价原 document keydown） */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        transformRef.current('format')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Quick 单栏可见性跟随 editor，卸载时恢复根属性。
  useEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.editor
    root.dataset.editor = editor
    return () => {
      if (previous === undefined) delete root.dataset.editor
      else root.dataset.editor = previous
    }
  }, [editor])

  /* —— 生命周期：PluginKit 一次初始化 + latest-ref 桥接 —— */
  useEffect(() => {
    let alive = true
    const kit = PluginKit.create({
      title: 'JSON 工具',
      quickPlaceholder: '粘贴 JSON，Enter 格式化',
      height: 510,
      defaults: { indent: '2', defaultView: 'text', wrapLines: true },
      onQuery(value) {
        setInput(value)
        invalidateRef.current()
        clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
          if (value.trim()) transformRef.current('format', false)
        }, 300)
      },
      onAction(action) {
        if (action === 'submit') transformRef.current('format')
        else if (action === 'clear') clearAllRef.current()
      },
    })
    kitRef.current = kit
    api?.onEnter?.(({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload?.text
      if (typeof text === 'string' && text) {
        setInput(text)
        requestAnimationFrame(() => {
          invalidateRef.current()
          transformRef.current('format')
        })
      } else inputRef.current?.focus()
    })
    void (async () => {
      await kit.ready
      if (!alive) return
      setIndent(String(kit.settings.indent || 2))
      setWrapOff(kit.settings.wrapLines === false)
      PluginKit.upgradeSelects() // 纯 state 赋值不触发 change，手动同步自定义下拉标签
      switchViewRef.current(kit.settings.defaultView === 'tree' ? 'tree' : 'text')
      kit.onSettings((settings) => {
        setIndent(String(settings.indent || 2))
        setWrapOff(settings.wrapLines === false)
        PluginKit.upgradeSelects()
      })
    })()
    return () => {
      alive = false
      clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const clearAllRef = useRef(clearAll)
  clearAllRef.current = clearAll
  const switchViewRef = useRef(switchView)
  switchViewRef.current = switchView

  return (
    <main className="json-workspace">
      <header className="app-head">
        <div className="head-brand">
          <h1>JSON 工具</h1>
          <span id="stats" className="stat-line">{statsLine}</span>
        </div>
        <div className="quick-switch">
          <button id="show-source" aria-pressed={editor === 'source'} onClick={() => setEditor('source')}>原文</button>
          <button id="show-result" aria-pressed={editor === 'result'} onClick={() => setEditor('result')}>结果</button>
        </div>
      </header>
      <div className="toolbar" role="toolbar" aria-label="JSON 操作">
        <div className="segmented" id="mode-switch" role="tablist" aria-label="处理模式">
          {[
            ['format', '格式化'],
            ['minify', '压缩'],
            ['sort', '键排序'],
            ['check', '校验'],
            ['escape', '转义'],
            ['unescape', '反转义'],
          ].map(([action, label]) => (
            <button key={action} data-action={action} className={mode === action ? 'active' : ''} aria-pressed={mode === action}
              onClick={() => transform(action)}>{label}</button>
          ))}
        </div>
        <label className="indent-pick" htmlFor="indent">
          缩进
          <select id="indent" value={indent} onChange={(e) => setIndent(e.target.value)}>
            <option value="2">2 空格</option>
            <option value="4">4 空格</option>
            <option value="tab">Tab</option>
          </select>
        </label>
        <span className="tool-gap"></span>
        <button id="paste" className="ghost" onClick={() => void paste()}>粘贴</button>
        <button id="clear" className="ghost" onClick={clearAll}>清空</button>
      </div>
      <div id="error" role="alert">{errorText}</div>
      <section className="editors">
        <div className="source-pane">
          <div className="pane-head">
            <label htmlFor="input">输入</label><span id="input-size">{inputSize}</span>
          </div>
          <textarea
            id="input"
            ref={inputRef}
            spellcheck="false"
            wrap={wrapOff ? 'off' : 'soft'}
            placeholder='{"message": "粘贴 JSON 开始"}'
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              invalidateRef.current()
            }}
          ></textarea>
        </div>
        <div className="result-pane">
          <div className="pane-head">
            <nav className="segmented" id="view-switch" aria-label="结果视图">
              {[
                ['text', '文本'],
                ['tree', '树'],
                ['query', '查询'],
                ['ts', 'TS'],
                ['stats', '统计'],
                ['diff', '差异'],
              ].map(([name, label]) => (
                <button key={name} data-view={name} className={view === name ? 'active' : ''} aria-pressed={view === name}
                  onClick={() => switchView(name)}>{label}</button>
              ))}
            </nav>
            <button id="copy" className="ghost" onClick={() => (resultRef.current ? copy(resultRef.current) : kitRef.current.toast('先生成结果', 'info'))}>复制</button>
            <MoreMenu
              ariaLabel="结果操作"
              items={[
                { key: 'refill', label: '回填', onSelect: refill },
                { key: 'save', label: '导出', onSelect: () => resultRef.current && saveText('formatted.json', resultRef.current) },
              ]}
            />
          </div>
          <div className="view text-view" data-content="text" hidden={view !== 'text'}>
            <div className="code-tools" id="code-tools" hidden={!codeToolsVisible}>
              <button id="hl-toggle" className={'chip' + (hlOn ? ' active' : '')} aria-pressed={hlOn}
                onClick={() => setHlOn((v) => !v)}>高亮</button>
              <button id="fold-none" className="chip" onClick={() => {
                foldStateRef.current.clear()
                applyFoldState()
                setFoldHint('全展开')
              }}>全部展开</button>
              {[1, 2, 3].map((depth) => (
                <button key={depth} data-fold-depth={depth} className="chip" onClick={() => {
                  const foldState = foldStateRef.current
                  foldState.clear()
                  for (const [, folds] of codeFoldsByStartRef.current)
                    for (const f of folds) if (f.depth >= depth) foldState.set(f.start, true)
                  applyFoldState()
                  setFoldHint(`已折叠 ${foldState.size} 处`)
                }}>{depth} 层</button>
              ))}
              <span id="fold-hint" className="count-hint">{foldHint}</span>
            </div>
            <div
              id="code-render"
              className="code-render mono"
              tabIndex={0}
              role="group"
              aria-label="JSON 高亮结果（行号旁箭头可折叠）"
              hidden={!codeVisible}
              onClick={onCodeRenderClick}
              dangerouslySetInnerHTML={{ __html: codeHtml }}
            ></div>
            <textarea
              id="output"
              readOnly
              spellcheck="false"
              wrap={wrapOff ? 'off' : 'soft'}
              aria-label="JSON 结果"
              placeholder="结果将显示在这里"
              hidden={outputHidden}
              value={output}
            ></textarea>
          </div>
          <div className="view tree-view" data-content="tree" hidden={view !== 'tree'}>
            <div className="tree-toolbar">
              <input
                id="search"
                placeholder="搜索键、值或路径"
                aria-label="搜索 JSON 树"
                value={searchText}
                onChange={(e) => onSearchInput(e.target.value)}
              /><span id="search-count" className="count-hint">{searchCount}</span>
              <button id="tree-expand" className="ghost" onClick={expandAllTree}>全部展开</button>
              <button id="tree-collapse" className="ghost" onClick={collapseTree}>全部收起</button>
            </div>
            <div id="tree" className="tree-body" ref={treeBodyRef} onClick={onTreeClick}
              dangerouslySetInnerHTML={{ __html: treeRootHtml || treeSearchHtml }}
            ></div>
          </div>
          <div className="view query-view" data-content="query" hidden={view !== 'query'}>
            <div className="query-bar">
              <code className="query-sign">$</code>
              <input
                id="query"
                spellcheck="false"
                placeholder=".users[*].name · ..id · .items[0]"
                aria-label="路径查询"
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    runQueryRef.current()
                  }
                }}
              />
              <button id="query-run" onClick={runQuery}>查询</button>
            </div>
            <p className="view-hint">点路径写法：<code>.a.b</code> 子键 · <code>[*]</code> 全部元素 · <code>[0]</code> / <code>[-1]</code> 索引 · <code>..name</code> 任意层级</p>
            <div id="query-results" className="query-body" onClick={onQueryResultsClick}
              dangerouslySetInnerHTML={{ __html: queryHtml }}
            ></div>
          </div>
          <div className="view ts-view" data-content="ts" hidden={view !== 'ts'}>
            <div className="view-actions">
              <label className="ts-root" htmlFor="ts-root-name">根类型名
                <input id="ts-root-name" value={tsRootName} spellcheck="false" onChange={(e) => onTsRootInput(e.target.value)} />
              </label>
              <span className="tool-gap"></span>
              <button id="ts-copy" onClick={() => {
                if (tsText) copy(tsText)
                else kitRef.current.toast('先在输入中提供 JSON', 'info')
              }}>复制类型</button>
            </div>
            <pre id="ts-output" className="code-block" tabIndex={0} aria-label="TypeScript 类型">{tsText}</pre>
          </div>
          <div className="view stats-view" data-content="stats" hidden={view !== 'stats'}>
            <div id="stats-cards" className="stat-cards"
              dangerouslySetInnerHTML={{ __html: statsCardsHtml }}></div>
            <div className="stats-cols">
              <section className="stat-col">
                <h3>键出现次数 Top 8</h3>
                <ol id="stats-keys" className="stat-list" dangerouslySetInnerHTML={{ __html: statsKeysHtml }}></ol>
              </section>
              <section className="stat-col">
                <h3>类型分布</h3>
                <ul id="stats-types" className="stat-list" dangerouslySetInnerHTML={{ __html: statsTypesHtml }}></ul>
              </section>
            </div>
          </div>
          <div className="view diff-view" data-content="diff" hidden={view !== 'diff'}>
            <textarea
              id="compare"
              spellcheck="false"
              aria-label="比较 JSON"
              placeholder="粘贴另一份 JSON，与左侧输入比较"
              value={compareText}
              onChange={(e) => setCompareText(e.target.value)}
            ></textarea>
            <div className="diff-actions">
              <button id="compare-run" onClick={compare}>比较</button>
              <button id="diff-copy" className="ghost" onClick={() => copy(JSON.stringify(differencesRef.current, null, 2))}>复制差异</button>
              <span className="view-hint-inline">按路径比较，数字按原始 token 比较</span>
            </div>
            <div id="diff-results" dangerouslySetInnerHTML={{ __html: diffHtml }}></div>
          </div>
          <div className="result-empty" id="result-empty" hidden={!emptyVisible}>
            <p className="empty-title">还没有结果</p>
            <p className="empty-desc">在左侧粘贴 JSON，选择上方模式；<br />⌘/Ctrl + Shift + Enter 快速格式化</p>
          </div>
        </div>
      </section>
      <footer>
        <span id="result-size">{resultSize}</span>
        <span className="foot-hint">⌘/Ctrl + Shift + Enter 格式化</span>
      </footer>
    </main>
  )
}
