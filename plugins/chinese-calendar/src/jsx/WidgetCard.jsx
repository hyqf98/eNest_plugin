/**
 * 小组件皮肤 —— 三种可切换的紧凑卡：今日 / 倒计时 / 迷你月历。
 * 放在 shell 布局左上（黄历栏顶部），quick 布局不显示。
 */
import { dayInfo, collectFestivals, upcomingHolidays, monthCells, weekHead, todayKey, toKey, WEEKDAY_NAMES } from '../core/index.js'
import { ArrowUp, ArrowDown } from './icons.jsx'

export const WIDGET_STYLES = [
  { value: 'today', label: '今日' },
  { value: 'countdown', label: '倒计时' },
  { value: 'mini', label: '迷你月历' },
]

function TodayCard() {
  const info = dayInfo(todayKey())
  if (!info) return null
  const festivals = collectFestivals(info).filter(item => item.type !== 'legal' || !item.isWork)
  return (
    <>
      <div className="wg-today">
        <span className="wg-day">{info.d}</span>
        <div className="wg-today-side">
          <span className="wg-weekday">{WEEKDAY_NAMES[info.weekday]}</span>
          <span className="wg-lunar">{info.lunar.month}{info.lunar.day}</span>
        </div>
      </div>
      <div className="wg-meta">{info.ganzhi.year}年 · {info.zodiac}年 · {info.ganzhi.day}日</div>
      {festivals.length > 0 && (
        <div className="wg-chips">{festivals.slice(0, 3).map(item => <span key={item.name} className={`chip chip-${item.type}`}>{item.short}</span>)}</div>
      )}
    </>
  )
}

function CountdownCard() {
  const today = todayKey()
  const list = upcomingHolidays(today, 2)
  if (list.length === 0) return <div className="wg-empty pk-muted">近期没有法定假期</div>
  const [next, after] = list
  return (
    <>
      <div className="wg-cd-label">下一个假期</div>
      <div className="wg-cd-main">
        <strong>{next.name}</strong>
        <span className="wg-cd-days">{next.today ? '就是今天' : next.daysUntil === 1 ? '明天' : `还有 ${next.daysUntil} 天`}</span>
      </div>
      <div className="wg-meta">{toKey(next.start).slice(5).replace('-', '/')} 起 · 连休 {next.days} 天</div>
      {after && <div className="wg-cd-after">{after.name} <span>{after.daysUntil} 天后</span></div>}
    </>
  )
}

function MiniMonthCard() {
  const today = todayKey()
  const cells = monthCells({ y: today.y, m: today.m }, { startWeekday: 0 })
  const head = weekHead(0)
  return (
    <div className="wg-mini">
      <div className="wg-mini-head">{head.map(({ day, name }) => <span key={day}>{name}</span>)}</div>
      <div className="wg-mini-grid">
        {cells.map(cell => (
          <span
            key={cell.key}
            className={`wg-mini-cell${cell.outside ? ' wg-mini-out' : ''}${cell.key === toKey(today) ? ' wg-mini-today' : ''}${cell.tag === 'rest' ? ' wg-mini-rest' : ''}`}
          >{cell.d}</span>
        ))}
      </div>
    </div>
  )
}

export function WidgetCard({ style, weather }) {
  const cards = { today: TodayCard, countdown: CountdownCard, mini: MiniMonthCard }
  const Card = cards[style] ?? TodayCard
  return (
    <div className="widget" data-style={style}>
      <div className="widget-body"><Card /></div>
      {weather?.current && (
        <div className="widget-weather">
          <span>{weather.current.emoji}</span>
          <span className={`wx-temp wx-temp-${weather.current.band}`}>{Math.round(weather.current.temp)}°</span>
        </div>
      )}
    </div>
  )
}

/** 小组件样式切换器：三个小箭头按钮循环切换，不占空间 */
export function WidgetStyleSwitch({ value, onChange }) {
  const index = WIDGET_STYLES.findIndex(item => item.value === value)
  const step = delta => onChange(WIDGET_STYLES[(index + delta + WIDGET_STYLES.length) % WIDGET_STYLES.length].value)
  return (
    <div className="wg-switch" role="group" aria-label="小组件样式">
      <button type="button" className="icon-btn" aria-label="上一种小组件样式" onClick={() => step(-1)}><ArrowUp /></button>
      <span className="wg-switch-label">{WIDGET_STYLES[index]?.label ?? '今日'}</span>
      <button type="button" className="icon-btn" aria-label="下一种小组件样式" onClick={() => step(1)}><ArrowDown /></button>
    </div>
  )
}
