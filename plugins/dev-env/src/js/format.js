/** 字节/数值格式化（占用右对齐 tabular-nums 用）。 */

export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatCount(n) {
  const value = Number(n)
  return Number.isFinite(value) ? value.toLocaleString() : '—'
}

export function totalBytes(items = []) {
  return items.reduce((sum, item) => sum + (Number(item?.bytes) || 0), 0)
}

export function platformLabel(platform) {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return String(platform ?? '')
}
