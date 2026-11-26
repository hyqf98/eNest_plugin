/**
 * 前后端桥接：backend.call 封装 + 宿主能力（选目录、提示）。
 * 视图不直接碰 window.enest.backend。
 */

import type { DeleteResult, FolderNode, MediaItem, MoveResult, RootEntry } from '../shared/contracts'
import { METHODS } from '../shared/contracts'

export function getApi() {
  const enest = window.enest || window.zapi
  if (!enest?.backend?.call) throw new Error('媒体浏览需要 eNest 宿主后端支持（backend.node）')
  return enest
}

async function call<T>(method: string, args: unknown[] = [], timeoutMs = 30_000): Promise<T> {
  return getApi().backend.call<T>(method, args, { timeoutMs })
}

/**
 * 列表类接口的形状保险：后端异常、版本不匹配或宿主夹具返回非数组时，
 * 按空列表处理而不是让渲染层崩溃。宁可显示「没有内容」，也不白屏。
 */
function asArray<T>(value: T): T {
  return Array.isArray(value) ? value : ([] as unknown as T)
}

/**
 * 后端异常退出（崩溃、请求超时被宿主终止）时宿主会推 backend.exit。
 * 收到后必须让用户知道界面上的内容已经过期；返回取消订阅函数。
 */
export function onBackendExit(listener: () => void): () => void {
  const api = getApi()
  if (typeof api.on !== 'function') return () => undefined
  const handler = (payload: unknown) => {
    if ((payload as { event?: string } | null)?.event === 'backend.exit') listener()
  }
  api.on('backend.event', handler)
  return () => api.off('backend.event', handler)
}

export const roots = {
  list: async () => asArray(await call<RootEntry[]>(METHODS.rootsList)),
  /** 让用户选一个文件夹；取消返回 null */
  async add(): Promise<{ entry: RootEntry; added: boolean } | null> {
    const handles = await getApi().localFiles.pick({ kind: 'directory', access: 'write' })
    const handle = handles[0]
    if (!handle) return null
    return call<{ entry: RootEntry; added: boolean }>(METHODS.rootsAdd, [handle.id])
  },
  remove: async (rootId: string) => asArray(await call<RootEntry[]>(METHODS.rootsRemove, [rootId])),
}

export interface TreeRoot {
  node: FolderNode
  children: FolderNode[]
}

export const browser = {
  tree: async () => asArray(await call<TreeRoot[]>(METHODS.treeLoad, [], 60_000)).map(root => ({ ...root, children: asArray(root?.children) })),
  subfolders: async (entryId: string) => asArray(await call<FolderNode[]>(METHODS.folderSubfolders, [entryId])),
  folder: async (entryId: string, offset = 0, limit = 200) => {
    const page = await call<{ items: MediaItem[]; total: number }>(METHODS.folderList, [entryId, offset, limit], 60_000)
    return { items: asArray(page?.items), total: Number.isFinite(page?.total) ? page.total : 0 }
  },
  move: (entryIds: string[], targetFolderId: string) => call<MoveResult>(METHODS.itemsMove, [entryIds, targetFolderId], 120_000),
  remove: (entryIds: string[]) => call<DeleteResult>(METHODS.itemsDelete, [entryIds], 120_000),
  origin: () => call<{ origin: string }>(METHODS.mediaOrigin),
}

export async function toast(body: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): Promise<void> {
  try {
    await getApi().ui.toast({ body, level })
  } catch {
    // 提示失败不影响业务
  }
}
