/**
 * params — 生成参数常量（尺寸 / 质量），Composer 与设置弹窗共用。
 */

export const SIZE_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '1:1', value: '1024x1024' },
  { label: '3:2', value: '1536x1024' },
  { label: '2:3', value: '1024x1536' }
]

export const QUALITY_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' }
]

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** usage 对象 → 摘要文本（input_tokens 等常见字段） */
export function usageLabel(usage) {
  if (!usage || typeof usage !== 'object') return ''
  const parts = []
  if (Number.isFinite(usage.input_tokens)) parts.push(`in ${usage.input_tokens}`)
  if (Number.isFinite(usage.output_tokens)) parts.push(`out ${usage.output_tokens}`)
  if (Number.isFinite(usage.total_tokens)) parts.push(`总 ${usage.total_tokens}`)
  return parts.join(' · ')
}
