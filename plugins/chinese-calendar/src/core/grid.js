/**
 * 月网格数据 —— 纯函数，输出固定 42 格（6 行 × 7 列）。
 * startWeekday：0 周日起 / 1 周一起。
 * visibleTypes：副行显示哪些节日类型（legal 始终显示）。
 */
import { addDays, daysInMonth, weekOrder } from './dates.js'
import { dayInfo } from './calendar.js'
import { collectFestivals, primaryFestival } from './festivals.js'
import { legalOfDay } from './holidays.js'

/**
 * 返回 42 个格子：{ key, y, m, d, outside, info, sub, subKind, tag }
 *   outside  = 不属于当前展示月份
 *   sub      = 副行文案（节日 > 节气 > 农历日）
 *   subKind  = 副行着色类型
 *   tag      = 'rest' | 'work' | null（休/班角标）
 */
export function monthCells(range, { startWeekday, visibleTypes } = {}) {
  // 同时接受 { year, month } 与 dates.js 的 { y, m }
  const year = range?.year ?? range?.y
  const month = range?.month ?? range?.m
  // 非法的周起始（undefined / 越界）回退周日；不要让一格坏数据污染整张网格
  const weekStart = startWeekday === 1 ? 1 : 0
  const first = { y: year, m: month, d: 1 }
  const offset = (new Date(year, month - 1, 1).getDay() - weekStart + 7) % 7
  const start = addDays(first, -offset)
  const cells = []
  for (let i = 0; i < 42; i++) {
    const date = addDays(start, i)
    const info = dayInfo(date)
    const outside = date.m !== month
    const festivals = collectFestivals(date)
    const primary = primaryFestival(festivals, visibleTypes)
    const legal = legalOfDay(date)
    let sub = info?.lunar.day ?? ''
    let subKind = null
    if (primary) { sub = primary.short; subKind = primary.type }
    else if (info?.term.isTermDay && (!visibleTypes || visibleTypes.has('term'))) { sub = info.term.name; subKind = 'term' }
    else if (info && info.lunar.day === '初一') { sub = info.lunar.month; subKind = null }
    cells.push({
      key: info?.key ?? `${date.y}-${date.m}-${date.d}`,
      ...date,
      outside,
      info,
      festivals,
      sub,
      subKind,
      tag: legal ? (legal.off ? 'rest' : 'work') : null,
    })
  }
  return cells
}

/** 表头 7 个星期，按周起始排布 */
export function weekHead(startWeekday, names = ['日', '一', '二', '三', '四', '五', '六']) {
  return weekOrder(startWeekday === 1 ? 1 : 0).map(day => ({ day, name: names[day], weekend: day === 0 || day === 6 }))
}

export { daysInMonth }
