import { surfaceImageUrl } from './image.js'
const api = window.enestAux
const image = document.getElementById('image')
const context = await api.getContext()
let objectUrl
try { objectUrl = await surfaceImageUrl(context.data); image.src = objectUrl }
catch (error) { await api.close(); throw error }
document.title = context.data.title || '贴图'
image.onload = () => { if (image.naturalWidth * image.naturalHeight > 40_000_000) void api.close() }
image.onerror = () => { void api.close() }
let scale = 1
addEventListener('wheel', event => {
  event.preventDefault()
  scale = Math.min(4, Math.max(.2, scale * (event.deltaY > 0 ? .92 : 1.08)))
  image.style.transform = `scale(${scale})`
}, { passive: false })
document.getElementById('close').onclick = () => api.close()
addEventListener('keydown', event => { if (event.key === 'Escape') void api.close() })
addEventListener('pagehide', () => { image.removeAttribute('src'); URL.revokeObjectURL(objectUrl) }, { once: true })
