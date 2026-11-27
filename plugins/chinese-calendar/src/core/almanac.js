/**
 * 黄历与时辰 —— 基于 calendar.js 的 dayInfo 再组织成面板需要的形状。
 *
 * tyme4ts 的 getHours() 返回 13 项：idx 0 是早子时（00–01 点），idx 1–11 是丑…亥，
 * idx 12 是晚子时（23–24 点）。界面只显示 12 个槽位，所以晚子时合并进「子时」槽，
 * 但干支/宜忌按当前时刻真正落在哪一段取（23 点后日柱换、时柱也换）。
 */
import { dayInfo } from './calendar.js'

export const SHICHEN_NAMES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']
/** 每个时辰的起始小时；子时跨午夜，显示为 23:00–01:00 */
export const SHICHEN_START = [23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]
export const SHICHEN_RANGE = ['23:00–01:00', '01:00–03:00', '03:00–05:00', '05:00–07:00', '07:00–09:00', '09:00–11:00', '11:00–13:00', '13:00–15:00', '15:00–17:00', '17:00–19:00', '19:00–21:00', '21:00–23:00']

/** 黄道六神：吉；其余黑道：凶 */
export const YELLOW_ROAD = new Set(['青龙', '明堂', '金匮', '天德', '玉堂', '司命'])

/** 当前小时落在哪个时辰槽（0 = 子 … 11 = 亥） */
export function shichenIndexAt(hour) {
  return hour >= 23 || hour < 1 ? 0 : Math.floor((hour + 1) / 2)
}

/** 当前小时对应 tyme4ts 13 项里的哪一项：早子时 0、晚子时 12 */
function hourSlot(hour) {
  if (hour >= 23) return 12
  if (hour < 1) return 0
  return Math.floor((hour + 1) / 2)
}

/**
 * 12 个时辰槽的完整信息。
 * tyme4ts 的 getTwelveStar() 直接给出每个时辰的值神，优先用它；值神缺失时回退到
 * 「日支序 % 6 起算」的传统公式（he-calendar 的做法），保证两套算法一致。
 */
export function shichenList(date, now = new Date()) {
  const info = dayInfo(date)
  if (!info) return []
  const slots = Array.isArray(info.hours) ? info.hours : []
  const branchIndex = '子丑寅卯辰巳午未申酉戌亥'.indexOf(info.ganzhi.day.slice(-1))
  const currentSlot = shichenIndexAt(now.getHours())
  const activeHourSlot = hourSlot(now.getHours())
  return SHICHEN_NAMES.map((name, slot) => {
    // 槽 0（子时）在 13 项里对应 idx 0 和 idx 12；其余槽 i 对应 idx i
    const entry = slot === 0 ? slots[activeHourSlot >= 12 ? 12 : 0] : slots[slot]
    const star = entry?.getTwelveStar?.().getName?.()
    const god = star || ['青龙', '明堂', '金匮', '天德', '玉堂', '司命', '天刑', '朱雀', '白虎', '天牢', '玄武', '勾陈'][(branchIndex % 6 + slot) % 12]
    return {
      slot,
      name: `${name}时`,
      range: SHICHEN_RANGE[slot],
      god,
      lucky: YELLOW_ROAD.has(god),
      ganzhi: entry?.getSixtyCycle?.().getName?.() ?? '',
      recommends: (entry?.getRecommends?.() ?? []).map(item => item.getName()),
      avoids: (entry?.getAvoids?.() ?? []).map(item => item.getName()),
      current: slot === currentSlot,
    }
  })
}

/** 黄历面板数据：宜忌、彭祖百忌、纳音、冲煞、胎神、建除二十八宿 */
export function almanac(date) {
  const info = dayInfo(date)
  if (!info) return null
  return {
    key: info.key,
    recommends: info.recommends,
    avoids: info.avoids,
    pengzu: info.pengzu,
    sound: info.sound,
    chong: info.chong,
    sha: info.sha,
    fetus: info.fetus,
    duty: info.duty,
    star28: info.star28,
    gods: info.gods,
    zodiac: info.zodiac,
    ganzhi: info.ganzhi,
    lunar: info.lunar,
    term: info.term,
  }
}
