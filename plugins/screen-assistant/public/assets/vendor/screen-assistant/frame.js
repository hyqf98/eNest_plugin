/* 纯视觉范围框：窗口 native passthrough，不接收任何指针事件。 */
const api = window.enestAux
const context = await api.getContext()
const data = context.data || {}
const bounds = data.bounds || { x: 0, y: 0, width: 0, height: 0 }
const scale = Number(context.display?.scaleFactor) || 1
const selection = document.getElementById('sel')
const rec = document.getElementById('rec')

const x = bounds.x / scale
const y = bounds.y / scale
const width = Math.max(1, bounds.width / scale)
const height = Math.max(1, bounds.height / scale)
selection.style.left = `${x}px`
selection.style.top = `${y}px`
selection.style.width = `${width}px`
selection.style.height = `${height}px`

const displayWidth = context.display?.width || innerWidth
const displayHeight = context.display?.height || innerHeight
if (width >= displayWidth - 2 && height >= displayHeight - 2) selection.classList.add('full')

function placeRec(visible) {
  rec.hidden = !visible
  if (!visible) return
  let recX = Math.min(innerWidth - 62, Math.max(4, x))
  let recY = y - 22
  if (recY < 4) recY = Math.min(innerHeight - 22, y + 6)
  rec.style.left = `${recX}px`
  rec.style.top = `${recY}px`
}
placeRec(data.recording === true)

api.onMessage(message => {
  if (message?.type === 'state') placeRec(message.recording === true)
})
