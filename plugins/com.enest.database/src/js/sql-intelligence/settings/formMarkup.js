/** Shared presentation helpers; all persisted/configured text is escaped. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}
export const clone = value => JSON.parse(JSON.stringify(value))
export const uid = prefix => `${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 7)}`
export function options(items, value) {
  return items.map(item => {
    const [key, label] = Array.isArray(item) ? item : [item, item]
    return `<option value="${esc(key)}" ${String(value ?? '') === String(key) ? 'selected' : ''}>${esc(label)}</option>`
  }).join('')
}
export function field(label, key, value, kind = 'text', extra = '') {
  if (kind === 'checkbox') return `<label class="sql-setting-check"><input type="checkbox" data-config="${key}" ${value ? 'checked' : ''}><span>${label}</span></label>`
  return `<label>${label}<input type="${kind}" data-config="${key}" value="${esc(value)}" ${extra}></label>`
}
export function select(label, key, value, items) {
  return `<label>${label}<select data-config="${key}">${options(items, value)}</select></label>`
}
export function scopeLabel(scope = {}) {
  return [scope.connectionId, scope.database, scope.schema, scope.table].filter(Boolean).join(' / ') || '全局'
}
