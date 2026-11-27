/**
 * 年 / 月选择器 —— 点击标题弹出网格；年份每页 6 个，滚轮翻页，范围 1901–2100。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MIN_YEAR, MAX_YEAR } from '../core/index.js'
import { ChevronLeft, ChevronRight } from './icons.jsx'

const PAGE = 6

/** 锚点定位的浮层壳：Portal 到 body，自动避开视口边缘，点击外部 / Esc 关闭 */
export function AnchorPopup({ anchor, onClose, children, className = '', align = 'left' }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const card = ref.current.getBoundingClientRect()
    let top = a.bottom + 6
    if (top + card.height > innerHeight - 8) top = a.top - card.height - 6
    const left = align === 'right' ? Math.max(8, Math.min(a.right - card.width, innerWidth - card.width - 8)) : Math.max(8, Math.min(a.left, innerWidth - card.width - 8))
    setPos({ top: Math.max(8, top), left })
  }, [anchor, align])
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    const onDown = event => { if (ref.current && !ref.current.contains(event.target) && !anchor?.contains(event.target)) onClose() }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true) }
  }, [anchor, onClose])
  return createPortal(
    <div ref={ref} className={`picker-pop ${className}`} role="dialog" data-input-context="overlay" style={pos ?? { opacity: 0 }}>{children}</div>,
    document.body,
  )
}

export function YearPicker({ anchor, year, onPick, onClose }) {
  const [page, setPage] = useState(() => Math.floor((year - MIN_YEAR) / PAGE))
  const pages = Math.ceil((MAX_YEAR - MIN_YEAR + 1) / PAGE)
  const wheelLock = useRef(0)
  const start = MIN_YEAR + page * PAGE
  const years = Array.from({ length: PAGE }, (_, i) => start + i).filter(y => y <= MAX_YEAR)

  // 滚轮翻页：300ms 节流，避免一次滚动连翻好几页
  const onWheel = event => {
    event.preventDefault()
    const now = Date.now()
    if (now - wheelLock.current < 300) return
    wheelLock.current = now
    setPage(value => Math.max(0, Math.min(pages - 1, value + (event.deltaY > 0 ? 1 : -1))))
  }

  return (
    <AnchorPopup anchor={anchor} onClose={onClose} className="picker-year" align="right">
      <div className="picker-nav">
        <button type="button" className="icon-btn" aria-label="更早的年份" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft /></button>
        <span className="picker-range">{years[0]} – {years.at(-1)}</span>
        <button type="button" className="icon-btn" aria-label="更晚的年份" disabled={page === pages - 1} onClick={() => setPage(page + 1)}><ChevronRight /></button>
      </div>
      <div className="picker-grid" onWheel={onWheel}>
        {years.map(y => (
          <button key={y} type="button" className="picker-cell" data-current={y === year || undefined} onClick={() => onPick(y)}>{y}</button>
        ))}
      </div>
      <div className="picker-hint pk-muted">滚动切换年份</div>
    </AnchorPopup>
  )
}

export function MonthPicker({ anchor, month, onPick, onClose }) {
  return (
    <AnchorPopup anchor={anchor} onClose={onClose} className="picker-month" align="left">
      <div className="picker-grid picker-grid-month">
        {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
          <button key={m} type="button" className="picker-cell" data-current={m === month || undefined} onClick={() => onPick(m)}>{m} 月</button>
        ))}
      </div>
    </AnchorPopup>
  )
}
