/**
 * 节日倒数面板 —— 从今天起 400 天内的节日按月份分组，带倒数与连休天数。
 */
import { addDays, diffDays, fromKey, toKey, weekday } from './dates.js'
import { festivalsInRange, countdownText, MAX_RANGE_DAYS } from './festivals.js'
import { holidaySpan } from './holidays.js'

const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 倒数面板数据。
 * visibleTypes：参与显示的节日类型集合（legal 始终显示）；rangeDays：向前看多少天。
 * 同一天多个节日各占一行；法定节日的调休上班日不单独成行，而是并入该假期的「休 N 天」。
 */
export function countdownBoard({ visibleTypes, rangeDays = 400 } = {}) {
  const today = new Date()
  const start = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() }
  // 注意不能用 `|| 400`：rangeDays=0 是合法输入（只看今天），会被当成假值
  const requested = Number(rangeDays)
  const days = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 400, MAX_RANGE_DAYS))
  const rows = []
  const seenLegal = new Set()
  for (const entry of festivalsInRange(start, addDays(start, days - 1))) {
    for (const festival of entry.festivals) {
      // 调休上班日：把「休 N 天」挂到它所属假期上，自身不出行
      if (festival.type === 'legal' && festival.isWork) continue
      if (festival.type !== 'legal' && visibleTypes && !visibleTypes.has(festival.type)) continue
      const date = fromKey(entry.date)
      const isLegal = festival.type === 'legal'
      // 同一假期只出一行（取首日），避免 8 天连休刷 8 行
      if (isLegal) {
        const span = holidaySpan(date)
        const spanKey = span ? toKey(span.start) : entry.date
        if (seenLegal.has(spanKey)) continue
        seenLegal.add(spanKey)
        const target = span ? span.start : date
        rows.push({
          key: `legal-${spanKey}`,
          name: span?.name ?? festival.name,
          type: 'legal',
          description: festival.description,
          date: toKey(target),
          month: target.m,
          year: target.y,
          weekday: WEEKDAY_SHORT[weekday(target)],
          daysFromToday: diffDays(start, target),
          countdown: countdownText(diffDays(start, target)),
          restDays: span?.days ?? 1,
        })
        continue
      }
      rows.push({
        key: `${festival.type}-${entry.date}-${festival.name}`,
        name: festival.name,
        type: festival.type,
        description: festival.description,
        date: entry.date,
        month: date.m,
        year: date.y,
        weekday: WEEKDAY_SHORT[weekday(date)],
        daysFromToday: diffDays(start, date),
        countdown: countdownText(diffDays(start, date)),
        restDays: 0,
      })
    }
  }
  return groupByMonth(rows, start.y)
}

/** 按年月分组；跨年的月份标题交给 UI 用 year 判断是否显示「明年」 */
function groupByMonth(rows, currentYear) {
  const groups = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last && last.year === row.year && last.month === row.month) last.rows.push(row)
    else groups.push({ year: row.year, month: row.month, rows: [row] })
  }
  return groups
}

export { WEEKDAY_SHORT }
