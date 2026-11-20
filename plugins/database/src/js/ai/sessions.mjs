/**
 * sessions.mjs — AI 会话持久化
 * 索引：KV db.ai.sessions.v1 = [{ id, title, updatedAt }]（FIFO 50，超出删最旧分键）
 * 内容：KV db.ai.session.<id> = { id, title, createdAt, messages }
 * 消息类型：user{role,content,at} / assistant{role,content,at,a2ui?,surfaces?} /
 *   turn{role:'assistant-turn', toolCalls:[{tool,args,status,text,structured,ms}], content, ms, a2ui?, surfaces?, at}
 * a2ui = 该轮 A2UI 线报（AgentToRendererMessage[]，切会话时 host.replay 重放恢复界面）；
 * surfaces = 线报产出的 surfaceId 顺序列表（React 消息区按消息归属渲染）。
 * 旧格式消息（无 a2ui）走 markdown 兼容路径（含 ```mermaid/```echarts 围栏降级）。
 * 每轮结束与确认状态变更时防抖 500ms 写盘（storage.set 为缓冲写，插件退出统一 flush）。
 */

import { storageGet, storageSet, storageRemove } from '../api.js'

const INDEX_KEY = 'db.ai.sessions.v1'
const sessionKeyOf = (id) => `db.ai.session.${id}`
const MAX_SESSIONS = 50
const PERSIST_DELAY = 500

/** 内存缓存：id -> 会话对象；索引按 updatedAt 降序 */
const cache = new Map()
let indexCache = null
let loaded = false
const timers = new Map()

function uid() {
  return `ai_s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function loadSessions() {
  if (loaded) return
  const [index] = await Promise.all([storageGet(INDEX_KEY, [])])
  indexCache = Array.isArray(index) ? index : []
  loaded = true
}

export function sessionIndex() {
  return (indexCache || []).slice()
}

export async function getSession(id) {
  if (cache.has(id)) return cache.get(id)
  const data = await storageGet(sessionKeyOf(id), null)
  if (!data || !Array.isArray(data.messages)) return null
  cache.set(id, data)
  return data
}

export async function createSession(title = '新会话') {
  await loadSessions()
  const session = { id: uid(), title, createdAt: Date.now(), messages: [] }
  cache.set(session.id, session)
  indexCache = [{ id: session.id, title, updatedAt: Date.now() }, ...(indexCache || [])]
  schedulePersist(session.id, true)
  return session
}

/** 索引重排（新消息置顶）+ 防抖写盘；writeIndex 供新建时立即落索引 */
function schedulePersist(id, writeIndex = false) {
  const session = cache.get(id)
  if (session) {
    const entry = (indexCache || []).find((item) => item.id === id)
    if (entry) {
      entry.title = session.title
      entry.updatedAt = Date.now()
      indexCache.sort((a, b) => b.updatedAt - a.updatedAt)
    }
  }
  clearTimeout(timers.get(id))
  timers.set(id, setTimeout(async () => {
    timers.delete(id)
    const data = cache.get(id)
    if (!data) return
    // FIFO：超上限删最旧分键
    if (indexCache.length > MAX_SESSIONS) {
      const dropped = indexCache.splice(MAX_SESSIONS)
      for (const item of dropped) {
        cache.delete(item.id)
        await storageRemove(sessionKeyOf(item.id)).catch(() => {})
      }
    }
    await storageSet(INDEX_KEY, indexCache).catch(() => {})
    await storageSet(sessionKeyOf(id), data).catch(() => {})
  }, PERSIST_DELAY))
  if (writeIndex) {
    void storageSet(INDEX_KEY, indexCache).catch(() => {})
  }
}

/** 每轮结束/状态变更后调用（防抖 500ms） */
export function persistSession(id) {
  schedulePersist(id)
}

export async function deleteSession(id) {
  cache.delete(id)
  indexCache = (indexCache || []).filter((item) => item.id !== id)
  await storageRemove(sessionKeyOf(id)).catch(() => {})
  await storageSet(INDEX_KEY, indexCache).catch(() => {})
}

export async function renameSession(id, title) {
  const session = cache.get(id) || (await getSession(id))
  if (!session) return
  session.title = String(title || '').trim().slice(0, 60) || session.title
  schedulePersist(id)
  return session
}

/** 首条用户消息自动生成标题 */
export function autoTitle(session, text) {
  if (session.messages.filter((m) => m.role === 'user').length > 1) return
  session.title = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 24) || '新会话'
}

export function relativeTime(ts) {
  const delta = Date.now() - Number(ts || 0)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString()
}

/** 会话首条消息摘要（最近会话下拉用） */
export function summaryOf(session) {
  const first = session?.messages?.find((m) => m.role === 'user')
  return first ? String(first.content || '').replace(/\s+/g, ' ').slice(0, 60) : '空会话'
}

/** 退出前 flush 全部待写会话 */
export async function flushSessions() {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  await storageSet(INDEX_KEY, indexCache || []).catch(() => {})
  await Promise.all([...cache.values()].map((data) => storageSet(sessionKeyOf(data.id), data).catch(() => {})))
}
