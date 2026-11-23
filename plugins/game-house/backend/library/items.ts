/**
 * 条目库：收藏、已安装记录、自定义条目。持久化走 store.ts 的 items 段。
 * ensureItem 登记浏览/建任务时的条目，已存在则保留 favorite/exePath/installDir。
 */

import { BackendError } from '../adapters/types.ts'
import type { LibraryItem, ManagedEntry, Section } from '../contracts.ts'
import { loadItems, removeItem, upsertItem, type StoredItem } from '../store.ts'
import { runningIds } from './launch.ts'

/** 已登记条目状态：从任务列表取 state，从 launch 运行表取 running */
export interface ManagedQuery {
  /** 任务列表：taskId → { itemId, state } */
  taskStates?: Array<{ itemId: string; state: string }>
}

const KINDS = new Set(['game', 'software', 'trainer', 'mod', 'custom'])

function toLibraryItem(stored: StoredItem): LibraryItem {
  const coverToken = stored.cover ? (stored.cover.startsWith('img:') || stored.cover.startsWith('cover:') ? stored.cover : `img:${Buffer.from(stored.cover, 'utf8').toString('base64url')}`) : ''
  return {
    id: stored.id,
    kind: (KINDS.has(stored.kind) ? stored.kind : 'game') as LibraryItem['kind'],
    section: (['pc', 'console', 'software', 'trainer', 'mod'].includes(stored.section) ? stored.section : 'pc') as Section,
    source: stored.source,
    sourceId: stored.sourceId,
    title: stored.title,
    subtitle: stored.subtitle,
    cover: stored.cover,
    coverToken,
    category: stored.category,
    sizeText: stored.sizeText,
    meta: Array.isArray(stored.meta) ? stored.meta : [],
    favorite: stored.favorite,
    installed: Boolean(stored.exePath),
  }
}

/**
 * 浏览/建任务时登记条目。已存在时不覆盖 favorite/exePath/installDir。
 * id 形如 `${source}:${sourceId}`（浏览）或任务生成的稳定 id。
 */
export async function ensureItem(partial: Partial<Omit<StoredItem, 'addedAt'>> & { id: string }): Promise<StoredItem> {
  const list = await loadItems()
  const existing = list.find(entry => entry.id === partial.id)
  if (existing) {
    // 只补站点给的字段，用户数据（收藏、安装信息）不动。
    // 站点这次没给的（空串）不覆盖已有的值：偶发缺字段不该把封面、标题清空。
    // exeRel 是安装时定位可执行文件用的站点字段，所以也在可更新之列。
    const patch: Partial<StoredItem> = {}
    for (const key of ['title', 'subtitle', 'cover', 'category', 'sizeText', 'kind', 'section', 'source', 'sourceId', 'exeRel'] as const) {
      const value = partial[key]
      if (value === undefined || existing[key] === value) continue
      if (typeof value === 'string' && value === '') continue
      (patch as Record<string, unknown>)[key] = value
    }
    if (Array.isArray(partial.meta) && partial.meta.length > 0 && (!existing.meta || existing.meta.length === 0)) patch.meta = partial.meta
    if (Object.keys(patch).length > 0) await upsertItem({ id: partial.id, ...patch })
    const updated = (await loadItems()).find(entry => entry.id === partial.id)
    return updated ?? { ...existing }
  }
  const created: StoredItem = {
    id: partial.id,
    kind: partial.kind ?? 'game',
    section: partial.section ?? 'pc',
    source: partial.source ?? '',
    sourceId: partial.sourceId ?? '',
    title: partial.title ?? '',
    subtitle: partial.subtitle ?? '',
    cover: partial.cover ?? '',
    category: partial.category ?? '',
    sizeText: partial.sizeText ?? '',
    meta: Array.isArray(partial.meta) ? partial.meta : [],
    favorite: false,
    exeRel: partial.exeRel ?? '',
    exePath: '',
    installDir: '',
    downloadDir: partial.downloadDir ?? '',
    addedAt: Date.now(),
  }
  await upsertItem(created)
  return created
}

export async function setFavorite(id: string, favorite: boolean): Promise<void> {
  const list = await loadItems()
  const existing = list.find(entry => entry.id === id)
  if (!existing) throw new BackendError('NOT_FOUND', '条目不存在')
  await upsertItem({ id, favorite })
}

/** 所有已登记条目（收藏的、已安装的、有任务记录的）→ ManagedEntry[] */
export async function listManaged(taskStates: Array<{ itemId: string; state: string }> = []): Promise<ManagedEntry[]> {
  const list = await loadItems()
  const stateByItem = new Map<string, string>()
  for (const entry of taskStates) {
    // 同一条目多任务时保留最新（数组顺序即任务列表顺序）。
    stateByItem.set(entry.itemId, entry.state)
  }
  const running = runningIds()
  const entries: ManagedEntry[] = []
  for (const stored of list) {
    const state = stateByItem.get(stored.id)
    const relevant = stored.favorite || stored.exePath || state !== undefined || stored.kind === 'custom'
    if (!relevant) continue
    entries.push({
      item: toLibraryItem(stored),
      state: (state ?? 'none') as ManagedEntry['state'],
      exePath: stored.exePath,
      installDir: stored.installDir,
      running: running.has(stored.id),
    })
  }
  return entries
}

/** 按 id 取条目；不存在抛 NOT_FOUND */
export async function requireItem(id: string): Promise<StoredItem> {
  const list = await loadItems()
  const stored = list.find(entry => entry.id === id)
  if (!stored) throw new BackendError('NOT_FOUND', '条目不存在')
  return stored
}

/** 更新安装信息（安装完成 / 用户手动指定 exe 后调用） */
export async function setInstallInfo(id: string, patch: { exePath?: string; installDir?: string; downloadDir?: string; exeRel?: string }): Promise<void> {
  await upsertItem({ id, ...patch })
}

/** 清安装字段（卸载时用）；remove 为 true 时整条删除 */
export async function clearInstall(id: string, remove: boolean): Promise<void> {
  if (remove) {
    await removeItem(id)
    return
  }
  await upsertItem({ id, exePath: '', installDir: '', exeRel: '' })
}

/**
 * 浏览列表返回给页面前调用：把列表里的条目登记进条目库（已登记的只补展示字段，
 * 不动收藏与安装信息），再把用户的收藏 / 已安装状态合并回每一项。
 * 数据源不知道用户状态，总是返回 favorite=false、installed=false；不合并的话收藏过、
 * 安装过的游戏在列表里看不出区别，而且对未登记的条目点收藏会报"条目不存在"。
 */
export async function registerAndMerge(items: LibraryItem[]): Promise<LibraryItem[]> {
  const byId = new Map<string, StoredItem>()
  for (const item of items) {
    if (!item.id || byId.has(item.id)) continue
    byId.set(item.id, await ensureItem({
      id: item.id, kind: item.kind, section: item.section, source: item.source, sourceId: item.sourceId,
      title: item.title, subtitle: item.subtitle, cover: item.cover, category: item.category, sizeText: item.sizeText, meta: item.meta,
    }))
  }
  return items.map(item => {
    const stored = item.id ? byId.get(item.id) : undefined
    return stored ? { ...item, favorite: stored.favorite, installed: Boolean(stored.exePath) } : item
  })
}

/** 把一个条目的用户状态合并进去（详情页用）；未登记的条目原样返回 */
export async function mergeUserState<T extends LibraryItem>(item: T): Promise<T> {
  const stored = (await loadItems()).find(entry => entry.id === item.id)
  if (!stored) return item
  return { ...item, favorite: stored.favorite, installed: Boolean(stored.exePath) }
}

export { toLibraryItem }
