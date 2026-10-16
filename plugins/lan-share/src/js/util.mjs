// 局域网传件纯逻辑：字节数 / 时间 / 剩余时长格式化。可在 node 中直接自测。

/** 字节数人性化：B → KB → MB → GB，一位小数（GB 两位） */
export function fmtBytes(n) {
  const value = Number(n)
  if (!Number.isFinite(value) || value < 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

/** 时钟时间：HH:mm:ss（24 小时制） */
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 剩余时长 mm:ss（不足归零） */
export function fmtRemain(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
