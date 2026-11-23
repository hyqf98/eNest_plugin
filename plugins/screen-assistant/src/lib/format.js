/** 日期、体积与命名。 */

export function formatBytes(bytes) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size < 0) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now())
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatDate(ts) {
  const date = new Date(Number(ts) || Date.now())
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function groupLabel(ts) {
  const date = new Date(Number(ts) || Date.now())
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const day = 24 * 60 * 60 * 1000
  if (value === start) return '今天'
  if (value === start - day) return '昨天'
  if (value === start - day * 2) return '前天'
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

export function stampName(prefix = '截图') {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${prefix} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

export function formatDimensions(width, height) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  return w && h ? `${w} × ${h}` : ''
}
