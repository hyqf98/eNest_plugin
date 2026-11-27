/**
 * 节日聚合 —— 某一天的全部节日（法定 / 农历 / 公历 / 节气 / 国际），名称归一后去重。
 * 法定节假日走 holidays.js，因此联网刷新的覆盖表对节日列表同样生效。
 */
import { INTERNATIONAL_FESTIVALS, FESTIVAL_DESCRIPTIONS, FESTIVAL_ALIASES, FESTIVAL_SHORT_NAMES, SOLAR_TERM_DESCRIPTIONS } from '../data/festivals.js'
import { addDays, diffDays, fromKey, toKey, weekday } from './dates.js'
import { dayInfo, shortName } from './calendar.js'
import { legalOfDay } from './holidays.js'

export const FESTIVAL_TYPES = ['lunar', 'solar', 'term', 'international']

/** 某年某月第 n 个星期 w（w: 0 周日…6 周六）是几号 */
function nthWeekday(year, month, week, n) {
  const first = new Date(year, month - 1, 1).getDay()
  return ((week - first + 7) % 7) + 1 + (n - 1) * 7
}

/** 母亲节 = 五月第二个星期日；父亲节 = 六月第三个星期日；感恩节 = 十一月第四个星期四 */
export function dynamicInternational(year, month, day) {
  if (month === 5 && day === nthWeekday(year, 5, 0, 2)) return '母亲节'
  if (month === 6 && day === nthWeekday(year, 6, 0, 3)) return '父亲节'
  if (month === 11 && day === nthWeekday(year, 11, 4, 4)) return '感恩节'
  return null
}

export function normalizeName(name) {
  return FESTIVAL_ALIASES[name] || name
}

/** 某天的全部节日，带类型与简介 */
export function collectFestivals(date) {
  const info = dayInfo(date)
  if (!info) return []
  const { y, m, d } = info
  const list = []
  const seen = new Set()
  const add = (raw, type, extra = {}) => {
    const name = normalizeName(raw)
    if (!name || seen.has(name)) return
    seen.add(name)
    list.push({
      name,
      short: shortName(name),
      type,
      description: FESTIVAL_DESCRIPTIONS[name] || SOLAR_TERM_DESCRIPTIONS[name] || '',
      ...extra,
    })
  }
  const legal = legalOfDay({ y, m, d })
  if (legal) add(legal.name, 'legal', { isWork: !legal.off })
  for (const name of info.festivals) {
    // 农历节日与公历节日可能在同一天同名（如国庆中秋重合），类型按先后归并
    add(name, info.lunar.text.includes(name) || isLunarFestivalName(name) ? 'lunar' : 'solar')
  }
  if (info.term.isTermDay) add(info.term.name, 'term')
  const intl = INTERNATIONAL_FESTIVALS[`${m}-${d}`] || dynamicInternational(y, m, d)
  if (intl) add(intl, 'international')
  return list
}

/** tyme4ts 把农历/公历节日混在一个数组里返回；这张表区分哪些是农历节日 */
const LUNAR_FESTIVAL_NAMES = new Set(['春节', '元宵节', '龙头节', '上巳节', '七夕节', '中元节', '中秋节', '重阳节', '寒衣节', '下元节', '腊八节', '小年', '除夕'])
function isLunarFestivalName(name) {
  return LUNAR_FESTIVAL_NAMES.has(normalizeName(name))
}

/** 格子副行显示的节日名：按类型开关筛选后取第一个（法定 > 农历 > 公历 > 节气 > 国际） */
const TYPE_PRIORITY = { legal: 0, lunar: 1, solar: 2, term: 3, international: 4 }
export function primaryFestival(festivals, visibleTypes) {
  let best = null
  for (const item of festivals) {
    if (item.type === 'legal' && item.isWork) continue
    if (visibleTypes && item.type !== 'legal' && !visibleTypes.has(item.type)) continue
    if (!best || TYPE_PRIORITY[item.type] < TYPE_PRIORITY[best.type]) best = item
  }
  return best
}

/**
 * 区间内的节日列表（逐日扫描）。跨度上限 400 天，含首尾。
 * 返回 { date, daysFromToday, festivals } 数组。
 */
export const MAX_RANGE_DAYS = 400

export function festivalsInRange(start, end) {
  const a = fromKey(toKey(start)), b = fromKey(toKey(end))
  if (!a || !b) throw new Error('日期格式必须为 YYYY-MM-DD')
  const span = diffDays(a, b)
  if (span < 0) throw new Error('结束日期不能早于起始日期')
  if (span >= MAX_RANGE_DAYS) throw new Error(`日期范围一次最多查询 ${MAX_RANGE_DAYS} 天`)
  const today = new Date()
  const todayKey = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() }
  const results = []
  let cursor = a
  for (let i = 0; i <= span; i++) {
    const festivals = collectFestivals(cursor)
    if (festivals.length) results.push({ date: toKey(cursor), weekday: WEEKDAY_NAMES[weekday(cursor)], daysFromToday: diffDays(todayKey, cursor), festivals })
    cursor = addDays(cursor, 1)
  }
  return results
}

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 倒数文案：今天 / 明天 / 还有 N 天 / N 天前 */
export function countdownText(days) {
  if (days === 0) return '就是今天'
  if (days === 1) return '明天'
  if (days > 1) return `还有${days}天`
  return `${-days}天前`
}

/**
 * 从今天起 400 天内找下一个名称匹配的节日/节气（双向包含匹配）。
 * 节气单独一张表，所以「清明」既可能命中节气也可能命中清明节，取先到者。
 */
export function searchNextFestival(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('必须提供非空的 festival_name 参数')
  const keyword = name.trim()
  const today = new Date()
  let cursor = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() }
  for (let i = 0; i <= MAX_RANGE_DAYS; i++) {
    const match = collectFestivals(cursor).find(item => item.name.includes(keyword) || keyword.includes(item.name))
    if (match) {
      return {
        found: true,
        name: match.name,
        type: match.type,
        description: match.description,
        date: toKey(cursor),
        weekday: WEEKDAY_NAMES[weekday(cursor)],
        daysFromToday: i,
        countdown: countdownText(i),
      }
    }
    cursor = addDays(cursor, 1)
  }
  return { found: false, message: `未来${MAX_RANGE_DAYS}天内未找到名称包含「${keyword}」的节日或节气` }
}
