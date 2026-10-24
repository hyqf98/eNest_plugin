// 局域网传件纯逻辑：分享历史记录模型。可在 node 中直接自测。
// 历史结构（storage v2，向后兼容 v1 旧字段：files 字符串 / downloads / ts / shareId）：
// { v: 2, entries: [{ id, names, count, totalSize, downloads, ts, shareId? }] }

export const HISTORY_LIMIT = 50

/** 从旧版（字符串数组或 v1 对象数组）与 v2 结构归一读取历史 */
export function loadHistory(raw) {
  if (raw?.v === 2 && Array.isArray(raw.entries)) raw = raw.entries
  if (!Array.isArray(raw)) return []
  const entries = []
  for (const item of raw) {
    if (typeof item === 'string') {
      entries.push({ id: `h-${item}`, names: item, count: 1, totalSize: 0, downloads: 0, ts: 0 })
      continue
    }
    if (!item || typeof item !== 'object') continue
    entries.push({
      id: typeof item.id === 'string' ? item.id : `h-${item.ts ?? entries.length}`,
      names: String(item.names ?? item.files ?? ''),
      count: Number.isFinite(item.count) ? item.count : 1,
      totalSize: Number.isFinite(item.totalSize) ? item.totalSize : Number(item.totalSize) || 0,
      downloads: Number.isFinite(item.downloads) ? item.downloads : 0,
      ts: Number.isFinite(item.ts) ? item.ts : 0,
      shareId: typeof item.shareId === 'string' ? item.shareId : undefined
    })
  }
  return entries
}

/** 追加一条记录（去重按 shareId，最新在前，截断到上限） */
export function pushHistory(entries, record) {
  const filtered = entries.filter((e) => !(record.shareId && e.shareId === record.shareId))
  return [{ ...record, id: record.id || `h-${Date.now()}` }, ...filtered].slice(0, HISTORY_LIMIT)
}

/** 把 LanShareStatus 折叠成一条历史记录 */
export function recordFromShare(share) {
  const files = Array.isArray(share?.files) ? share.files : []
  return {
    names: files.map((f) => f.name).join('、').slice(0, 120),
    count: files.length,
    totalSize: files.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0),
    downloads: Number.isSafeInteger(share?.downloads) && share.downloads >= 0 ? share.downloads : 0,
    ts: share?.startedAt ?? Date.now(),
    shareId: share?.shareId
  }
}

/** 历史行展示文案：文件名（多条附计数）+ 大小 + 时间 + 方向 */
export function historyLine(entry) {
  const base = entry.count > 1 ? `${entry.count} 个文件 · ${entry.names}` : entry.names
  return base
}

/** 历史行元信息：时间 + 大小 + 下载次数 */
export function historyMeta(entry) {
  const parts = []
  if (entry.ts) parts.push(new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }))
  if (entry.totalSize > 0) parts.push(fmtBytesLocal(entry.totalSize))
  parts.push(`下载 ${entry.downloads ?? 0} 次`)
  return parts.join(' · ')
}

function fmtBytesLocal(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
