/**
 * 日期悬停意图 —— 多锚点共享一张卡片。
 * bindHoverPanel 是单锚点设计，42 个格子各绑一个并不合适，这里用事件委托实现同样的手感：
 * 停留 120ms 才显示（快速划过不闪）、离开 300ms 后消失、鼠标移进卡片则保持、
 * Esc / 窗口失焦 / 尺寸变化立即收起；点击日期则固定（pinned），再次点击或 Esc 解除。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const SHOW_DELAY = 120
const HIDE_DELAY = 300

export function useDayHover({ enabled = true }) {
  const [hover, setHover] = useState(null)     // { cell, anchor }
  const [pinned, setPinned] = useState(null)   // { cell, anchor }
  const showTimer = useRef(0)
  const hideTimer = useRef(0)
  const overCard = useRef(false)
  const current = useRef(null)
  current.current = hover

  const clear = () => { clearTimeout(showTimer.current); clearTimeout(hideTimer.current) }
  const scheduleHide = useCallback(() => {
    clearTimeout(showTimer.current)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => { if (!overCard.current) setHover(null) }, HIDE_DELAY)
  }, [])

  // 网格上的事件委托：只认 .day 按钮
  const onPointerOver = useCallback(event => {
    if (!enabled) return
    const cell = event.target.closest?.('.day')
    if (!cell || !event.currentTarget.contains(cell)) return
    if (event.pointerType === 'touch') return
    clearTimeout(hideTimer.current)
    if (current.current?.anchor === cell) return
    clearTimeout(showTimer.current)
    // 从一格直接移到另一格：已有卡片时立即切换，没有时延迟显示
    if (current.current) setHover({ anchor: cell })
    else showTimer.current = setTimeout(() => setHover({ anchor: cell }), SHOW_DELAY)
  }, [enabled])

  const onPointerOut = useCallback(event => {
    if (!enabled) return
    const cell = event.target.closest?.('.day')
    if (!cell) return
    const to = event.relatedTarget
    if (to && cell.contains(to)) return
    clearTimeout(showTimer.current)
    scheduleHide()
  }, [enabled, scheduleHide])

  const enterCard = useCallback(() => { overCard.current = true; clearTimeout(hideTimer.current) }, [])
  const leaveCard = useCallback(() => { overCard.current = false; scheduleHide() }, [scheduleHide])

  const unpin = useCallback(() => setPinned(null), [])

  useEffect(() => {
    if (!enabled) { clear(); setHover(null); setPinned(null) }
  }, [enabled])

  // Esc / 失焦 / 尺寸变化 / 页面隐藏：收起
  useEffect(() => {
    if (!hover && !pinned) return
    const onKey = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      clear()
      setPinned(null)
      setHover(null)
    }
    const close = () => { clear(); setHover(null); setPinned(null) }
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    document.addEventListener('visibilitychange', close)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      document.removeEventListener('visibilitychange', close)
    }
  }, [hover, pinned])

  // 固定态下点击卡片 / 锚点之外的地方解除固定
  useEffect(() => {
    if (!pinned) return
    const onDown = event => {
      if (pinned.anchor?.contains(event.target)) return
      setPinned(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [pinned])

  return {
    hover, pinned, unpin,
    gridHandlers: { onPointerOver, onPointerOut },
    cardHandlers: { onPointerEnter: enterCard, onPointerLeave: leaveCard },
    /** 点击日期：固定卡片；再点同一格则解除 */
    pin: (cell, anchor) => {
      clear()
      setHover(null)
      setPinned(prev => prev?.anchor === anchor ? null : { cell, anchor })
    },
  }
}
