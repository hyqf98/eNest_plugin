/** 标注草稿：单个 KV 文档按 itemId 存放，写入串行。 */
import { host } from './env.js'

const KEY = 'sa.drafts.v2'
let cache = null
let queue = Promise.resolve()

async function ensure() {
  if (cache) return cache
  const stored = await host.storage.get(KEY).catch(() => null)
  cache = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  return cache
}

export async function loadDrafts() {
  return { ...(await ensure()) }
}

export function draftFor(id) {
  return cache?.[id] || null
}

function persist() {
  const snapshot = { ...cache }
  queue = queue.catch(() => {}).then(() => host.storage.set(KEY, snapshot))
  return queue
}

export async function saveDraft(id, draft) {
  if (!id) return false
  await ensure()
  if (!draft || !Array.isArray(draft.operations) || !draft.operations.length) {
    if (!(id in cache)) return false
    delete cache[id]
  } else {
    cache[id] = {
      operations: draft.operations.slice(0, 40),
      cursor: Math.max(0, Math.min(draft.operations.slice(0, 40).length, Number(draft.cursor) || 0))
    }
  }
  await persist()
  return true
}

export async function removeDraft(id) {
  await ensure()
  if (!(id in cache)) return false
  delete cache[id]
  await persist()
  return true
}

export async function flushDrafts() {
  await queue.catch(() => {})
  await host.storage.flush().catch(() => {})
}
