/**
 * 纯公历日期工具 —— 不依赖 tyme4ts，全部按本地时区计算。
 * 内部统一用 { y, m, d } 结构体传递，m/d 均为 1 起始的真实月份与日期。
 */

export const DAY_MS = 24 * 60 * 60 * 1000

export function todayKey() {
  const date = new Date()
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
}

export function pad(n) {
  return String(n).padStart(2, '0')
}

/** { y, m, d } → 'YYYY-MM-DD' */
export function toKey({ y, m, d }) {
  return `${y}-${pad(m)}-${pad(d)}`
}

/** 'YYYY-MM-DD' → { y, m, d }；格式非法返回 null */
export function fromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  if (!match) return null
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3])
  const probe = new Date(y, m - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null
  return { y, m, d }
}

/** 真实 Date → { y, m, d } */
export function fromDate(date) {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
}

export function toDate({ y, m, d }) {
  return new Date(y, m - 1, d)
}

export function sameDay(a, b) {
  return a.y === b.y && a.m === b.m && a.d === b.d
}

export function isWeekend({ y, m, d }) {
  const week = new Date(y, m - 1, d).getDay()
  return week === 0 || week === 6
}

/** 周日 = 0 … 周六 = 6 */
export function weekday({ y, m, d }) {
  return new Date(y, m - 1, d).getDay()
}

export function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate()
}

/** 加减天数，自动跨月跨年 */
export function addDays({ y, m, d }, delta) {
  const date = new Date(y, m - 1, d + delta)
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
}

/** 加减月份，日期超出目标月时钳到月末 */
export function addMonths({ y, m, d }, delta) {
  const target = new Date(y, m - 1 + delta, 1)
  const last = daysInMonth(target.getFullYear(), target.getMonth() + 1)
  return { y: target.getFullYear(), m: target.getMonth() + 1, d: Math.min(d, last) }
}

/** b − a 的整天数（b 在后为正） */
export function diffDays(a, b) {
  const a0 = Date.UTC(a.y, a.m - 1, a.d)
  const b0 = Date.UTC(b.y, b.m - 1, b.d)
  return Math.round((b0 - a0) / DAY_MS)
}

/** 一周从 startWeekday（0 周日 / 1 周一）起算的 7 个星期序号 */
export function weekOrder(startWeekday) {
  return Array.from({ length: 7 }, (_, i) => (i + startWeekday) % 7)
}

export const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
export const WEEKDAY_FULL = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
