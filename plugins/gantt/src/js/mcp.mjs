/**
 * mcp.mjs —— 甘特图 MCP 工具处理器注册
 * handler 键集合必须与 plugin.json contributes.mcpTools 完全一致（宿主注册握手
 * 逐一对比，不符即拒绝）。App 数据 ready 后注册一次、不等页面可见。
 * handler 全部走 App 内构造的 api 对象（同一 mutation + persist 路径）。
 */
import { addDays, todayStr } from './model.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const ok = (text, structured) => ({
  content: [{ type: 'text', text }],
  ...(structured !== undefined ? { structuredContent: structured } : {})
})

const err = (message) => ({ isError: true, content: [{ type: 'text', text: `执行失败：${message}` }] })

/** 参数校验/业务失败与内部异常统一转 isError 文本，绝不弹交互框 */
function wrap(run) {
  return async (args) => {
    try {
      return await run(args || {})
    } catch (error) {
      return err(error?.message || String(error))
    }
  }
}

function reqStr(value, field, max) {
  const text = String(value ?? '').trim().slice(0, max)
  if (!text) throw new Error(`${field} 不能为空`)
  return text
}

function optStr(value, max = 64) {
  if (value === undefined || value === null || value === '') return undefined
  return String(value).trim().slice(0, max)
}

function reqDate(value, field) {
  const s = String(value ?? '').trim()
  if (!DATE_RE.test(s)) throw new Error(`${field} 需为 YYYY-MM-DD 格式`)
  return s
}

function optDate(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  return reqDate(value, field)
}

function optInt(value, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new Error('数值参数无效')
  return Math.max(min, Math.min(n, max))
}

function optRangeInt(value, field, { min, max }) {
  const n = Number(value)
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
    throw new Error(`${field} 需为 ${min}-${max} 的整数`)
  }
  return n
}

function optBool(value) {
  if (value === undefined || value === null || value === '') return undefined
  return Boolean(value)
}

function planBrief(plan, stats) {
  return {
    id: plan.id, name: plan.name, taskCount: plan.tasks.length,
    progress: stats.progress, leaves: stats.leaves,
    rangeStart: stats.range.start, rangeEnd: stats.range.end,
    violations: stats.violations.length, updatedAt: plan.updatedAt
  }
}

function taskOut(t) {
  return {
    id: t.id, name: t.name, start: t.start, end: t.end,
    duration: t.duration ?? null,
    progress: t.progress, colorIndex: t.colorIndex, milestone: t.milestone,
    parentId: t.parentId, deps: t.deps, depth: t.depth, isParent: t.isParent,
    rangeStart: t.rangeStart, rangeEnd: t.rangeEnd, progressSummary: t.progressSummary,
    note: t.note, collapsed: t.collapsed, updatedAt: t.updatedAt
  }
}

export function registerGanttMcp(api) {
  const host = window.enest || window.zapi
  if (!host?.mcp?.registerHandlers) return Promise.resolve(false)
  const handlers = {
    'plans.list': wrap(async () => {
      const s = api.getState()
      const plans = s.plans.map(p => planBrief(p, api.summarizePlan(p.id)))
      return ok(`共 ${plans.length} 个计划`, { activePlanId: s.activePlanId, plans })
    }),
    'plan.create': wrap(async (args) => {
      const name = reqStr(args.name, 'name', 60)
      const plan = api.createPlan(name, { activate: args.activate !== false })
      return ok(`已创建计划「${plan.name}」(${plan.id})`, planBrief(plan, { progress: 0, leaves: 0, range: { start: plan.updatedAt.slice(0, 10), end: plan.updatedAt.slice(0, 10) }, violations: [] }))
    }),
    'plan.update': wrap(async (args) => {
      const id = reqStr(args.id, 'id', 64)
      const s = api.getState()
      const plan = s.plans.find(p => p.id === id)
      if (!plan) throw new Error('计划不存在')
      if (args.name !== undefined) api.renamePlan(id, reqStr(args.name, 'name', 60))
      if (args.activate === true) api.setActivePlan(id)
      const next = api.getState().plans.find(p => p.id === id)
      return ok(`已更新计划「${next.name}」`, planBrief(next, api.summarizePlan(id)))
    }),
    'plan.delete': wrap(async (args) => {
      const id = reqStr(args.id, 'id', 64)
      api.deletePlan(id)
      return ok(`已删除计划 ${id}`, { id })
    }),
    'tasks.list': wrap(async (args) => {
      const planId = optStr(args.planId)
      const r = api.listTasks({
        planId,
        keyword: optStr(args.keyword, 200),
        milestone: optBool(args.milestone),
        limit: optInt(args.limit, { min: 1, max: 1000, fallback: 200 })
      })
      return ok(`共 ${r.total} 个任务，返回 ${r.tasks.length} 条${r.truncated ? '（已截断，可用 limit 调大）' : ''}`, {
        total: r.total, truncated: r.truncated, tasks: r.tasks.map(taskOut)
      })
    }),
    'task.create': wrap(async (args) => {
      const patch = { name: reqStr(args.name, 'name', 200), start: reqDate(args.start, 'start') }
      if (args.duration !== undefined) {
        const d = optRangeInt(args.duration, 'duration', { min: 1, max: 365 })
        patch.duration = d
        patch.end = addDays(patch.start, d - 1)
      } else if (args.end !== undefined) {
        patch.end = optDate(args.end, 'end') || patch.start
        patch.duration = null
      } else {
        patch.end = patch.start
        patch.duration = null
      }
      if (args.progress !== undefined) patch.progress = optInt(args.progress, { min: 0, max: 100, fallback: 0 })
      if (args.colorIndex !== undefined) patch.colorIndex = optInt(args.colorIndex, { min: 0, max: 9, fallback: 0 })
      if (args.milestone !== undefined) patch.milestone = Boolean(args.milestone)
      if (args.parentId !== undefined) patch.parentId = optStr(args.parentId) || null
      if (args.deps !== undefined) patch.deps = (Array.isArray(args.deps) ? args.deps : []).slice(0, 16)
      if (args.note !== undefined) patch.note = String(args.note).slice(0, 2000)
      const t = api.createTask(optStr(args.planId), patch)
      return ok(`已创建任务「${t.name}」(${t.id})`, { ...taskOut(t), depth: null, isParent: false })
    }),
    'task.update': wrap(async (args) => {
      const id = reqStr(args.id, 'id', 64)
      const patch = {}
      if (args.name !== undefined) patch.name = reqStr(args.name, 'name', 200)
      if (args.start !== undefined) patch.start = reqDate(args.start, 'start')
      if (args.duration !== undefined) {
        const d = optRangeInt(args.duration, 'duration', { min: 1, max: 365 })
        patch.duration = d
        if (d) patch.end = addDays(patch.start ?? api.getPlan(optStr(args.planId))?.tasks.find(t => t.id === id)?.start ?? todayStr(), d - 1)
      } else if (args.end !== undefined) {
        patch.end = optDate(args.end, 'end')
        patch.duration = null
      }
      if (args.progress !== undefined) patch.progress = optInt(args.progress, { min: 0, max: 100, fallback: 0 })
      if (args.colorIndex !== undefined) patch.colorIndex = optInt(args.colorIndex, { min: 0, max: 9, fallback: 0 })
      if (args.milestone !== undefined) patch.milestone = Boolean(args.milestone)
      if (args.parentId !== undefined) patch.parentId = optStr(args.parentId) || null
      if (args.deps !== undefined) patch.deps = (Array.isArray(args.deps) ? args.deps : []).slice(0, 16)
      if (args.note !== undefined) patch.note = String(args.note).slice(0, 2000)
      if (args.collapsed !== undefined) patch.collapsed = Boolean(args.collapsed)
      if (!Object.keys(patch).length) throw new Error('至少提供一个可更新字段')
      const t = api.patchTask(optStr(args.planId), id, patch)
      return ok(`已更新任务「${t.name}」(${t.id})`, { ...taskOut(t), depth: null, isParent: undefined })
    }),
    'task.delete': wrap(async (args) => {
      const id = reqStr(args.id, 'id', 64)
      const t = api.deleteTask(optStr(args.planId), id)
      return ok(`已删除任务「${t.name}」`, { id })
    }),
    'plan.summary': wrap(async (args) => {
      const planId = optStr(args.planId)
      const plan = api.getPlan(planId)
      if (!plan) throw new Error('计划不存在')
      const stats = api.summarizePlan(plan.id)
      const byId = new Map(plan.tasks.map(t => [t.id, t]))
      return ok(`计划「${plan.name}」：${stats.leaves} 项任务，平均进度 ${stats.progress}%`, {
        plan: planBrief(plan, stats),
        status: stats.status,
        milestones: plan.tasks.filter(t => t.milestone).map(t => ({ id: t.id, name: t.name, date: t.start })),
        violations: stats.violations.map(v => ({
          task: byId.get(v.taskId)?.name, dep: byId.get(v.depId)?.name,
          taskStart: v.taskStart, depEnd: v.depEnd
        }))
      })
    })
  }
  return host.mcp.registerHandlers(handlers).then(() => true)
}
