/**
 * App.jsx —— 甘特图插件主组件
 * 状态（gantt_v1）经 kit.load/save 持久化；mutation api 同时供 UI 与 MCP
 * handler 复用（同一持久化路径）。MCP 注册不等页面可见（todos 模式）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  STORE_KEY, emptyState, validateState, makeTask, makePlan, summarize,
  flattenTasks, planStats, todayStr, addDays, genId, autoSchedule
} from '../js/model.mjs'
import { DEFAULT_WIDTHS } from '../js/timeScale.mjs'
import { GanttChart } from './GanttChart.jsx'
import { PlanSidebar } from './PlanSidebar.jsx'
import { TaskDialog } from './TaskDialog.jsx'
import { PromptDialog } from '../ui/index.jsx'
import { registerGanttMcp } from '../js/mcp.mjs'
import { exportPlanXlsx } from '../js/exportXlsx.mjs'
import { exportPlanHtml } from '../js/exportHtml.mjs'

const GRAN_LABELS = { day: '日', week: '周', month: '月' }

export function App() {
  const kitRef = useRef(null)
  if (!kitRef.current) kitRef.current = PluginKit.create()
  const kit = kitRef.current

  const [ready, setReady] = useState(false)
  const [state, setState] = useState(null)
  const [granularity, setGranularity] = useState('day')
  const [dayWidth, setDayWidth] = useState(DEFAULT_WIDTHS.day)
  const [dialog, setDialog] = useState(null) // null | {task} | {defaults}
  // 单行文本输入（重命名、改时长）：window.prompt 在 Electron 渲染进程里恒返回 null，统一走 PromptDialog
  const [prompt, setPrompt] = useState(null) // null | {title, defaultValue, resolve}
  const mcpApiRef = useRef(null)

  /* ---------- 载入 ---------- */
  useEffect(() => {
    let disposed = false
    ;(async () => {
      let data = await kit.load(STORE_KEY, null).catch(() => null)
      if (disposed) return
      if (!data) {
        data = emptyState()
        await kit.save(STORE_KEY, data).catch(() => {})
      } else if (!validateState(data)) {
        data = emptyState()
        // 校验失败不覆盖原数据：换 key 备份后重建（todos 惯例）
        await kit.save(`${STORE_KEY}_backup_${Date.now()}`, data).catch(() => {})
        kit.toast('甘特图数据格式异常，已重建示例计划（原数据已备份）', 'warn')
      }
      if (disposed) return
      setState(data)
      setReady(true)
    })()
    return () => { disposed = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 持久化 + 撤销栈 ----------
     所有变更都经 persist/mutatePlan 收口：变更前把旧快照压入 undo 栈，
     ⌘Z 撤销 / ⇧⌘Z（Ctrl+Y）重做。快照是整个 state（含 activePlanId），
     MCP handler 走同一路径所以同样可撤销。 */
  const historyRef = useRef({ undo: [], redo: [] })

  const pushHistory = useCallback((snapshot) => {
    if (!snapshot) return
    const h = historyRef.current
    h.undo.push(snapshot)
    if (h.undo.length > 60) h.undo.shift()
    h.redo.length = 0
  }, [])

  const persist = useCallback((next) => {
    pushHistory(stateRef.current)
    setState(next)
    void kit.save(STORE_KEY, next)
  }, [kit, pushHistory])

  const mutatePlan = useCallback((planId, fn) => {
    setState(prev => {
      const plan = prev.plans.find(p => p.id === planId)
      if (!plan) return prev
      const tasks = fn(plan.tasks)
      if (tasks === plan.tasks) return prev
      pushHistory(prev)
      const next = {
        ...prev,
        plans: prev.plans.map(p => p.id === planId
          ? { ...p, tasks, updatedAt: new Date().toISOString() }
          : p)
      }
      void kit.save(STORE_KEY, next)
      return next
    })
  }, [kit, pushHistory])

  const undo = useCallback(() => {
    const h = historyRef.current
    const prev = h.undo.pop()
    if (!prev) { kit.toast('没有可撤销的操作', 'warn'); return false }
    h.redo.push(stateRef.current)
    setState(prev)
    void kit.save(STORE_KEY, prev)
    kit.toast('已撤销')
    return true
  }, [kit])

  const redo = useCallback(() => {
    const h = historyRef.current
    const next = h.redo.pop()
    if (!next) { kit.toast('没有可重做的操作', 'warn'); return false }
    h.undo.push(stateRef.current)
    setState(next)
    void kit.save(STORE_KEY, next)
    kit.toast('已重做')
    return true
  }, [kit])

  /* ---------- mutation api（UI 与 MCP 共用） ---------- */
  const api = useMemo(() => {
    const getState = () => stateRef.current
    return {
      toast: (msg, type) => kit.toast(msg, type),
      openMenu: (...args) => PluginKit.openMenu(...args),
      undo,
      redo,
      getState,
      getActivePlan: () => {
        const s = stateRef.current
        return s?.plans.find(p => p.id === s.activePlanId) || s?.plans[0] || null
      },
      getPlan: (planId) => {
        const s = stateRef.current
        if (planId) return s.plans.find(p => p.id === planId) || null
        return api.getActivePlan()
      },

      /* 计划 */
      createPlan: (name, { activate = true } = {}) => {
        const s = stateRef.current
        const planName = String(name || `计划 ${s.plans.length + 1}`).slice(0, 60)
        const plan = makePlan({ name: planName })
        const next = { ...s, plans: [...s.plans, plan], ...(activate ? { activePlanId: plan.id } : {}) }
        persist(next)
        return plan
      },
      renamePlan: (planId, name) => {
        const s = stateRef.current
        const next = {
          ...s,
          plans: s.plans.map(p => p.id === planId ? { ...p, name: String(name).slice(0, 60), updatedAt: new Date().toISOString() } : p)
        }
        persist(next)
        return next.plans.find(p => p.id === planId)
      },
      deletePlan: (planId) => {
        const s = stateRef.current
        if (s.plans.length <= 1) throw new Error('至少保留一个计划')
        const idx = s.plans.findIndex(p => p.id === planId)
        if (idx < 0) throw new Error('计划不存在')
        const plans = s.plans.filter(p => p.id !== planId)
        const next = { ...s, plans, activePlanId: s.activePlanId === planId ? (plans[Math.min(idx, plans.length - 1)]?.id || plans[0].id) : s.activePlanId }
        persist(next)
        return { deleted: true }
      },
      setActivePlan: (planId) => {
        const s = stateRef.current
        if (!s.plans.some(p => p.id === planId)) throw new Error('计划不存在')
        persist({ ...s, activePlanId: planId })
        return true
      },

      /* 任务 */
      createTask: (planId, patch) => {
        const plan = api.getPlan(planId)
        if (!plan) throw new Error('计划不存在')
        const task = makeTask(patch)
        const parentOk = !task.parentId || plan.tasks.some(t => t.id === task.parentId)
        if (!parentOk) throw new Error('父任务不存在')
        mutatePlan(plan.id, tasks => autoSchedule([...tasks, task]))
        return task
      },
      patchTask: (planId, taskId, patch) => {
        const plan = api.getPlan(planId)
        if (!plan) throw new Error('计划不存在')
        const target = plan.tasks.find(t => t.id === taskId)
        if (!target) throw new Error('任务不存在')
        const merged = { ...target, ...patch, id: taskId, updatedAt: new Date().toISOString() }
        if (merged.milestone) { merged.end = merged.start; merged.duration = null }
        else if (merged.duration) { merged.end = addDays(merged.start, merged.duration - 1) }
        else if (merged.end < merged.start) { merged.end = merged.start }
        merged.progress = Math.max(0, Math.min(100, Math.round(merged.progress ?? 0)))
        merged.colorIndex = Math.max(0, Math.min(9, Math.round(merged.colorIndex ?? 0)))
        if (merged.parentId === taskId) merged.parentId = null
        mutatePlan(plan.id, tasks => autoSchedule(tasks.map(t => t.id === taskId ? merged : t)))
        return merged
      },
      deleteTask: (planId, taskId) => {
        const plan = api.getPlan(planId)
        if (!plan) throw new Error('计划不存在')
        const target = plan.tasks.find(t => t.id === taskId)
        if (!target) throw new Error('任务不存在')
        // 子任务上提一级；依赖引用清除
        mutatePlan(plan.id, tasks => tasks
          .filter(t => t.id !== taskId)
          .map(t => ({
            ...t,
            parentId: t.parentId === taskId ? target.parentId : t.parentId,
            deps: (t.deps || []).filter(d => d !== taskId)
          })))
        return target
      },
      duplicateTask: (planId, taskId) => {
        const plan = api.getPlan(planId)
        if (!plan) throw new Error('计划不存在')
        const target = plan.tasks.find(t => t.id === taskId)
        if (!target) throw new Error('任务不存在')
        const copy = makeTask({ ...target, name: `${target.name} 副本` })
        const idx = plan.tasks.findIndex(t => t.id === taskId)
        mutatePlan(plan.id, tasks => {
          const next = [...tasks]
          next.splice(idx + 1, 0, copy)
          return next
        })
        return copy
      },
      toggleCollapse: (planId, taskId) => {
        mutatePlan(planId, tasks => tasks.map(t => t.id === taskId ? { ...t, collapsed: !t.collapsed } : t))
        return true
      },
      /** level: -1 升级（脱离父任务） 1 降级（挂到上一同级任务下） */
      moveTaskLevel: (planId, taskId, dir) => {
        const plan = api.getPlan(planId)
        if (!plan) throw new Error('计划不存在')
        const flat = flattenTasks(plan.tasks)
        const idx = flat.findIndex(r => r.task.id === taskId)
        if (idx < 0) throw new Error('任务不存在')
        const cur = flat[idx]
        if (dir === -1) {
          if (!cur.task.parentId) return null
          const parent = plan.tasks.find(t => t.id === cur.task.parentId)
          mutatePlan(plan.id, tasks => tasks.map(t => t.id === taskId ? { ...t, parentId: parent?.parentId ?? null } : t))
          return true
        }
        // 降级：挂到前一个可见任务（需有子任务能力，即前一行任务）
        const prev = flat[idx - 1]
        if (!prev) throw new Error('上面没有任务可作为父任务')
        if (prev.task.id === cur.task.parentId) return null
        mutatePlan(plan.id, tasks => tasks.map(t => t.id === taskId ? { ...t, parentId: prev.task.id } : t))
        return true
      },

      /* 查询（MCP/导出共用） */
      listTasks: ({ planId, keyword, milestone, limit = 200 } = {}) => {
        const plan = api.getPlan(planId)
        if (!plan) throw new Error('计划不存在')
        const summaries = summarize(plan.tasks)
        const flat = flattenTasks(plan.tasks, { respectCollapsed: false })
        const q = String(keyword || '').trim().toLowerCase()
        let list = flat.map(r => ({
          ...r.task,
          depth: r.depth,
          isParent: r.isParent,
          rangeStart: summaries.get(r.task.id)?.start,
          rangeEnd: summaries.get(r.task.id)?.end,
          progressSummary: summaries.get(r.task.id)?.progress
        }))
        if (q) list = list.filter(t => t.name.toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q))
        if (milestone === true) list = list.filter(t => t.milestone)
        if (milestone === false) list = list.filter(t => !t.milestone)
        const total = list.length
        const truncated = total > limit
        return { total, truncated, tasks: list.slice(0, limit) }
      },
      summarizePlan: (planId) => {
        const plan = api.getPlan(planId)
        if (!plan) throw new Error('计划不存在')
        return planStats(plan)
      }
    }
  }, [kit, persist, mutatePlan, undo, redo])

  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { mcpApiRef.current = api }, [api])

  /* ---------- 撤销/重做快捷键：⌘Z / Ctrl+Z 撤销，⇧⌘Z / Ctrl+Y 重做 ---------- */
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  /* ---------- MCP 注册（数据 ready 后立即，不等页面可见） ---------- */
  useEffect(() => {
    if (!ready) return
    registerGanttMcp(mcpApiRef.current).catch(() => {})
  }, [ready])

  /* ---------- 导出 ---------- */
  const doExport = useCallback(async (plan, kind) => {
    try {
      const date = todayStr()
      if (kind === 'xlsx') {
        const dataUrl = await exportPlanXlsx(plan)
        await kit.saveFile(`甘特图-${plan.name}-${date}.xlsx`, dataUrl)
      } else {
        const html = exportPlanHtml(plan)
        await kit.saveText(`甘特图-${plan.name}-${date}.html`, html)
      }
    } catch (e) {
      if (e?.message !== '已取消') kit.toast(e?.message || '导出失败', 'error')
    }
  }, [kit])

  /* ---------- 渲染 ---------- */
  if (!ready || !state) {
    return <div className="gt-app"><div className="pk-empty-state" role="status">正在读取计划…</div></div>
  }

  const plan = state.plans.find(p => p.id === state.activePlanId) || state.plans[0]
  const stats = planStats(plan)
  const violations = stats.violations.length

  const openNewTask = (defaults) => setDialog({ defaults: defaults || {} })
  const openEditTask = (task) => setDialog({ task })
  const onCreateAt = (date, opts) => setDialog({ defaults: { start: date, end: date, ...(opts || {}) } })
  const askText = (title, defaultValue = '') => new Promise((resolve) => setPrompt({ title, defaultValue, resolve }))

  return (
    <div className="gt-app">
      <header>
        <div className="gt-plan-title">
          <h1>{plan.name}</h1>
          <span className="gt-plan-meta">
            {stats.leaves} 项任务 · {stats.progress}%{stats.milestones ? ` · ${stats.milestones} 里程碑` : ''}
          </span>
        </div>
        <div className="gt-toolbar-spacer" />
        <div className="gt-toolbar-group" role="group" aria-label="时间粒度">
          {Object.entries(GRAN_LABELS).map(([key, label]) => (
            <button key={key}
              className={`pk-btn pk-btn-sm gt-gran${granularity === key ? ' is-active' : ''}`}
              onClick={() => {
                setGranularity(key)
                setDayWidth(DEFAULT_WIDTHS[key])
              }}
              aria-pressed={granularity === key}>
              {label}
            </button>
          ))}
        </div>
        <button className="pk-btn pk-btn-sm" onClick={() => doExport(plan, 'xlsx')}>导出 Excel</button>
        <button className="pk-btn pk-btn-sm" onClick={() => doExport(plan, 'html')}>导出 HTML</button>
        <button className="pk-btn pk-btn-sm pk-btn-primary" onClick={() => openNewTask()}>+ 新建任务</button>
      </header>

      <div className="gt-body">
        <PlanSidebar state={state} activePlan={plan} api={api} onExport={doExport} askText={askText} />
        <GanttChart
          plan={plan}
          granularity={granularity}
          dayWidth={dayWidth}
          setDayWidth={setDayWidth}
          api={api}
          openTaskDialog={openEditTask}
          onCreateAt={onCreateAt}
          askText={askText}
        />
      </div>

      <footer className="gantt-foot">
        <span>{stats.status.done} 已完成</span>
        <span>{stats.status.ongoing} 进行中</span>
        <span>{stats.status.todo} 待开始</span>
        {stats.status.overdue > 0 && <span className="gt-foot-warn">{stats.status.overdue} 已逾期</span>}
        {violations > 0 && <span className="gt-foot-warn">{violations} 依赖冲突</span>}
        <span style={{ flex: 1 }} />
        <span>拖动条移动 · 拖两端改期 · 拖条尾圆点连线 · 右键更多 · ⌘Z 撤销</span>
      </footer>

      <TaskDialog
        open={dialog !== null}
        onOpenChange={(open) => { if (!open) setDialog(null) }}
        plan={plan}
        editing={dialog}
        api={api}
      />

      {prompt && (
        <PromptDialog
          title={prompt.title}
          defaultValue={prompt.defaultValue}
          onCancel={() => { prompt.resolve(null); setPrompt(null) }}
          onSubmit={(value) => { prompt.resolve(value); setPrompt(null) }}
        />
      )}
    </div>
  )
}
