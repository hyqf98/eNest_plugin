import { surfaceImageUrl } from './image.js'
const api = window.enestAux, context = await api.getContext(), image = document.getElementById('background'), selection = document.getElementById('selection')
let objectUrl
try { objectUrl = await surfaceImageUrl(context.data); image.src = objectUrl }
catch (error) { await api.close(); throw error }
let sx = 0, sy = 0, ex = 0, ey = 0, dragging = false, finished = false
const point = event => [Math.max(0, Math.min(innerWidth, event.clientX)), Math.max(0, Math.min(innerHeight, event.clientY))]
function draw() {
  const x = Math.min(sx, ex), y = Math.min(sy, ey), width = Math.abs(ex - sx), height = Math.abs(ey - sy)
  Object.assign(selection.style, { display: dragging || width > 2 || height > 2 ? 'block' : 'none', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` })
}
function confirm() {
  const ratioX = context.data.width / innerWidth, ratioY = context.data.height / innerHeight
  const bounds = { x: Math.round(Math.min(sx, ex) * ratioX), y: Math.round(Math.min(sy, ey) * ratioY), width: Math.round(Math.abs(ex - sx) * ratioX), height: Math.round(Math.abs(ey - sy) * ratioY) }
  if (finished || bounds.width <= 3 || bounds.height <= 3) return
  finished = true
  void api.post({ type: 'confirm', bounds })
}
addEventListener('pointerdown', event => { if (event.button !== 0 || finished) return; [sx, sy] = [ex, ey] = point(event); dragging = true; document.body.setPointerCapture(event.pointerId); draw() })
addEventListener('pointermove', event => { if (dragging) { [ex, ey] = point(event); draw() } })
addEventListener('pointerup', event => { if (!dragging) return; [ex, ey] = point(event); dragging = false; draw(); confirm() })
addEventListener('keydown', event => { if (event.key === 'Escape') { finished = true; void api.post({ type: 'cancel' }) } else if (event.key === 'Enter') confirm() })
addEventListener('pagehide', () => { image.removeAttribute('src'); URL.revokeObjectURL(objectUrl) }, { once: true })
