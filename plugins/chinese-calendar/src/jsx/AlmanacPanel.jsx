/**
 * 黄历面板 —— 选中日的大号日期、农历干支、节日 chip、宜/忌、干支五行冲煞胎神、十二时辰。
 */
import { useEffect, useState } from 'react'
import { almanac, shichenList } from '../core/index.js'

function Row({ label, value, tone }) {
  return (
    <div className={`al-row${tone ? ` al-row-${tone}` : ''}`}>
      <span className="al-label">{label}</span>
      <span className="al-value">{value}</span>
    </div>
  )
}

/** 时辰标签：值神首字 + 吉/凶；点击展开详情 */
function Shichen({ item, expanded, onToggle }) {
  return (
    <>
      <button
        type="button"
        className={`sc${item.lucky ? ' sc-lucky' : ''}${item.current ? ' sc-now' : ''}${expanded ? ' sc-open' : ''}`}
        aria-expanded={expanded}
        title={`${item.name} ${item.range} ${item.god}${item.lucky ? '（黄道）' : '（黑道）'}`}
        onClick={onToggle}
      >
        <span className="sc-god">{item.god.slice(0, 1)}</span>
        <span className="sc-name">{item.name.slice(0, 1)}</span>
        <span className="sc-luck">{item.lucky ? '吉' : '凶'}</span>
      </button>
      {expanded && (
        <div className="sc-detail" role="region" aria-label={`${item.name}吉凶`}>
          <div className="sc-detail-head">
            <strong>{item.name}</strong>
            <span className="sc-range">{item.range}</span>
            <span className={`sc-badge${item.lucky ? ' sc-badge-lucky' : ''}`}>{item.god} · {item.lucky ? '黄道' : '黑道'}</span>
            <span className="sc-gz">{item.ganzhi}时</span>
          </div>
          {item.recommends.length > 0 && <div className="sc-line"><span>宜</span>{item.recommends.join(' ')}</div>}
          {item.avoids.length > 0 && <div className="sc-line sc-line-avoid"><span>忌</span>{item.avoids.join(' ')}</div>}
        </div>
      )}
    </>
  )
}

export function AlmanacPanel({ date, festivals, onSelectFestival, tick }) {
  const [openSlot, setOpenSlot] = useState(null)
  const data = almanac(date)
  // tick：分钟级时钟，用来刷新「当前时辰」高亮
  const hours = data ? shichenList(date, new Date(tick)) : []
  useEffect(() => { setOpenSlot(null) }, [data?.key])

  if (!data) return <aside className="almanac" aria-label="黄历" />
  const lunarDate = `${data.lunar.month}${data.lunar.day}`
  const rest = festivals.find(item => item.type === 'legal' && !item.isWork)
  const work = festivals.find(item => item.type === 'legal' && item.isWork)

  return (
    <aside className="almanac" aria-label="黄历">
      <div className="al-head">
        <div className="al-big">
          <span className="al-day">{date.d}</span>
          <div className="al-head-side">
            <span className="al-weekday">{WEEKDAYS[data.key ? new Date(date.y, date.m - 1, date.d).getDay() : 0]}</span>
            <span className="al-full">{date.y}年{date.m}月</span>
          </div>
        </div>
        <div className="al-lunar">
          <span className="al-lunar-date">{lunarDate}</span>
          {data.lunar.isLeapMonth && <span className="al-leap">闰</span>}
          <span className="al-zodiac">{data.ganzhi.year}年 · {data.zodiac}年</span>
        </div>
        {(festivals.length > 0 || rest || work) && (
          <div className="al-chips">
            {rest && <span className="chip chip-rest">休 · {rest.name}</span>}
            {work && <span className="chip chip-work">班 · {work.name}</span>}
            {festivals.filter(item => item.type !== 'legal').map(item => (
              <button key={`${item.type}-${item.name}`} type="button" className={`chip chip-${item.type}`} onClick={event => onSelectFestival?.({ ...item, date: data.key, weekday: WEEKDAYS[new Date(date.y, date.m - 1, date.d).getDay()], daysFromToday: 0, countdown: '就是今天' }, event.currentTarget)}>
                {item.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="al-yiji">
        <div className="yiji">
          <span className="yiji-label">宜</span>
          <div className="yiji-list">{data.recommends.length ? data.recommends.map(item => <span key={item}>{item}</span>) : <span className="pk-muted">无</span>}</div>
        </div>
        <div className="yiji yiji-avoid">
          <span className="yiji-label">忌</span>
          <div className="yiji-list">{data.avoids.length ? data.avoids.map(item => <span key={item}>{item}</span>) : <span className="pk-muted">无</span>}</div>
        </div>
      </div>

      <div className="al-board">
        <Row label="干支" value={`${data.ganzhi.year}年 ${data.ganzhi.month}月 ${data.ganzhi.day}日`} />
        <Row label="纳音" value={data.sound} />
        <Row label="冲煞" value={`冲${data.chong}（煞${data.sha}）`} />
        <Row label="胎神" value={data.fetus} />
        <Row label="建除" value={`${data.duty}日`} />
        <Row label="值神" value={data.gods[0] ?? ''} />
        <Row label="彭祖" value={data.pengzu} tone="pengzu" />
      </div>

      <div className="al-shichen">
        <div className="al-sub">十二时辰</div>
        <div className="sc-grid" role="list">
          {hours.map(item => (
            <Shichen key={item.slot} item={item} expanded={openSlot === item.slot} onToggle={() => setOpenSlot(openSlot === item.slot ? null : item.slot)} />
          ))}
        </div>
      </div>
    </aside>
  )
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
