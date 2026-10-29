import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { formatZoned, zoneOffsetText } from '../js/core.mjs'
import { Button } from '../ui/index.jsx'

function clockAt(now, zone) {
  try {
    const value = formatZoned(now, zone)
    return {
      value,
      time: value.slice(11, 16),
      seconds: value.slice(17),
      date: value.slice(0, 10),
      label: new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'long', day: 'numeric', weekday: 'short' }).format(now),
      offset: zoneOffsetText(now, zone),
    }
  } catch {
    return null
  }
}

function cityName(zone) {
  return zone.split('/').pop().replace(/_/g, ' ')
}

function relativeDay(date, base) {
  const days = Math.round((Date.parse(date) - Date.parse(base)) / 86400000)
  return days === 0 ? '今天' : days === 1 ? '明天' : days === -1 ? '昨天' : date.slice(5)
}

export function PanelView({ now, zone, worldZones, onCopy, onOpen }) {
  const rootRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => observeWidgetSize(rootRef.current, setSize), [])

  const primary = clockAt(now, zone)
  const others = [...new Set(worldZones)].filter((item) => item !== zone)
  const wide = size.width >= 420 && others.length > 0
  const rowLimit = Math.max(0, Math.floor((size.height - (wide ? 66 : 166)) / 39))
  const visibleZones = others.slice(0, rowLimit)

  return (
    <main ref={rootRef} className="pk-widget clock-widget" data-wide={wide} aria-label="世界时钟小组件">
      <div className="pk-widget-heading clock-widget-heading">
        <h1 className="pk-widget-title" title={zone}>{cityName(zone)}</h1>
        <Button variant="ghost" size="sm" className="clock-widget-open" onClick={onOpen} title="打开完整时间工具，管理时区" aria-label="打开完整时间工具">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="M6 14 14 6M6 6h8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </Button>
      </div>
      <div className="clock-widget-body">
        {primary ? (
          <Button variant="ghost" className="clock-widget-face" onClick={() => onCopy(primary.value)} title="复制当前日期时间" aria-label={`复制 ${zone} 当前日期时间 ${primary.value}`}>
            <time className="clock-widget-time" dateTime={new Date(now).toISOString()}>{primary.time}<span>{primary.seconds}</span></time>
            <span className="clock-widget-date">{primary.label}</span>
            <span className="clock-widget-offset">{primary.offset}</span>
          </Button>
        ) : <p className="pk-widget-caption clock-widget-invalid">时区无效，请在完整应用中设置 IANA 时区。</p>}
        {visibleZones.length > 0 && (
          <ul className="clock-widget-world" aria-label="其他时区">
            {visibleZones.map((item) => {
              const clock = clockAt(now, item)
              return <li key={item} title={item}>
                <span className="clock-widget-city">{cityName(item)}<small>{clock && primary ? relativeDay(clock.date, primary.date) : '时区无效'}</small></span>
                <time>{clock?.time || '—'}</time>
              </li>
            })}
          </ul>
        )}
        {!others.length && size.height >= 230 && <p className="pk-widget-caption clock-widget-hint">在完整应用中添加世界时区</p>}
      </div>
    </main>
  )
}
