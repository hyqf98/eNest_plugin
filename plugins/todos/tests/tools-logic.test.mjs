// 纯逻辑自测：复刻三个插件中与 UI 解耦的核心算法，验证行为与向后兼容。
// 运行：node --test scripts/tests/agent-a-tools-logic.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

// —— 番茄钟：统计聚合（今日 / 近 7 天 / 周图） ——
const dayKey = (ts) => new Date(ts).toLocaleDateString()
function summarize(records, now = Date.now()) {
  const completed = records.filter((r) => r.counted)
  const weekStart = new Date(now)
  weekStart.setHours(0, 0, 0, 0)
  weekStart.setDate(weekStart.getDate() - 6)
  const today = completed.filter((r) => dayKey(r.endedAt) === dayKey(now))
  const week = completed.filter((r) => r.endedAt >= weekStart.getTime())
  const minutes = Math.round(
    today.reduce((sum, r) => sum + r.durationMs, 0) / 60000,
  )
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    return {
      count: completed.filter((r) => dayKey(r.endedAt) === dayKey(d)).length,
    }
  })
  return { todayCount: today.length, minutes, weekCount: week.length, days }
}

test('番茄钟统计：跳过/不计入的记录不进统计', () => {
  const now = Date.now()
  const records = [
    { counted: true, endedAt: now, durationMs: 25 * 60000 },
    { counted: false, endedAt: now, durationMs: 25 * 60000 },
    { counted: true, endedAt: now - 3 * 86400000, durationMs: 50 * 60000 },
    { counted: true, endedAt: now - 30 * 86400000, durationMs: 10 * 60000 },
  ]
  const s = summarize(records, now)
  assert.equal(s.todayCount, 1)
  assert.equal(s.minutes, 25)
  assert.equal(s.weekCount, 2)
  assert.equal(s.days.length, 7)
  assert.equal(s.days[6].count, 1)
})

test('番茄钟统计：空记录不除零', () => {
  const s = summarize([], Date.now())
  assert.equal(s.todayCount, 0)
  assert.equal(s.minutes, 0)
})

// —— 待办：order 排序向后兼容 ——
function sortTasks(tasks) {
  const hasOrder = tasks.some((t) => t.order !== null && t.order !== undefined)
  return [...tasks].sort((a, b) => {
    if (Number(a.done) !== Number(b.done)) return Number(a.done) - Number(b.done)
    if (hasOrder) {
      const ao = a.order ?? Number.MAX_SAFE_INTEGER,
        bo = b.order ?? Number.MAX_SAFE_INTEGER
      if (ao !== bo) return ao - bo
    }
    return b.createdAt - a.createdAt
  })
}

test('待办排序：order 值优先，null 兜底按创建时间', () => {
  const base = Date.now()
  const tasks = [
    { id: 'a', order: null, createdAt: base, done: false },
    { id: 'b', order: 1, createdAt: base - 1000, done: false },
    { id: 'c', order: 0, createdAt: base - 2000, done: false },
    { id: 'd', order: null, createdAt: base - 3000, done: false },
  ]
  const sorted = sortTasks(tasks)
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['c', 'b', 'a', 'd'],
  )
})

test('待办排序：完成项始终沉底（order 之前先比 done）', () => {
  const base = Date.now()
  const tasks = [
    { id: 'done-first', order: 0, createdAt: base, done: true },
    { id: 'open', order: 5, createdAt: base - 1000, done: false },
  ]
  const sorted = sortTasks(tasks)
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['open', 'done-first'],
  )
})

test('待办排序：完全没有 order 字段时保持旧排序（时间倒序）', () => {
  const base = Date.now()
  const tasks = [
    { id: 'new', createdAt: base },
    { id: 'old', createdAt: base - 5000 },
  ]
  const sorted = sortTasks(tasks)
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['new', 'old'],
  )
})

test('待办 normalize：旧 v2 数据（无 order）读入后 order 为 null', () => {
  const normalize = (t) => ({
    id: t.id,
    order: Number.isFinite(t.order) ? t.order : null,
  })
  assert.equal(normalize({ id: 'x' }).order, null)
  assert.equal(normalize({ id: 'x', order: 3 }).order, 3)
  assert.equal(normalize({ id: 'x', order: 'bad' }).order, null)
})

// —— 待办：到期状态 ——
function dueState(due, done, day) {
  if (!due || done) return ''
  if (due < day) return 'overdue'
  if (due === day) return 'due-today'
  return ''
}
test('到期状态：过期 / 今天 / 未来', () => {
  assert.equal(dueState('2026-10-01', false, '2026-10-15'), 'overdue')
  assert.equal(dueState('2026-10-15', false, '2026-10-15'), 'due-today')
  assert.equal(dueState('2026-10-20', false, '2026-10-15'), '')
  assert.equal(dueState('2026-10-01', true, '2026-10-15'), '')
  assert.equal(dueState('', false, '2026-10-15'), '')
})

// —— 备忘录：相对时间 ——
function relTime(ts, now) {
  const diff = now - ts,
    min = 60000,
    hour = 60 * min,
    day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 2 * day) return '昨天'
  return new Date(ts).toLocaleDateString()
}
test('备忘录相对时间阶梯', () => {
  const now = Date.now()
  assert.equal(relTime(now - 10_000, now), '刚刚')
  assert.equal(relTime(now - 5 * 60000, now), '5 分钟前')
  assert.equal(relTime(now - 3 * 3600000, now), '3 小时前')
  assert.equal(relTime(now - 30 * 3600000, now), '昨天')
})

// —— 备忘录：字数统计（CJK 按字计，英文按词计） ——
function wordCount(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const words = text
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  return { chars: text.length, words: cjk + words }
}
test('备忘录字数：中英混排', () => {
  assert.deepEqual(wordCount('你好世界'), { chars: 4, words: 4 })
  assert.deepEqual(wordCount('hello world'), { chars: 11, words: 2 })
  assert.deepEqual(wordCount('记 one note'), { chars: 10, words: 3 })
  assert.deepEqual(wordCount(''), { chars: 0, words: 0 })
})

// —— 备忘录：颜色过滤与计数 ——
function visibleNotes(notes, { color }) {
  return notes.filter(
    (n) => !n.deletedAt && !n.archived && (!color || n.color === color),
  )
}
test('备忘录颜色过滤：旧数据无 color 概念仍可读', () => {
  const notes = [
    { color: '#cfa467', deletedAt: null, archived: false },
    { color: '#cfa467', deletedAt: Date.now(), archived: false },
    { color: '#7b9ebc', deletedAt: null, archived: true },
    { color: '#7b9ebc', deletedAt: null, archived: false },
  ]
  assert.equal(visibleNotes(notes, { color: '' }).length, 2)
  assert.equal(visibleNotes(notes, { color: '#cfa467' }).length, 1)
  assert.equal(visibleNotes(notes, { color: '#7b9ebc' }).length, 1)
})
