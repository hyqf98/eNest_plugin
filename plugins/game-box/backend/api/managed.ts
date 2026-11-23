/**
 * 条目管理相关方法：收藏、我的游戏列表、指定可执行文件、添加本地游戏、
 * 启动 / 关闭 / 卸载 / 在文件管理器显示。
 *
 * 文件一律只认宿主文件选择器给的句柄（files.resolve），路径字符串不能当授权。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import type { ManagedEntry } from '../contracts.ts'
import { close as closeApp, launch, reveal, setExePath, uninstall } from '../library/launch.ts'
import { ensureItem, listManaged, setFavorite, setInstallInfo } from '../library/items.ts'
import type { TaskService } from '../library/taskService.ts'
import { resolveFileHandle } from '../runtime.ts'
import { requireString } from '../util.ts'

/** 封面图片上限：本地封面读成 data URL 存进条目，不能太大 */
const COVER_MAX_BYTES = 2 * 1024 * 1024
const COVER_MIMES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

export interface ManagedApi {
  favorite(itemId: string, favorite: boolean): Promise<{ ok: boolean }>
  list(): Promise<ManagedEntry[]>
  setExe(itemId: string, handleId: string, installDir: string): Promise<ManagedEntry[]>
  addCustom(raw: unknown): Promise<ManagedEntry[]>
  launch(itemId: string): Promise<{ running: boolean; elevated: boolean }>
  close(itemId: string): Promise<{ running: boolean }>
  uninstall(itemId: string): Promise<ManagedEntry[]>
  reveal(itemId: string, target: 'download' | 'install'): Promise<{ ok: boolean }>
}

/** tasks 用来给"我的游戏"列表标注每个条目的任务状态；它晚于本模块创建，所以用取值函数 */
export function libraryMethods(tasks: () => TaskService): ManagedApi {
  async function entries(): Promise<ManagedEntry[]> {
    const all = await tasks().list()
    // 同一条目多个任务时保留最新的（列表按创建时间倒序，第一个就是最新的）
    const states = all.map(task => ({ itemId: task.itemId, state: task.state }))
    return listManaged(states)
  }

  return {
    async favorite(itemId, favorite) {
      await setFavorite(itemId, favorite)
      return { ok: true }
    },

    list: entries,

    async setExe(itemId, handleId, installDir) {
      await setExePath(itemId, handleId, installDir)
      return entries()
    },

    async addCustom(raw) {
      const input = (raw ?? {}) as Record<string, unknown>
      const title = requireString(input.title, '游戏名称', 120).trim()
      const handleId = requireString(input.handleId, '文件句柄', 512)
      const adapter = getAdapter()
      let exePath: string
      try {
        const resolved = await resolveFileHandle(handleId, 'read')
        if (typeof resolved !== 'string' || !resolved) throw new Error('invalid handle')
        exePath = resolved
      } catch {
        throw new BackendError('INVALID_ARGUMENT', '文件授权已失效，请重新选择')
      }
      if (adapter.path.extname(exePath).toLowerCase() !== '.exe') throw new BackendError('INVALID_ARGUMENT', '请选择 .exe 可执行文件')

      // 可选封面：读成 data URL 存进条目（封面令牌用 data: 形式，页面可直接显示）
      let cover = ''
      const coverHandleId = typeof input.coverHandleId === 'string' ? input.coverHandleId : ''
      if (coverHandleId) {
        const coverPath = await resolveFileHandle(coverHandleId, 'read').catch(() => null)
        const mime = coverPath ? COVER_MIMES[adapter.path.extname(coverPath).toLowerCase()] : undefined
        if (coverPath && mime) {
          const info = await adapter.files.stat(coverPath)
          if (info && info.size <= COVER_MAX_BYTES) {
            cover = `data:${mime};base64,${Buffer.from(await adapter.files.readFile(coverPath)).toString('base64')}`
          }
        }
      }

      const id = `custom:${Date.now().toString(36)}${[...crypto.getRandomValues(new Uint8Array(4))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
      await ensureItem({ id, kind: 'custom', section: 'pc', title, cover })
      await setInstallInfo(id, { exePath, installDir: adapter.path.dirname(exePath) })
      return entries()
    },

    async launch(itemId) {
      return launch(itemId)
    },

    async close(itemId) {
      return closeApp(itemId)
    },

    async uninstall(itemId) {
      await uninstall(itemId)
      return entries()
    },

    async reveal(itemId, target) {
      return reveal(itemId, target)
    },
  }
}
