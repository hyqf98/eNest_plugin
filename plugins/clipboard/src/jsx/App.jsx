/**
 * clipboard 主界面 —— React 版（原 src/js/main.js + src/js/tools.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 文本变换纯逻辑复用 textkit.js（未改动）。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MoreMenu } from '../ui/index.jsx'
import * as tk from '../js/textkit.js'
import { createClipboardApi } from '../js/history-api.mjs'

const SNIPPET_KEY = 'clipboard.snippets.v1'
const SNIPPET_MAX = 20
const TYPE_LABEL = { text: '文本', image: '图片', files: '文件' }
const esc = PluginKit.escape

const age = (ts) => {
  const minutes = Math.floor((Date.now() - ts) / 60000)
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const size = (bytes) => (bytes < 1024 ? `${bytes || 0} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`)

const XFMT_BUTTONS = ['json', 'json-min', 'unique', 'sort', 'strip', 'upper', 'lower', 'camel', 'snake', 'kebab']
const XFMT_LABELS = { json: '格式化 JSON', 'json-min': '压缩 JSON', unique: '行去重', sort: '行排序', strip: '去格式化', upper: '全部大写', lower: '全部小写', camel: 'camelCase', snake: 'snake_case', kebab: 'kebab-case' }

export function App() {
  const api = useMemo(() => createClipboardApi(window.enest || window.zapi), [])
  const kitRef = useRef(null)
  const listRef = useRef(null)
  const detailRef = useRef(null)
  const searchRef = useRef(null)

  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [hasCursor, setHasCursor] = useState(false)
  const [current, setCurrent] = useState('')
  const [collection, setCollection] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [groups, setGroups] = useState({ names: [], entries: {} })
  const [countText, setCountText] = useState('正在读取…')
  const [emptyReason, setEmptyReason] = useState(null) // null | 'read-failed' | 'unsupported'
  const [emptyError, setEmptyError] = useState('')
  const [capPaste, setCapPaste] = useState(true)
  const [capReason, setCapReason] = useState('')
  const [capPermissionRequired, setCapPermissionRequired] = useState(false)
  const [density, setDensity] = useState('comfortable')
  const [mode, setMode] = useState('shell')
  const [detail, setDetail] = useState({ kind: 'empty', text: '选择一条记录，查看完整内容' })
  const [snippets, setSnippets] = useState([])
  const [toolsOpen, setToolsOpen] = useState(false)
  const [snipDialog, setSnipDialog] = useState(null) // { title, name, body, error }
  const [settingsDraft, setSettingsDraft] = useState({ excluded: '', collections: '' })
  const [confirmState, setConfirmState] = useState(null) // { title, text, action }
  const [monitoring, setMonitoring] = useState(true)

  // A host without the background bridge can never serve history; show the reason instead of a bare toast.
  const historySupported = api.clipboard.history.supported !== false
  const historyUnavailableReason = api.clipboard.history.unavailableReason || ''

  const stateRef = useRef({})
  stateRef.current = { items, total, hasCursor, current, query, type, collection, selected, groups, mode, monitoring, snippets }

  const cursorRef = useRef(null)
  const requestId = useRef(0)
  const detailRevision = useRef(0)
  const queryTimer = useRef(0)
  const touched = useRef(false)
  const images = useRef(new Map())
  const pendingImages = useRef(new Map())
  const observer = useRef(null)
  const confirmAction = useRef(null)
  const unsupportedNotified = useRef(false)

  const run = useCallback(async (task) => {
    try {
      return await task()
    } catch (error) {
      kitRef.current?.toast(error?.message || String(error), 'error')
    }
  }, [])

  const label = (item) => TYPE_LABEL[item.type] || '内容'

  const imageData = useCallback(
    (id) => {
      if (images.current.has(id)) return Promise.resolve(images.current.get(id))
      if (pendingImages.current.has(id)) return pendingImages.current.get(id)
      const work = api.clipboard.history
        .get(id)
        .then((value) => {
          const url = value?.dataUrl
          if (url) {
            images.current.set(id, url)
            while (images.current.size > 16 || [...images.current.values()].reduce((sum, value) => sum + value.length, 0) > 16 * 1024 * 1024) {
              images.current.delete(images.current.keys().next().value)
            }
          }
          return url
        })
        .finally(() => pendingImages.current.delete(id))
      pendingImages.current.set(id, work)
      return work
    },
    [api],
  )

  const selectedText = () => {
    const item = stateRef.current.items.find((i) => i.id === stateRef.current.current)
    return item && item.type === 'text' ? item.text || item.preview || '' : ''
  }

  const saveView = () =>
    run(() => kitRef.current.save('clipboard.view.v2', { query: stateRef.current.query, type: stateRef.current.type, current: stateRef.current.current, collection: stateRef.current.collection, scroll: listRef.current?.scrollTop ?? 0 }))

  const copy = useCallback(
    (id = stateRef.current.current, options) =>
      run(async () => {
        if (!id) return
        await api.clipboard.history.copy(id, options)
        kitRef.current?.toast('已复制', 'success')
      }),
    [api, run],
  )

  /** 提交即走：quick 小窗内回车选中后收起小窗（回贴成功由宿主收起；旧宿主无此能力时跳过） */
  const dismissQuick = () => {
    if (stateRef.current.mode === 'quick' && typeof api?.ui?.dismissQuick === 'function') api.ui.dismissQuick().catch(() => {})
  }
  const primary = useCallback(async () => {
    const id = stateRef.current.current
    if (!id) return
    if (kitRef.current.settings.defaultAction === 'copy') {
      await copy()
      return dismissQuick()
    }
    const result = await api.clipboard.history.paste(id)
    if (!result.pasted) kitRef.current?.toast(`已复制，请手动粘贴${result.reason ? ` · ${result.reason}` : ''}`)
  }, [api, copy])

  const batchCopy = useCallback(async () => {
    const { items: its, selected: sel, mode: m } = stateRef.current
    const list = m === 'shell' && sel.size ? its.filter((item) => sel.has(item.id)) : []
    if (!list.length) return copy()
    if (list.some((item) => item.type === 'image')) throw new Error('图片不能合并为文本，请单独复制图片')
    await kitRef.current.copy(list.map((item) => (item.type === 'files' ? item.files.map((file) => file.path).join('\n') : item.text || item.preview)).join('\n\n'))
  }, [copy])

  const search = useCallback(
    (value) => {
      touched.current = true
      setQuery(value)
      if (searchRef.current) searchRef.current.value = value
      clearTimeout(queryTimer.current)
      queryTimer.current = setTimeout(() => {
        void refreshRef.current()
        void saveView()
      }, 120)
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )

  /** 列表刷新（等价原 refresh：requestId 竞态保护 + 分类收集 + 追加去重） */
  const refresh = useCallback(
    async (append = false) => {
      const s = stateRef.current
      const revision = ++requestId.current
      try {
        const kindOf = ['text', 'image', 'files'].includes(s.type) ? s.type : undefined
        let result = await api.clipboard.history.query({ query: s.query, type: kindOf, pinned: s.type === 'pinned', cursor: append ? s.cursor : 0, limit: 60 })
        if (s.collection) {
          const gathered = [...result.items]
          while (result.nextCursor !== null && revision === requestId.current) {
            result = await api.clipboard.history.query({ query: s.query, type: kindOf, pinned: s.type === 'pinned', cursor: result.nextCursor, limit: 100 })
            gathered.push(...result.items)
          }
          result = { items: gathered.filter((item) => s.groups.entries[item.id] === s.collection), total: 0, nextCursor: null }
          result.total = result.items.length
        }
        if (revision !== requestId.current) return
        const merged = append ? [...s.items, ...result.items.filter((item) => !s.items.some((old) => old.id === item.id))] : result.items
        setItems(merged)
        setTotal(result.total)
        setHasCursor(result.nextCursor !== null)
        const cur = merged.some((item) => item.id === s.current) ? s.current : merged[0]?.id || ''
        setCurrent(cur)
        setSelected((prev) => {
          const ids = new Set(merged.map((i) => i.id))
          return new Set([...prev].filter((id) => ids.has(id)))
        })
        setCountText(`${result.total} 条记录${kitRef.current?.settings.monitoring ? '' : ' · 已暂停监控'}`)
        setMonitoring(!!kitRef.current?.settings.monitoring)
        setEmptyReason(null)
        setEmptyError('')
      } catch (error) {
        if (revision === requestId.current) {
          const message = error?.message || String(error)
          setCountText(historySupported ? '读取失败' : '历史不可用')
          // Capability gaps get a persistent empty state with an action; real read failures stay a retry.
          setEmptyReason(historySupported ? 'read-failed' : 'unsupported')
          setEmptyError(message)
          // The empty state already explains a missing backend; toast that case once, not on every refresh.
          if (historySupported) kitRef.current?.toast(`读取历史失败：${message}`, 'error')
          else if (!unsupportedNotified.current) { unsupportedNotified.current = true; kitRef.current?.toast(`读取历史失败：${message}`, 'error') }
        }
      }
    },
    [api, historySupported],
  )
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const choose = useCallback(
    (id, scroll = false) => {
      setCurrent(id)
      if (scroll) requestAnimationFrame(() => document.getElementById(`entry-${CSS.escape(id)}`)?.scrollIntoView({ block: 'nearest' }))
      void saveView()
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const move = useCallback(
    (delta) => {
      const s = stateRef.current
      if (!s.items.length) return
      const index = s.items.findIndex((item) => item.id === s.current)
      choose(s.items[Math.max(0, Math.min(s.items.length - 1, index + delta))].id, true)
      if (index + delta >= s.items.length && s.hasCursor) void refresh(true)
    },
    [choose, refresh],
  )

  const capabilities = useCallback(async () => {
    const value = await api.clipboard.capabilities()
    setCapPaste(value.paste)
    setCapReason(value.paste ? '' : value.reason || '回贴需要系统辅助功能授权，复制始终可用')
    setCapPermissionRequired(!value.paste && !!value.permissionRequired)
  }, [api])

  const applyTransform = (text, kind) => {
    switch (kind) {
      case 'json': return tk.formatJson(text)
      case 'json-min': return tk.formatJson(text, { minify: true })
      case 'unique': return tk.uniqueLines(text)
      case 'sort': return tk.sortLines(text, 'asc')
      case 'strip': return tk.stripFormatting(text)
      case 'upper': return tk.changeCase(text, 'upper')
      case 'lower': return tk.changeCase(text, 'lower')
      case 'camel': return tk.changeCase(text, 'camel')
      case 'snake': return tk.changeCase(text, 'snake')
      case 'kebab': return tk.changeCase(text, 'kebab')
      default: throw new Error('未知变换')
    }
  }
  const transformAndWrite = (kind) =>
    run(async () => {
      const text = selectedText()
      if (!text) return kitRef.current?.toast('先在历史中选择一条文本记录', 'warn')
      const out = applyTransform(text, kind)
      await api.clipboard.writeText(out)
      kitRef.current?.toast('已变换并写回剪贴板', 'success')
    })
  const applyRegex = (pattern, replacement) =>
    run(async () => {
      const text = selectedText()
      if (!text) return kitRef.current?.toast('先在历史中选择一条文本记录', 'warn')
      const out = tk.regexReplace(text, pattern, replacement)
      await api.clipboard.writeText(out)
      kitRef.current?.toast('已替换并写回剪贴板', 'success')
    })

  // —— 暂存片段 ——
  const saveSnippets = (next) => {
    setSnippets(next)
    return kitRef.current.save(SNIPPET_KEY, next).catch(() => {})
  }
  const saveCurrentSelection = () =>
    run(async () => {
      const text = selectedText()
      if (!text || !text.trim()) return kitRef.current?.toast('先在历史中选择一条文本记录', 'warn')
      const next = [tk.normalizeSnippet({ body: text }), ...stateRef.current.snippets].slice(0, SNIPPET_MAX)
      await saveSnippets(next)
      kitRef.current?.toast('已存入暂存片段', 'success')
    })
  const openSnippetDialog = (snippet) => {
    setSnipDialog({
      title: snippet ? '编辑片段' : '新建片段',
      name: snippet?.title || '',
      body: snippet?.body || '',
      error: '',
      editingId: snippet?.id ?? null,
    })
    requestAnimationFrame(() => document.getElementById('snippet-body')?.focus())
  }
  const submitSnippet = (event) => {
    event.preventDefault()
    const nameEl = document.getElementById('snippet-name')
    const bodyEl = document.getElementById('snippet-body')
    try {
      const normalized = tk.normalizeSnippet({ ...(snipDialog?.editingId ? { id: snipDialog.editingId } : {}), title: nameEl.value, body: bodyEl.value })
      const next = snipDialog?.editingId
        ? stateRef.current.snippets.map((s) => (s.id === snipDialog.editingId ? normalized : s))
        : [normalized, ...stateRef.current.snippets].slice(0, SNIPPET_MAX)
      setSnipDialog(null)
      void saveSnippets(next)
    } catch (err) {
      setSnipDialog((prev) => ({ ...prev, error: err.message }))
    }
  }

  // —— 图片懒加载 IntersectionObserver（等价原 observer） ——
  useEffect(() => {
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.dataset.visible = String(entry.isIntersecting)
          if (entry.isIntersecting) {
            void run(async () => {
              const value = await imageData(entry.target.dataset.image)
              if (value && entry.target.isConnected && entry.target.dataset.visible === 'true') entry.target.src = value
            })
          } else entry.target.removeAttribute('src')
        }
      },
      { root: listRef.current, rootMargin: '80px' },
    )
    return () => observer.current?.disconnect()
  }, [imageData, run])
  // 列表渲染后挂载观察
  useEffect(() => {
    const obs = observer.current
    if (!obs) return
    for (const img of listRef.current?.querySelectorAll('[data-image]') || []) obs.observe(img)
  }, [items, emptyReason])

  /** 详情渲染（等价原 renderDetail：含图片异步加载与 revision 竞态保护） */
  useEffect(() => {
    const revision = ++detailRevision.current
    const item = items.find((i) => i.id === current)
    if (!item) {
      setDetail({ kind: 'empty', text: '选择一条记录，查看完整内容' })
      return
    }
    const header = { label: label(item), time: esc(new Date(item.ts).toLocaleString()), size: size(item.bytes) }
    setDetail({ kind: 'loading', header, item })
    let cancelled = false
    ;(async () => {
      if (item.type === 'image') {
        if (mode === 'shell') {
          const data = await run(() => imageData(item.id))
          if (cancelled || revision !== detailRevision.current) return
          setDetail({ kind: 'image', header, item, data })
        } else {
          if (revision !== detailRevision.current) return
          setDetail({ kind: 'image', header, item, data: null })
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, items, mode])

  // —— 管理对话框打开 ——
  const openManager = () => {
    const kit = kitRef.current
    setSettingsDraft({ excluded: kit.settings.excludedApps, collections: stateRef.current.groups.names.join('\n') })
    document.getElementById('manager').showModal()
  }
  const saveManagement = () =>
    run(async () => {
      const kit = kitRef.current
      const excluded = document.getElementById('excluded').value
      await api.settings.set('excludedApps', excluded)
      kit.settings.excludedApps = excluded
      const names = [...new Set(document.getElementById('collections').value.split('\n').map((v) => v.trim()).filter(Boolean))].slice(0, 30)
      const next = { ...stateRef.current.groups, names }
      setGroups(next)
      await kit.save('clipboard.groups.v2', next)
      if (!names.includes(stateRef.current.collection)) setCollection('')
      document.getElementById('manager').close()
      await refreshRef.current()
      kit.toast('管理设置已保存')
    })

  // —— 删除确认 ——
  const confirmDialog = (title, text, action) => {
    setConfirmState({ title, text })
    confirmAction.current = action
    document.getElementById('confirm').showModal()
  }
  const removeCurrent = () => {
    const s = stateRef.current
    const ids = s.mode === 'shell' && s.selected.size ? [...s.selected] : [s.current].filter(Boolean)
    confirmDialog('删除历史记录', `确定删除 ${ids.length} 条记录？文件原件不会被删除。`, async () => {
      for (const id of ids) await api.clipboard.history.remove(id)
      setSelected(new Set())
      await refreshRef.current()
      kitRef.current?.toast('已删除记录')
    })
  }
  const removeItem = (id) => {
    if (!id) return
    confirmDialog('删除历史记录', '确定删除这条记录？文件原件不会被删除。', async () => {
      await api.clipboard.history.remove(id)
      setSelected((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await refreshRef.current()
      kitRef.current?.toast('已删除记录')
    })
  }
  const togglePinItem = (id) =>
    run(async () => {
      if (!id) return
      await api.clipboard.history.togglePin(id)
      await refreshRef.current()
    })
  const copyPaths = (id) => run(() => copy(id, { paths: true }))
  const revealFile = (id, index) => run(() => api.clipboard.history.reveal(id, Number(index)))

  const itemMenu = (item, event) => {
    event.preventDefault()
    const firstFile = item.type === 'files' ? (item.files || []).findIndex((file) => file.exists !== false) : -1
    PluginKit.openMenu(
      event,
      [
        ['copy', item.type === 'files' ? '复制文件' : '复制内容'],
        item.type === 'files' ? ['paths', '复制路径'] : null,
        item.type === 'files' ? ['reveal', '在文件夹中定位', { disabled: firstFile < 0 }] : null,
        { sep: true },
        ['pin', item.pinned ? '取消收藏' : '收藏'],
        ['delete', '删除', { danger: true }],
      ].filter(Boolean),
      (key) => {
        if (key === 'copy') void run(() => copy(item.id))
        if (key === 'paths') copyPaths(item.id)
        if (key === 'reveal') revealFile(item.id, firstFile)
        if (key === 'pin') togglePinItem(item.id)
        if (key === 'delete') removeItem(item.id)
      },
      { align: 'end' },
    )
  }

  // —— quick Tab 轮换分类 ——
  const cycleType = (delta) => {
    const order = ['all', 'text', 'image', 'files', 'pinned']
    const index = order.indexOf(stateRef.current.type)
    setType(order[(index + delta + order.length) % order.length])
    setSelected(new Set())
    void refreshRef.current()
    void saveView()
  }

  useEffect(() => {
    const kit = PluginKit.create({
      title: '剪贴板',
      height: 490,
      quickPlaceholder: '搜索剪贴板内容、文件或来源…',
      defaults: { monitoring: true, historyLimit: 200, retentionDays: 0, recordSource: true, defaultAction: 'paste', density: 'comfortable', excludedApps: '' },
      onQuery: (value) => search(value),
      onAction: (action) => {
        if (action === 'next') moveRef.current(1)
        if (action === 'previous') moveRef.current(-1)
        if (action === 'submit') void run(() => primaryRef.current())
      },
    })
    kitRef.current = kit
    setMode(kit.mode)
    kit.onSettings((_settings, changedKey) => {
      setDensity(kit.settings.density)
      setMonitoring(kit.settings.monitoring)
      setCountText(`${stateRef.current.total} 条记录${kit.settings.monitoring ? '' : ' · 已暂停监控'}`)
      if (['historyLimit', 'retentionDays'].includes(changedKey)) void run(() => api.clipboard.history.preferencesChanged())
    })
    kit.onMode(() => setMode(kit.mode))

    const release = api?.clipboard?.history?.onChange?.(() => void refreshRef.current())
    api?.onDestroy?.(() => {
      release?.()
      observer.current?.disconnect()
      clearTimeout(queryTimer.current)
      images.current.clear()
    })
    api?.onEnter?.(async (event) => {
      await initialized.current
      if (event.code === 'manage') openManager()
      if (typeof event.payload?.historyId === 'string') {
        const entry = await api.clipboard.history.get(event.payload.historyId)
        if (entry) {
          setQuery(''); setType('all'); setCollection('')
          setItems(previous => [entry, ...previous.filter(value => value.id !== entry.id)])
          setCurrent(entry.id)
          if (searchRef.current) searchRef.current.value = ''
          kit.setQuery('')
          return
        }
      }
      void refreshRef.current()
      void run(capabilities)
    })
    api?.onBeforeClose?.(async () => {
      await initialized.current
      clearTimeout(queryTimer.current)
      await saveView()
    })

    document.addEventListener('keydown', keyHandler)
    let alive = true
    initialized.current = run(async () => {
      await kit.ready
      if (!alive) return
      const loadedGroups = await kit.load('clipboard.groups.v2', { names: [], entries: {} })
      const view = await kit.load('clipboard.view.v2', {})
      if (!alive) return
      let q = '', t = 'all', c = '', col = ''
      if (!touched.current) {
        q = view.query || ''
        t = view.type || 'all'
        c = view.current || ''
        col = view.collection || ''
        setQuery(q)
        setType(t)
        setCurrent(c)
        setCollection(col)
      }
      setGroups(loadedGroups && typeof loadedGroups === 'object' ? loadedGroups : { names: [], entries: {} })
      if (searchRef.current) searchRef.current.value = q
      kit.setQuery(q)
      setDensity(kit.settings.density)
      await refreshRef.current()
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = view.scroll || 0
      })
      await capabilities()
    })
    return () => {
      alive = false
      release?.()
      observer.current?.disconnect()
      clearTimeout(queryTimer.current)
      images.current.clear()
      document.removeEventListener('keydown', keyHandler)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const moveRef = useRef(move)
  moveRef.current = move
  const primaryRef = useRef(primary)
  primaryRef.current = primary
  const initialized = useRef(Promise.resolve())

  const keyHandler = (event) => {
    if (event.isComposing || event.defaultPrevented || document.querySelector('dialog[open]')) return
    if (stateRef.current.mode === 'quick' && event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      cycleType(event.shiftKey ? -1 : 1)
      return
    }
    if (event.target.closest('input,textarea,select,button,a,[role="menu"],[role="menuitem"],[role="menuitemcheckbox"],.pk-menu,dialog')) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveRef.current(event.key === 'ArrowDown' ? 1 : -1)
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void run(primaryRef.current)
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      void run(batchCopyRef.current)
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      removeCurrentRef.current()
    }
  }
  const batchCopyRef = useRef(batchCopy)
  batchCopyRef.current = batchCopy
  const removeCurrentRef = useRef(removeCurrent)
  removeCurrentRef.current = removeCurrent

  const many = mode === 'shell' && selected.size > 0
  const currentItem = items.find((item) => item.id === current)
  const selectedLabel = many ? `已选 ${selected.size} 条` : currentItem ? `${label(currentItem)} · ${age(currentItem.ts)}` : '请选择记录'
  const buttonsDisabled = !currentItem && !many
  const pasteDisabled = !currentItem || many
  const pinDisabled = !currentItem || many
  const pinText = currentItem?.pinned ? '取消收藏' : '收藏'
  const copyText = many ? '合并复制' : '复制'
  // 与原版一致：按钮内 HTML 恒为「{动作} <kbd>↵</kbd>」，动作名由 defaultAction 决定
  const pasteAction = kitRef.current?.settings.defaultAction === 'copy' ? '复制' : '回贴'

  return (
    <main className="app" data-density={density}>
      <header className="shell-only">
        <div>
          <h1>剪贴板</h1>
          <span className="muted">留住刚刚复制的内容</span>
        </div>
        <input
          id="search"
          ref={searchRef}
          type="search"
          placeholder="搜索内容、文件或来源应用"
          aria-label="搜索历史"
          onInput={(e) => {
            kitRef.current?.setQuery(e.target.value)
            search(e.target.value)
          }}
        />
        <button data-open-settings className="pk-btn pk-btn-ghost">偏好设置</button>
      </header>
      <nav className="filters" aria-label="历史分类">
        <div id="types">
          {[['all', '全部'], ['text', '文本'], ['image', '图片'], ['files', '文件'], ['pinned', '收藏']].map(([id, text]) => (
            <button
              key={id}
              data-type={id}
              className={type === id ? 'active' : ''}
              onClick={() => {
                setType(id)
                setSelected(new Set())
                void refresh()
                void saveView()
              }}
            >
              {text}
            </button>
          ))}
        </div>
        <span className="grow"></span>
        <button
          id="open-tools"
          className="pk-btn pk-btn-ghost tool-toggle"
          aria-expanded={toolsOpen}
          aria-controls="tools-panel"
          onClick={() => setToolsOpen((v) => !v)}
        >
          {toolsOpen ? '收起工具' : '工具'}
        </button>
        <button id="manage" className="pk-btn" aria-label="管理剪贴板" onClick={openManager}>管理</button>
      </nav>
      <section id="tools-panel" className="tools" hidden={!toolsOpen} aria-label="文本工具与暂存片段">
        <div className="tools-block">
          <div className="tools-label">变换当前选中的文本</div>
          <div className="tools-grid">
            {XFMT_BUTTONS.map((kind) => (
              <button key={kind} className="pk-btn pk-btn-sm" data-xfmt={kind} onClick={() => transformAndWrite(kind)}>{XFMT_LABELS[kind]}</button>
            ))}
          </div>
          <details className="tools-advanced">
            <summary>正则替换</summary>
            <div className="regex-row">
              <input id="regex-pattern" placeholder="正则，例如 \d+" aria-label="正则表达式" spellCheck="false" />
              <input id="regex-replacement" placeholder="替换为（可用 $1）" aria-label="替换文本" spellCheck="false" />
              <button
                id="regex-apply"
                className="pk-btn pk-btn-sm"
                onClick={() =>
                  applyRegex(document.getElementById('regex-pattern').value, document.getElementById('regex-replacement').value)
                }
              >
                应用并复制
              </button>
            </div>
          </details>
        </div>
        <div className="tools-block">
          <div className="tools-label">
            暂存片段 <span className="muted">（临时，本地保存，最多 20 条）</span>
          </div>
          <div className="snippet-row">
            <button id="snippet-save" className="pk-btn pk-btn-sm" title="把当前选中的文本存为暂存片段" onClick={saveCurrentSelection}>存入选中</button>
            <button id="snippet-new" className="pk-btn pk-btn-sm" title="新建空白片段" onClick={() => openSnippetDialog(null)}>新建</button>
          </div>
          <div id="snippets" className="snippets">
            {snippets.length ? (
              snippets.map((s) => (
                <div className="snippet" data-snippet={esc(s.id)} key={s.id}>
                  <button
                    className="snippet-copy pk-btn pk-btn-sm"
                    data-snippet-copy
                    title="复制此片段"
                    onClick={() => void api.clipboard.writeText(s.body).then(() => kitRef.current?.toast('已复制片段', 'success')).catch((err) => kitRef.current?.toast(err.message, 'error'))}
                  >
                    <b>{esc(s.title)}</b>
                    <small>{esc(s.body.split(/\r?\n/)[0].slice(0, 60))}</small>
                  </button>
                  <span className="snippet-tools">
                    <button data-snippet-edit className="pk-btn pk-btn-ghost pk-btn-sm" title="编辑" onClick={() => openSnippetDialog(s)}>编辑</button>
                    <button
                      data-snippet-del
                      className="pk-btn pk-btn-ghost pk-btn-sm"
                      title="删除"
                      onClick={() => {
                        void saveSnippets(snippets.filter((x) => x.id !== s.id))
                        kitRef.current?.toast('已删除片段')
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))
            ) : (
              <p className="muted snippet-empty">暂无片段。选中文本后点「存入选中」，或新建空白片段。</p>
            )}
          </div>
        </div>
      </section>
      <div className="workspace">
        <section className="history">
          <div className="list-info">
            <span id="count" role="status">{countText}</span>
            <select
              id="collection-filter"
              className="shell-only"
              aria-label="筛选分类"
              value={groups.names.includes(collection) ? collection : ''}
              onChange={(e) => {
                setCollection(e.target.value)
                setSelected(new Set())
                void refresh()
                void saveView()
              }}
            >
              <option value="">所有分类</option>
              {groups.names.map((name) => (
                <option key={name}>{esc(name)}</option>
              ))}
            </select>
            <button id="refresh" className="pk-btn pk-btn-ghost pk-btn-sm" title="刷新历史" onClick={() => void refresh()}>刷新</button>
          </div>
          <div
            id="list"
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label="剪贴板历史"
            aria-activedescendant={current ? `entry-${current}` : ''}
            onClick={(event) => {
              const row = event.target.closest('[data-id]')
              if (!row) return
              if (event.target.closest('[data-copy]')) return void run(() => copy(row.dataset.id))
              if (event.target.classList.contains('check')) {
                const id = row.dataset.id
                setSelected((prev) => {
                  const n = new Set(prev)
                  event.target.checked ? n.add(id) : n.delete(id)
                  return n
                })
                return
              }
              choose(row.dataset.id)
              listRef.current?.focus()
            }}
            onDoubleClick={() => void run(primary)}
            onScroll={(event) => {
              const el = event.currentTarget
              if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80 && hasCursor) void refresh(true)
            }}
          >
            {items.length ? (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`entry${item.id === current ? ' active' : ''}`}
                  data-id={esc(item.id)}
                  data-row-actions
                  id={`entry-${esc(item.id)}`}
                  role="option"
                  aria-selected={item.id === current}
                  onContextMenu={(e) => itemMenu(item, e)}
                >
                  <input
                    className="check shell-only"
                    type="checkbox"
                    aria-label="选择此记录"
                    defaultChecked={selected.has(item.id)}
                  />
                  {item.type === 'image' ? (
                    <img data-image={esc(item.id)} alt="剪贴板图片缩略图" />
                  ) : (
                    <span className={`kind-mark ${esc(item.type)}`}>{label(item)}</span>
                  )}
                  <div className="summary">
                    <div className="preview">
                      {item.pinned ? <span className="pin-mark">★ </span> : ''}
                      {esc(item.type === 'image' ? `${item.width} × ${item.height} 图片` : item.preview)}
                    </div>
                    <div className="meta">
                      <span>{age(item.ts)}</span>
                      <span className="source" title={esc(item.sourceApp?.id || '')}>
                        {esc(item.sourceApp?.name || '未知来源')}
                      </span>
                      <span className="size">
                        {item.type === 'text'
                          ? `${(item.text || item.preview).length} 字符`
                          : item.type === 'files'
                            ? `${item.files?.length || 0} 个文件`
                            : size(item.bytes)}
                      </span>
                    </div>
                  </div>
                  <div className="pk-row-actions" onClick={(event) => { if (!event.target.closest('[data-copy]')) event.stopPropagation() }} onDoubleClick={(event) => event.stopPropagation()}>
                    <button className="copy-row pk-btn pk-btn-ghost pk-btn-sm" data-copy aria-label="复制此记录">复制</button>
                    <span onClick={(event) => event.stopPropagation()}>
                      <MoreMenu
                        buttonClassName="pk-btn-sm"
                        ariaLabel="更多记录操作"
                        items={[
                          { key: 'pin', label: item.pinned ? '取消收藏' : '收藏', onSelect: () => togglePinItem(item.id) },
                          item.type === 'files' ? { key: 'paths', label: '复制路径', onSelect: () => copyPaths(item.id) } : null,
                          { key: 'delete', label: '删除', danger: true, onSelect: () => removeItem(item.id) },
                        ].filter(Boolean)}
                      />
                    </span>
                  </div>
                </div>
              ))
            ) : emptyReason === 'unsupported' ? (
              <div className="empty empty-blocked">
                <p><b>剪贴板历史暂不可用</b></p>
                <p className="muted">{historyUnavailableReason || '当前 eNest 版本不提供剪贴板历史后台。'}</p>
                <div className="empty-actions">
                  <button className="pk-btn pk-btn-sm" onClick={() => window.location.reload()}>重新加载</button>
                  <button className="pk-btn pk-btn-ghost pk-btn-sm" onClick={() => void api?.ui?.openSettings?.().catch(() => {})}>查看详情</button>
                </div>
              </div>
            ) : emptyReason === 'read-failed' ? (
              <div className="empty empty-blocked">
                <p><b>读取失败</b></p>
                {emptyError ? <p className="muted">{emptyError}</p> : null}
                <div className="empty-actions">
                  <button className="pk-btn pk-btn-sm" onClick={() => void refresh()}>重试</button>
                </div>
              </div>
            ) : (
              <div className="empty"><Fragment>没有匹配的记录<br />复制文本、图片或文件后，会自动出现在这里。</Fragment></div>
            )}
          </div>
          <button id="more" className="pk-btn" hidden={!hasCursor} onClick={() => void refresh(true)}>载入更多</button>
        </section>
        <aside id="detail" className="shell-only" ref={detailRef}>
          {detail.kind === 'empty' ? (
            <div className="empty">{detail.text}</div>
          ) : (
            <>
              <div className="detail-heading">
                <span>{detail.header.label} · {detail.header.time}</span>
                <span>{detail.header.size}</span>
              </div>
              {detail.item.type === 'text' ? (
                <pre className="full-text">{esc(detail.item.text || detail.item.preview)}</pre>
              ) : detail.item.type === 'files' ? (
                <>
                  {(detail.item.files || []).map((file, index) => (
                    <div className={`file${file.exists === false ? ' invalid' : ''}`} key={index} data-row-actions
                      onContextMenu={(event) => {
                        event.preventDefault()
                        PluginKit.openMenu(event, [
                          ['copy-file', '复制文件', { disabled: file.exists === false }],
                          ['copy-path', '复制此文件路径'],
                          ['reveal', '在文件夹中定位', { disabled: file.exists === false }],
                        ], (key) => {
                          if (key === 'copy-file') void run(() => copy(detail.item.id))
                          if (key === 'copy-path') void run(() => api.clipboard.writeText(file.path).then(() => kitRef.current?.toast('已复制路径', 'success')))
                          if (key === 'reveal') void run(() => api.clipboard.history.reveal(detail.item.id, index))
                        }, { align: 'end' })
                      }}>
                      <div>
                        <b>{esc(file.name)}</b>
                        <small>{esc(file.path)}</small>
                        {file.exists === false ? <small>文件已移动或删除</small> : file.exists === null ? <small>尚未授权检查此路径；定位时将确认目标</small> : ''}
                      </div>
                      <div className="pk-row-actions file-actions">
                        <button
                          type="button"
                          className="pk-btn pk-btn-ghost pk-btn-sm"
                          data-reveal={index}
                          disabled={file.exists === false}
                          onClick={(e) => void run(() => api.clipboard.history.reveal(current, Number(e.currentTarget.dataset.reveal)))}
                        >
                          定位
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="detail-actions">
                    <select
                      id="assign-group"
                      aria-label="记录分类"
                      value={groups.entries[current] || ''}
                      onChange={(e) => {
                        const next = { ...groups, entries: { ...groups.entries, [current]: e.target.value } }
                        setGroups(next)
                        void run(() => kitRef.current.save('clipboard.groups.v2', next))
                        if (collection) void refresh()
                      }}
                    >
                      <option value="">未分类</option>
                      {groups.names.map((name) => (
                        <option key={name}>{esc(name)}</option>
                      ))}
                    </select>
                    <button data-detail-copy className="pk-btn pk-btn-ghost" onClick={() => void run(() => copy())}>复制文件</button>
                    <button id="copy-paths" className="pk-btn pk-btn-ghost" onClick={() => void run(() => copy(current, { paths: true }))}>复制路径</button>
                  </div>
                </>
              ) : detail.kind === 'image' ? (
                <>
                  {detail.data ? (
                    <img className="detail-image" alt="完整剪贴板图片" src={detail.data} />
                  ) : (
                    <div className="empty">{mode === 'shell' ? '正在读取原图…' : '原图不可用'}</div>
                  )}
                  <div className="detail-actions">
                    <select
                      id="assign-group"
                      aria-label="记录分类"
                      value={groups.entries[current] || ''}
                      onChange={(e) => {
                        const next = { ...groups, entries: { ...groups.entries, [current]: e.target.value } }
                        setGroups(next)
                        void run(() => kitRef.current.save('clipboard.groups.v2', next))
                        if (collection) void refresh()
                      }}
                    >
                      <option value="">未分类</option>
                      {groups.names.map((name) => (
                        <option key={name}>{esc(name)}</option>
                      ))}
                    </select>
                    <button data-detail-copy className="pk-btn pk-btn-ghost" onClick={() => void run(() => copy())}>复制</button>
                  </div>
                </>
              ) : (
                <div className="empty">正在读取原图…</div>
              )}
            </>
          )}
        </aside>
      </div>
      <footer>
        <div className="selection">
          <span id="selected-label">{selectedLabel}</span>
          <button
            id="select-all"
            className="shell-only"
            onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((item) => item.id)))}
          >
            全选已载入
          </button>
        </div>
        <div className="actions">
          <MoreMenu
            label="更多"
            ariaLabel="记录更多操作"
            buttonClassName="footer-more"
            items={[
              { key: 'pin', label: pinText, disabled: pinDisabled, onSelect: () => void run(async () => {
                await api.clipboard.history.togglePin(current)
                await refresh()
              }) },
              { key: 'delete', label: '删除', danger: true, disabled: buttonsDisabled, onSelect: removeCurrent },
            ]}
          />
          <button id="copy" className="pk-btn" disabled={buttonsDisabled} onClick={() => void run(batchCopy)}>{copyText}</button>
          <button id="paste" className="pk-btn pk-btn-primary" disabled={pasteDisabled} onClick={() => void run(primary)}>
            {pasteAction} <kbd>↵</kbd>
          </button>
        </div>
      </footer>
      <div id="capability" className="capability" hidden={capPaste}>
        <span>{capReason}</span>
        <button
          id="authorize"
          className="pk-btn pk-btn-sm"
          hidden={!capPermissionRequired}
          onClick={() => void run(async () => {
            await api.clipboard.requestPermission()
            await capabilities()
          })}
        >
          开启权限
        </button>
      </div>
      <dialog id="manager">
        <form method="dialog" className="dialog-title">
          <h2>历史管理</h2>
          <button className="pk-btn pk-btn-ghost pk-btn-sm" aria-label="关闭管理">关闭</button>
        </form>
        <label>
          排除来源应用
          <textarea id="excluded" rows={3} placeholder="每行一个应用名称或应用 ID" defaultValue={settingsDraft.excluded}></textarea>
        </label>
        <p className="muted">仅在系统能可靠识别来源时生效。未知来源会明确显示为“未知来源”。</p>
        <label>
          自定义分类
          <textarea id="collections" rows={3} placeholder="每行一个分类，例如工作、资料、常用" defaultValue={settingsDraft.collections}></textarea>
        </label>
        <div className="dialog-actions">
          <button
            id="clear"
            className="pk-btn pk-btn-danger"
            onClick={() =>
              confirmDialog('清理历史', '清理所有未收藏的历史记录，保留收藏和原文件。此操作不可撤销。', async () => {
                await api.clipboard.history.clear()
                await refresh()
                kitRef.current?.toast('历史已清理')
              })
            }
          >
            清理未收藏历史
          </button>
          <button id="save-management" className="pk-btn pk-btn-primary" onClick={saveManagement}>保存管理设置</button>
        </div>
        <button data-open-settings className="pk-btn pk-btn-ghost settings-link">在壳设置中调整监控、容量、保留期限和密度</button>
      </dialog>
      <dialog id="confirm">
        <h2 id="confirm-title">{confirmState?.title ?? '删除记录'}</h2>
        <p id="confirm-text">{confirmState?.text ?? ''}</p>
        <div className="dialog-actions">
          <button id="confirm-cancel" className="pk-btn" onClick={() => document.getElementById('confirm').close()}>取消</button>
          <button
            id="confirm-ok"
            className="pk-btn pk-btn-danger"
            onClick={() => {
              document.getElementById('confirm').close()
              const action = confirmAction.current
              confirmAction.current = null
              void run(action)
            }}
          >
            确认删除
          </button>
        </div>
      </dialog>
      {snipDialog ? (
        <dialog id="snippet-dialog" open>
          <form id="snippet-form" method="dialog" onSubmit={submitSnippet}>
            <h2 id="snippet-title">{snipDialog.title}</h2>
            <label>
              标题
              <input id="snippet-name" maxLength={60} placeholder="可留空，自动取首行" defaultValue={snipDialog.name} />
            </label>
            <label>
              内容
              <textarea id="snippet-body" rows={6} required placeholder="片段内容" defaultValue={snipDialog.body}></textarea>
            </label>
            <p className="form-error" id="snippet-error" hidden={!snipDialog.error}>{snipDialog.error}</p>
            <div className="dialog-actions">
              <button type="button" id="snippet-cancel" className="pk-btn" onClick={() => setSnipDialog(null)}>取消</button>
              <button type="submit" className="pk-btn pk-btn-primary">保存片段</button>
            </div>
          </form>
        </dialog>
      ) : (
        <dialog id="snippet-dialog"></dialog>
      )}
    </main>
  )
}
