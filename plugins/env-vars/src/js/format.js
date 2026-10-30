/** 变量值/来源的展示格式化。 */

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatWhen(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const SCOPE_LABEL = {
  user: '用户', machine: '系统', process: '进程', persistent: '持久', path: 'PATH'
}

export function scopeLabel(id) {
  return SCOPE_LABEL[id] ?? id
}

export function originLabel(item) {
  if (!item?.origin) return ''
  if (item.origin === 'registry') return '注册表'
  return item.origin.replace(/^\/Users\/[^/]+/, '~')
}
