/**
 * 后端入口（utilityProcess）。消息循环、初始化与关闭流程在这里；
 * 各业务方法由 backend/api/* 与领域服务提供，在 dispatch 里按契约的方法名分发。
 *
 * 约定：
 * - 请求默认 30 秒超时且超时会终止整个后端：这里只做"立刻返回"，慢工作交给任务服务后台执行并 postEvent。
 * - 关闭只有约 900ms：onShutdown 里只保存状态与中止连接。
 * - 凭据不进日志、错误消息与事件。
 */

import { beginShutdown, currentScope, initializeRuntime, installSignalHandlers, isClosing, logMessage, onShutdown, parentPort, receiveHostResponse } from './runtime.ts'
import { flushStore, loadSettings, saveSettings } from './store.ts'
import { errorMessage, requireString } from './util.ts'
import { setPackagePath } from './adapters/live.ts'
import { METHODS } from './contracts.ts'
import { authForget, authInfo, authSaveSession, authLogout, shareParse } from './api/cloud.ts'
import { libraryDetail, libraryFacets, libraryList } from './api/library.ts'
import { libraryMethods } from './api/managed.ts'
import { mediaLoad } from './imageProxy.ts'
import { health as panSouHealth, search as panSouSearch } from './sources/pansou.ts'
import { AuthService } from './library/authService.ts'
import { TaskService } from './library/taskService.ts'
import { refreshUrl, resolveRequest, verifyAccess } from './library/taskResolver.ts'

const port = parentPort()
let ready: Promise<void> | undefined
let auth: AuthService
let tasks: TaskService
let managed: ReturnType<typeof libraryMethods>

port.on('message', ({ data }) => {
  if (!data || typeof data !== 'object') return
  const message = data as Record<string, unknown>
  if (message.type === 'init') {
    try {
      initializeRuntime(message as never)
      ready = initializeServices()
    } catch (error) {
      port.postMessage({ id: 0, ok: false, error: errorMessage(error) })
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

async function initializeServices(): Promise<void> {
  setPackagePath(currentScope().context.packagePath)
  auth = new AuthService()
  tasks = new TaskService({
    resolveFiles: request => resolveRequest({ auth }, request),
    refreshUrl: (task, file) => refreshUrl({ auth }, task, file),
    verifyAccess: task => verifyAccess({ auth }, task),
  })
  await tasks.init()
  managed = libraryMethods(() => tasks)
  void logMessage('info', 'boot', `backend ready on ${process.platform}`)
}

onShutdown(async () => {
  // 只做保存与中止；不要在这里等待网络或解压。
  await tasks?.shutdown().catch(() => undefined)
  // 最后把所有防抖写入（任务、条目、设置、登录元信息）真正落盘：之后 50ms 进程就退出，防抖定时器等不到
  await flushStore().catch(() => undefined)
})

async function handleRequest(id: number, method: string, rawArgs: unknown): Promise<void> {
  try {
    if (isClosing()) throw new Error('后端正在关闭')
    const scope = currentScope()
    if (!ready) throw new Error('后端尚未初始化')
    await ready
    const args = Array.isArray(rawArgs) ? rawArgs : []
    const data = await dispatch(method, args)
    if (!scope.isCurrent()) return
    port.postMessage({ id, ok: true, data })
  } catch (error) {
    port.postMessage({ id, ok: false, error: errorMessage(error) })
  }
}

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case METHODS.systemHello:
      return { pluginId: currentScope().pluginId, platform: process.platform, arch: process.arch, node: process.version }

    case METHODS.settingsGet:
      return loadSettings()

    case METHODS.settingsUpdate: {
      const next = await saveSettings((args[0] ?? {}) as Record<string, never>)
      tasks.setConcurrency(next.concurrentTasks)
      return next
    }

    /* ---------------- 浏览与详情 ---------------- */
    case METHODS.facets:
      return libraryFacets(requireString(args[0], '栏目', 32))

    case METHODS.list:
      return libraryList(args[0])

    case METHODS.detail:
      return libraryDetail(args[0])

    case METHODS.mediaLoad:
      return mediaLoad(requireString(args[0], 'media token', 16_384))

    /* ---------------- 天翼云 ---------------- */
    case METHODS.authInfo: return authInfo(auth)
    case METHODS.authSaveSession: return authSaveSession(auth, args[0])
    case METHODS.authLogout: return authLogout(auth)
    case METHODS.authForget: return authForget(auth, args[0])
    case METHODS.parseShare: return shareParse(auth, args[0], args[1])

    /* ---------------- 任务 ---------------- */
    case METHODS.taskList: return tasks.list()
    case METHODS.taskCreate: return tasks.create(args[0] as never)
    case METHODS.taskPause: return tasks.pause(requireString(args[0], '任务 id', 128))
    case METHODS.taskResume: return tasks.resume(requireString(args[0], '任务 id', 128))
    case METHODS.taskRetryInstall: return tasks.retryInstall(requireString(args[0], '任务 id', 128))
    case METHODS.taskRemove: return tasks.remove(requireString(args[0], '任务 id', 128), Boolean(args[1]))
    case METHODS.taskUpdateOptions: return tasks.updateOptions(requireString(args[0], '任务 id', 128), (args[1] ?? {}) as { autoInstall?: boolean; removePackage?: boolean })

    /* ---------------- 条目管理（收藏、启动、卸载…） ---------------- */
    case METHODS.favorite: return managed.favorite(requireString(args[0], '条目 id', 600), Boolean(args[1]))
    case METHODS.managed: return managed.list()
    case METHODS.setExe: return managed.setExe(requireString(args[0], '条目 id', 600), requireString(args[1], '文件句柄', 512), optionalStringOf(args[2]))
    case METHODS.addCustom: return managed.addCustom(args[0])
    case METHODS.launch: return managed.launch(requireString(args[0], '条目 id', 600))
    case METHODS.closeApp: return managed.close(requireString(args[0], '条目 id', 600))
    case METHODS.uninstall: return managed.uninstall(requireString(args[0], '条目 id', 600))
    case METHODS.reveal: return managed.reveal(requireString(args[0], '条目 id', 600), args[1] === 'download' ? 'download' : 'install')

    /* ---------------- 网盘搜索 ---------------- */
    case METHODS.panSouHealth: {
      const current = await loadSettings()
      const result = await panSouHealth(current.pansouBaseUrl)
      return { available: result.available, baseUrl: result.baseUrl }
    }
    case METHODS.panSouSearch: {
      const current = await loadSettings()
      const keyword = requireString(args[0], '关键词', 200)
      const types = Array.isArray(args[1]) ? args[1].filter((value): value is string => typeof value === 'string').slice(0, 20) : []
      return panSouSearch(keyword, types, current.pansouBaseUrl)
    }

    default:
      throw new Error(`未知后端方法：${method}`)
  }
}

/** 可选字符串参数：缺省或非字符串都按空串处理 */
function optionalStringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}