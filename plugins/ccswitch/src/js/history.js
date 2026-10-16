import { storageGet, storageSet, agentRead } from './api.js'
import { extractCurrent, extractCurrentFromText, applyProvider } from './providers.js'
/**
 * com.github.eNest.ccswitch — 切换历史
 * 记录每次供应商切换（storage 持久化，环形上限 50 条）：
 *   { id, at, app, providerId, providerName, baseUrl, model,
 *     prevProviderId?, prevName?, prevBaseUrl?, prevModel?, changed }
 * 「回退」= 把 prev* 字段构造成一个临时供应商对当前应用执行 agent.write（写前宿主自动快照）。
 * 命名空间挂 window.CCS.history。
 */

const STORE_KEY = 'ccswitch.switch-history.v1'
const LIMIT = 50

let cache = null

async function load() {
  if (!cache) cache = (await storageGet(STORE_KEY, [])) || []
  return cache
}

/** 记录一次切换。before: 切换前 extractCurrent 结果（可为 null）；targets: 实际写入的应用列表 */
async function record(provider, before, targets) {
  await load()
  const entry = {
    id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: Date.now(),
    app: targets[0] || null,
    apps: targets.slice(),
    providerId: provider.id || null,
    providerName: provider.name || '未命名',
    baseUrl: provider.baseUrl || '',
    model: provider.model || '',
    prevProviderId: before?.providerId || null,
    prevName: before?.name || null,
    prevBaseUrl: before?.baseUrl || '',
    prevModel: before?.model || '',
    changed: (before?.baseUrl || '') !== (provider.baseUrl || '') || (before?.model || '') !== (provider.model || '')
  }
  cache.unshift(entry)
  if (cache.length > LIMIT) cache.length = LIMIT
  await storageSet(STORE_KEY, cache)
  return entry
}

/** 最近 N 条（默认全部，已按时间倒序） */
function recent(n) {
  const list = cache || []
  return Number.isFinite(n) ? list.slice(0, n) : list.slice()
}

function clear() {
  cache = []
  return storageSet(STORE_KEY, [])
}

/**
 * 回退一条历史：用 prev* 构造临时供应商，对 entry.app 执行 applyProvider。
 * 写前宿主自动快照，失败时可在「备份」页恢复。
 */
async function rollback(entry) {
  if (!entry || !entry.app) throw new Error('该记录没有可回退的目标应用')
  if (!entry.prevName && !entry.prevBaseUrl && !entry.prevModel) {
    throw new Error('该记录没有切换前状态（首次切换），无法回退')
  }
  const restore = {
    id: '',
    name: entry.prevName || '切换前状态',
    tag: '回退',
    tags: ['回退'],
    baseUrl: entry.prevBaseUrl || '',
    model: entry.prevModel || '',
    secretRef: '',
    apps: [entry.app],
    universal: false
  }
  const before = await readCurrentState(entry.app)
  await applyProvider(entry.app, restore)
  const recorded = await record({ ...restore, id: null }, before, [entry.app])
  recorded.rolledBackFrom = entry.id
  return recorded
}

/** 读取某应用当前生效的端点/模型（快照级，供历史展示与回退前记录） */
async function readCurrentState(app) {
  try {
    const snap = await agentRead(app)
    const cur = extractCurrent(app, snap) || extractCurrentFromText(app, snap.files?.[0]?.content)
    return cur ? { baseUrl: cur.baseUrl || '', model: cur.model || '' } : { baseUrl: '', model: '' }
  } catch {
    return { baseUrl: '', model: '' }
  }
}

export { load as loadHistory, record as recordHistory, recent, clear as clearHistory, rollback, readCurrentState, LIMIT as HISTORY_LIMIT }
