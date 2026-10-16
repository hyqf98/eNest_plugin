/**
 * 待办清单主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 数据归一化 / 排序 / 拖拽排序管线与原版逐行等价。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const KEY = 'todos_v2'
const LABELS = { all: '全部', today: '今天', important: '重要', done: '已完成', archived: '归档' }

const uid = () => globalThis.crypto.randomUUID()
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const sameDay = (ts) => {
  const d = new Date(ts), n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}
// order 为可选字段：旧数据没有 order 时走默认排序，完全向后兼容
const normalize = (t) => ({
  id: typeof t.id === 'string' ? t.id : uid(),
  text: String(t.text || '').slice(0, 500),
  done: !!t.done,
  pinned: !!t.pinned,
  createdAt: Number(t.createdAt) || Date.now(),
  updatedAt: Number(t.updatedAt) || Date.now(),
  due: /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '',
  priority: ['normal', 'high', 'low'].includes(t.priority) ? t.priority : 'normal',
  list: String(t.list || '收件箱'),
  tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
  note: String(t.note || ''),
  subtasks: Array.isArray(t.subtasks)
    ? t.subtasks.filter((s) => s && typeof s.text === 'string').map((s) => ({ text: s.text, done: !!s.done }))
    : [],
  archived: !!t.archived,
  order: Number.isFinite(t.order) ? t.order : null,
})
const esc = PluginKit.escape

export function App() {
  const kitRef = useRef(null)
  const api = window.enest || window.zapi

  const [tasks, setTasks] = useState([])
  const [lists, setLists] = useState(['收件箱'])
  const [query, setQuery] = useState('')
  const [view, setView] = useState('all')
  const [list, setList] = useState('全部清单')
  const [selectedId, setSelectedId] = useState('')
  const [checked, setChecked] = useState(() => new Set())
  const [undoSnapshot, setUndoSnapshot] = useState(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saveState, setSaveState] = useState('已保存')
  const [dayStats, setDayStats] = useState({ doneToday: 0, totalToday: 0 })
  const [listFormOpen, setListFormOpen] = useState(false)
  const [settings, setSettings] = useState({ showCompleted: false, defaultView: 'all' })
  const [mode, setMode] = useState(PluginKit.create ? undefined : undefined) // 实际 mode 在 kit ready 后读取
  const [detailOpen, setDetailOpen] = useState(false)
  const [draft, setDraft] = useState(null) // 详情编辑草稿 { text, due, priority, list, tags, note }

  const newTaskRef = useRef(null)
  const listNameRef = useRef(null)
  const tasksRef = useRef(null)
  const detailRef = useRef(null)
  const subInputRef = useRef(null)
  const historySearchRef = useRef(null)
  const saveTimer = useRef(0)
  const stateRef = useRef({})
  stateRef.current = { tasks, lists, query, view, list, selectedId, checked, ready, settings }

  const visible = useCallback(() => {
    const { tasks: ts, list: l, view: v, query: q, settings: s } = stateRef.current
    const day = today()
    const hasOrder = ts.some((t) => t.order !== null)
    return ts
      .filter(
        (t) =>
          (l === '全部清单' || t.list === l) &&
          (v === 'archived' ? t.archived : !t.archived) &&
          (v === 'done'
            ? t.done
            : v === 'today'
              ? !t.done && t.due && t.due <= day
              : v === 'important'
                ? !t.done && (t.pinned || t.priority === 'high')
                : v === 'all'
                  ? s.showCompleted || !t.done
                  : true) &&
          `${t.text} ${t.note} ${t.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()),
      )
      .sort((a, b) => {
        if (Number(a.done) !== Number(b.done)) return Number(a.done) - Number(b.done)
        if (hasOrder) {
          const ao = a.order ?? Number.MAX_SAFE_INTEGER
          const bo = b.order ?? Number.MAX_SAFE_INTEGER
          if (ao !== bo) return ao - bo
        }
        return (
          Number(b.pinned) - Number(a.pinned) ||
          Number(b.priority === 'high') - Number(a.priority === 'high') ||
          (a.due || '9999').localeCompare(b.due || '9999') ||
          b.createdAt - a.createdAt
        )
      })
  }, [])

  const countFor = useCallback((key) => {
    const { tasks: ts, settings: s } = stateRef.current
    const day = today()
    if (key === 'all') return ts.filter((t) => !t.done && !t.archived && (s.showCompleted || !t.done)).length
    if (key === 'today') return ts.filter((t) => !t.done && !t.archived && t.due && t.due <= day).length
    if (key === 'important') return ts.filter((t) => !t.done && !t.archived && (t.pinned || t.priority === 'high')).length
    if (key === 'done') return ts.filter((t) => t.done && !t.archived).length
    if (key === 'archived') return ts.filter((t) => t.archived).length
    return 0
  }, [])

  /** 持久化（等价原 persist：立即写、状态条反馈） */
  const persist = useCallback(async (snapshot) => {
    const kit = kitRef.current
    if (!kit || !stateRef.current.ready) return
    setSaveState('保存中…')
    try {
      await kit.save(KEY, { version: 2, tasks: snapshot.tasks, lists: snapshot.lists })
      setSaveState('已保存')
    } catch (e) {
      setSaveState('保存失败 · 点击重试')
      kit.toast(e.message, 'error')
    }
  }, [])

  /** 立即保存当前状态（等价原 save：防抖由各编辑路径自带） */
  const saveNow = useCallback(
    (patchTasks, patchLists) => {
      const snapshot = {
        tasks: patchTasks ?? stateRef.current.tasks,
        lists: patchLists ?? stateRef.current.lists,
      }
      void persist(snapshot)
    },
    [persist],
  )

  /** 编辑任务字段 + 防抖保存（等价原 detail 250ms 防抖） */
  const patchTask = useCallback(
    (id, patch) => {
      setTasks((prev) => {
        const now = Date.now()
        const next = prev.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: now } : t))
        clearTimeout(saveTimer.current)
        const snapshot = { tasks: next, lists: stateRef.current.lists }
        saveTimer.current = setTimeout(() => void persist(snapshot), 250)
        return next
      })
    },
    [persist],
  )

  /** 快照供撤销（等价原 checkpoint） */
  const checkpoint = useCallback(() => {
    setUndoSnapshot({ tasks: stateRef.current.tasks, lists: stateRef.current.lists })
  }, [])

  /** 添加任务（等价原 composer onsubmit） */
  const addTask = useCallback(
    (text) => {
      if (!stateRef.current.ready) return
      const trimmed = text.trim()
      if (!trimmed) return
      const t = normalize({ id: uid(), text: trimmed, list: stateRef.current.list === '全部清单' ? '收件箱' : stateRef.current.list })
      checkpoint()
      setTasks((prev) => [t, ...prev])
      setSelectedId(t.id)
      setView('all')
      saveNow([t, ...stateRef.current.tasks])
    },
    [checkpoint, saveNow],
  )

  /** 勾选完成（等价原 toggle） */
  const toggle = useCallback(
    (id) => {
      const t = stateRef.current.tasks.find((t) => t.id === id)
      if (!t) return
      checkpoint()
      const next = stateRef.current.tasks.map((row) => (row.id === id ? { ...row, done: !row.done, updatedAt: Date.now() } : row))
      setTasks(next)
      saveNow(next)
    },
    [checkpoint, saveNow],
  )

  /** 删除（等价原 remove：含撤销 toast） */
  const removeTask = useCallback(
    (id) => {
      const kit = kitRef.current
      checkpoint()
      const next = stateRef.current.tasks.filter((t) => t.id !== id)
      setTasks(next)
      setChecked((prev) => {
        const n = new Set(prev)
        n.delete(id)
        return n
      })
      saveNow(next)
      kit?.toast('任务已删除，可撤销')
    },
    [checkpoint, saveNow],
  )

  // —— 拖拽排序：Pointer Events + setPointerCapture，1:1 跟随，松手即提交（等价原管线） ——
  const dragRef = useRef(null)
  const rowsIn = (el) => [...el.querySelectorAll('.task:not(.dragging)')]
  const commitOrder = useCallback(
    (orderedIds) => {
      checkpoint()
      const now = Date.now()
      const next = stateRef.current.tasks.map((t) => {
        const i = orderedIds.indexOf(t.id)
        return i >= 0 ? { ...t, order: i, updatedAt: now } : t
      })
      setTasks(next)
      saveNow(next)
    },
    [checkpoint, saveNow],
  )
  const endDrag = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    const { row, id, insertAt } = drag
    row.classList.remove('dragging')
    rowsIn(tasksRef.current).forEach((r) => {
      r.classList.remove('shift')
      r.style.transform = ''
    })
    row.style.transform = ''
    dragRef.current = null
    if (insertAt < 0) return
    const ids = visible().map((t) => t.id).filter((x) => x !== id)
    ids.splice(Math.min(insertAt, ids.length), 0, id)
    commitOrder(ids)
  }, [commitOrder, visible])
  const onListPointerDown = useCallback(
    (e) => {
      const handle = e.target.closest('[data-act="drag"]')
      const kit = kitRef.current
      if (!handle || kit?.mode !== 'shell') return
      const row = handle.closest('[data-id]')
      if (!row) return
      e.preventDefault()
      row.setPointerCapture(e.pointerId)
      const rect = row.getBoundingClientRect()
      dragRef.current = { row, id: row.dataset.id, startY: e.clientY, height: rect.height, insertAt: -1 }
      row.classList.add('dragging')
      rowsIn(tasksRef.current).forEach((r) => r.classList.add('shift'))
    },
    [],
  )
  const onListPointerMove = useCallback((e) => {
    const drag = dragRef.current
    if (!drag) return
    const dy = e.clientY - drag.startY
    drag.row.style.transform = `translateY(${dy}px)`
    const rowRect = drag.row.getBoundingClientRect()
    const center = rowRect.top + rowRect.height / 2
    const others = rowsIn(tasksRef.current)
    let insertAt = 0
    others.forEach((other) => {
      const r = other.getBoundingClientRect()
      const mid = r.top + r.height / 2
      const before = drag.row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING
      let shift = 0
      if (before && center > mid) shift = -drag.height
      if (!before && center < mid) shift = drag.height
      other.style.transform = shift ? `translateY(${shift}px)` : ''
      // 让位后的中点在拖行中心之上 → 插入点后移一位
      if (mid + shift < center) insertAt++
    })
    drag.insertAt = insertAt
  }, [])

  const onRowClick = useCallback(
    (e, id) => {
      const act = e.target.closest('[data-act]')?.dataset.act
      if (act === 'drag') return
      if (act === 'done') return toggle(id)
      if (act === 'delete') return removeTask(id)
      if (act === 'select') {
        const input = e.target
        setChecked((prev) => {
          const n = new Set(prev)
          input.checked ? n.add(id) : n.delete(id)
          return n
        })
        return
      }
      const t = stateRef.current.tasks.find((t) => t.id === id)
      if (!t) return
      setSelectedId(id)
      setDraft({
        text: t.text,
        due: t.due,
        priority: t.priority,
        list: t.list,
        tags: t.tags.join(', '),
        note: t.note,
      })
      setDetailOpen(true)
    },
    [removeTask, toggle],
  )

  const onListKeyDown = useCallback(
    (e) => {
      if (e.isComposing || e.target.matches('input,textarea')) return
      const row = e.target.closest('[data-id]')
      const kit = kitRef.current
      if (row && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault()
        toggle(row.dataset.id)
      }
      // 键盘排序：Ctrl/Cmd + 上下箭头 移动任务
      if (
        row &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        (e.metaKey || e.ctrlKey) &&
        kit?.mode === 'shell' &&
        stateRef.current.view !== 'archived' &&
        stateRef.current.view !== 'done'
      ) {
        e.preventDefault()
        const rows = visible().map((t) => t.id)
        const i = rows.indexOf(row.dataset.id)
        const j = i + (e.key === 'ArrowUp' ? -1 : 1)
        if (i < 0 || j < 0 || j >= rows.length) return
        ;[rows[i], rows[j]] = [rows[j], rows[i]]
        commitOrder(rows)
        requestAnimationFrame(() => tasksRef.current?.querySelector(`[data-id="${CSS.escape(row.dataset.id)}"]`)?.focus())
      }
    },
    [commitOrder, toggle, visible],
  )

  // —— 详情子任务操作 ——
  const selectedTask = tasks.find((t) => t.id === selectedId)
  const toggleSub = useCallback(
    (index, value) => {
      const t = stateRef.current.tasks.find((t) => t.id === stateRef.current.selectedId)
      if (!t) return
      const subtasks = t.subtasks.map((s, i) => (i === index ? { ...s, done: value } : s))
      const next = stateRef.current.tasks.map((row) => (row.id === t.id ? { ...row, subtasks } : row))
      setTasks(next)
      saveNow(next)
    },
    [saveNow],
  )
  const removeSub = useCallback(
    (index) => {
      const t = stateRef.current.tasks.find((t) => t.id === stateRef.current.selectedId)
      if (!t) return
      const subtasks = t.subtasks.filter((_, i) => i !== index)
      const next = stateRef.current.tasks.map((row) => (row.id === t.id ? { ...row, subtasks } : row))
      setTasks(next)
      saveNow(next)
    },
    [saveNow],
  )
  const addSub = useCallback(
    (text) => {
      const t = stateRef.current.tasks.find((t) => t.id === stateRef.current.selectedId)
      if (!t) return
      const trimmed = text.trim()
      if (!trimmed) return
      const subtasks = [...t.subtasks, { text: trimmed, done: false }]
      const next = stateRef.current.tasks.map((row) => (row.id === t.id ? { ...row, subtasks } : row))
      setTasks(next)
      saveNow(next)
    },
    [saveNow],
  )

  const closeDetail = useCallback(() => {
    setDetailOpen(false)
    if (kitRef.current?.mode === 'shell') setDraft(null)
  }, [])

  // —— 派生视图数据 ——
  const day = today()
  const open = tasks.filter((t) => !t.done && !t.archived)
  const doneToday = tasks.filter((t) => t.done && !t.archived && t.updatedAt && sameDay(t.updatedAt)).length
  const pendingToday = tasks.filter((t) => !t.done && !t.archived && t.due && t.due <= day).length
  const totalToday = doneToday + pendingToday
  const pct = totalToday ? Math.round((doneToday / totalToday) * 100) : 0
  useEffect(() => {
    setDayStats({ doneToday, totalToday })
  }, [doneToday, totalToday])

  const rows = useMemo(() => (ready ? visible() : []), [ready, tasks, query, view, list, settings, visible])
  useEffect(() => {
    if (!ready) return
    if (!rows.some((t) => t.id === selectedId)) setSelectedId(rows[0]?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rows.length, view, list, query])

  const dueState = (t) => {
    if (!t.due || t.done) return ''
    if (t.due < day) return 'overdue'
    if (t.due === day) return 'due-today'
    return ''
  }
  const dueLabel = (t) => {
    if (!t.due) return ''
    const state = dueState(t)
    if (state === 'overdue') return `已过期 ${t.due.slice(5)}`
    if (state === 'due-today') return '今天到期'
    return t.due
  }
  const emptyArt = () => (
    <svg viewBox="0 0 96 96" aria-hidden="true">
      <rect x="18" y="14" width="60" height="72" rx="8" fill="none" stroke="var(--line)" strokeWidth="2.5" />
      <path d="M30 34h24M30 48h36M30 62h30" stroke="var(--mark)" strokeWidth="2.5" strokeLinecap="round" opacity=".55" />
      <path d="M56 24l6 6 12-12" fill="none" stroke="var(--mark)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )

  // —— latest-ref 桥接（kit 回调用） ——
  const actionsRef = useRef({})
  actionsRef.current = {
    toggle,
    removeTask,
    visible,
    selectedId,
    setSelected: (id) => {
      setSelectedId(id)
      const t = stateRef.current.tasks.find((t) => t.id === id)
      if (t) {
        setDraft({ text: t.text, due: t.due, priority: t.priority, list: t.list, tags: t.tags.join(', '), note: t.note })
        setDetailOpen(true)
      }
    },
  }

  const initializedRef = useRef(null)
  useEffect(() => {
    const kit = PluginKit.create({
      title: '待办清单',
      quickPlaceholder: '搜索待办，回车完成选中任务',
      height: 480,
      defaults: { defaultView: 'all', showCompleted: false },
      onQuery: (value) => {
        setQuery(value)
      },
      onAction: (action) => {
        if (!stateRef.current.ready) return
        const rowsNow = actionsRef.current.visible()
        let i = rowsNow.findIndex((t) => t.id === actionsRef.current.selectedId)
        if (action === 'next' || action === 'previous') {
          i = Math.max(0, Math.min(rowsNow.length - 1, i + (action === 'next' ? 1 : -1)))
          actionsRef.current.setSelected(rowsNow[i]?.id || '')
        }
        if (action === 'submit' && actionsRef.current.selectedId) actionsRef.current.toggle(actionsRef.current.selectedId)
      },
    })
    kitRef.current = kit
    setMode(kit.mode)
    kit.onSettings(() => {
      setSettings({ ...kit.settings })
    })
    kit.onMode(() => {
      setMode(kit.mode)
    })
    let alive = true
    initializedRef.current = (async () => {
      try {
        await kit.ready
        if (!alive) return
        setSettings({ ...kit.settings })
        const initialView = Object.hasOwn(LABELS, kit.settings.defaultView) ? kit.settings.defaultView : 'all'
        setView(initialView)
        const data = await kit.load(KEY, null)
        if (!alive) return
        if (data) {
          if (data.version !== 2 || !Array.isArray(data.tasks)) throw Error('待办数据格式异常，未覆盖原数据')
          const normalized = data.tasks.map(normalize)
          setTasks(normalized)
          setLists([...new Set(['收件箱', ...(data.lists || []), ...normalized.map((t) => t.list)])])
        } else {
          const old = await kit.load('todos_v1', [])
          if (!Array.isArray(old)) throw Error('旧待办数据格式异常')
          await kit.save('todos_v1_backup', old)
          const normalized = old.filter((t) => t && typeof t.text === 'string').map(normalize)
          setTasks(normalized)
          await kit.save(KEY, { version: 2, tasks: normalized, lists: ['收件箱'] })
        }
        if (!alive) return
        setReady(true)
      } catch (e) {
        if (!alive) return
        setFailed(true)
        kit.toast(e.message, 'error')
        if (newTaskRef.current) newTaskRef.current.disabled = true
      }
    })()
    api?.onEnter?.(async ({ payload }) => {
      await initializedRef.current
      const text = typeof payload === 'string' ? payload : payload?.type === 'text' ? payload.text : ''
      if (text && newTaskRef.current) {
        newTaskRef.current.value = text
        newTaskRef.current.focus()
      }
    })
    api?.onBeforeClose?.(async () => {
      await initializedRef.current
      clearTimeout(saveTimer.current)
      return persist(stateRef.current)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitSub = (e) => {
    e.preventDefault()
    const text = subInputRef.current?.value.trim()
    if (text) {
      addSub(text)
      if (subInputRef.current) subInputRef.current.value = ''
    }
  }

  const archiveTask = () => {
    if (!selectedTask) return
    checkpoint()
    patchTask(selectedTask.id, { archived: !selectedTask.archived })
  }

  const submitListForm = (e) => {
    e.preventDefault()
    const name = listNameRef.current?.value.trim()
    if (name && !lists.includes(name)) {
      const next = [...lists, name]
      setLists(next)
      setList(name)
      setListFormOpen(false)
      if (listNameRef.current) listNameRef.current.value = ''
      saveNow(undefined, next)
    }
  }

  const importTasks = async () => {
    const kit = kitRef.current
    try {
      const [f] = await api.localFiles.pick({ kind: 'file', access: 'read' })
      if (!f) return
      if (f.size > 5e6) throw Error('导入文件不能超过 5 MB')
      const data = JSON.parse(await api.localFiles.read({ handleId: f.id, encoding: 'text', maxBytes: 5000000 }))
      const incoming = Array.isArray(data) ? data : data.tasks
      if (!Array.isArray(incoming) || incoming.some((t) => !t || typeof t.text !== 'string')) throw Error('任务文件格式不正确')
      checkpoint()
      const merged = [...stateRef.current.tasks, ...incoming.map((t) => normalize({ ...t, id: uid() }))]
      const nextLists = [...new Set([...stateRef.current.lists, ...merged.map((t) => t.list)])]
      setTasks(merged)
      setLists(nextLists)
      saveNow(merged, nextLists)
      kit.toast(`已导入 ${incoming.length} 条任务`)
    } catch (e) {
      kit?.toast(e.message, 'error')
    }
  }

  const exportTasks = () =>
    kitRef.current
      .saveText('待办清单.json', JSON.stringify({ version: 2, tasks, lists }, null, 2))
      .catch((e) => kitRef.current.toast(e.message, 'error'))

  const detailValue = (field) => (draft ? draft[field] : '')
  const onDetailField = (field, value) => {
    if (!selectedTask) return
    setDraft((prev) => ({ ...prev, [field]: value }))
    const patch =
      field === 'tags'
        ? { tags: value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }
        : { [field]: value }
    patchTask(selectedTask.id, patch)
  }

  // 详情（无选中时占位）
  const subDone = selectedTask ? selectedTask.subtasks.filter((s) => s.done).length : 0
  const subAll = selectedTask ? selectedTask.subtasks.length : 0
  const subPct = subAll ? Math.round((subDone / subAll) * 100) : 0

  return (
    <>
      <header className="shell-only">
        <div>
          <div className="eyebrow">把下一步写下来</div>
          <h1>待办清单</h1>
        </div>
        <div className="progress-wrap" title="今日完成度">
          <div className="progress-track">
            <div className="progress-fill" id="day-fill" style={{ width: pct + '%' }}></div>
          </div>
          <span className="progress-label" id="day-label">
            {totalToday ? (
              <>
                今日 <b>{doneToday}</b>/{totalToday}
              </>
            ) : (
              '今日 0/0'
            )}
          </span>
        </div>
        <span className="grow"></span>
        <input
          className="search"
          id="search"
          type="search"
          placeholder="搜索任务、标签、备注"
          aria-label="搜索任务"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            kitRef.current?.setQuery(e.target.value)
          }}
        />
        <button id="export" onClick={exportTasks}>导出</button>
        <button data-open-settings>设置</button>
      </header>
      <div className="workspace">
        <nav className="shell-only">
          <div className="eyebrow">清单</div>
          <div id="lists">
            {/* 与原版一致：清单导航在数据就绪后才填充（初始为空容器） */}
            {ready
              ? ['全部清单', ...lists].map((name) => {
                  const count =
                    name === '全部清单'
                      ? open.length
                      : tasks.filter((t) => t.list === name && !t.done && !t.archived).length
                  return (
                    <button key={name} data-list={esc(name)} className={name === list ? 'active' : ''} onClick={() => setList(name)}>
                      {esc(name)}
                      {count ? <span className="nav-count">{count}</span> : ''}
                    </button>
                  )
                })
              : null}
          </div>
          <button id="new-list" onClick={() => {
            setListFormOpen(true)
            requestAnimationFrame(() => listNameRef.current?.focus())
          }}>＋ 新建清单</button>
          <form id="list-form" hidden={!listFormOpen} onSubmit={submitListForm}>
            <input id="list-name" ref={listNameRef} placeholder="清单名称" maxLength={50} aria-label="新清单名称" />
            <button>创建</button>
            <button type="button" id="cancel-list" onClick={() => setListFormOpen(false)}>取消</button>
          </form>
          <hr />
          <button id="import" onClick={importTasks}>导入任务</button>
        </nav>
        <section className="list-pane">
          <div className="quick-summary quick-only">
            待办清单 <span id="quick-count">{ready ? open.length : ''}</span>
          </div>
          <div className="filters" id="filters">
            {/* 与原版一致：仅在数据就绪后渲染筛选（读取失败时保持初始空白态） */}
            {ready
              ? Object.entries(LABELS).map(([key, label]) => {
                  const count = countFor(key)
                  return (
                    <button key={key} data-view={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>
                      {label}
                      {count ? <span className="f-count">{count}</span> : ''}
                    </button>
                  )
                })
              : null}
          </div>
          <form
            className="composer"
            id="composer"
            onSubmit={(e) => {
              e.preventDefault()
              addTask(newTaskRef.current?.value ?? '')
              if (newTaskRef.current) {
                newTaskRef.current.value = ''
                newTaskRef.current.focus()
              }
            }}
          >
            <input
              id="new-task"
              ref={newTaskRef}
              autoComplete="off"
              maxLength={500}
              placeholder="下一件要做的事…"
              aria-label="新任务"
            />
            <button className="primary" type="submit">添加</button>
          </form>
          <div
            id="tasks"
            role="list"
            ref={tasksRef}
            onPointerDown={onListPointerDown}
            onPointerMove={onListPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={(e) => {
              const row = e.target.closest('[data-id]')
              if (row) onRowClick(e, row.dataset.id)
            }}
            onKeyDown={onListKeyDown}
          >
            {failed ? (
              <div className="empty">读取失败，原数据已保留。请重新打开插件。</div>
            ) : rows.length ? (
              rows.map((t) => {
                const ds = dueState(t)
                const subDone2 = t.subtasks.filter((s) => s.done).length
                const subAll2 = t.subtasks.length
                return (
                  <div
                    key={t.id}
                    className={`task ${t.done ? 'done' : ''} ${selectedId === t.id ? 'selected' : ''}`}
                    role="listitem"
                    data-id={esc(t.id)}
                    tabIndex={0}
                  >
                    <span className="drag-handle shell-only" data-act="drag" aria-label="拖动排序" title="拖动排序">⠿</span>
                    <input
                      className="shell-only"
                      type="checkbox"
                      data-act="select"
                      aria-label="选择任务"
                      defaultChecked={checked.has(t.id)}
                    />
                    <button className="check" data-act="done" aria-label={t.done ? '标记未完成' : '完成任务'}>
                      {t.done ? '✓' : ''}
                    </button>
                    <div className="task-body">
                      <div className="task-title">{esc(t.text)}</div>
                      <div className="meta">
                        {t.due ? <span className={ds}>{esc(dueLabel(t))}</span> : ''}
                        <span>{esc(t.list)}</span>
                        {t.priority === 'high' ? <span className="flag">⚑ 高优先级</span> : ''}
                        {subAll2 ? (
                          <span className="subtask-progress">
                            <span className="subtask-mini">
                              <i style={{ width: Math.round((subDone2 / subAll2) * 100) + '%' }}></i>
                            </span>
                            {subDone2}/{subAll2}
                          </span>
                        ) : (
                          ''
                        )}
                        {t.tags.map((tag) => (
                          <span key={tag}>#{esc(tag)}</span>
                        ))}
                      </div>
                    </div>
                    <button data-act="pin" className="pin" aria-label={t.pinned ? '取消置顶' : '置顶'} onClick={(e) => {
                      e.stopPropagation()
                      const cur = stateRef.current.tasks.find((row) => row.id === t.id)
                      if (!cur) return
                      const next = stateRef.current.tasks.map((row) => (row.id === t.id ? { ...row, pinned: !row.pinned } : row))
                      setTasks(next)
                      saveNow(next)
                    }}>
                      {t.pinned ? '★' : '☆'}
                    </button>
                    <button className="remove" data-act="delete" aria-label="删除任务" onClick={(e) => {
                      e.stopPropagation()
                      removeTask(t.id)
                    }}>×</button>
                  </div>
                )
              })
            ) : (
              <div className="empty">
                {emptyArt()}
                这里已整理好
                <br />
                <small>添加新任务，或换个筛选看看</small>
              </div>
            )}
          </div>
          <div className="batch shell-only">
            <button id="batch-done" onClick={() => {
              checkpoint()
              const next = stateRef.current.tasks.map((t) => (checked.has(t.id) ? { ...t, done: true } : t))
              setTasks(next)
              setChecked(new Set())
              saveNow(next)
            }}>完成已选</button>
            <button id="batch-archive" onClick={() => {
              checkpoint()
              const next = stateRef.current.tasks.map((t) => (checked.has(t.id) ? { ...t, archived: true } : t))
              setTasks(next)
              setChecked(new Set())
              saveNow(next)
            }}>归档已选</button>
            <button id="clear-done" onClick={() => {
              checkpoint()
              const next = stateRef.current.tasks.map((t) => (t.done ? { ...t, archived: true } : t))
              setTasks(next)
              saveNow(next)
            }}>归档已完成</button>
          </div>
          <footer>
            <span id="count">{ready ? `${rows.length} 条 · ${open.length} 待完成` : ''}</span>
            <button
              id="undo"
              hidden={!undoSnapshot}
              onClick={() => {
                if (undoSnapshot) {
                  setTasks(undoSnapshot.tasks)
                  setLists(undoSnapshot.lists)
                  setUndoSnapshot(null)
                  saveNow(undoSnapshot.tasks, undoSnapshot.lists)
                }
              }}
            >
              撤销
            </button>
            {/* 与原版一致：初始 HTML 为「已保存」，首帧即静态文本 */}
            <span id="save-state" onClick={() => void persist(stateRef.current)}>{saveState}</span>
          </footer>
        </section>
        <aside className={`detail${detailOpen ? ' open' : ''}`} id="detail" ref={detailRef}>
          {!selectedTask || !draft ? (
            <div className="empty">选择任务，安排下一步</div>
          ) : (
            <>
              <div className="detail-actions">
                <h2>任务详情</h2>
                <button id="close-detail" style={{ marginLeft: 'auto' }} onClick={closeDetail}>收起</button>
              </div>
              <label>
                任务
                <input data-field="text" value={detailValue('text')} maxLength={500} onChange={(e) => onDetailField('text', e.target.value)} />
              </label>
              <label>
                截止日期
                <input data-field="due" type="date" value={detailValue('due')} onChange={(e) => onDetailField('due', e.target.value)} />
              </label>
              <label>
                优先级
                <select data-field="priority" value={detailValue('priority')} onChange={(e) => onDetailField('priority', e.target.value)}>
                  <option value="normal">普通</option>
                  <option value="high">高</option>
                  <option value="low">低</option>
                </select>
              </label>
              <label>
                清单
                <select data-field="list" value={detailValue('list')} onChange={(e) => onDetailField('list', e.target.value)}>
                  {lists.map((l) => (
                    <option key={l} value={l}>{esc(l)}</option>
                  ))}
                </select>
              </label>
              <label>
                标签（逗号分隔）
                <input data-field="tags" value={detailValue('tags')} onChange={(e) => onDetailField('tags', e.target.value)} />
              </label>
              <label>
                备注
                <textarea data-field="note" rows={4} value={detailValue('note')} onChange={(e) => onDetailField('note', e.target.value)} />
              </label>
              <label>子任务</label>
              {subAll ? (
                <div className="sub-progress">
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: subPct + '%' }}></div>
                  </div>
                  <span>{subDone}/{subAll}</span>
                </div>
              ) : (
                ''
              )}
              <div>
                {selectedTask.subtasks.map((s, i) => (
                  <div className="subtask" key={i}>
                    <input type="checkbox" data-sub={i} defaultChecked={s.done} aria-label="完成子任务" onChange={(e) => toggleSub(i, e.target.checked)} />
                    <span style={s.done ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>{esc(s.text)}</span>
                    <button data-remove-sub={i} aria-label="删除子任务" onClick={() => removeSub(i)}>×</button>
                  </div>
                ))}
              </div>
              <form id="subform" onSubmit={submitSub}>
                <input id="subinput" ref={subInputRef} placeholder="添加子任务" maxLength={300} />
                <button>＋</button>
              </form>
              <div className="detail-actions" style={{ marginTop: 20 }}>
                <button id="archive-task" onClick={archiveTask}>{selectedTask.archived ? '恢复到清单' : '归档任务'}</button>
                <button id="delete-task" onClick={() => removeTask(selectedTask.id)}>删除</button>
              </div>
            </>
          )}
        </aside>
      </div>
    </>
  )
}
