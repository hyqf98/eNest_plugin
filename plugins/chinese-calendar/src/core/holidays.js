/**
 * 法定节假日 / 调休 —— 三个来源按优先级合并：
 *   1. holiday-cn 联网刷新写入的覆盖表（services/holidayRefresh.js 注入）
 *   2. tyme4ts 内置表（1.5.5 覆盖到 2027-10-09）
 *   3. 周末兜底
 * 覆盖表按年份整体替换，避免同一年的数据半新半旧。
 */
import { addDays, diffDays, fromKey, isWeekend, toKey } from './dates.js'
import { dayInfo } from './calendar.js'

/** year → Map<'YYYY-MM-DD', { name, off: boolean }> */
const overrides = new Map()

export const HOLIDAY_STORAGE_KEY = 'calendar.holidays.v1'
export const HOLIDAY_SOURCE_URL = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/'

/** 校验并归一 holiday-cn 的 days 数组；任何一条非法都整体丢弃该年 */
export function normalizeYear(year, days) {
  const number = Number(year)
  if (!Number.isInteger(number) || number < 2000 || number > 2200 || !Array.isArray(days)) return null
  const table = new Map()
  for (const entry of days) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) return null
    const date = fromKey(entry.date)
    if (!date || date.y !== number || typeof entry.isOffDay !== 'boolean') return null
    table.set(toKey(date), { name: entry.name.trim().slice(0, 16), off: entry.isOffDay })
  }
  return table.size ? table : null
}

export function setYearOverride(year, days) {
  const table = normalizeYear(year, days)
  if (table) overrides.set(Number(year), table)
  return Boolean(table)
}

export function clearOverrides() {
  overrides.clear()
}

export function overrideYears() {
  return [...overrides.keys()].sort()
}

/**
 * 返回某天的节假日状态。
 * off=true 放假、off=false 调休上班、null=非节假日（调用方再按周末判断）
 */
export function legalOfDay(date) {
  const key = toKey(date)
  const year = overrides.get(date.y)
  if (year?.has(key)) return { name: year.get(key).name, off: year.get(key).off, source: 'remote' }
  const info = dayInfo(key)
  if (info?.legal) return { name: info.legal.name, off: !info.legal.work, source: 'builtin' }
  return null
}

/** 是否需要上班：节假日/调休优先，其次看周末 */
export function isWorkday(date) {
  const legal = legalOfDay(date)
  if (legal) return !legal.off
  return !isWeekend(date)
}

/** 是否休息日 */
export function isOffDay(date) {
  return !isWorkday(date)
}

/** 从某天所在假期往前找首日，再往后数连续休息日，得到整个假期 */
export function holidaySpan(date) {
  if (!isOffDay(date)) return null
  let start = date
  const legal = legalOfDay(date)
  // 周末并入相邻假期时没有法定名，沿用向前找到的第一个具名休息日
  let name = legal?.name ?? null
  for (let step = 0; step < 12 && isOffDay(addDays(start, -1)); step++) {
    start = addDays(start, -1)
    name = legalOfDay(start)?.name ?? name
  }
  let end = start
  for (let step = 0; step < 12 && isOffDay(addDays(end, 1)); step++) end = addDays(end, 1)
  return { name, start, end, days: diffDays(start, end) + 1 }
}

/**
 * 接下来的假期列表（从 from 起算），每项含连休天数与倒数天数。
 * 同一假期只出一次；跨年时按日期自然排序。
 */
export function upcomingHolidays(from, limit = 6) {
  const result = []
  let cursor = from
  for (let scanned = 0; scanned < 420 && result.length < limit; scanned++) {
    const legal = legalOfDay(cursor)
    if (legal?.off) {
      const span = holidaySpan(cursor)
      if (span && !result.some(item => item.startKey === toKey(span.start))) {
        result.push({
          name: span.name ?? legal.name,
          startKey: toKey(span.start),
          endKey: toKey(span.end),
          start: span.start,
          end: span.end,
          days: span.days,
          daysUntil: diffDays(from, span.start),
          today: toKey(from) >= toKey(span.start) && toKey(from) <= toKey(span.end),
        })
      }
      cursor = addDays(cursor, Math.max(1, span?.days ?? 1))
    } else {
      cursor = addDays(cursor, 1)
    }
  }
  return result
}
