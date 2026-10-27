/**
 * theme — 4 套纸感手绘主题（沿 drawboard 纸感体系）。
 * 每套提供 CSS 变量组（--ac-*），挂 #root[data-paper="..."]；
 * roughness 0-2 控制节点框与连线的抖动幅度。
 */

export const PAPERS = [
  { id: 'paper', label: '白纸' },
  { id: 'cream', label: '米黄' },
  { id: 'dark', label: '深色' },
  { id: 'board', label: '黑板' }
]

export const DEFAULT_PREFERENCES = {
  paper: 'paper',
  roughness: 1.2,
  grid: 'dots',
  defaultSize: 'auto',
  defaultQuality: 'auto'
}

const PREFS_KEY = 'ai-canvas.prefs.v1'

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

export async function loadPreferences() {
  try {
    const saved = await store().storage.get(PREFS_KEY)
    if (saved && typeof saved === 'object') return { ...DEFAULT_PREFERENCES, ...saved }
  } catch { /* 首次 */ }
  return { ...DEFAULT_PREFERENCES }
}

export async function savePreferences(prefs) {
  await store().storage.set(PREFS_KEY, prefs)
  return prefs
}
