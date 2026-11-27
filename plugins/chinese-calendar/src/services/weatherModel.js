/**
 * 天气数据模型 —— 纯函数，不依赖网络。把 Open-Meteo 的响应压平成 UI 需要的形状。
 * Open-Meteo 使用 WMO weather code；这里映射为中文描述与表情符号（夜间替换月亮）。
 */

/** WMO 天气码 → [中文, 白天表情, 夜间表情] */
const WMO = {
  0: ['晴', '☀️', '🌙'],
  1: ['大致晴朗', '🌤️', '🌙'],
  2: ['多云', '⛅', '☁️'],
  3: ['阴', '☁️', '☁️'],
  45: ['雾', '🌫️', '🌫️'],
  48: ['雾凇', '🌫️', '🌫️'],
  51: ['小毛毛雨', '🌦️', '🌧️'],
  53: ['毛毛雨', '🌦️', '🌧️'],
  55: ['大毛毛雨', '🌧️', '🌧️'],
  56: ['冻毛毛雨', '🌧️', '🌧️'],
  57: ['强冻毛毛雨', '🌧️', '🌧️'],
  61: ['小雨', '🌦️', '🌧️'],
  63: ['中雨', '🌧️', '🌧️'],
  65: ['大雨', '🌧️', '🌧️'],
  66: ['冻雨', '🌧️', '🌧️'],
  67: ['强冻雨', '🌧️', '🌧️'],
  71: ['小雪', '🌨️', '🌨️'],
  73: ['中雪', '🌨️', '🌨️'],
  75: ['大雪', '❄️', '❄️'],
  77: ['雪粒', '🌨️', '🌨️'],
  80: ['阵雨', '🌦️', '🌧️'],
  81: ['中阵雨', '🌧️', '🌧️'],
  82: ['强阵雨', '⛈️', '⛈️'],
  85: ['小阵雪', '🌨️', '🌨️'],
  86: ['大阵雪', '❄️', '❄️'],
  95: ['雷暴', '⛈️', '⛈️'],
  96: ['雷暴伴冰雹', '⛈️', '⛈️'],
  99: ['强雷暴伴冰雹', '⛈️', '⛈️'],
}

export const WEATHER_TTL_MS = 10 * 60 * 1000
export const WEATHER_REFRESH_MS = 30 * 60 * 1000
export const MAX_CITIES = 5
export const FORECAST_DAYS = 4
export const HOURLY_COUNT = 24

export function describeCode(code) {
  return WMO[code]?.[0] ?? '未知'
}

/** 是否夜间（按当地时间小时判断，用于选表情） */
export function isNightHour(hour) {
  return hour < 6 || hour >= 19
}

export function emojiFor(code, hour) {
  const entry = WMO[code]
  if (!entry) return '🌡️'
  return isNightHour(hour) ? entry[2] : entry[1]
}

/** 温度分色档位；返回 CSS 类名后缀 */
export function tempBand(temp) {
  if (temp == null || !Number.isFinite(temp)) return 'na'
  if (temp <= 0) return 'freeze'
  if (temp <= 8) return 'cold'
  if (temp <= 18) return 'mild'
  if (temp <= 26) return 'warm'
  if (temp <= 32) return 'hot'
  return 'scorch'
}

export function roundTemp(temp) {
  return temp == null || !Number.isFinite(temp) ? '--' : String(Math.round(temp))
}

const at = (list, index) => (Array.isArray(list) && index >= 0 && index < list.length ? list[index] : null)

/**
 * 解析 Open-Meteo forecast 响应。
 * now：用于定位「当前小时」在 hourly 数组里的下标（按当地时间字符串比较）。
 */
export function parseForecast(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || !raw.current || !raw.hourly || !raw.daily) return null
  const current = raw.current
  const currentHour = (() => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(current.time ?? ''))
    return match ? Number(match[4]) : now.getHours()
  })()
  // 从当前小时开始的 24 条小时数据
  const startIndex = Math.max(0, raw.hourly.time?.findIndex?.(time => String(time) >= String(current.time).slice(0, 13) + ':00') ?? -1)
  const hourly = []
  for (let i = 0; i < HOURLY_COUNT; i++) {
    const index = startIndex + i
    const time = at(raw.hourly.time, index)
    if (!time) break
    const hour = Number(String(time).slice(11, 13))
    const code = at(raw.hourly.weather_code, index)
    hourly.push({
      time: String(time),
      // 跨日的小时标日期，同一天只标小时
      hour,
      label: i === 0 ? '现在' : `${String(hour).padStart(2, '0')}时`,
      temp: at(raw.hourly.temperature_2m, index),
      code,
      emoji: emojiFor(code, hour),
      pop: at(raw.hourly.precipitation_probability, index),
    })
  }
  const daily = []
  const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  for (let i = 0; i < Math.min(FORECAST_DAYS, raw.daily.time?.length ?? 0); i++) {
    const date = at(raw.daily.time, i)
    const code = at(raw.daily.weather_code, i)
    const dateObj = new Date(`${date}T12:00:00`)
    daily.push({
      date,
      label: i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : DAY_NAMES[dateObj.getDay()],
      code,
      emoji: emojiFor(code, 12),
      max: at(raw.daily.temperature_2m_max, i),
      min: at(raw.daily.temperature_2m_min, i),
      pop: at(raw.daily.precipitation_probability_max, i),
    })
  }
  return {
    fetchedAt: now.getTime(),
    timezone: raw.timezone ?? '',
    current: {
      temp: current.temperature_2m,
      feels: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      wind: current.wind_speed_10m,
      code: current.weather_code,
      text: describeCode(current.weather_code),
      emoji: emojiFor(current.weather_code, currentHour),
      band: tempBand(current.temperature_2m),
    },
    hourly,
    daily,
  }
}

/** 解析 Open-Meteo geocoding 搜索结果 */
export function parseGeocoding(raw) {
  if (!raw || !Array.isArray(raw.results)) return []
  return raw.results.slice(0, 8).map(item => ({
    id: String(item.id),
    name: String(item.name ?? ''),
    admin1: String(item.admin1 ?? ''),
    admin2: String(item.admin2 ?? ''),
    country: String(item.country ?? ''),
    latitude: item.latitude,
    longitude: item.longitude,
    // 显示名：直辖市/同名行政区不重复显示，按先后去重
    label: [item.name, item.admin1, item.admin2]
      .map(value => String(value ?? ''))
      .filter((value, index, all) => value && all.indexOf(value) === index)
      .join(' '),
  }))
}

export function forecastUrl(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto', forecast_days: String(FORECAST_DAYS),
  })
  return `https://api.open-meteo.com/v1/forecast?${params}`
}

export function geocodingUrl(name) {
  const params = new URLSearchParams({ name, count: '8', language: 'zh', format: 'json' })
  return `https://geocoding-api.open-meteo.com/v1/search?${params}`
}
