/**
 * model.mjs —— 甘特图数据模型与纯逻辑
 * 日期统一 'YYYY-MM-DD' 字符串；任务树以 parentId 组织，deps 为前置任务 id
 * 列表（完成-开始依赖）。所有视图/mcp/导出共用这里的派生计算，不在调用方散落。
 */

export const STORE_KEY = 'gantt_v1'
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const MIN_DATE = '1970-01-01'
export const MAX_DATE = '9999-12-31'
export const PALETTE_SIZE = 10

/* ---------- 日期工具（本地时区，无第三方库） ---------- */

export function todayStr() {
  return toDateStr(new Date())
}

export function toDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseDate(str) {
  if (!DATE_RE.test(str || '')) return null
  const [y, m, d] = str.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

export function addDays(str, n) {
  const d = parseDate(str)
  if (!d) return null
  d.setDate(d.getDate() + n)
  return toDateStr(d)
}

export function diffDays(a, b) {
  const da = parseDate(a)
  const db = parseDate(b)
  if (!da || !db) return 0
  return Math.round((da - db) / 86400000)
}

export function cmpDate(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export function clampDate(str) {
  if (str < MIN_DATE) return MIN_DATE
  if (str > MAX_DATE) return MAX_DATE
  return str
}

/** 格式化为显示用：M月D日 / YYYY年M月 */
export function fmtDate(str, { withYear = false } = {}) {
  const d = parseDate(str)
  if (!d) return str
  return withYear || d.getFullYear() !== new Date().getFullYear()
    ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getMonth() + 1}月${d.getDate()}日`
}

/* ---------- id 与数据构造 ---------- */

let idSeq = 0
export function genId(prefix = 't') {
  idSeq = (idSeq + 1) % 1679616 // 36^4
  return `${prefix}${Date.now().toString(36)}${String(idSeq).padStart(4, '0')}${Math.random().toString(36).slice(2, 5)}`
}

export function makeTask({ name, start, end, progress = 0, colorIndex = 0, milestone = false, parentId = null, deps = [], note = '', date = null } = {}) {
  const s = clampDate(String(start || '').slice(0, 10))
  let e = clampDate(String(end || '').slice(0, 10))
  if (e < s) e = s
  return {
    id: genId('t'),
    name: String(name || '未命名任务').slice(0, 200),
    start: s,
    end: milestone ? s : e,
    progress: Math.max(0, Math.min(100, Math.round(Number(progress) || 0))),
    colorIndex: Math.max(0, Math.min(PALETTE_SIZE - 1, Math.round(Number(colorIndex) || 0))),
    milestone: Boolean(milestone),
    parentId: parentId || null,
    deps: Array.isArray(deps) ? [...new Set(deps.filter(Boolean))].slice(0, 16) : [],
    collapsed: false,
    note: String(note || '').slice(0, 2000),
    createdAt: date || new Date().toISOString(),
    updatedAt: date || new Date().toISOString()
  }
}

export function makePlan({ name, tasks = [] } = {}) {
  const now = new Date().toISOString()
  return { id: genId('p'), name: String(name || '未命名计划').slice(0, 60), tasks, createdAt: now, updatedAt: now }
}

export function emptyState() {
  const plan = makePlan({ name: '示例计划' })
  plan.tasks = sampleTasks()
  return { version: 1, activePlanId: plan.id, plans: [plan] }
}

/** 首次创建的演示数据（仅当 storage 为空时写入）；后继任务从前置结束次日开始，避免演示态就报依赖冲突 */
function sampleTasks() {
  const base = addDays(todayStr(), -6)
  const mk = (name, offset, len, progress, colorIndex, extra = {}) =>
    makeTask({ name, start: addDays(base, offset), end: addDays(base, offset + len - 1), progress, colorIndex, ...extra })
  const kickoff = mk('项目启动', 0, 3, 100, 0)
  const design = mk('方案设计', 3, 5, 80, 1, { deps: [kickoff.id] })
  const develop = mk('功能开发', 8, 10, 45, 2, { deps: [design.id] })
  const front = makeTask({ name: '前端开发', start: develop.start, end: develop.end, progress: 60, colorIndex: 2, parentId: develop.id })
  const back = makeTask({ name: '后端开发', start: develop.start, end: addDays(develop.start, 7), progress: 30, colorIndex: 6, parentId: develop.id })
  const qa = mk('测试验收', 18, 5, 0, 3, { deps: [develop.id] })
  const release = makeTask({ name: '版本发布', start: addDays(qa.end, 1), end: addDays(qa.end, 1), progress: 0, colorIndex: 5, milestone: true, deps: [qa.id] })
  return [kickoff, design, develop, front, back, qa, release]
}

/* ---------- 校验 ---------- */

export function validateState(data) {
  if (!data || typeof data !== 'object') return null
  if (data.version !== 1) return null
  if (!Array.isArray(data.plans) || data.plans.length === 0) return null
  const seen = new Set()
  for (const plan of data.plans) {
    if (!plan || typeof plan.id !== 'string' || seen.has(plan.id)) return null
    seen.add(plan.id)
    if (!Array.isArray(plan.tasks)) return null
  }
  if (!data.plans.some(p => p.id === data.activePlanId)) return null
  return data
}

/* ---------- 树结构派生 ---------- */

/** 展示顺序（父任务后紧跟子任务，递归）。返回带 depth/isParent 的浅拷贝数组 */
export function flattenTasks(tasks, { respectCollapsed = true } = {}) {
  const childrenOf = new Map()
  const roots = []
  for (const t of tasks) {
    const parent = t.parentId && tasks.some(x => x.id === t.parentId) && t.parentId !== t.id ? t.parentId : null
    if (parent) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent).push(t)
    } else roots.push(t)
  }
  const out = []
  const walk = (list, depth) => {
    for (const t of list) {
      const kids = childrenOf.get(t.id) || []
      out.push({ task: t, depth, isParent: kids.length > 0 })
      if (kids.length && !(respectCollapsed && t.collapsed)) walk(kids, depth + 1)
    }
  }
  walk(roots, 0)
  return out
}

/** 叶子任务集合（无子任务者）。父任务进度/区间由叶子汇总 */
export function leafMap(tasks) {
  const hasChild = new Set(tasks.filter(t => t.parentId).map(t => t.parentId))
  return new Map(tasks.filter(t => !hasChild.has(t.id)).map(t => [t.id, t]))
}

/** 汇总父任务区间与进度；返回 Map<taskId, {start,end,progress,leafCount}> */
export function summarize(tasks) {
  const childrenOf = new Map()
  for (const t of tasks) {
    if (!t.parentId) continue
    if (!childrenOf.has(t.parentId)) childrenOf.set(t.parentId, [])
    childrenOf.get(t.parentId).push(t)
  }
  const result = new Map()
  const calc = (task) => {
    if (result.has(task.id)) return result.get(task.id)
    const kids = childrenOf.get(task.id) || []
    if (!kids.length) {
      const own = { start: task.start, end: task.milestone ? task.start : task.end, progress: task.progress, leafCount: 1 }
      result.set(task.id, own)
      return own
    }
    let start = MAX_DATE
    let end = MIN_DATE
    let progressSum = 0
    let leafCount = 0
    for (const kid of kids) {
      const sub = calc(kid)
      if (sub.start < start) start = sub.start
      if (sub.end > end) end = sub.end
      progressSum += sub.progress * sub.leafCount
      leafCount += sub.leafCount
    }
    const own = { start, end, progress: leafCount ? Math.round(progressSum / leafCount) : task.progress, leafCount }
    result.set(task.id, own)
    return own
  }
  for (const t of tasks) calc(t)
  return result
}

/* ---------- 依赖 ---------- */

/** deps 是否会成环（新增 from -> to 之后 from 依赖链上是否出现 to） */
export function wouldCycle(tasks, fromId, toId) {
  // toId 将依赖 fromId（fromId 为前置）。检查 fromId 的依赖链是否已含 toId
  const byId = new Map(tasks.map(t => [t.id, t]))
  const seen = new Set()
  const stack = [fromId]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === toId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    const task = byId.get(cur)
    if (task) for (const dep of task.deps) stack.push(dep)
  }
  return false
}

/** 汇总后的依赖冲突：后置任务 start 早于任一前置的 end+1（FS 约束） */
export function dependencyViolations(tasks, summaries) {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const out = []
  for (const t of tasks) {
    for (const depId of t.deps) {
      const dep = byId.get(depId)
      if (!dep) continue
      const depEnd = summaries.get(depId)?.end ?? dep.end
      const taskStart = summaries.get(t.id)?.start ?? t.start
      if (taskStart <= depEnd) out.push({ taskId: t.id, depId, taskStart, depEnd })
    }
  }
  return out
}

/** 任务状态：done(100%) / ongoing(今天在区间内) / todo / overdue(end < 今天且未完成) */
export function taskStatus(task, summary, today = todayStr()) {
  const s = summary || { start: task.start, end: task.end, progress: task.progress }
  if (s.progress >= 100) return 'done'
  if (s.end < today) return 'overdue'
  if (s.start <= today) return 'ongoing'
  return 'todo'
}

/** 计划统计 */
export function planStats(plan) {
  const summaries = summarize(plan.tasks)
  const today = todayStr()
  const leaves = [...leafMap(plan.tasks).values()]
  const range = { start: MAX_DATE, end: MIN_DATE }
  let progressSum = 0
  const status = { done: 0, ongoing: 0, todo: 0, overdue: 0 }
  let milestones = 0
  for (const t of plan.tasks) {
    const s = summaries.get(t.id)
    if (s.start < range.start) range.start = s.start
    if (s.end > range.end) range.end = s.end
    if (t.milestone) milestones++
  }
  for (const leaf of leaves) {
    progressSum += leaf.progress
    status[taskStatus(leaf, summaries.get(leaf.id), today)]++
  }
  const total = leaves.length
  return {
    total: plan.tasks.length,
    leaves: total,
    progress: total ? Math.round(progressSum / total) : 0,
    range: total || plan.tasks.length ? range : { start: today, end: today },
    milestones,
    status,
    violations: dependencyViolations(plan.tasks, summaries)
  }
}
