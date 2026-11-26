/* 纯视觉范围框：窗口 native passthrough，不接收任何指针事件。 */
import { displayRectInViewport, sameDisplay } from './geometry.js'

const api = window.enestAux
const context = await api.getContext()
const data = context.data || {}
const bounds = data.bounds
const display = context.display
let viewportBounds = context.viewportBounds
let recording = data.recording === true
const selection = document.getElementById('sel')
const rec = document.getElementById('rec')

function layoutFrame() {
  const rect = displayRectInViewport(bounds, display, viewportBounds, { width: innerWidth, height: innerHeight })
  Object.assign(selection.style, {
    left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`
  })
  rec.hidden = !recording
  if (!recording) return
  const gap = 5
  const width = rec.offsetWidth, height = rec.offsetHeight
  const left = Math.max(gap, Math.min(innerWidth - width - gap, rect.x))
  const top = Math.max(gap, Math.min(innerHeight - height - gap, rect.y))
  const position = [
    { x: left, y: rect.y - height - gap },
    { x: left, y: rect.y + rect.height + gap },
    { x: rect.x - width - gap, y: top },
    { x: rect.x + rect.width + gap, y: top }
  ].find(point => point.x >= 0 && point.y >= 0 && point.x + width <= innerWidth && point.y + height <= innerHeight)
  if (position) Object.assign(rec.style, { left: `${position.x}px`, top: `${position.y}px` })
  else rec.hidden = true
}

layoutFrame()
addEventListener('resize', layoutFrame)
api.onMessage(message => {
  if (message?.type === 'state') recording = message.recording === true
  else if (message?.type === 'enest:surface-changed' && message.state?.display) {
    if (!sameDisplay(display, message.state.display)) {
      void api.close()
      return
    }
    viewportBounds = message.state.viewportBounds ?? viewportBounds
  } else return
  layoutFrame()
})
