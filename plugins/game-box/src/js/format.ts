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

/* ---------------- 下载目录的展示文本 ----------------
   后端在用户所选根目录下按条目标题建子目录（backend/paths.ts 的 sanitizeSegment）。
   这里只负责把「根目录/子目录」拼成给用户看的文本；真正的落盘路径以后端为准。 */

/** 与后端 sanitizeSegment 的 MAX_SEGMENT 一致：Windows 路径段有长度上限 */
const MAX_SEGMENT = 180
/** Windows 保留设备名，不能单独作文件名 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 把标题清洗成可作文件夹名的文本，规则与后端 sanitizeSegment 逐步一致：
 * 非法字符转下划线、合并空白与下划线、去首尾的点/空格/下划线、保留名加前缀、超长截断。
 * 必须与后端一致，否则对话框显示的文件夹名会和实际创建的不同。
 */
export function sanitizeLeaf(title: string): string {
  let value = title.normalize('NFC')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[<>:"|?*\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/_+/g, '_')
    .replace(/^[.\s_]+|[.\s_]+$/g, '')
  if (!value) return 'Download'
  if (RESERVED.test(value)) value = `_${value}`
  if (value.length > MAX_SEGMENT) value = value.slice(0, MAX_SEGMENT).replace(/[\s._]+$/, '')
  return value || 'Download'
}

/** 拼接「根目录/子目录」的展示路径：按根目录的风格选分隔符（Windows 盘符或反斜杠用 \，其余用 /） */
export function joinDir(root: string, leaf: string): string {
  if (!root) return leaf
  const separator = root.includes('\\') || /^[A-Za-z]:/.test(root) ? '\\' : '/'
  return root.endsWith('\\') || root.endsWith('/') ? `${root}${leaf}` : `${root}${separator}${leaf}`
}
