/**
 * 展示用的纯格式化函数：字节数、速度、剩余时间、百分比。
 * 只做数据到文本的转换，不依赖 React 与后端。
 */

/** 字节数转可读大小；未知（0 或非法）返回「未知大小」 */
export function formatBytes(bytes: number, fallback = '未知大小'): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return fallback
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 字节每秒转可读速度；无速度返回空串 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond, '0 B')}/s`
}

/** 秒数转剩余时间文本；未知返回空串 */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`
  return `${secs} 秒`
}

/** 0..100 的百分比，固定 1 位小数；非法值返回 0% */
export function percent(value: number): string {
  if (!Number.isFinite(value)) return '0%'
  const clamped = Math.max(0, Math.min(100, value))
  return `${clamped.toFixed(1)}%`
}
