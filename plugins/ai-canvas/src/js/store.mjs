/**
 * store — 多画布草稿持久化（宿主私有 KV，防抖合并写）。
 * 草稿 { id, name, nodes, edges, viewport }；图片只存 asset 引用（url 可由
 * enest://media 稳定读取），节点 lastRun 缓存随草稿保存，重启后单节点运行可用。
 */

const DRAFTS_KEY = 'ai-canvas.drafts.v1'
const SAVE_DELAY_MS = 800

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

export function newDraft(name = '未命名画布') {
  return { id: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: Date.now(), updatedAt: Date.now() }
}

export async function loadDrafts() {
  try {
    const saved = await store().storage.get(DRAFTS_KEY)
    if (Array.isArray(saved)) return saved
  } catch { /* 首次 */ }
  return [newDraft('画布 1')]
}

let saveTimer = null
let pending = null
/** 防抖保存全部草稿；立即调用可 flush */
export function saveDrafts(drafts, { immediate = false } = {}) {
  pending = drafts.map(d => ({ ...d, updatedAt: Date.now() }))
  if (immediate) return flush()
  if (saveTimer) clearTimeout(saveTimer)
  return new Promise(resolve => {
    saveTimer = setTimeout(() => { flush().then(resolve, resolve) }, SAVE_DELAY_MS)
  })
}
async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (!pending) return
  const data = pending
  pending = null
  await store().storage.set(DRAFTS_KEY, data)
}
