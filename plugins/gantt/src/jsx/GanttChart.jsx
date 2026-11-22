/**
 * GanttChart.jsx —— 甘特图主体：表头（月份带 + 日期列）+ 任务行 + 任务条 + 依赖连线
 * 拖拽状态机（move / resize-w / resize-e / link）参考 drawboard 的 pointer capture
 * 模式：pointerdown 记录快照，move 中换算像素->天数增量并钳制，up 时一次性提交。
 * 拖拽期间把预览写进 ref（finishDrag 唯一数据源）与 state（仅驱动渲染）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  flattenTasks, summarize, dependencyViolations, wouldCycle,
  addDays, diffDays, fmtDate, parseDate, toDateStr, PALETTE_SIZE
} from '../js/model.mjs'
import {
  buildColumns, buildMonthBands, frameFor, dayIndex, indexToDate, fitDayWidth, DEFAULT_WIDTHS
} from '../js/timeScale.mjs'

export function paletteVar(i) {
  return `var(--gt-c${Math.max(0, Math.min(PALETTE_SIZE - 1, i || 0))})`
}

const BAR_MIN_DAYS = 1
const DRAG_DEAD_ZONE = 3
const ROW_H = 40
const HEAD_H = 56
const MIN_LEFT_COL = 140
const MAX_LEFT_COL = 420
const EDGE_SCROLL_ZONE = 56
const EDGE_SCROLL_STEP = 14

export function GanttChart({ plan, granularity, dayWidth, setDayWidth, api, openTaskDialog, onCreateAt }) {
  const summaries = useMemo(() => summarize(plan.tasks), [plan.tasks])
  const allRows = useMemo(() => flattenTasks(plan.tasks), [plan.tasks])
  const violations = useMemo(
    () => new Set(dependencyViolations(plan.tasks, summaries).map(v => `${v.depId}>${v.taskId}`)),
    [plan.tasks, summaries]
  )

  const frame = useMemo(() => frameFor(plan.tasks, summaries, granularity), [plan.tasks, summaries, granularity])
  const columns = useMemo(
    () => buildColumns(granularity, frame.minIndex, frame.maxIndex, dayWidth),
    [granularity, frame, dayWidth]
  )
  const monthBands = useMemo(() => bandsFor(columns, granularity, frame, dayWidth), [columns, granularity, frame, dayWidth])
  const timelineWidth = (frame.maxIndex - frame.minIndex + 1) * dayWidth
  const todayX = (frame.todayIndex - frame.minIndex) * dayWidth + dayWidth / 2
  const todayColKey = useMemo(() => todayKey(frame.todayIndex, granularity), [frame.todayIndex, granularity])

  /* ---------- 左列宽度（可拖拽） ---------- */
  const [leftCol, setLeftCol] = useState(200)
  const colDragRef = useRef(null)
  const [colDragging, setColDragging] = useState(false)

  const beginColResize = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    colDragRef.current = { startX: e.clientX, startW: leftCol }
    setColDragging(true)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* webview 合成事件 */ }
  }
  const moveColResize = (e) => {
    const ctx = colDragRef.current
    if (!ctx) return
    const w = Math.max(MIN_LEFT_COL, Math.min(MAX_LEFT_COL, ctx.startW + (e.clientX - ctx.startX)))
    setLeftCol(w)
  }
  const endColResize = (e) => {
    if (!colDragRef.current) return
    colDragRef.current = null
    setColDragging(false)
    try { e?.currentTarget?.releasePointerCapture?.(e.pointerId) } catch { /* 同上 */ }
  }

  /* ---------- 任务搜索过滤（命中子任务时保留其祖先链；命中父任务时保留其后代） ---------- */
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allRows
    const byId = new Map(plan.tasks.map(t => [t.id, t]))
    const hit = new Set()
    for (const t of plan.tasks) {
      if (t.name.toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q)) hit.add(t.id)
    }
    if (hit.size === 0) return []
    // 向上补祖先：保证层级缩进正确
    for (const id of [...hit]) {
      let cur = byId.get(id)
      while (cur?.parentId) {
        hit.add(cur.parentId)
        cur = byId.get(cur.parentId)
      }
    }
    // 向下补后代：命中父任务时展开其子任务
    let grew = true
    while (grew) {
      grew = false
      for (const t of plan.tasks) {
        if (t.parentId && hit.has(t.parentId) && !hit.has(t.id)) { hit.add(t.id); grew = true }
      }
    }
    return allRows.filter(r => hit.has(r.task.id))
  }, [allRows, query, plan.tasks])

  /* 行号映射（依赖连线定位用）：taskId -> 可视行序 */
  const rowIndex = useMemo(() => {
    const m = new Map()
    rows.forEach((r, i) => m.set(r.task.id, i))
    return m
  }, [rows])

  /* ---------- 滚动投影与视口 ---------- */
  const scrollRef = useRef(null)
  const [scrollState, setScrollState] = useState({ left: 0, width: 0 })
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setScrollState({ left: el.scrollLeft, width: el.clientWidth })
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => setScrollState({ left: el.scrollLeft, width: el.clientWidth }))
      : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [plan.id])

  const scrollToToday = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, (frame.todayIndex - frame.minIndex) * dayWidth - (el.clientWidth - leftCol) * 0.3)
  }, [frame.todayIndex, frame.minIndex, dayWidth, leftCol])

  /** 可用时间轴宽度（视口减去左列与内边距） */
  const laneViewport = useCallback(() => {
    const el = scrollRef.current
    if (!el) return 0
    return Math.max(0, el.clientWidth - leftCol - 16)
  }, [leftCol])

  /** 适应宽度：把整个计划压进视口 */
  const fitToView = useCallback(() => {
    setAutoFit(true)
    const w = laneViewport()
    if (!w) return
    setDayWidth(fitDayWidth(w, frame.minIndex, frame.maxIndex))
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollLeft = 0 })
  }, [frame.minIndex, frame.maxIndex, laneViewport, setDayWidth])

  /* 自动适应：首次进入、切换计划/粒度、容器变宽变窄都重新贴合（手动缩放后停止自动）。
     月粒度列宽本身已按自然月天数放大，不再做日宽适配（否则一个月会被压成几百像素）。 */
  const [autoFit, setAutoFit] = useState(true)
  useEffect(() => {
    if (!autoFit) return
    const el = scrollRef.current
    if (!el) return
    const apply = () => {
      if (granularity === 'month') {
        setDayWidth(DEFAULT_WIDTHS.month)
        // 月粒度列宽固定，滚到首个任务所在月而不是最左
        requestAnimationFrame(() => {
          const el2 = scrollRef.current
          if (!el2) return
          const first = rows[0] ? summaries.get(rows[0].task.id)?.start : null
          const idx = first ? dayIndex(first) : frame.todayIndex
          el2.scrollLeft = Math.max(0, (idx - frame.minIndex) * DEFAULT_WIDTHS.month - (el2.clientWidth - leftCol) * 0.25)
        })
        return
      }
      const w = laneViewport()
      if (!w) return
      setDayWidth(fitDayWidth(w, frame.minIndex, frame.maxIndex))
      el.scrollLeft = 0
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [autoFit, frame.minIndex, frame.maxIndex, laneViewport, setDayWidth, plan.id, granularity])

  /** 手动缩放（按钮/菜单）时关闭自动适应；下限 20px 防两位日期裁字 */
  const zoomBy = useCallback((delta) => {
    setAutoFit(false)
    setDayWidth(w => Math.max(20, Math.min(96, w + delta)))
  }, [setDayWidth])

  /* ---------- 选中行 ---------- */
  const [selectedId, setSelectedId] = useState(null)
  useEffect(() => {
    if (selectedId && !plan.tasks.some(t => t.id === selectedId)) setSelectedId(null)
  }, [plan.tasks, selectedId])

  /* ---------- 拖拽状态机 ---------- */
  const dragRef = useRef(null)
  const [dragPreview, setDragPreview] = useState(null) // {taskId, start, end} 渲染预览
  const [dragHint, setDragHint] = useState(null) // {x, y, text}

  const hintFor = (mode, start, end) => {
    const days = diffDays(end, start) + 1
    const range = milestoneLike(start, end)
      ? fmtDate(start)
      : `${fmtDate(start)} – ${fmtDate(end)}`
    const tag = mode === 'move' ? '' : mode === 'resize-w' ? '调整开始 · ' : '调整结束 · '
    return `${tag}${range}${milestoneLike(start, end) ? '' : ` · ${days} 天`}`
  }

  const applyDrag = useCallback((clientX, clientY) => {
    const drag = dragRef.current
    if (!drag || !drag.moved) return
    const el = scrollRef.current
    const scrollDelta = el ? el.scrollLeft - drag.scrollStart : 0
    const dx = clientX - drag.pointerStart + scrollDelta
    const delta = Math.round(dx / dayWidth)
    let { originStart: start, originEnd: end } = drag
    if (drag.mode === 'move') {
      const len = diffDays(end, start)
      start = addDays(start, delta)
      end = addDays(start, len)
    } else if (drag.mode === 'resize-w') {
      start = addDays(start, delta)
      if (diffDays(end, start) < BAR_MIN_DAYS - 1) start = addDays(end, -(BAR_MIN_DAYS - 1))
      if (start > end) start = end
    } else if (drag.mode === 'resize-e') {
      end = addDays(end, delta)
      if (diffDays(end, start) < BAR_MIN_DAYS - 1) end = addDays(start, BAR_MIN_DAYS - 1)
      if (end < start) end = start
    }
    /* 预览结果写进 ref（finishDrag 的数据源）与 state（仅驱动渲染） */
    drag.preview = { taskId: drag.taskId, start, end }
    drag.lastClientX = clientX
    setDragPreview(drag.preview)
    setDragHint({ x: clientX, y: clientY, text: hintFor(drag.mode, start, end), moved: delta !== 0 })
  }, [dayWidth])

  const beginDrag = (e, task, mode) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const summary = summaries.get(task.id) || { start: task.start, end: task.end }
    dragRef.current = {
      mode, taskId: task.id, moved: false,
      originStart: summary.start, originEnd: summary.end,
      pointerStart: e.clientX,
      scrollStart: scrollRef.current?.scrollLeft || 0,
      lastClientX: e.clientX,
      pointerId: e.pointerId
    }
    setSelectedId(task.id)
    setDragHint(null)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* webview 合成事件下可能抛 NotFoundError */ }
  }

  const onDragMove = useCallback((e) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.pointerStart
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_DEAD_ZONE) return
      drag.moved = true
    }
    applyDrag(e.clientX, e.clientY)
  }, [applyDrag])

  const finishDrag = useCallback((e) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    try { e?.currentTarget?.releasePointerCapture?.(e.pointerId) } catch { /* 同 beginDrag */ }
    const preview = drag.preview
    setDragPreview(null)
    setDragHint(null)
    if (!drag.moved || !preview || (preview.start === drag.originStart && preview.end === drag.originEnd)) return
    api.patchTask(plan.id, drag.taskId, { start: preview.start, end: preview.end })
    /* 依赖冲突软提示（不硬阻断） */
    const task = plan.tasks.find(t => t.id === drag.taskId)
    if (task?.deps?.length) {
      const moved = plan.tasks.map(t => (t.id === drag.taskId ? { ...t, start: preview.start, end: preview.end } : t))
      const bad = dependencyViolations(moved, summarize(moved)).filter(v => v.taskId === drag.taskId)
      if (bad.length) api.toast(`「${task.name}」开始早于前置任务结束（完成-开始约束）`, 'warn')
    }
  }, [api, plan.id, plan.tasks])

  /* 拖到视口边缘自动横向滚动（rAF 循环，位移带回滚补偿） */
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const drag = dragRef.current
      const el = scrollRef.current
      if (drag && el && drag.moved) {
        const rect = el.getBoundingClientRect()
        const x = drag.lastClientX
        let next = el.scrollLeft
        if (x < rect.left + EDGE_SCROLL_ZONE) next -= EDGE_SCROLL_STEP
        else if (x > rect.right - EDGE_SCROLL_ZONE) next += EDGE_SCROLL_STEP
        const clamped = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, next))
        if (clamped !== el.scrollLeft) {
          el.scrollLeft = clamped
          applyDrag(x, 0)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [applyDrag])

  /* Esc 取消拖拽 / Delete 删除选中 */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (dragRef.current) {
          dragRef.current = null
          setDragPreview(null)
          setDragHint(null)
        } else if (linkRef.current) {
          linkRef.current = null
          setLinkDrag(null)
        } else if (selectedId) {
          setSelectedId(null)
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        const task = plan.tasks.find(t => t.id === selectedId)
        if (!task) return
        e.preventDefault()
        if (window.confirm(`删除任务「${task.name}」？`)) {
          api.deleteTask(plan.id, task.id)
          setSelectedId(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, plan.tasks, plan.id, api])

  /* ---------- 依赖连线拖拽 ---------- */
  const linkRef = useRef(null)
  const [linkDrag, setLinkDrag] = useState(null) // {fromId, x, y, hoverTaskId}

  const beginLink = (e, task) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const lane = e.currentTarget.closest('.g-lane')
    if (!lane) return
    const rect = lane.getBoundingClientRect()
    linkRef.current = { fromId: task.id, lane }
    setLinkDrag({ fromId: task.id, x: e.clientX - rect.left, y: e.clientY - rect.top, hoverTaskId: null })
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 见 beginDrag */ }
  }

  const onLinkMove = useCallback((e) => {
    const ctx = linkRef.current
    if (!ctx) return
    const rect = ctx.lane.getBoundingClientRect()
    const y = e.clientY - rect.top
    const row = rows[Math.max(0, Math.floor(y / ROW_H))]
    const hoverTaskId = row && row.task.id !== ctx.fromId ? row.task.id : null
    ctx.preview = { fromId: ctx.fromId, hoverTaskId }
    setLinkDrag({ fromId: ctx.fromId, x: e.clientX - rect.left, y, hoverTaskId })
  }, [rows])

  const finishLink = useCallback(() => {
    const ctx = linkRef.current
    linkRef.current = null
    if (!ctx) return
    /* 拖拽落点从 ref 读，避免同步事件序列下 state 闭包滞后 */
    const snapshot = ctx.preview
    setLinkDrag(null)
    if (!snapshot?.hoverTaskId) return
    const { fromId } = ctx
    const toId = snapshot.hoverTaskId
    if (fromId === toId) return
    if (wouldCycle(plan.tasks, fromId, toId)) {
      api.toast('不能创建循环依赖', 'error')
      return
    }
    const target = plan.tasks.find(t => t.id === toId)
    if (!target) return
    if ((target.deps || []).includes(fromId)) {
      api.toast(`「${target.name}」已经依赖该任务`, 'warn')
      return
    }
    api.patchTask(plan.id, toId, { deps: [...new Set([...(target.deps || []), fromId])] })
    api.toast(`已建立依赖：「${plan.tasks.find(t => t.id === fromId)?.name}」→「${target.name}」`)
  }, [api, plan])

  /* ---------- 右键菜单 ---------- */
  const taskMenu = (task, e) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(task.id)
    const summary = summaries.get(task.id)
    const items = [
      ['edit', '编辑任务'],
      ['copy', '复制任务'],
      'sep',
      ...[0, 25, 50, 75, 100].map(p => [`p${p}`, `进度 ${p}%`, { checked: summary?.progress === p }]),
      'sep',
      ['milestone', task.milestone ? '转为任务条' : '设为里程碑'],
      ['nextColor', '换下一色'],
      ['duration', '调整时长…'],
      'sep',
      ['outdent', '升级（减少缩进）', { disabled: !task.parentId }],
      ['indent', '降级（变为子任务）'],
      'sep',
      ['clearDeps', '清除依赖', { disabled: !task.deps?.length }],
      ['delete', '删除任务', { danger: true }]
    ]
    api.openMenu(e, items, (key) => {
      if (key === 'edit') openTaskDialog(task)
      else if (key === 'copy') api.duplicateTask(plan.id, task.id)
      else if (key === 'milestone') api.patchTask(plan.id, task.id, { milestone: !task.milestone })
      else if (key === 'nextColor') api.patchTask(plan.id, task.id, { colorIndex: ((task.colorIndex ?? 0) + 1) % PALETTE_SIZE })
      else if (key === 'duration') {
        const sum = summaries.get(task.id) || task
        const days = diffDays(sum.end, sum.start) + 1
        const raw = window.prompt(`「${task.name}」时长（天，1-365）`, String(days))
        if (raw === null) return
        const n = Math.round(Number(raw))
        if (!Number.isFinite(n) || n < 1) { api.toast('时长需为大于 0 的天数', 'warn'); return }
        const capped = Math.min(365, n)
        api.patchTask(plan.id, task.id, { end: addDays(sum.start, capped - 1) })
      } else if (key.startsWith('p')) api.patchTask(plan.id, task.id, { progress: Number(key.slice(1)) })
      else if (key === 'delete') {
        if (window.confirm(`删除任务「${task.name}」？`)) api.deleteTask(plan.id, task.id)
      } else if (key === 'clearDeps') api.patchTask(plan.id, task.id, { deps: [] })
      else if (key === 'outdent') api.moveTaskLevel(plan.id, task.id, -1)
      else if (key === 'indent') api.moveTaskLevel(plan.id, task.id, 1)
    })
  }

  const linkMenu = (depId, taskId, e) => {
    e.preventDefault()
    e.stopPropagation()
    const from = plan.tasks.find(t => t.id === depId)
    const to = plan.tasks.find(t => t.id === taskId)
    api.openMenu(e, [
      ['del', `删除连线「${from?.name}」→「${to?.name}」`, { danger: true }]
    ], () => {
      const target = plan.tasks.find(t => t.id === taskId)
      api.patchTask(plan.id, taskId, { deps: (target?.deps || []).filter(d => d !== depId) })
    })
  }

  const laneMenu = (e) => {
    const lane = e.currentTarget
    const rect = lane.getBoundingClientRect()
    const idx = Math.floor((e.clientX - rect.left) / dayWidth) + frame.minIndex
    const date = indexToDate(idx)
    e.preventDefault()
    api.openMenu(e, [
      ['new', `在 ${fmtDate(date)} 新建任务`],
      ['milestone', `在 ${fmtDate(date)} 新建里程碑`],
      'sep',
      ['today', '回到今天'],
      ['fit', '适应宽度'],
      ['resetZoom', `恢复默认列宽（${DEFAULT_WIDTHS[granularity]}px）`]
    ], (key) => {
      if (key === 'new') onCreateAt?.(date)
      else if (key === 'milestone') onCreateAt?.(date, { milestone: true })
      else if (key === 'today') scrollToToday()
      else if (key === 'fit') fitToView()
      else if (key === 'resetZoom') { setAutoFit(false); setDayWidth(DEFAULT_WIDTHS[granularity]) }
    })
  }

  /* ---------- 依赖连线几何 ----------
     拖拽预览叠加：被拖任务的端点直接用 preview 值，连线实时跟随条移动，
     而不是等 pointerup 提交后才跳到新位置。 */
  const liveSummaries = useMemo(() => {
    if (!dragPreview) return summaries
    const m = new Map(summaries)
    m.set(dragPreview.taskId, { ...summaries.get(dragPreview.taskId), start: dragPreview.start, end: dragPreview.end })
    return m
  }, [summaries, dragPreview])

  const linkPaths = useMemo(() => {
    const out = []
    for (const row of rows) {
      const task = row.task
      for (const depId of task.deps || []) {
        const depRowIdx = rowIndex.get(depId)
        if (depRowIdx === undefined) continue
        const depSum = liveSummaries.get(depId)
        const mySum = liveSummaries.get(task.id)
        if (!depSum || !mySum) continue
        const x1 = (dayIndex(depSum.end) - frame.minIndex + 1) * dayWidth
        const y1 = depRowIdx * ROW_H + ROW_H / 2
        const x2 = (dayIndex(mySum.start) - frame.minIndex) * dayWidth
        const y2 = rowIndex.get(task.id) * ROW_H + ROW_H / 2
        const forward = x2 >= x1
        const midX = forward ? x1 + Math.max(14, (x2 - x1) / 2) : x1 + 16
        const d = `M ${x1} ${y1} C ${midX} ${y1}, ${forward ? midX : x2 - 16} ${y2}, ${x2} ${y2}`
        out.push({ key: `${depId}>${task.id}`, d, depId, taskId: task.id, violated: violations.has(`${depId}>${task.id}`) })
      }
    }
    return out
  }, [rows, liveSummaries, rowIndex, frame.minIndex, dayWidth, violations])

  const rubberPath = useMemo(() => {
    if (!linkDrag) return null
    const fromRow = rowIndex.get(linkDrag.fromId)
    const sum = summaries.get(linkDrag.fromId)
    if (fromRow === undefined || !sum) return null
    const x1 = (dayIndex(sum.end) - frame.minIndex + 1) * dayWidth
    const y1 = fromRow * ROW_H + ROW_H / 2
    return `M ${x1} ${y1} C ${x1 + 16} ${y1}, ${linkDrag.x - 16} ${linkDrag.y}, ${linkDrag.x} ${linkDrag.y}`
  }, [linkDrag, rowIndex, summaries, frame.minIndex, dayWidth])

  if (plan.tasks.length === 0) {
    return (
      <div className="gantt-stage">
        <div className="gt-panel">
          <div className="gt-empty">
            <div className="gt-empty-mark">▤</div>
            <p>还没有任务，点击右上「新建任务」或在时间轴空白处右键添加</p>
          </div>
        </div>
      </div>
    )
  }

  const totalDays = frame.maxIndex - frame.minIndex + 1
  /* 缩略带几何：轨道铺满「左列右侧的可用宽度」，内部按百分比定位 */
  const mmLaneWidth = Math.max(0, scrollState.width - leftCol - 24)
  const mmVisible = mmLaneWidth > 40 && timelineWidth > 0
  /* 时间轴上被视口覆盖的比例（左列之外的可见区间） */
  const visLeftPx = Math.max(0, scrollState.left - leftCol)
  const visWidthPx = Math.max(0, scrollState.width - leftCol)
  const viewLeftPct = timelineWidth > 0 ? Math.min(100, visLeftPx / timelineWidth * 100) : 0
  const viewWidthPct = timelineWidth > 0 ? Math.min(100 - viewLeftPct, Math.max(4, visWidthPx / timelineWidth * 100)) : 100

  return (
    <div className="gantt-stage">
      <div className="gt-panel">
        <div className="gantt-scroll" ref={scrollRef} style={{ '--gt-left-col': `${leftCol}px` }}>
            <div className="gantt-inner" data-scroll-left={scrollState.left > 4}>
              {/* 表头：月份带 + 日期列 */}
              <div className="g-head" style={{ '--gt-left-col': `${leftCol}px` }}>
                <div className="g-head-left">
                  <div className="g-task-search">
                    <input value={query} onChange={(e) => setQuery(e.target.value)}
                      placeholder={`搜索任务（${plan.tasks.length}）`} maxLength={60} aria-label="搜索任务" />
                    {query && (
                      <button type="button" className="g-task-search-clear" title="清除搜索"
                        onClick={() => setQuery('')}>×</button>
                    )}
                  </div>
                  <div className="gt-zoom-group">
                    <button className="gt-zoom-btn" title="适应宽度（显示全部）" onClick={fitToView}>⤢</button>
                    <button className="gt-zoom-btn" title="回到今天" onClick={scrollToToday}>◎</button>
                    <button className="gt-zoom-btn" title="缩小列宽" onClick={() => zoomBy(-4)}>−</button>
                    <button className="gt-zoom-btn" title="放大列宽" onClick={() => zoomBy(4)}>+</button>
                  </div>
                </div>
                <div className="g-head-cells" style={{ width: timelineWidth }}>
                  <div className="g-month-row">
                    {monthBands.map(band => (
                      <div key={band.key}
                        className={`g-month-band${band.current ? ' is-current' : ''}`}
                        style={{ left: band.left, width: band.width }}>
                        <span>{band.label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="g-col-row">
                    {columns.map(col => (
                      <div key={col.key}
                        className={`g-col${col.weekend ? ' is-weekend' : ''}${col.key === todayColKey ? ' is-today' : ''}${col.width < 24 ? ' is-narrow' : ''}${col.width > 120 ? ' is-wide' : ''}`}
                        style={{ left: (col.index - frame.minIndex) * dayWidth, width: col.width }}>
                        <span className="g-col-main">{col.label}</span>
                        {col.sub ? <span className="g-col-sub">{col.sub}</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="g-col-resizer" title="拖动调整任务列宽度"
                  onPointerDown={beginColResize} onPointerMove={moveColResize} onPointerUp={endColResize} />
              </div>

              {/* 行 */}
              {rows.map((row, i) => {
                const task = row.task
                const sum = summaries.get(task.id) || { start: task.start, end: task.end, progress: task.progress }
                const preview = dragPreview?.taskId === task.id ? dragPreview : null
                const vStart = preview?.start || sum.start
                const vEnd = preview?.end || sum.end
                const barLeft = (dayIndex(vStart) - frame.minIndex) * dayWidth
                const barDays = Math.max(1, diffDays(vEnd, vStart) + 1)
                const color = paletteVar(task.colorIndex)
                const isDragging = dragPreview?.taskId === task.id
                const isLinkHover = linkDrag?.hoverTaskId === task.id
                const isSelected = selectedId === task.id
                const barPx = Math.max(barDays * dayWidth, 12)
                const narrow = barPx < 64
                return (
                  <div key={task.id}
                    className={`g-row${isLinkHover ? ' is-drop-target' : ''}${isSelected ? ' is-selected' : ''}${i % 2 ? ' is-alt' : ''}`}
                    onPointerDown={() => setSelectedId(task.id)}>
                    <div className={`g-row-label${row.isParent ? ' is-parent' : ''}`}
                      style={{ paddingLeft: 6 + row.depth * 14 }}
                      onContextMenu={(e) => taskMenu(task, e)}
                      onDoubleClick={() => openTaskDialog(task)}>
                      <button className={`twist${row.isParent ? (task.collapsed ? '' : ' is-open') : ' is-hidden'}`}
                        tabIndex={-1}
                        onClick={(e) => { e.stopPropagation(); api.toggleCollapse(plan.id, task.id) }}>▶</button>
                      <span className={`task-dot${task.milestone ? ' is-milestone' : ''}`} style={{ '--gt-bar-color': color }} />
                      <span className="task-name" title={task.name}>{task.name}</span>
                      <span className={`task-prog${sum.progress >= 100 ? ' is-done' : ''}`}>{sum.progress}%</span>
                    </div>
                    <div className="g-lane" style={{ width: timelineWidth }}
                      onContextMenu={laneMenu}
                      onPointerMove={onLinkMove}
                      onPointerUp={finishLink}
                      onDoubleClick={(e) => {
                        if (e.target !== e.currentTarget) return
                        const rect = e.currentTarget.getBoundingClientRect()
                        const idx = Math.floor((e.clientX - rect.left) / dayWidth) + frame.minIndex
                        onCreateAt?.(indexToDate(idx))
                      }}>
                      {columns.map(col => (
                        <div key={col.key}
                          className={`lane-gridline${col.weekend ? ' is-weekend' : ''}${col.key === todayColKey ? ' is-today' : ''}`}
                          style={{ left: (col.index - frame.minIndex) * dayWidth, width: col.width }} />
                      ))}
                      {task.milestone ? (
                        <div className={`g-milestone${isDragging ? ' is-dragging' : ''}`}
                          style={{ left: barLeft + dayWidth / 2 - 9, '--gt-bar-color': color }}
                          title={`${task.name} · ${fmtDate(vStart)}${sum.progress ? ` · ${sum.progress}%` : ''}`}
                          onPointerDown={(e) => beginDrag(e, task, 'move')}
                          onPointerMove={onDragMove}
                          onPointerUp={finishDrag}
                          onDoubleClick={() => openTaskDialog(task)}
                          onContextMenu={(e) => taskMenu(task, e)}>
                          <span className="g-connect"
                            onPointerDown={(e) => beginLink(e, task)}
                            onPointerMove={onLinkMove}
                            onPointerUp={finishLink} />
                        </div>
                      ) : (
                        <>
                          <div className={`g-bar${row.isParent ? ' is-parent-bar' : ''}${isDragging ? ' is-dragging' : ''}${narrow ? ' is-narrow' : ''}`}
                            style={{ left: barLeft, width: barPx, '--gt-bar-color': color }}
                            title={`${task.name} · ${fmtDate(vStart)} - ${fmtDate(vEnd)} · ${sum.progress}%`}
                            onPointerDown={(e) => beginDrag(e, task, 'move')}
                            onPointerMove={onDragMove}
                            onPointerUp={finishDrag}
                            onDoubleClick={() => openTaskDialog(task)}
                            onContextMenu={(e) => taskMenu(task, e)}>
                            <div className="g-bar-fill" style={{ width: `${sum.progress}%` }} />
                            <span className="g-bar-text">{task.name}</span>
                            {!row.isParent && <>
                              <span className="g-handle w" title="拖动调整开始"
                                onPointerDown={(e) => beginDrag(e, task, 'resize-w')}
                                onPointerMove={onDragMove} onPointerUp={finishDrag} />
                              <span className="g-handle e" title="拖动调整结束"
                                onPointerDown={(e) => beginDrag(e, task, 'resize-e')}
                                onPointerMove={onDragMove} onPointerUp={finishDrag} />
                              <span className="g-connect" title="拖到其他任务建立依赖"
                                onPointerDown={(e) => beginLink(e, task)}
                                onPointerMove={onLinkMove} onPointerUp={finishLink} />
                            </>}
                          </div>
                          {narrow && (
                            <span className="g-bar-label-out" style={{ left: barLeft + barPx + 7 }}>
                              {task.name}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}

              {rows.length === 0 && (
                <div className="g-no-match">没有匹配「{query}」的任务</div>
              )}

              {/* 今天线（贯穿全部行，随内容滚动） */}
              <div className="g-today-line" style={{ left: `calc(var(--gt-left-col) + ${todayX}px)`, top: 0, height: '100%' }} />

              {/* 依赖连线层 */}
              <svg className="gantt-links"
                style={{ left: leftCol, top: HEAD_H, width: timelineWidth, height: rows.length * ROW_H }}>
                {linkPaths.map(link => (
                  <path key={link.key} d={link.d} className={link.violated ? 'is-violated' : ''}
                    onContextMenu={(e) => linkMenu(link.depId, link.taskId, e)} />
                ))}
                {rubberPath && <path d={rubberPath} className="g-link-rubber" />}
              </svg>
            </div>
          </div>

          {/* 概览缩略带：全计划压成一条，点击/拖动定位 + 视口指示 */}
          <div className={`g-minimap${mmVisible ? '' : ' is-hidden'}`} style={{ '--gt-left-col': `${leftCol}px` }}>
            <div className="g-minimap-track" style={{ left: leftCol + 12, width: mmLaneWidth }}
              onPointerDown={(e) => jumpMinimap(e)}>
              {rows.map((row, i) => {
                const sum = summaries.get(row.task.id)
                if (!sum) return null
                const l = (dayIndex(sum.start) - frame.minIndex) / totalDays * 100
                const w = Math.max(0.4, (diffDays(sum.end, sum.start) + 1) / totalDays * 100)
                return (
                  <span key={row.task.id}
                    className={`g-minimap-bar${row.isParent ? ' is-parent' : ''}`}
                    style={{
                      left: `${l}%`, width: `${w}%`,
                      top: `${(i / Math.max(1, rows.length)) * 100}%`,
                      height: `${Math.max(2, 100 / Math.max(1, rows.length) * 0.7)}%`,
                      background: paletteVar(row.task.colorIndex)
                    }} />
                )
              })}
              <span className="g-minimap-view" style={{ left: `${viewLeftPct}%`, width: `${viewWidthPct}%` }} />
              <span className="g-minimap-today" style={{
                left: `${Math.max(0, Math.min(100, (frame.todayIndex - frame.minIndex) / totalDays * 100))}%`
              }} />
            </div>
          </div>
      </div>

      {dragHint && (
        <div className={`g-drag-hint${dragHint.moved ? '' : ' is-idle'}`}
          style={{ left: dragHint.x + 14, top: dragHint.y - 36 }}>
          {dragHint.text}
        </div>
      )}
    </div>
  )

  function jumpMinimap(e) {
    const track = e.currentTarget
    const rect = track.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, leftCol + ratio * timelineWidth - (el.clientWidth - leftCol) / 2)
  }
}

/** 里程碑（单日）判定：用于拖拽气泡文案 */
function milestoneLike(start, end) {
  return start === end
}

/** 表头上行的分组带：日粒度按自然月、周粒度按周起始月、月粒度按年份 */
function bandsFor(columns, granularity, frame, dayWidth) {
  if (granularity === 'day') return buildMonthBands(frame.minIndex, frame.maxIndex, dayWidth)
  const bands = []
  let cur = null
  for (const col of columns) {
    const d = parseDate(col.date)
    if (!d) continue
    const key = granularity === 'month' ? String(d.getFullYear()) : `${d.getFullYear()}-${d.getMonth()}`
    if (!cur || cur.key !== key) {
      cur = {
        key,
        label: granularity === 'month'
          ? `${d.getFullYear()}年`
          : (d.getMonth() === 0 ? `${d.getFullYear()}年1月` : `${d.getMonth() + 1}月`),
        left: (col.index - frame.minIndex) * dayWidth,
        width: 0,
        current: granularity === 'month'
          ? new Date().getFullYear() === d.getFullYear()
          : `${new Date().getFullYear()}-${new Date().getMonth()}` === key
      }
      bands.push(cur)
    }
    cur.width += col.width
  }
  return bands
}

/** 今天所在列 key（day: d{i} / week: w{周一i} / month: m{月初i}） */
function todayKey(todayIndex, granularity) {
  if (granularity === 'day') return `d${todayIndex}`
  const d = parseDate(indexToDate(todayIndex))
  if (!d) return null
  if (granularity === 'week') {
    const monday = todayIndex - ((d.getDay() + 6) % 7)
    return `w${monday}`
  }
  return `m${dayIndex(toDateStr(new Date(d.getFullYear(), d.getMonth(), 1)))}`
}