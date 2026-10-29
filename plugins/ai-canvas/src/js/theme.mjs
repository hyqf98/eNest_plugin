/**
 * theme — 纸感手绘主题（沿 drawboard 纸感体系）。
 * 每套提供 CSS 变量组（--ac-*），挂 :root[data-paper="..."]（同时挂 .ac-app，便于局部覆盖）；
 * roughness 0-2 控制节点框与连线的抖动幅度。
 * auto = 跟随系统明暗：浅色用白纸、深色用深色。
 */

export const PAPERS = [
  { id: 'auto', label: '跟随系统' },
  { id: 'paper', label: '白纸' },
  { id: 'cream', label: '米黄' },
  { id: 'dark', label: '深色' },
  { id: 'board', label: '黑板' }
]

export const DEFAULT_PREFERENCES = {
  paper: 'auto',
  roughness: 1.2,
  grid: 'dots',
  defaultSize: 'auto',
  defaultQuality: 'auto'
}

/** 把 auto 解析成具体纸面；其余原样返回 */
export function resolvePaper(paper) {
  if (paper !== 'auto') return paper
  const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  return dark ? 'dark' : 'paper'
}

/** 订阅系统明暗变化（仅 auto 模式需要）；返回取消订阅函数 */
export function watchSystemScheme(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => onChange(query.matches ? 'dark' : 'paper')
  query.addEventListener?.('change', handler)
  return () => query.removeEventListener?.('change', handler)
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
