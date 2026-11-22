/**
 * timeScale.mjs —— 日/周/月三粒度时间轴
 * 核心约定：dayWidth 像素 = 一天；dayIndex(date) 距锚点天数；x = originPad + dayIndex * dayWidth。
 * 周列以周一为起点，月列按自然月（宽度为该月天数 × dayWidth）。
 */

import { parseDate, toDateStr, todayStr, diffDays, addDays } from './model.mjs'

export const GRANULARITIES = ['day', 'week', 'month']

/** 锚点：2020-01-06（周一），保证负日期也能换算 */
const ANCHOR = parseDate('2020-01-06')

export function dayIndex(dateStr) {
  return diffDays(dateStr, '2020-01-06')
}

export function indexToDate(i) {
  return addDays('2020-01-06', i)
}

/** 默认列宽 */
export const DEFAULT_WIDTHS = { day: 44, week: 26, month: 12 }

export function colWidth(granularity, dayWidth) {
  if (granularity === 'day') return dayWidth
  if (granularity === 'week') return dayWidth * 7
  return null // 月列宽度动态
}

/** 生成从 minIndex 到 maxIndex 的列描述 */
export function buildColumns(granularity, minIndex, maxIndex, dayWidth) {
  const cols = []
  if (granularity === 'day') {
    for (let i = minIndex; i <= maxIndex; i++) {
      const d = parseDate(indexToDate(i))
      cols.push({
        key: `d${i}`,
        index: i,
        label: String(d.getDate()),
        sub: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()],
        weekend: d.getDay() === 0 || d.getDay() === 6,
        left: i * dayWidth,
        width: dayWidth,
        date: indexToDate(i)
      })
    }
  } else if (granularity === 'week') {
    // 周一为列起点：找到 minIndex 所在周的周一
    const minDate = parseDate(indexToDate(minIndex))
    const shiftToMonday = (minDate.getDay() + 6) % 7
    const firstMonday = minIndex - shiftToMonday
    for (let i = firstMonday; i <= maxIndex; i += 7) {
      const d = parseDate(indexToDate(i))
      const next = parseDate(indexToDate(i + 6))
      const sameMonth = d.getMonth() === next.getMonth() && d.getFullYear() === next.getFullYear()
      const weekNo = isoWeekNo(d)
      cols.push({
        key: `w${i}`,
        index: i,
        label: sameMonth
          ? `${d.getMonth() + 1}.${d.getDate()}–${next.getDate()}日`
          : `${d.getMonth() + 1}.${d.getDate()}–${next.getMonth() + 1}.${next.getDate()}日`,
        sub: `第${weekNo}周`,
        left: i * dayWidth,
        width: dayWidth * 7,
        date: indexToDate(i)
      })
    }
  } else {
    let cur = parseDate(indexToDate(minIndex))
    cur = new Date(cur.getFullYear(), cur.getMonth(), 1)
    while (dayIndex(toDateStr(cur)) <= maxIndex) {
      const i = dayIndex(toDateStr(cur))
      const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate()
      const width = daysInMonth * dayWidth
      cols.push({
        key: `m${i}`,
        index: i,
        label: `${cur.getMonth() + 1}月`,
        sub: '',
        left: i * dayWidth,
        width,
        date: toDateStr(cur)
      })
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
    }
  }
  return cols
}

/** ISO 周序号（周一起算） */
function isoWeekNo(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const day = (t.getDay() + 6) % 7
  t.setDate(t.getDate() - day + 3)
  const firstThursday = new Date(t.getFullYear(), 0, 4)
  const fd = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - fd + 3)
  return 1 + Math.round((t - firstThursday) / (7 * 86400000))
}

/** 视口需要覆盖的日期范围：任务范围外扩（前后留白随粒度变化）。
 *  周粒度把边界对齐到周一（避免首列从上周中途起画、被左侧任务列遮住）；
 *  月粒度对齐到自然月首（首列是完整月份）。列边界与任务列右缘齐平，
 *  两侧不再出现无网格的空白带。 */
export function frameFor(tasks, summaries, granularity, pad = 7) {
  let min = Infinity
  let max = -Infinity
  const today = todayStr()
  for (const t of tasks) {
    const s = summaries.get(t.id)
    if (!s) continue
    const a = dayIndex(s.start)
    const b = dayIndex(s.end)
    if (a < min) min = a
    if (b > max) max = b
  }
  const ti = dayIndex(today)
  if (!Number.isFinite(min)) { min = ti; max = ti }
  if (ti < min) min = ti
  if (ti > max) max = ti
  const padDays = granularity === 'month' ? 45 : granularity === 'week' ? 14 : pad
  min -= padDays
  max += padDays
  let minIndex = Math.floor(min)
  let maxIndex = Math.ceil(max)
  if (granularity === 'week') {
    // 周一为一周之首：min 向前对齐周一，max 向后补足到周日
    const minDate = parseDate(indexToDate(minIndex))
    const maxDate = parseDate(indexToDate(maxIndex))
    if (minDate && maxDate) {
      minIndex -= (minDate.getDay() + 6) % 7
      if (maxDate.getDay() !== 0) maxIndex += 7 - maxDate.getDay()
    }
  } else if (granularity === 'month') {
    const minDate = parseDate(indexToDate(minIndex))
    if (minDate) {
      minIndex = dayIndex(toDateStr(new Date(minDate.getFullYear(), minDate.getMonth(), 1)))
      const maxDate = parseDate(indexToDate(maxIndex))
      const nextMonth1st = new Date(maxDate.getFullYear(), maxDate.getMonth() + 1, 1)
      maxIndex = dayIndex(toDateStr(nextMonth1st)) - 1
    }
  }
  return { minIndex, maxIndex, todayIndex: ti }
}

/**
 * 表头上行的月份分组条：把 minIndex..maxIndex 按自然月切段。
 * left 以「列左边缘」为 0（与 buildColumns 的 left 同基准）。
 */
export function buildMonthBands(minIndex, maxIndex, dayWidth) {
  const bands = []
  const first = parseDate(indexToDate(minIndex))
  if (!first) return bands
  let cur = new Date(first.getFullYear(), first.getMonth(), 1)
  while (dayIndex(toDateStr(cur)) <= maxIndex) {
    const monthStart = dayIndex(toDateStr(cur))
    const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate()
    const rawLeft = (monthStart - minIndex) * dayWidth
    const rawRight = (monthStart + daysInMonth - minIndex) * dayWidth
    const left = Math.max(0, rawLeft)
    const right = Math.min((maxIndex - minIndex + 1) * dayWidth, rawRight)
    if (right > left) {
      bands.push({
        key: `mb${monthStart}`,
        label: cur.getMonth() === 0 || bands.length === 0
          ? `${cur.getFullYear()}年${cur.getMonth() + 1}月`
          : `${cur.getMonth() + 1}月`,
        left,
        width: right - left,
        current: todayStr().slice(0, 7) === toDateStr(cur).slice(0, 7)
      })
    }
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
  }
  return bands
}

/** 把全部日期压进视口所需的列宽；最小 20px——再窄两位日期就裁字，
 *  放不下时宁可横向滚动（配合缩略带与滚动条）也不挤压；
 *  自适应上限 64px：日期数不多时把列放大铺满视口，避免尾部大片空白列。 */
export function fitDayWidth(viewportWidth, minIndex, maxIndex, min = 20, max = 64) {
  const days = Math.max(1, maxIndex - minIndex + 1)
  return Math.max(min, Math.min(max, Math.floor(viewportWidth / days)))
}

/** x 像素 -> 日期索引（四舍五入） */
export function xToIndex(x, dayWidth) {
  return Math.round(x / dayWidth)
}

/** 日期索引区间的 [left, width) */
export function indexRangeToPx(startIndex, endIndex, dayWidth) {
  const left = startIndex * dayWidth
  return { left, width: Math.max(dayWidth, (endIndex - startIndex + 1) * dayWidth) }
}
