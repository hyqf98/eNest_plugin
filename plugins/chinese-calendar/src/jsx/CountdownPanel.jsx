/**
 * 节日倒数面板 —— 从今天起的节日按月份分组，带倒数与连休天数；点击展开简介卡。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { countdownBoard, todayKey } from '../core/index.js'
import { External, X } from './icons.jsx'
import { AnchorPopup } from './Picker.jsx'

const TYPE_LABEL = { legal: '法定', lunar: '农历', solar: '公历', term: '节气', international: '国际' }
const INITIAL_ROWS = 18

/** 只保留前 limit 行，返回仍带月份标题的分组 */
function takeRows(groups, limit) {
  const result = []
  let used = 0
  for (const group of groups) {
    if (used >= limit) break
    const rows = group.rows.slice(0, limit - used)
    result.push({ ...group, rows })
    used += rows.length
  }
  return result
}

/** 节日简介浮卡；Portal 到 body，避开带 backdrop-filter 的容器 */
export function FestivalPopup({ festival, anchor, onClose, onOpenExternal }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  useEffect(() => {
    if (!anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const card = ref.current.getBoundingClientRect()
    // 优先在锚点下方右对齐；放不下则上方；仍溢出则钳回视口
    let top = a.bottom + 6
    if (top + card.height > innerHeight - 8) top = a.top - card.height - 6
    const left = Math.max(8, Math.min(a.right - card.width, innerWidth - card.width - 8))
    top = Math.max(8, Math.min(top, innerHeight - card.height - 8))
    setPos({ top, left })
  }, [anchor])
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    const onDown = event => { if (ref.current && !ref.current.contains(event.target) && !anchor?.contains(event.target)) onClose() }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true) }
  }, [anchor, onClose])
  if (!festival) return null
  const url = `https://baike.baidu.com/item/${encodeURIComponent(festival.name)}`
  return createPortal(
    <div ref={ref} className="fp" role="dialog" aria-label={festival.name} data-input-context="overlay" style={pos ?? { opacity: 0 }}>
      <div className="fp-head">
        <span className={`fp-type fp-type-${festival.type}`}>{TYPE_LABEL[festival.type]}</span>
        <strong>{festival.name}</strong>
        {festival.restDays > 0 && <span className="fp-rest">休 {festival.restDays} 天</span>}
        <button type="button" className="fp-close" aria-label="关闭" onClick={onClose}><X /></button>
      </div>
      <div className="fp-date">{festival.date} · {festival.weekday}<span className="fp-count">{festival.countdown}</span></div>
      {festival.description && <p className="fp-desc">{festival.description}</p>}
      <div className="fp-actions">
        <button type="button" className="fp-link" onClick={() => onOpenExternal?.(url)}>查看百度百科 <External /></button>
      </div>
    </div>,
    document.body,
  )
}

export function CountdownPanel({ anchor, onClose, visibleTypes, rangeDays = 400, onOpenExternal }) {
  const [popup, setPopup] = useState(null)
  const [popupAnchor, setPopupAnchor] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const groups = useMemo(() => countdownBoard({ visibleTypes, rangeDays }), [visibleTypes, rangeDays])
  const thisYear = todayKey().y
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const visibleGroups = expanded ? groups : takeRows(groups, INITIAL_ROWS)
  const shown = visibleGroups.reduce((n, g) => n + g.rows.length, 0)

  return (
    <AnchorPopup anchor={anchor} onClose={onClose} className="cd" align="right">
      <div className="cd-head">
        <span className="al-sub">节日倒数</span>
        <span className="cd-count">未来 {rangeDays} 天 · {total} 个</span>
      </div>
      <div className="cd-list">
        {visibleGroups.map(group => (
          <section key={`${group.year}-${group.month}`} className="cd-group">
            <div className="cd-month">
              {group.year !== thisYear && <span className="cd-nextyear">明年</span>}{group.month} 月
            </div>
            {group.rows.map(row => (
              <button
                key={row.key}
                type="button"
                className={`cd-row cd-row-${row.type}`}
                onClick={event => { setPopupAnchor(event.currentTarget); setPopup(row) }}
              >
                <span className="cd-name">{row.name}</span>
                <span className="cd-rest">{row.restDays > 0 ? `休${row.restDays}天` : ''}</span>
                <span className="cd-date">{row.date.slice(5).replace(/^0/, '').replace('-', '月')}日 · {row.weekday}</span>
                <span className={`cd-until${row.daysFromToday <= 7 ? ' cd-until-soon' : ''}`}>{row.countdown}</span>
              </button>
            ))}
          </section>
        ))}
        {total === 0 && <div className="cd-empty pk-muted">这段时间没有符合条件的节日</div>}
      </div>
      {total > INITIAL_ROWS && (
        <button type="button" className="cd-more" onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起' : `展开全部（还有 ${total - shown} 个）`}
        </button>
      )}
      <button type="button" className="cd-close" aria-label="关闭" onClick={onClose}><X /></button>
      {popup && <FestivalPopup festival={popup} anchor={popupAnchor} onClose={() => setPopup(null)} onOpenExternal={onOpenExternal} />}
    </AnchorPopup>
  )
}
