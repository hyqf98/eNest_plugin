/**
 * 中国日历 —— 单棵组件树。
 * quick / shell 差异全部走 [data-mode] CSS，不重建业务状态（见 ui-standard）。
 */
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addMonths, todayKey, toKey, diffDays } from '../core/index.js'
import { monthCells, weekHead } from '../core/grid.js'
import { ChevronLeft, ChevronRight, CalendarDays, Settings } from './icons.jsx'
import { AlmanacPanel } from './AlmanacPanel.jsx'
import { CountdownPanel, FestivalPopup } from './CountdownPanel.jsx'
import { YearPicker, MonthPicker } from './Picker.jsx'
import { DayHoverCard } from './DayHoverCard.jsx'
import { useDayHover } from './useDayHover.js'
import { WeatherCard } from './WeatherCard.jsx'
import { createWeatherStore } from '../services/weather.js'
import { WidgetCard } from './WidgetCard.jsx'
import { useWheelMonth } from './useWheelMonth.js'

export const DEFAULTS = {
  weekStart: 1,                 // 0 周日 / 1 周一
  showLunar: true,              // 农历节日
  showSolar: true,              // 公历节日
  showTerm: true,               // 节气
  showInternational: true,      // 国际节日
  showWeather: true,
  accentMode: 'shell',          // shell 跟随壳子 / term 跟随节气
  widgetStyle: 'today',         // today / countdown / mini
  widgetOpen: true,
}

/** 月网格：42 格固定，行高随容器均分；ref 指向外层容器，供滚轮翻月绑定 */
const MonthGrid = forwardRef(function MonthGrid({ cells, head, today, selected, slide, onPick, gridHandlers }, ref) {
  return (
    <div ref={ref} className="grid-wrap">
      <div className="week-head">{head.map(({ day, name, weekend }) => <span key={day} data-weekend={weekend || undefined}>{name}</span>)}</div>
      <div className="grid" data-anim={slide || undefined} style={{ '--slide': `${slide * 12}px` }} {...gridHandlers}>
        {cells.map(cell => (
          <button
            key={cell.key}
            type="button"
            className="day"
            data-outside={cell.outside || undefined}
            data-today={cell.key === toKey(today) || undefined}
            data-selected={cell.key === toKey(selected) || undefined}
            data-date={cell.key}
            onClick={event => onPick({ y: cell.y, m: cell.m, d: cell.d }, event.currentTarget)}
          >
            <span className="day-num">{cell.d}</span>
            <span className="day-sub" data-kind={cell.subKind || undefined}>{cell.sub}</span>
            {cell.tag && <span className="tag" data-kind={cell.tag}>{cell.tag === 'rest' ? '休' : '班'}</span>}
          </button>
        ))}
      </div>
    </div>
  )
})

export function App() {
  const kitRef = useRef(null)
  const api = window.enest || window.zapi
  const [mode, setMode] = useState(() => api?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode') || 'shell')
  const [settings, setSettings] = useState(DEFAULTS)
  const [cursor, setCursor] = useState(() => { const t = todayKey(); return { y: t.y, m: t.m } })
  const [selected, setSelected] = useState(() => todayKey())
  const [slide, setSlide] = useState(0)
  const [tick, setTick] = useState(() => Date.now())
  const [picker, setPicker] = useState(null)          // 'year' | 'month' | null
  const [pickerAnchor, setPickerAnchor] = useState(null)
  const [countdownAnchor, setCountdownAnchor] = useState(null)
  const [festivalPopup, setFestivalPopup] = useState(null)  // { festival, anchor }
  const gridRef = useRef(null)
  const quick = mode === 'quick'
  const hoverCtl = useDayHover({ enabled: quick })
  const weatherStore = useMemo(() => createWeatherStore({ load: key => kitRef.current?.load(key, null), save: (key, value) => kitRef.current?.save(key, value) }), [])

  // 分钟级时钟：驱动「当前时辰」高亮与跨日刷新
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const kit = PluginKit.create({ title: '中国日历', prefs: true, defaults: DEFAULTS })
    kitRef.current = kit
    kit.onMode(setMode)
    const onEnter = () => { if (kit.settings.showWeather !== false) weatherStore.start() }
    const onOut = () => weatherStore.stop()
    api?.onEnter?.(onEnter)
    api?.onOut?.(onOut)
    // ready 在无宿主桥时可能 resolve 出非对象；只接受真正的对象，否则保持默认值
    void kit.ready.then(value => { if (value && typeof value === 'object') setSettings({ ...DEFAULTS, ...value }) })
    return () => kit.destroy()
  }, [])

  const visibleTypes = useMemo(() => {
    const set = new Set()
    if (settings.showLunar) set.add('lunar')
    if (settings.showSolar) set.add('solar')
    if (settings.showTerm) set.add('term')
    if (settings.showInternational) set.add('international')
    return set
  }, [settings.showLunar, settings.showSolar, settings.showTerm, settings.showInternational])

  const cells = useMemo(() => monthCells(cursor, { startWeekday: settings.weekStart, visibleTypes }), [cursor, settings.weekStart, visibleTypes])
  const head = useMemo(() => weekHead(settings.weekStart), [settings.weekStart])
  const today = todayKey()
  const diff = diffDays(today, selected)
  const selectedCell = cells.find(cell => cell.key === toKey(selected))
  // 悬停卡按锚点的 data-date 回查格子数据
  const cellFor = anchor => cells.find(cell => cell.key === anchor?.dataset?.date)

  const go = useCallback(delta => {
    setSlide(delta)
    setCursor(current => addMonths(current, delta))
  }, [])
  const prevMonth = useCallback(() => go(-1), [go])
  const nextMonth = useCallback(() => go(1), [go])
  useWheelMonth(gridRef, prevMonth, nextMonth)

  const jumpTo = date => {
    setCursor({ y: date.y, m: date.m })
    setSelected({ y: date.y, m: date.m, d: date.d })
  }
  const openExternal = async url => {
    try { await api?.shell?.openExternal?.(url) } catch { /* 用户拒绝或宿主不支持时静默 */ }
  }

  return (
    <div className="cal" data-mode={mode} data-surface={mode}>
      <header className="cal-header">
        <div className="cal-title">
          <button type="button" className="cal-year" aria-label="选择年份" aria-expanded={picker === 'year'}
            onClick={event => { setPickerAnchor(event.currentTarget); setPicker(picker === 'year' ? null : 'year') }}>
            {cursor.y}<span className="cal-unit">年</span>
          </button>
          <button type="button" className="cal-month" aria-label="选择月份" aria-expanded={picker === 'month'}
            onClick={event => { setPickerAnchor(event.currentTarget); setPicker(picker === 'month' ? null : 'month') }}>
            {cursor.m}<span className="cal-unit">月</span>
          </button>
          <span className="cal-diff">{diff === 0 ? '今天' : diff > 0 ? `${diff} 天后` : `${-diff} 天前`}</span>
          <WeatherCard store={weatherStore} enabled={settings.showWeather} />
        </div>
        <div className="cal-nav">
          <button type="button" className="icon-btn" aria-label="上个月" onClick={prevMonth}><ChevronLeft /></button>
          <button type="button" className="icon-btn" aria-label="下个月" onClick={nextMonth}><ChevronRight /></button>
          <button type="button" className="today-btn" onClick={() => jumpTo(todayKey())}>今天</button>
          <span className="nav-sep" aria-hidden="true" />
          <button type="button" className="icon-btn" aria-label="节日倒数" aria-pressed={Boolean(countdownAnchor)}
            onClick={event => setCountdownAnchor(countdownAnchor ? null : event.currentTarget)}><CalendarDays /></button>
          <button type="button" className="icon-btn" aria-label="设置"><Settings /></button>
        </div>
      </header>

      <div className="cal-body">
        <main className="cal-main">
          <MonthGrid ref={gridRef} cells={cells} head={head} today={today} selected={selected} slide={slide} gridHandlers={hoverCtl.gridHandlers}
            onPick={date => setSelected(date)} />
        </main>
        {quick && (
          <aside className="dock" aria-label="当日信息">
            {(() => {
              const hovered = hoverCtl.hover ? cellFor(hoverCtl.hover.anchor) : null
              const cell = hovered ?? selectedCell ?? cells[20]
              return cell?.info
                ? <DayHoverCard cell={cell} anchor={null} docked maxItems={8} />
                : <div className="dock-empty">把鼠标移到日期上<br />查看当日黄历</div>
            })()}
          </aside>
        )}
        {!quick && (
          <div className="cal-side">
            {settings.widgetOpen && (
              <WidgetCard style={settings.widgetStyle} weather={weatherStore.snapshot().data[weatherStore.snapshot().cities[0]?.id]} />
            )}
            <AlmanacPanel
              key={toKey(selected)}
              date={selected}
              festivals={selectedCell?.festivals ?? []}
              tick={tick}
              onSelectFestival={(festival, anchor) => setFestivalPopup({ festival, anchor })}
            />
          </div>
        )}
      </div>

      {picker === 'year' && <YearPicker anchor={pickerAnchor} year={cursor.y} onClose={() => setPicker(null)} onPick={y => { setCursor({ y, m: cursor.m }); setPicker(null) }} />}
      {picker === 'month' && <MonthPicker anchor={pickerAnchor} month={cursor.m} onClose={() => setPicker(null)} onPick={m => { setCursor({ y: cursor.y, m }); setPicker(null) }} />}
      {festivalPopup && (
        <FestivalPopup festival={festivalPopup.festival} anchor={festivalPopup.anchor} onClose={() => setFestivalPopup(null)} onOpenExternal={openExternal} />
      )}
      {countdownAnchor && (
        <CountdownPanel
          anchor={countdownAnchor}
          onClose={() => setCountdownAnchor(null)}
          visibleTypes={visibleTypes}
          onOpenExternal={openExternal}
        />
      )}
    </div>
  )
}
