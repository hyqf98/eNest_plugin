/**
 * 法定节假日联网刷新 —— 从 holiday-cn 拉取当前年与下一年的数据。
 * 内置表（tyme4ts）始终打底：联网失败、下一年文件尚不存在（404）都静默回退，
 * 不打断使用。成功的数据写入内存覆盖表并缓存到插件存储，下次启动先恢复缓存。
 */
import { HOLIDAY_STORAGE_KEY, HOLIDAY_SOURCE_URL, normalizeYear, setYearOverride, overrideYears } from '../core/holidays.js'

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000

async function request(url) {
  const bridge = globalThis.enest?.net?.fetch || globalThis.zapi?.net?.fetch
  if (typeof bridge === 'function') {
    const response = await bridge({ url, timeoutMs: 15_000 })
    // holiday-cn 对不存在的年份返回 404
    if (response?.status === 404) return { missing: true }
    if (response?.status !== 200) throw new Error(`节假日数据返回 ${response?.status ?? '错误'}`)
    return { body: response.body }
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (response.status === 404) return { missing: true }
  if (!response.ok) throw new Error(`节假日数据返回 ${response.status}`)
  return { body: await response.text() }
}

/** 解析单年文件；格式不符返回 null */
export function parseYearFile(year, body) {
  try {
    const json = JSON.parse(body)
    if (!json || Number(json.year) !== Number(year) || !Array.isArray(json.days)) return null
    const table = normalizeYear(year, json.days)
    return table ? [...table.entries()].map(([date, value]) => ({ date, name: value.name, isOffDay: value.off })) : null
  } catch {
    return null
  }
}

/** 把 holiday-cn 的 days 条目转成可存储的纯数据；非法返回 null */
export function storableDays(days) {
  return Array.isArray(days) ? days.map(entry => ({ name: entry.name, date: entry.date, isOffDay: entry.isOffDay })) : null
}

/** 从已缓存的 JSON 恢复覆盖表；返回恢复的年份数 */
export function restoreOverrides(cache) {
  let restored = 0
  if (!cache || typeof cache !== 'object' || !Array.isArray(cache.years)) return 0
  for (const entry of cache.years.slice(0, 4)) {
    if (entry && setYearOverride(entry.year, entry.days)) restored++
  }
  return restored
}

export function emptyOverrideCache() {
  return { version: 1, savedAt: 0, years: [] }
}

/**
 * 刷新当前年与下一年。返回 { updated: [{year, days}], missing: number[], failed: number[] }。
 * 即使某年失败，另一年成功也会生效；updated 携带原始条目以便调用方缓存。
 */
export async function refreshHolidays({ now = new Date() } = {}) {
  const years = [now.getFullYear(), now.getFullYear() + 1]
  const result = { updated: [], missing: [], failed: [] }
  for (const year of years) {
    try {
      const response = await request(`${HOLIDAY_SOURCE_URL}${year}.json`)
      if (response.missing) { result.missing.push(year); continue }
      const days = parseYearFile(year, response.body)
      if (!days) { result.failed.push(year); continue }
      if (setYearOverride(year, days)) result.updated.push({ year, days })
      else result.failed.push(year)
    } catch {
      result.failed.push(year)
    }
  }
  return result
}

/** 把刷新结果合并进缓存对象（同一年整体替换） */
export function mergeIntoCache(cache, result) {
  const next = cache && Array.isArray(cache.years) ? { ...cache, years: [...cache.years] } : emptyOverrideCache()
  for (const { year, days } of result.updated) {
    next.years = next.years.filter(entry => Number(entry.year) !== Number(year))
    next.years.push({ year, days: storableDays(days) })
  }
  // 只保留最近 4 年，避免缓存无限增长
  next.years = next.years.sort((a, b) => Number(a.year) - Number(b.year)).slice(-4)
  next.savedAt = Date.now()
  return next
}

export { HOLIDAY_STORAGE_KEY, REFRESH_INTERVAL_MS }
