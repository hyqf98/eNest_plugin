/**
 * 天气服务 —— 多城市天气的状态与网络层。
 * 网络请求走宿主 enest.net.fetch（受控、https-only）；无宿主桥时回退到浏览器 fetch，
 * 供独立预览与截图使用。数据缓存 10 分钟，可被 30 分钟定时器驱动刷新。
 */
import { WEATHER_TTL_MS, MAX_CITIES, forecastUrl, geocodingUrl, parseForecast, parseGeocoding } from './weatherModel.js'

const STORE_KEY = 'calendar.weather.v1'

/** 统一的请求函数：宿主桥优先，其次浏览器 fetch */
async function request(url, timeoutMs = 15_000) {
  const bridge = globalThis.enest?.net?.fetch || globalThis.zapi?.net?.fetch
  if (typeof bridge === 'function') {
    const response = await bridge({ url, timeoutMs })
    if (response?.status !== 200) throw new Error(`天气服务返回 ${response?.status ?? '错误'}`)
    return response.body
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`天气服务返回 ${response.status}`)
  return response.text()
}

export async function fetchForecast(city) {
  const body = await request(forecastUrl(city.latitude, city.longitude))
  const parsed = parseForecast(JSON.parse(body))
  if (!parsed) throw new Error('天气数据格式异常')
  return parsed
}

export async function searchCities(keyword) {
  const name = String(keyword ?? '').trim()
  if (name.length < 2) return []
  const body = await request(geocodingUrl(name))
  return parseGeocoding(JSON.parse(body))
}

/**
 * 城市天气仓库。cities：[{ id, name, latitude, longitude }]；data：id → 预报。
 * 订阅者在状态变化时被通知；refresh 按需只拉过期城市。
 */
export function createWeatherStore({ load, save, onChange } = {}) {
  let cities = []
  const data = new Map()
  const errors = new Map()
  const listeners = new Set()
  const inflight = new Map()
  let hydrated = false
  let timer = 0
  let running = false

  const emit = () => {
    for (const listener of listeners) listener()
    onChange?.(snapshot())
  }
  const notify = () => emit()

  const snapshot = () => ({
    cities: cities.map(city => ({ ...city })),
    data: Object.fromEntries([...data.entries()].map(([id, value]) => [id, value])),
    errors: Object.fromEntries(errors),
  })

  async function hydrate() {
    if (hydrated) return
    hydrated = true
    const stored = await load?.(STORE_KEY)
    if (Array.isArray(stored?.cities)) {
      cities = stored.cities
        .filter(city => city && typeof city.id === 'string' && Number.isFinite(city.latitude) && Number.isFinite(city.longitude))
        .slice(0, MAX_CITIES)
        .map(city => ({ id: city.id, name: String(city.name ?? city.id).slice(0, 32), latitude: city.latitude, longitude: city.longitude }))
    }
    persist()
    notify()
  }

  function persist() {
    void save?.(STORE_KEY, { cities })
  }

  async function refreshCity(city, { force = false } = {}) {
    const cached = data.get(city.id)
    if (!force && cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS) return cached
    const pending = inflight.get(city.id)
    if (pending) return pending
    const task = (async () => {
      try {
        const forecast = await fetchForecast(city)
        data.set(city.id, forecast)
        errors.delete(city.id)
        return forecast
      } catch (error) {
        // 失败时保留旧缓存，只标记错误，界面显示「重试」
        errors.set(city.id, error instanceof Error ? error.message : String(error))
        return cached ?? null
      } finally {
        inflight.delete(city.id)
        notify()
      }
    })()
    inflight.set(city.id, task)
    return task
  }

  return {
    async hydrate() { return hydrate() },
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async refreshAll({ force = false } = {}) {
      await hydrate()
      await Promise.all(cities.map(city => refreshCity(city, { force })))
    },
    async refresh(id, { force = true } = {}) {
      const city = cities.find(item => item.id === id)
      return city ? refreshCity(city, { force }) : null
    },
    async add(city) {
      await hydrate()
      if (cities.length >= MAX_CITIES) throw new Error(`最多添加 ${MAX_CITIES} 个城市`)
      if (cities.some(item => item.id === city.id)) return false
      cities.push({ id: String(city.id), name: String(city.name).slice(0, 32), latitude: city.latitude, longitude: city.longitude })
      persist()
      notify()
      await refreshCity(cities.at(-1), { force: true })
      return true
    },
    remove(id) {
      const next = cities.filter(city => city.id !== id)
      if (next.length === cities.length) return
      cities = next
      data.delete(id)
      errors.delete(id)
      persist()
      notify()
    },
    reorder(fromId, toId) {
      const from = cities.findIndex(city => city.id === fromId)
      const to = cities.findIndex(city => city.id === toId)
      if (from < 0 || to < 0 || from === to) return
      const [moved] = cities.splice(from, 1)
      cities.splice(to, 0, moved)
      persist()
      notify()
    },
    move(id, delta) {
      const index = cities.findIndex(city => city.id === id)
      const target = index + delta
      if (index < 0 || target < 0 || target >= cities.length) return
      const [moved] = cities.splice(index, 1)
      cities.splice(target, 0, moved)
      persist()
      notify()
    },
    /** 启动 / 暂停 30 分钟自动刷新；onOut 时应暂停 */
    start() {
      if (running) return
      running = true
      void this.refreshAll()
      timer = setInterval(() => void this.refreshAll(), WEATHER_TTL_MS * 3)
    },
    stop() {
      running = false
      clearInterval(timer)
      timer = 0
    },
    get running() { return running },
  }
}

export { STORE_KEY }
