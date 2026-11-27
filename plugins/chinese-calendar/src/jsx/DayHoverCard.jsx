/**
 * 日期悬停卡 —— Quick 小窗的核心交互：鼠标停在日期格上，弹出该日完整信息。
 * Portal 到 body（带 backdrop-filter 的顶栏会劫持 fixed），由 bindHoverPanel 管理 hover 意图。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dayInfo, collectFestivals } from '../core/index.js'
import { almanac } from '../core/almanac.js'

const TYPE_LABEL = { legal: '法定', lunar: '农历', solar: '公历', term: '节气', international: '国际' }

export function DayHoverCard({ cell, anchor, pinned, onClose, maxItems = 6, docked = false }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  const info = cell?.info
  const data = info ? almanac(cell) : null
  const festivals = info ? collectFestivals(cell) : []

  // 锚点变化（鼠标移到另一格）时重新定位；停靠模式不需要
  useLayoutEffect(() => {
    if (docked) return
    if (!anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const card = ref.current.getBoundingClientRect()
    const vw = innerWidth, vh = innerHeight
    // 默认在格子右侧垂直居中；右侧放不下则放左侧；仍溢出则钳回视口
    let left = a.right + 8
    if (left + card.width > vw - 8) left = a.left - card.width - 8
    let top = a.top + a.height / 2 - card.height / 2
    top = Math.max(8, Math.min(top, vh - card.height - 8))
    left = Math.max(8, Math.min(left, vw - card.width - 8))
    setPos({ top, left })
  }, [anchor])

  useEffect(() => {
    if (!pinned) return
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    const onDown = event => { if (ref.current && !ref.current.contains(event.target) && !anchor?.contains(event.target)) onClose() }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true) }
  }, [pinned, anchor, onClose])

  if (!info || !data) return null
  const rest = festivals.find(item => item.type === 'legal' && !item.isWork)
  const work = festivals.find(item => item.type === 'legal' && item.isWork)

  const body = (
    <div
      ref={ref}
      className={`dhc${pinned ? ' dhc-pinned' : ''}`}
      role={docked ? 'region' : 'dialog'}
      aria-label={`${info.key} 日历信息`}
      data-input-context={docked ? undefined : 'overlay'}
      data-docked={docked || undefined}
      style={docked ? undefined : pos ?? { opacity: 0 }}
    >
      <div className="dhc-head">
        <span className="dhc-day">{cell.d}</span>
        <div className="dhc-head-side">
          <span className="dhc-full">{info.m}月{info.d}日 · {WEEKDAYS[info.weekday]}</span>
          <span className="dhc-lunar">{info.lunar.month}{info.lunar.day}{info.lunar.isLeapMonth ? '（闰）' : ''}</span>
        </div>
      </div>
      <div className="dhc-gz">{data.ganzhi.year}年 {data.ganzhi.month}月 {data.ganzhi.day}日 · {data.zodiac}年 · {data.sound}</div>

      {(rest || work || festivals.length > 0) && (
        <div className="dhc-chips">
          {rest && <span className="chip chip-rest">休 · {rest.name}</span>}
          {work && <span className="chip chip-work">班 · {work.name}</span>}
          {festivals.filter(item => item.type !== 'legal').map(item => (
            <span key={`${item.type}-${item.name}`} className={`chip chip-${item.type}`}>{item.name}</span>
          ))}
        </div>
      )}

      <div className="dhc-yiji">
        <div className="dhc-line"><span className="dhc-tag dhc-tag-yi">宜</span>{data.recommends.slice(0, maxItems).join(' ')}{data.recommends.length > maxItems ? ` 等${data.recommends.length}项` : ''}</div>
        <div className="dhc-line"><span className="dhc-tag dhc-tag-ji">忌</span>{data.avoids.length ? data.avoids.slice(0, maxItems).join(' ') : '无'}</div>
      </div>

      <div className="dhc-foot">
        <span>冲{data.chong} 煞{data.sha}</span>
        <span>{data.duty}日</span>
        <span>值神 {data.gods[0]}</span>
        {info.term.isTermDay && <span className="dhc-term">{info.term.name}</span>}
      </div>
      {pinned && !docked && <div className="dhc-hint">Esc 关闭</div>}
    </div>
  )
  // 停靠模式直接内联渲染（不 Portal），浮动词典下才挂到 body
  return docked ? body : createPortal(body, document.body)
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
export { TYPE_LABEL }
