/**
 * tyme4ts 适配层 —— 把农历库的对象图压平成纯数据 dayInfo。
 * 只依赖实测过的 1.5.5 API；宜忌/神煞等都是 Taboo/God 对象，统一 getName() 取字符串。
 */
import { SolarDay, PengZu } from 'tyme4ts'
import { fromKey, isWeekend, sameDay, toKey, weekday } from './dates.js'

/** 建模范围：tyme4ts 农历可算到 1900–2100，法定节假日表另见 holidays.js */
export const MIN_YEAR = 1901
export const MAX_YEAR = 2100

const cache = new Map()
const CACHE_LIMIT = 2600

const names = items => (Array.isArray(items) ? items.map(item => (typeof item === 'string' ? item : item?.getName?.() ?? String(item))) : [])

/** 节气日字符串形如「立春第1天」；当天入节返回节气名，否则 null */
function termOf(solar) {
  const text = String(solar.getTermDay())
  const match = /^(.+?)第(\d+)天$/.exec(text)
  if (!match) return { name: match?.[1] ?? text, index: 0, isTermDay: false }
  return { name: match[1], index: Number(match[2]) - 1, isTermDay: Number(match[2]) === 1 }
}

function build({ y, m, d }) {
  const solar = SolarDay.fromYmd(y, m, d)
  const lunar = solar.getLunarDay()
  const lunarMonth = lunar.getLunarMonth()
  const dayCycle = lunar.getSixtyCycle()
  const earthBranch = dayCycle.getEarthBranch()
  const term = termOf(solar)
  const legal = solar.getLegalHoliday()
  // 普通日 getLegalHoliday() 返回 null；有返回值时 work=true 为调休上班、false 为放假
  const isWorkday = legal ? Boolean(legal.isWork()) : !isWeekend({ y, m, d })
  return {
    key: toKey({ y, m, d }),
    y, m, d,
    weekday: weekday({ y, m, d }),
    lunar: {
      year: lunarMonth.getLunarYear().getYear(),
      month: lunarMonth.getName(),
      day: lunar.getName(),
      text: String(lunar),
      isLeapMonth: Boolean(lunarMonth.isLeap()),
    },
    ganzhi: {
      year: lunar.getYearSixtyCycle().getName(),
      month: lunar.getMonthSixtyCycle().getName(),
      day: dayCycle.getName(),
    },
    zodiac: lunar.getYearSixtyCycle().getEarthBranch().getZodiac().getName(),
    // 五行纳音，如「大海水」
    sound: dayCycle.getSound().getName(),
    term,
    // 当天的公历/农历节日名（tyme4ts 内置表）
    festivals: [...new Set([String(solar.getFestival() ?? '').split(' ').pop(), String(lunar.getFestival() ?? '').split(' ').pop()].filter(Boolean))],
    recommends: names(lunar.getRecommends()),
    avoids: names(lunar.getAvoids()),
    duty: lunar.getDuty().getName(),
    star28: lunar.getTwentyEightStar().getName(),
    gods: names(lunar.getGods()),
    fetus: lunar.getFetusDay().getName(),
    pengzu: PengZu.fromSixtyCycle(dayCycle).getName(),
    // 冲 = 日支对冲的生肖；煞 = 日支的凶方（Direction 对象，须 getName）
    chong: earthBranch.getOpposite().getZodiac().getName(),
    sha: earthBranch.getOminous().getName(),
    legal: legal ? { name: legal.getName(), work: Boolean(legal.isWork()) } : null,
    isWorkday,
    isOffDay: !isWorkday,
    // tyme4ts 的 13 项时辰原始对象（早子时/晚子时各占一项），时辰吉凶按需读取
    hours: lunar.getHours(),
  }
}

/** 取某天的完整信息；超出建模范围返回 null */
export function dayInfo(date) {
  const key = typeof date === 'string' ? date : toKey(date)
  const parts = fromKey(key)
  if (!parts || parts.y < MIN_YEAR || parts.y > MAX_YEAR) return null
  const hit = cache.get(key)
  if (hit) return hit
  const info = build(parts)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, info)
  return info
}

export function isToday(date) {
  const now = new Date()
  return sameDay(date, { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() })
}

/** 节日对象 → 宿主展示用的短名；长名在格子里放不下 */
export const FESTIVAL_SHORT = { 日本投降日: '日本投降', 抗战胜利纪念日: '抗战胜利' }
export function shortName(name) {
  return FESTIVAL_SHORT[name] ?? name
}
