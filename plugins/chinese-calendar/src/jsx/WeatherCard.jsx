/**
 * 天气卡 —— 头部摘要 chip + 悬停展开：城市 tab / 实况 / 24 小时 / 4 日预报 / 城市管理。
 * 数据来自 weather store；无城市时显示添加入口，失败时显示重试。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_CITIES, roundTemp } from '../services/weatherModel.js'
import { searchCities } from '../services/weather.js'
import { Cloud, Grip, Plus, Refresh, Search, X, ArrowUp, ArrowDown } from './icons.jsx'

/** 城市行：拖把 + 名称 + 当前温度；拖拽排序，方向键微调 */
function CityRow({ city, weather, active, error, onPick, onRemove, onMove, onDragStart, onDragOver, onDrop }) {
  return (
    <div
      className={`wc-city${active ? ' wc-city-active' : ''}`}
      draggable
      onDragStart={event => onDragStart(event, city.id)}
      onDragOver={event => { event.preventDefault(); onDragOver(event, city.id) }}
      onDrop={event => onDrop(event, city.id)}
    >
      <button type="button" className="wc-grip" aria-label="拖动排序" onKeyDown={event => {
        if (event.key === 'ArrowUp') { event.preventDefault(); onMove(city.id, -1) }
        if (event.key === 'ArrowDown') { event.preventDefault(); onMove(city.id, 1) }
      }}><Grip /></button>
      <button type="button" className="wc-city-main" onClick={() => onPick(city.id)}>
        <span className="wc-city-name">{city.name}</span>
        <span className={`wc-temp wc-temp-${weather?.current.band ?? 'na'}`}>{roundTemp(weather?.current.temp)}°</span>
        {weather && <span className="wc-emoji">{weather.current.emoji}</span>}
        {error && !weather && <span className="wc-err">获取失败</span>}
        {error && weather && <span className="wc-stale" title={error}>!</span>}
      </button>
      <button type="button" className="wc-x" aria-label={`移除 ${city.name}`} onClick={() => onRemove(city.id)}><X /></button>
    </div>
  )
}

export function WeatherCard({ store, enabled, onEnabledChange }) {
  const [snap, setSnap] = useState(() => store.snapshot())
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState(null)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState(false)
  const [limitHit, setLimitHit] = useState(false)
  const wrapRef = useRef(null)
  const hideTimer = useRef(0)
  const dragFrom = useRef(null)
  const dragOver = useRef(null)

  useEffect(() => store.subscribe(() => setSnap(store.snapshot())), [store])
  const first = snap.cities[0]?.id ?? null
  const currentId = activeId && snap.cities.some(c => c.id === activeId) ? activeId : first
  const current = snap.data[currentId] ?? null
  const currentError = snap.errors[currentId]
  const summary = snap.data[first]

  // 城市搜索：输入后防抖 300ms
  useEffect(() => {
    const keyword = search.trim()
    if (keyword.length < 2) { setResults([]); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      setSearching(true)
      try { if (!cancelled) setResults(await searchCities(keyword)) } catch { if (!cancelled) setResults([]) }
      finally { if (!cancelled) setSearching(false) }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [search])

  const show = () => { clearTimeout(hideTimer.current); setOpen(true) }
  const scheduleHide = () => { clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => { setOpen(false); setAdding(false); setSearch('') }, 300) }

  const addCity = async city => {
    setLimitHit(false)
    try {
      if (!await store.add(city)) return
      setActiveId(city.id)
      setSearch(''); setResults([])
    } catch (error) {
      if (String(error?.message).includes('最多')) setLimitHit(true)
    }
  }

  if (!enabled) return null
  // 无城市且面板未打开：只显示空入口；打开后走下面的完整渲染，才能添加第一个城市
  if (snap.cities.length === 0 && !open) return (
    <button type="button" className="wx-empty" onClick={() => { setAdding(true); show() }} title="添加城市查看天气">
      <Cloud /><span>添加天气</span>
    </button>
  )

  return (
    <div className="wx" ref={wrapRef} onPointerEnter={show} onPointerLeave={scheduleHide}>
      {snap.cities.length > 0 ? (
        <button type="button" className="wx-chip" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <span className="wx-emoji">{summary?.current.emoji ?? '🌡️'}</span>
          <span className={`wx-temp wx-temp-${summary?.current.band ?? 'na'}`}>{roundTemp(summary?.current.temp)}°</span>
          <span className="wx-name">{snap.cities[0]?.name}</span>
        </button>
      ) : (
        <button type="button" className="wx-empty" aria-expanded={open} onClick={scheduleHide}><Cloud /><span>添加天气</span></button>
      )}
      {open && (
        <div className="wx-pop" role="dialog" aria-label="天气" data-input-context="overlay">
          <div className="wx-cities">
            {snap.cities.map(city => (
              <CityRow key={city.id} city={city} weather={snap.data[city.id]} error={snap.errors[city.id]} active={city.id === currentId}
                onPick={setActiveId} onRemove={id => store.remove(id)}
                onMove={(id, delta) => store.move(id, delta)}
                onDragStart={(event, id) => { dragFrom.current = id; event.dataTransfer.effectAllowed = 'move' }}
                onDragOver={(_event, id) => { dragOver.current = id }}
                onDrop={(event, id) => { event.preventDefault(); if (dragFrom.current) store.reorder(dragFrom.current, id); dragFrom.current = null }} />
            ))}
            {snap.cities.length < MAX_CITIES && (
              <div className="wc-add">
                <Search />
                <input className="wc-input" value={search} placeholder="搜索城市" aria-label="搜索城市"
                  onChange={event => setSearch(event.target.value)} onFocus={() => clearTimeout(hideTimer.current)} />
                {search && <button type="button" className="wc-x" aria-label="清除" onClick={() => setSearch('')}><X /></button>}
                {results.length > 0 && (
                  <div className="wc-results">
                    {results.map(city => (
                      <button key={city.id} type="button" className="wc-result" onClick={() => addCity(city)}>
                        <span>{city.label}</span><Plus />
                      </button>
                    ))}
                  </div>
                )}
                {search.trim().length >= 2 && !searching && results.length === 0 && <div className="wc-none">没有找到「{search.trim()}」</div>}
                {limitHit && <div className="wc-none">最多添加 {MAX_CITIES} 个城市</div>}
              </div>
            )}
          </div>

          {currentError && !current && (
            <div className="wx-error">
              <span>{currentError}</span>
              <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" onClick={() => store.refresh(currentId)}><Refresh />重试</button>
            </div>
          )}
          {current && (
            <>
              <div className="wx-now">
                <span className="wx-now-emoji">{current.current.emoji}</span>
                <span className={`wx-now-temp wx-temp-${current.current.band}`}>{roundTemp(current.current.temp)}°</span>
                <div className="wx-now-side">
                  <span className="wx-now-text">{current.current.text}</span>
                  <span className="wx-now-meta">体感 {roundTemp(current.current.feels)}° · 湿度 {current.current.humidity}% · 风速 {Math.round(current.current.wind)} km/h</span>
                </div>
              </div>
              <div className="wx-hours">
                {current.hourly.map((hour, index) => (
                  <div key={hour.time} className="wx-hour" data-now={index === 0 || undefined}>
                    <span className="wx-hour-label">{hour.label}</span>
                    <span className="wx-hour-emoji">{hour.emoji}</span>
                    <span className="wx-hour-temp">{Math.round(hour.temp)}°</span>
                    {hour.pop > 0 && <span className="wx-hour-pop">{hour.pop}%</span>}
                  </div>
                ))}
              </div>
              <div className="wx-days">
                {current.daily.map(day => (
                  <div key={day.date} className="wx-day">
                    <span className="wx-day-label">{day.label}</span>
                    <span className="wx-day-emoji">{day.emoji}</span>
                    <span className="wx-day-range"><span>{Math.round(day.min)}°</span><i aria-hidden="true"><b style={{ left: `${((day.min - weekMin(current.daily)) / Math.max(1, weekMax(current.daily) - weekMin(current.daily))) * 100}%`, width: `${Math.max(8, ((day.max - day.min) / Math.max(1, weekMax(current.daily) - weekMin(current.daily))) * 100)}%` }} /></i><span>{Math.round(day.max)}°</span></span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="wx-foot">
            <span>Open-Meteo · {snap.cities.length}/{MAX_CITIES}</span>
            <button type="button" className="wc-refresh" aria-label="刷新天气" onClick={() => store.refreshAll({ force: true })}><Refresh /></button>
          </div>
        </div>
      )}
    </div>
  )
}

const weekMin = days => Math.min(...days.map(d => d.min ?? 0))
const weekMax = days => Math.max(...days.map(d => d.max ?? 0))
