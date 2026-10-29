/**
 * 备忘录主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 存储（plugin-kit storage notes_v2 / v1 迁移与备份）逻辑原样复用；
 * Markdown 预览、相对时间、字数统计等纯函数原样搬运。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { PanelView } from './PanelView.jsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MoreMenu,
} from '../ui/index.jsx'

const api = window.enest || window.zapi
const KEY = 'notes_v2'
const colors = ['#cfa467', '#7fa894', '#b78180', '#7b9ebc', '#a592b7']
const uid = () => crypto.randomUUID()

const normalize = (n) => ({
  id: typeof n.id === 'string' ? n.id : uid(),
  title: String(n.title || ''),
  text: String(n.text || ''),
  color: typeof n.color === 'string' && /^#[\da-f]{6}$/i.test(n.color) ? n.color : colors[0],
  pinned: !!n.pinned,
  createdAt: Number(n.createdAt) || Date.now(),
  updatedAt: Number(n.updatedAt) || Date.now(),
  tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
  archived: !!n.archived,
  deletedAt: Number(n.deletedAt) || null,
})

function noteTitle(n) {
  return (
    n.title.trim() ||
    n.text
      .split('\n')
      .find((l) => l.trim())
      ?.replace(/^#+\s*/, '')
      .slice(0, 60) ||
    '未命名笔记'
  )
}

// 相对时间：刚刚 / n 分钟前 / 小时 / 昨天 / 日期
function relTime(ts) {
  const diff = Date.now() - ts
  const min = 60000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 2 * day) return '昨天'
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function wordCount(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const words = text
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  return { chars: text.length, words: cjk + words }
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function markdown(text) {
  let inCode = false
  return (
    text
      .split('\n')
      .map((line) => {
        if (/^```/.test(line)) {
          inCode = !inCode
          return inCode ? '<pre><code>' : '</code></pre>'
        }
        if (inCode) return esc(line) + '\n'
        let html = esc(line)
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
        const m = /^(#{1,3})\s+(.+)/.exec(line)
        if (m) return `<h${m[1].length}>${esc(m[2])}</h${m[1].length}>`
        if (/^[-*] \[[ x]\] /.test(line))
          return '<p>' + (/^[-*] \[x\]/.test(line) ? '☑ ' : '☐ ') + esc(line.slice(6)) + '</p>'
        if (/^[-*] /.test(line)) return '<p>• ' + html.slice(2) + '</p>'
        return '<p>' + (html || '<br>') + '</p>'
      })
      .join('') + (inCode ? '</code></pre>' : '')
  )
}

const emptyArt = (
  <svg viewBox="0 0 96 96" aria-hidden="true">
    <rect x="22" y="16" width="52" height="66" rx="6" fill="none" stroke="var(--line)" strokeWidth="2.5" transform="rotate(-4 48 48)" />
    <rect x="26" y="20" width="52" height="66" rx="6" fill="none" stroke="var(--warm)" strokeWidth="2.5" transform="rotate(3 52 52)" />
    <path d="M38 44h28M38 56h22M38 68h16" stroke="var(--warm)" strokeWidth="2.5" strokeLinecap="round" opacity=".55" />
  </svg>
)
const editorEmptyArt = (
  <>
    <svg viewBox="0 0 96 96" aria-hidden="true">
      <rect x="24" y="14" width="48" height="68" rx="6" fill="none" stroke="var(--line)" strokeWidth="2.5" />
      <path d="M34 32h28M34 44h28M34 56h18" stroke="var(--warm)" strokeWidth="2.5" strokeLinecap="round" opacity=".55" />
      <path d="M62 62l14 14m0-14L62 76" stroke="var(--line)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
    选择一条笔记，或新建开始记录
  </>
)

const TEMPLATES = {
  meeting: ['会议记录', '# 议题\n\n## 讨论\n\n## 决定\n\n## 待办\n- [ ] '],
  checklist: ['行动清单', '- [ ] 第一件事\n- [ ] 第二件事\n'],
  idea: ['想法草稿', '## 想解决什么\n\n## 可行的办法\n\n## 下一步\n'],
}

export function App() {
  const kitRef = useRef(null)
  const [notes, setNotes] = useState([])
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [tag, setTag] = useState('')
  const [color, setColor] = useState('')
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [preview, setPreview] = useState(false)
  const [layout, setLayout] = useState('list')
  const [editorOpen, setEditorOpen] = useState(false)
  const [quickText, setQuickText] = useState('')
  const [undo, setUndo] = useState(null)
  const [saveState, setSaveState] = useState('已保存')
  const [noteVersion, setNoteVersion] = useState(0) // 触发列表相对时间刷新
  const [colorMenuOpen, setColorMenuOpen] = useState(false)
  const [mode, setMode] = useState(() => api?.getLaunchMode?.() || 'shell')
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 580px)').matches)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [libraryPinned, setLibraryPinned] = useState(false)
  const [libraryPeek, setLibraryPeek] = useState(false)
  const libraryRef = useRef(null)
  const libraryToggleRef = useRef(null)
  const libraryBindingRef = useRef(null)
  const compact = mode === 'quick' || narrow
  const libraryCollapsed = compact ? editorOpen && !libraryPinned : sidebarCollapsed

  useEffect(() => {
    const media = window.matchMedia('(max-width: 580px)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (mode === 'panel') return
    const binding = PluginKit.bindHoverPanel(libraryToggleRef.current, libraryRef.current, {
      enabled: () => libraryCollapsed,
      onOpenChange: setLibraryPeek,
      delay: 120,
      hideDelay: 300,
      handleClick: false,
    })
    libraryBindingRef.current = binding
    return () => { binding.destroy(); libraryBindingRef.current = null }
  }, [libraryCollapsed, mode])

  const notesRef = useRef(notes)
  notesRef.current = notes
  const readyRef = useRef(ready)
  readyRef.current = ready
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const queryRef = useRef(query)
  queryRef.current = query
  const filterRef = useRef(filter)
  filterRef.current = filter
  const tagRef = useRef(tag)
  tagRef.current = tag
  const colorRef = useRef(color)
  colorRef.current = color
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const saveTimerRef = useRef(0)
  const undoRef = useRef(null)
  undoRef.current = undo

  const status = useCallback((text) => setSaveState(text), [])

  const persist = useCallback(async () => {
    if (!readyRef.current) return
    status('保存中…')
    try {
      await kitRef.current.save(KEY, { version: 2, notes: notesRef.current })
      status('已保存')
    } catch (e) {
      status('保存失败 · 点击重试')
      kitRef.current.toast(e.message, 'error')
    }
  }, [status])

  const save = useCallback((immediate = false) => {
    clearTimeout(saveTimerRef.current)
    if (immediate) void persist()
    else saveTimerRef.current = setTimeout(() => void persist(), 300)
  }, [persist])

  const visible = useCallback(() => {
    const f = filterRef.current
    const t = tagRef.current
    const c = colorRef.current
    const q = queryRef.current
    return notesRef.current
      .filter(
        (n) =>
          (f === 'trash' ? !!n.deletedAt : !n.deletedAt) &&
          (f === 'archive' ? n.archived : f === 'trash' ? true : !n.archived) &&
          (f === 'pinned' ? n.pinned : true) &&
          (!t || n.tags.includes(t)) &&
          (!c || n.color === c) &&
          `${n.title} ${n.text} ${n.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()),
      )
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  }, [])

  const countFor = useCallback((key) => {
    const list = notesRef.current
    if (key === 'all') return list.filter((n) => !n.deletedAt && !n.archived).length
    if (key === 'pinned') return list.filter((n) => n.pinned && !n.deletedAt && !n.archived).length
    if (key === 'archive') return list.filter((n) => n.archived && !n.deletedAt).length
    if (key === 'trash') return list.filter((n) => n.deletedAt).length
    return 0
  }, [])

  const colorCount = useCallback(
    (c) => notesRef.current.filter((n) => !n.deletedAt && !n.archived && n.color === c).length,
    [],
  )

  const open = useCallback((id) => {
    selectedRef.current = id
    setSelected(id)
    setPreview(false)
    setLibraryPinned(false)
    setEditorOpen(true)
  }, [])

  const create = useCallback((text = '', titleText = '') => {
    if (!readyRef.current) return
    const n = normalize({ id: uid(), text, title: titleText, color: kitRef.current.settings.defaultColor })
    notesRef.current = [n, ...notesRef.current]
    setNotes(notesRef.current)
    setFilter('all')
    filterRef.current = 'all'
    setTag('')
    tagRef.current = ''
    setColor('')
    colorRef.current = ''
    setQuery('')
    queryRef.current = ''
    const search = document.getElementById('search')
    if (search) search.value = ''
    kitRef.current.setQuery('')
    save(true)
    open(n.id)
    requestAnimationFrame(() => document.getElementById('body')?.focus())
  }, [open, save])

  const mutateNote = useCallback((id, mutator, { immediate = false } = {}) => {
    notesRef.current = notesRef.current.map((n) => {
      if (n.id !== id) return n
      const next = { ...n }
      mutator(next)
      next.updatedAt = Date.now()
      return next
    })
    setNotes(notesRef.current)
    setNoteVersion((v) => v + 1)
    save(immediate)
  }, [save])

  const mutateCurrent = useCallback((mutator, opts) => {
    mutateNote(selectedRef.current, mutator, opts)
  }, [mutateNote])

  // —— 列表派生 ——//
  const rows = visible()
  if (!selected && rows.length && ready) {
    selectedRef.current = rows[0].id
  }
  const grid = layout === 'grid' && kitRef.current?.mode === 'shell'
  const tags = [...new Set(notes.flatMap((n) => n.tags))]
  const current = notes.find((n) => n.id === selected)
  const wc = current ? wordCount(current.text) : null

  // —— 操作 ——//
  const toggleFilter = (key) => {
    filterRef.current = key
    setFilter(key)
  }
  const toggleColorFilter = (c) => {
    const next = colorRef.current === c ? '' : c
    colorRef.current = next
    setColor(next)
  }
  const onSearchInput = (e) => {
    queryRef.current = e.target.value
    setQuery(e.target.value)
    kitRef.current?.setQuery(e.target.value)
  }
  const toggleLayout = () => {
    layoutRef.current = layoutRef.current === 'list' ? 'grid' : 'list'
    setLayout(layoutRef.current)
  }
  const toggleLibrary = () => {
    libraryBindingRef.current?.hide()
    if (compact) setLibraryPinned(libraryCollapsed)
    else {
      const next = !sidebarCollapsed
      setSidebarCollapsed(next)
      void kitRef.current?.save('notes.view.v1', { sidebarCollapsed: next }).catch((e) => kitRef.current?.toast(e.message, 'error'))
    }
  }
  const togglePin = () => mutateCurrent((n) => { n.pinned = !n.pinned }, { immediate: true })
  const toggleArchive = () => mutateCurrent((n) => { n.archived = !n.archived }, { immediate: true })
  const toggleTrash = (id) => {
    const n = notesRef.current.find((x) => x.id === id)
    if (!n) return
    undoRef.current = structuredClone(n)
    setUndo(structuredClone(n))
    mutateNote(id, (draft) => { draft.deletedAt = draft.deletedAt ? null : Date.now() }, { immediate: true })
    kitRef.current.toast(n.deletedAt ? '已恢复笔记' : '已移入回收站')
  }
  const toggleDelete = () => toggleTrash(selectedRef.current)
  const undoDelete = () => {
    const u = undoRef.current
    if (!u) return
    const list = notesRef.current.slice()
    const i = list.findIndex((x) => x.id === u.id)
    if (i >= 0) list[i] = u
    else list.push(u)
    notesRef.current = list
    setNotes(list)
    undoRef.current = null
    setUndo(null)
    save(true)
  }
  const purgeNote = (id = selectedRef.current) => {
    if (!confirm('永久删除这条笔记？此操作不能撤销。')) return
    notesRef.current = notesRef.current.filter((x) => x.id !== id)
    setNotes(notesRef.current)
    if (selectedRef.current === id) {
      selectedRef.current = ''
      setSelected('')
    }
    undoRef.current = null
    setUndo(null)
    save(true)
  }

  const archiveNote = (id) => {
    const n = notesRef.current.find((x) => x.id === id)
    if (!n) return
    mutateNote(id, (draft) => { draft.archived = !draft.archived }, { immediate: true })
    kitRef.current.toast(n.archived ? '已取消归档' : '已归档')
  }

  const copyNote = (id) => {
    const n = notesRef.current.find((x) => x.id === id)
    if (!n) return
    kitRef.current
      .copy((n.title ? n.title + '\n\n' : '') + n.text)
      .catch((e) => kitRef.current.toast(e.message, 'error'))
  }

  // —— 宿主适配器 + 启动（latest-ref 桥接，等价原初始化段）——//
  useEffect(() => {
    const kit = PluginKit.create({
      title: '备忘录',
      quickPlaceholder: '搜索笔记与标签',
      height: 500,
      defaults: { defaultColor: '#cfa467', defaultLayout: 'list' },
      onQuery: (value) => {
        queryRef.current = value
        setQuery(value)
      },
      onAction: (action) => {
        const f = filterRef.current
        const t = tagRef.current
        const c = colorRef.current
        const q = queryRef.current
        const list = notesRef.current
          .filter(
            (n) =>
              (f === 'trash' ? !!n.deletedAt : !n.deletedAt) &&
              (f === 'archive' ? n.archived : f === 'trash' ? true : !n.archived) &&
              (f === 'pinned' ? n.pinned : true) &&
              (!t || n.tags.includes(t)) &&
              (!c || n.color === c) &&
              `${n.title} ${n.text} ${n.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()),
          )
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
        const i = list.findIndex((n) => n.id === selectedRef.current)
        if (action === 'next' || action === 'previous') {
          const next = list[Math.max(0, Math.min(list.length - 1, i + (action === 'next' ? 1 : -1)))]?.id || ''
          selectedRef.current = next
          setSelected(next)
        }
        if (action === 'submit' && selectedRef.current) open(selectedRef.current)
      },
    })
    kitRef.current = kit
    setMode(kit.mode)
    kit.onMode(() => {
      setMode(kit.mode)
      setLibraryPinned(false)
      if (readyRef.current) setNoteVersion((v) => v + 1)
    })
    kit.onSettings((s) => {
      layoutRef.current = s.defaultLayout === 'grid' ? 'grid' : 'list'
      setLayout(layoutRef.current)
      if (readyRef.current) setNoteVersion((v) => v + 1)
    })
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        void persist()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    let alive = true
    const initialized = (async () => {
      try {
        await kit.ready
        if (!alive) return
        layoutRef.current = kit.settings.defaultLayout === 'grid' ? 'grid' : 'list'
        setLayout(layoutRef.current)
        const view = await kit.load('notes.view.v1', {})
        if (!alive) return
        setSidebarCollapsed(view?.sidebarCollapsed === true)
        const saved = await kit.load(KEY, null)
        if (!alive) return
        if (saved) {
          if (saved.version !== 2 || !Array.isArray(saved.notes)) throw Error('笔记数据格式异常，未覆盖原数据')
          notesRef.current = saved.notes.map(normalize)
        } else {
          const old = await kit.load('notes_v1', [])
          if (!alive) return
          if (!Array.isArray(old)) throw Error('旧笔记数据格式异常')
          await kit.save('notes_v1_backup', old)
          notesRef.current = old.filter((n) => n && typeof n.text === 'string').map(normalize)
          await kit.save(KEY, { version: 2, notes: notesRef.current })
        }
        if (!alive) return
        setNotes(notesRef.current)
        setReady(true)
      } catch (e) {
        if (!alive) return
        setLoadError('读取失败，原数据已保留。请重新打开插件。')
        kit.toast(e.message, 'error')
      }
    })()
    const offEnter = api?.onEnter?.(async ({ payload }) => {
      await initialized
      const text = typeof payload === 'string' ? payload : payload?.type === 'text' ? payload.text : ''
      if (text) {
        const existing = notesRef.current.find((n) => n.text === text && !n.deletedAt)
        if (existing) open(existing.id)
        else create(text)
      }
    })
    const offClose = api?.onBeforeClose?.(async () => {
      await initialized
      clearTimeout(saveTimerRef.current)
      return persist()
    })
    return () => {
      alive = false
      document.removeEventListener('keydown', onKeyDown)
      offEnter?.()
      offClose?.()
      kit.destroy?.()
    }
  }, [create, open, persist])

  // —— 全量导出（等价原 export-md / export-all / import）——//
  const exportMd = () => {
    const live = notesRef.current.filter((n) => !n.deletedAt)
    if (!live.length) return kitRef.current.toast('没有可导出的笔记')
    const doc = live
      .map((n) => {
        const head = '# ' + noteTitle(n)
        const meta = `\n\n> 标签：${n.tags.map((t) => '#' + t).join(' ') || '无'} · 更新于 ${new Date(n.updatedAt).toLocaleString()}\n\n`
        return head + meta + n.text.trim()
      })
      .join('\n\n---\n\n')
    kitRef.current
      .saveText(`备忘录-${new Date().toISOString().slice(0, 10)}.md`, doc + '\n')
      .catch((e) => kitRef.current.toast(e.message, 'error'))
  }
  const exportAll = () =>
    kitRef.current
      .saveText('备忘录备份.json', JSON.stringify({ version: 2, notes: notesRef.current }, null, 2))
      .catch((e) => kitRef.current.toast(e.message, 'error'))
  const importNotes = async () => {
    try {
      const [file] = await api.localFiles.pick({ kind: 'file', access: 'read' })
      if (!file) return
      if (file.size > 10e6) throw Error('导入文件不能超过 10 MB')
      const text = await api.localFiles.read({ handleId: file.id, encoding: 'text', maxBytes: 10000000 })
      if (/\.json$/i.test(file.name)) {
        const data = JSON.parse(text)
        const incoming = Array.isArray(data) ? data : data.notes
        if (!Array.isArray(incoming) || incoming.some((n) => !n || typeof n.text !== 'string')) throw Error('笔记备份格式不正确')
        notesRef.current = [...notesRef.current, ...incoming.map((n) => normalize({ ...n, id: uid() }))]
        setNotes(notesRef.current)
        save(true)
        kitRef.current.toast(`已导入 ${incoming.length} 条笔记`)
      } else create(text, file.name.replace(/\.(md|txt)$/i, ''))
    } catch (e) {
      kitRef.current.toast(e.message, 'error')
    }
  }
  const onTemplateChange = (e) => {
    const t = TEMPLATES[e.target.value]
    if (t) create(t[1], t[0])
    e.target.value = ''
  }
  const onQuickSubmit = (e) => {
    e.preventDefault()
    const text = quickText.trim()
    if (text) {
      create(text)
      setQuickText('')
    }
  }

  const exportNote = (note, ext) => {
    if (!note) return
    const name = noteTitle(note).replace(/[\\/:*?"<>|]/g, '_') + '.' + ext
    const body = ext === 'md'
      ? (note.title ? '# ' + note.title + '\n\n' : '') + note.text
      : (note.title ? note.title + '\n\n' : '') + note.text
    kitRef.current.saveText(name, body).catch((e) => kitRef.current.toast(e.message, 'error'))
  }

  const rowMenu = (note, event) => {
    event.preventDefault()
    const inTrash = !!note.deletedAt
    PluginKit.openMenu(
      event,
      [
        ['copy', '复制内容'],
        ['pin', note.pinned ? '取消置顶' : '置顶'],
        ['archive', note.archived ? '取消归档' : '归档'],
        'sep',
        inTrash ? ['restore', '恢复'] : ['trash', '移入回收站', { danger: true }],
        inTrash ? ['purge', '永久删除', { danger: true }] : null,
      ].filter(Boolean),
      (key) => {
        if (key === 'copy') copyNote(note.id)
        if (key === 'pin') mutateNote(note.id, (n) => { n.pinned = !n.pinned }, { immediate: true })
        if (key === 'archive') archiveNote(note.id)
        if (key === 'trash' || key === 'restore') toggleTrash(note.id)
        if (key === 'purge') purgeNote(note.id)
      },
      { align: 'end' },
    )
  }

  const noteMenu = current
    ? [
        { key: 'export-md', label: '导出 .md', onSelect: () => exportNote(current, 'md') },
        { key: 'export-txt', label: '导出 .txt', onSelect: () => exportNote(current, 'txt') },
        { sep: true },
        { key: 'archive', label: current.archived ? '取消归档' : '归档', onSelect: toggleArchive },
        { key: 'delete', label: current.deletedAt ? '恢复笔记' : '移入回收站', danger: !current.deletedAt, onSelect: toggleDelete },
        ...(current.deletedAt ? [{ key: 'purge', label: '永久删除', danger: true, onSelect: () => purgeNote() }] : []),
      ]
    : []

  if (mode === 'panel') {
    const live = notes.filter(note => !note.deletedAt && !note.archived)
    const note = live.find(note => note.id === selected)
      || [...live].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)[0]
    return <PanelView note={note} title={note ? noteTitle(note) : ''} count={live.length} ready={ready} error={loadError}
      onCopy={() => copyNote(note.id)}
      onOpen={() => {
        if (note) open(note.id)
        void api.ui.openInShell().catch(error => kitRef.current?.toast(error.message, 'error'))
      }} />
  }

  return (
    <div className={`app${grid ? ' grid-layout' : ''}${libraryCollapsed ? ' sidebar-collapsed' : ''}`} id="app"
      data-compact={compact ? 'true' : 'false'} data-library-pinned={libraryPinned ? 'true' : 'false'}>
      <button ref={libraryToggleRef} type="button" className="pk-btn pk-btn-ghost pk-btn-sm library-toggle" hidden={compact && !editorOpen}
        aria-label={libraryCollapsed ? '展开笔记列表' : '收起笔记列表'} aria-controls="note-library"
        aria-expanded={!libraryCollapsed || libraryPeek} title={libraryCollapsed ? '展开笔记列表' : '收起笔记列表'}
        onClick={toggleLibrary}>☰</button>
      <section className="library" id="note-library" ref={libraryRef} aria-label="笔记导航">
        <header>
          <div>
            <h1>备忘录</h1>
            <div className="small shell-only">留住想法，再慢慢整理</div>
          </div>
          <span></span><button className="pk-btn new" id="new" onClick={() => create()}>＋ 新建</button>
        </header>
        <div className="search-wrap shell-only">
          <input id="search" type="search" placeholder="搜索笔记、标签" aria-label="搜索笔记" onInput={onSearchInput} />
        </div>
        <form className="quick-composer quick-only" id="quick-form" onSubmit={onQuickSubmit}>
          <input id="quick-input" placeholder="记下一句话…" aria-label="快速记录" value={quickText}
            onChange={(e) => setQuickText(e.target.value)} />
          <button className="pk-btn new">记录</button>
        </form>
        <div className="tabs" id="tabs">
          {loadError ? null : Object.entries({ all: '全部', pinned: '置顶', archive: '归档', trash: '回收站' }).map(([key, label]) => (
            <button key={key} data-filter={key} className={filter === key ? 'active' : ''} onClick={() => toggleFilter(key)}>
              {label}{countFor(key) ? <span className="t-count">{countFor(key)}</span> : ''}
            </button>
          ))}
        </div>
        <div className="color-filter shell-only" id="color-filter">
          {loadError ? null : (
          <button className={`all-dot ${color === '' ? 'chosen' : ''}`} data-color="" aria-label="全部颜色" title="全部颜色"
            onClick={() => toggleColorFilter('')}>全</button>)}
          {loadError ? null : colors.map((c) => (
            <button key={c} className={`dot ${color === c ? 'chosen' : ''}`} data-color={c} style={{ '--swatch': c }}
              aria-label={`筛选颜色 ${c}`} onClick={() => toggleColorFilter(c)}>
              {colorCount(c) ? <span className="c-count">{colorCount(c)}</span> : ''}
            </button>
          ))}
        </div>
        <div className="library-tools shell-only">
          <select id="tag-filter" aria-label="标签筛选" value={tag} onChange={(e) => { tagRef.current = e.target.value; setTag(e.target.value) }}>
            <option value="">全部标签</option>
            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button id="layout" className="pk-btn" onClick={toggleLayout}>{grid ? '列表视图' : '卡片视图'}</button>
          <select id="template" aria-label="新建模板" onChange={onTemplateChange}>
            <option value="">从模板新建</option>
            <option value="meeting">会议记录</option>
            <option value="checklist">行动清单</option>
            <option value="idea">想法草稿</option>
          </select>
        </div>
        <div id="notes" role="list" className={grid ? 'grid' : ''}>
          {loadError ? (
            <div className="empty">{loadError}</div>
          ) : !rows.length ? (
            <div className="empty">{emptyArt}没有匹配的笔记<br /><small>记录一句话，让想法有个落点</small></div>
          ) : (
            rows.map((n) => (
              <article key={n.id}
                className={`note-row ${n.id === selected ? 'selected' : ''}`}
                data-id={n.id} data-row-actions tabIndex="0" role="listitem" style={{ '--note-color': n.color }}
                onClick={() => open(n.id)}
                onContextMenu={(e) => rowMenu(n, e)}
                onKeyDown={(e) => {
                  if (e.defaultPrevented || e.isComposing || e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(n.id) }
                }}>
                <div className="note-title">{n.pinned ? '⌑ ' : ''}{noteTitle(n)}</div>
                <div className="note-excerpt">{n.text || '还没有内容'}</div>
                <div className="note-meta">
                  <span>{n.tags.map((t) => '#' + t).join(' ')}</span>
                  <time>{relTime(n.updatedAt)}</time>
                </div>
                <div className="pk-row-actions note-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" title="复制内容"
                    onClick={() => copyNote(n.id)}>复制</button>
                  <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" title={n.pinned ? '取消置顶' : '置顶'}
                    onClick={() => mutateNote(n.id, (draft) => { draft.pinned = !draft.pinned }, { immediate: true })}>{n.pinned ? '取消置顶' : '置顶'}</button>
                  <MoreMenu
                    buttonClassName="pk-btn-sm"
                    ariaLabel="更多笔记操作"
                    items={[
                      { key: 'archive', label: n.archived ? '取消归档' : '归档', onSelect: () => archiveNote(n.id) },
                      n.deletedAt
                        ? { key: 'restore', label: '恢复笔记', onSelect: () => toggleTrash(n.id) }
                        : { key: 'trash', label: '移入回收站', danger: true, onSelect: () => toggleTrash(n.id) },
                      ...(n.deletedAt ? [{ key: 'purge', label: '永久删除', danger: true, onSelect: () => purgeNote(n.id) }] : []),
                    ]}
                  />
                </div>
              </article>
            ))
          )}
        </div>
        <footer className="shell-only">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="pk-btn pk-btn-ghost footer-more" aria-label="备份与设置">备份与设置 ▾</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem id="export-all" onSelect={exportAll}>导出备份 JSON</DropdownMenuItem>
              <DropdownMenuItem id="export-md" onSelect={exportMd}>导出全部 Markdown</DropdownMenuItem>
              <DropdownMenuItem id="import" onSelect={() => void importNotes()}>导入…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => api?.ui?.openSettings?.()}>设置…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </footer>
      </section>
      <section className={`editor${editorOpen ? ' open' : ''}`} id="editor">
        {!current ? (
          <div className="editor-empty" id="editor-empty">{loadError ? '' : editorEmptyArt}</div>
        ) : (
          <>
            <div className="editor-top">
              <DropdownMenu open={colorMenuOpen} onOpenChange={setColorMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="pk-btn pk-btn-ghost color-trigger" aria-label="切换便签颜色" title="切换便签颜色"
                    style={{ '--swatch': current.color }}>
                    <span className="color-swatch" aria-hidden="true"></span>
                    <span className="color-caret" aria-hidden="true">▾</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="sn-color-pop" align="start">
                  <div className="color-grid" role="group" aria-label="便签颜色">
                    {colors.map((c) => (
                      <button key={c} type="button" className={`color ${current.color === c ? 'chosen' : ''}`} data-color={c}
                        style={{ '--swatch': c }} aria-label={`切换便签颜色 ${c}`}
                        onClick={() => { mutateCurrent((n) => { n.color = c }, { immediate: true }); setColorMenuOpen(false) }}></button>
                    ))}
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="spacer"></span>
              <button id="pin" className="pk-btn pk-btn-ghost" aria-pressed={current.pinned} onClick={togglePin}>{current.pinned ? '已收藏' : '收藏'}</button>
              <button id="preview-toggle" className="pk-btn pk-btn-ghost" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>{preview ? '编辑' : '预览'}</button>
              <button id="copy" className="pk-btn pk-btn-ghost" onClick={() => copyNote(current.id)}>复制</button>
              <MoreMenu label="更多" ariaLabel="导出与归档" buttonClassName="editor-more" items={noteMenu} />
            </div>
            <div className="document">
              <input id="title" aria-label="笔记标题" placeholder="无标题" maxLength={200} key={'t' + current.id}
                defaultValue={current.title}
                onInput={(e) => mutateCurrent((n) => { n.title = e.target.value })} />
              <input id="tags" aria-label="笔记标签" placeholder="添加标签，用逗号分隔" key={'g' + current.id}
                defaultValue={current.tags.join(', ')}
                onInput={(e) => mutateCurrent((n) => { n.tags = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
              <textarea id="body" placeholder="开始写吧。支持 Markdown 预览。" spellCheck={false} key={'b' + current.id}
                hidden={preview} defaultValue={current.text}
                onInput={(e) => mutateCurrent((n) => { n.text = e.target.value })}></textarea>
              <div id="preview" hidden={!preview} dangerouslySetInnerHTML={{ __html: markdown(current.text) }}></div>
            </div>
            <div className="editor-foot">
              <span className="stat">{wc.chars} 字符 · {wc.words} 词</span>
              <span className="stat" title={new Date(current.updatedAt).toLocaleString()}>编辑于 {relTime(current.updatedAt)}</span>
              <span>⌘ / Ctrl + Shift + Enter 保存</span>
              <button id="undo" className="pk-btn pk-btn-ghost pk-btn-sm" hidden={!undo} onClick={() => undoDelete()}>撤销删除</button>
              <button id="purge" className="pk-btn pk-btn-danger pk-btn-sm" hidden={!current.deletedAt} onClick={() => purgeNote()}>永久删除</button>
              <button id="save-state" className="pk-btn pk-btn-ghost pk-btn-sm" onClick={() => void persist()}>{saveState}</button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
