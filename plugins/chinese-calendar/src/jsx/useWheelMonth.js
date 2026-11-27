/**
 * 滚轮翻月 —— 累积滚动量超过阈值才翻一页，并带冷却，避免触控板惯性连翻。
 * 与 he-calendar 的行为一致：deltaMode 归一化、阈值 80、冷却 500ms、停手 200ms 后清零累积。
 */
import { useEffect, useRef } from 'react'

const THRESHOLD = 80
const COOLDOWN = 500
const RESET = 200

export function useWheelMonth(ref, onPrev, onNext, { enabled = true } = {}) {
  const state = useRef({ acc: 0, last: 0, cool: 0 })
  const handlers = useRef({ onPrev, onNext })
  handlers.current = { onPrev, onNext }
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const onWheel = event => {
      // 横向滚动（触控板左右滑）不参与翻月
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      event.preventDefault()
      const s = state.current
      const now = Date.now()
      if (now - s.cool < COOLDOWN) return
      if (now - s.last > RESET) s.acc = 0
      s.last = now
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1
      s.acc += event.deltaY * unit
      if (Math.abs(s.acc) < THRESHOLD) return
      s.acc = 0
      s.cool = now
      if (event.deltaY > 0) handlers.current.onNext()
      else handlers.current.onPrev()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, enabled])
}
