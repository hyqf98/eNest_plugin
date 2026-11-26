/**
 * 后端入口（utilityProcess）。消息循环、初始化与关闭流程在这里；
 * 各业务方法在 dispatch 里按契约的方法名分发。
 *
 * 约定：
 * - 请求默认 30 秒超时且超时会终止整个后端：目录扫描与批量操作都在这个预算内完成。
 * - 关闭只有约 900ms：onShutdown 里只停回环服务。
 * - 路径与句柄不进日志、错误消息与事件。
 */

import { beginShutdown, confirmWithUser, currentScope, initializeRuntime, installSignalHandlers, isClosing, onShutdown, parentPort, receiveHostResponse } from './runtime.ts'
import { addRoot, listRoots, removeRoot } from './roots.ts'
import { deleteItems, listMedia, listSubfolders, loadTree, moveItems } from './fs.ts'
import { pathOf } from './entries.ts'
import { startMediaServer, stopMediaServer, urlFor } from './mediaServer.ts'
import { hasFfmpeg, hasQuickLook } from './thumbs.ts'
import { METHODS } from '../src/shared/contracts.ts'

const port = parentPort()
let ready: Promise<void> | undefined

port.on('message', ({ data }) => {
  if (!data || typeof data !== 'object') return
  const message = data as Record<string, unknown>
  if (message.type === 'init') {
    try {
      initializeRuntime(message as never)
      ready = Promise.resolve()
    } catch (error) {
      port.postMessage({ id: 0, ok: false, error: errorText(error) })
    }
    return
  }
  if (message.type === 'host.response') {
    receiveHostResponse(message as never)
    return
  }
  if (message.type === 'shutdown') {
    void beginShutdown()
    return
  }
  if (!Number.isSafeInteger(message.id)) return
  if (typeof message.method !== 'string') {
    port.postMessage({ id: message.id, ok: false, error: 'invalid backend method' })
    return
  }
  void handleRequest(message.id as number, message.method, message.args)
})

installSignalHandlers()

onShutdown(async () => {
  // 只停回环服务；缩略图缓存留在磁盘上，下次直接命中
  await stopMediaServer().catch(() => undefined)
})

async function handleRequest(id: number, method: string, rawArgs: unknown): Promise<void> {
  try {
    if (isClosing()) throw new Error('后端正在关闭')
    const scope = currentScope()
    await ready
    const args = Array.isArray(rawArgs) ? rawArgs : []
    const data = await dispatch(method, args)
    if (!scope.isCurrent()) return
    port.postMessage({ id, ok: true, data })
  } catch (error) {
    port.postMessage({ id, ok: false, error: errorText(error) })
  }
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label}无效`)
  return value.slice(0, max)
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error('没有选择条目')
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
}

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case METHODS.systemHello:
      return {
        pluginId: currentScope().pluginId,
        platform: process.platform,
        ffmpeg: await hasFfmpeg(),
        quickLook: hasQuickLook(),
      }

    /* ---------------- 根目录 ---------------- */
    case METHODS.rootsList:
      return listRoots()

    case METHODS.rootsAdd:
      return addRoot(text(args[0], '目录句柄'))

    case METHODS.rootsRemove:
      return removeRoot(text(args[0], '目录标识'))

    /* ---------------- 浏览 ---------------- */
    case METHODS.treeLoad:
      return loadTree()

    case METHODS.folderList: {
      const offset = Number.isSafeInteger(args[1]) ? (args[1] as number) : 0
      const limit = Number.isSafeInteger(args[2]) ? (args[2] as number) : 200
      const result = await listMedia(text(args[0], '文件夹标识'), Math.max(0, offset), Math.min(Math.max(limit, 1), 500))
      return { ...result, items: result.items.map(item => ({ ...item, thumbUrl: urlFor('t', item.entryId) })) }
    }

    case METHODS.folderSubfolders:
      return listSubfolders(text(args[0], '文件夹标识'))

    /* ---------------- 媒体 ---------------- */
    case METHODS.mediaOrigin:
      return { origin: await startMediaServer() }

    /* ---------------- 文件操作 ---------------- */
    case METHODS.itemsMove:
      return moveItems(idList(args[0]), text(args[1], '目标文件夹'))

    case METHODS.itemsDelete: {
      const ids = idList(args[0])
      // 单个文件直接删；批量或含文件夹的删除必须经新鲜原生确认
      const needsConfirm = ids.length > 1 || (await statIsDirectory(ids[0]))
      if (needsConfirm) {
        const ok = await confirmWithUser('删除所选条目', `将永久删除 ${ids.length} 个条目，不会进入回收站。`, '此操作无法撤销。')
        if (!ok) return { deleted: 0, failed: [], cancelled: true }
      }
      return deleteItems(ids)
    }

    default:
      throw new Error(`未知后端方法：${method}`)
  }
}

async function statIsDirectory(entryId: string): Promise<boolean> {
  try {
    pathOf(entryId, 'directory')
    return true
  } catch {
    return false
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
