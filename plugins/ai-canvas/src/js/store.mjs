/**
 * store — 多画布草稿持久化（宿主私有 KV，防抖合并写）。
 *
 * 存储布局（v2）：索引 ai-canvas.draft-index.v1（[{id,name,updatedAt}]），
 * 每个草稿单独一个键 ai-canvas.draft.<id>（{id,name,nodes,edges,viewport,createdAt,updatedAt}）。
 * 分键原因：KV 单值上限 512 KiB，全部草稿挤一个值时多画布+多节点历史会触顶。
 * 首次加载自动从旧版单键 ai-canvas.drafts.v1 迁移并删除旧键。
 * 写失败经 onWriteError 上报（不再静默丢数据）。
 */

const INDEX_KEY = 'ai-canvas.draft-index.v2'
const DRAFT_PREFIX = 'ai-canvas.draft.'
const LEGACY_KEY = 'ai-canvas.drafts.v1'
const SAVE_DELAY_MS = 800

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

export function newDraft(name = '未命名画布') {
  return {
    id: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name, nodes: [], edges: [], viewport: null,
    createdAt: Date.now(), updatedAt: Date.now()
  }
}

let writeErrorHandler = null
export function onWriteError(handler) { writeErrorHandler = handler }

async function saveDraftRecord(draft) {
  try {
    await store().storage.set(`${DRAFT_PREFIX}${draft.id}`, draft)
  } catch (error) {
    writeErrorHandler?.(`画布「${draft.name}」保存失败：${error instanceof Error ? error.message : error}`)
  }
}

/** 旧版单键迁移：拆分写新键后删除旧键 */
async function migrateLegacy() {
  const legacy = await store().storage.get(LEGACY_KEY)
  if (!Array.isArray(legacy)) return null
  for (const draft of legacy) {
    if (!draft?.id) continue
    await saveDraftRecord({ ...draft, updatedAt: draft.updatedAt ?? Date.now() })
  }
  try { await store().storage.remove(LEGACY_KEY) } catch { /* 尽力而为 */ }
  return legacy.map(d => ({ id: d.id, name: d.name, updatedAt: d.updatedAt ?? Date.now() }))
}

export async function loadDrafts() {
  try {
    const enest = store()
    let index = await enest.storage.get(INDEX_KEY)
    if (!Array.isArray(index) || !index.length) {
      index = await migrateLegacy()
    }
    if (!Array.isArray(index) || !index.length) return [newDraft('画布 1')]
    const drafts = []
    for (const entry of index) {
      const draft = await enest.storage.get(`${DRAFT_PREFIX}${entry.id}`)
      drafts.push(draft?.id === entry.id ? draft : { ...newDraft(entry.name), id: entry.id, name: entry.name })
    }
    drafts.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    return drafts
  } catch { /* 首次或存储故障：给一张干净画布 */ }
  return [newDraft('画布 1')]
}

let saveTimer = null
let pending = null

/** 防抖保存全部草稿（逐草稿分键写）；immediate 可 flush */
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
  try {
    const index = data.map(d => ({ id: d.id, name: d.name, updatedAt: d.updatedAt }))
    await store().storage.set(INDEX_KEY, index)
    for (const draft of data) await saveDraftRecord(draft)
  } catch (error) {
    writeErrorHandler?.(`保存失败：${error instanceof Error ? error.message : error}`)
  }
}

/** 删除草稿记录（索引由下次 saveDrafts 覆盖） */
export async function removeDraftRecord(id) {
  try { await store().storage.remove(`${DRAFT_PREFIX}${id}`) } catch { /* 已不存在 */ }
}
