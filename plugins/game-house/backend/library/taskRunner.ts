/**
 * 任务执行体：给定一个任务记录，按序下载每个文件，下载完后（可选）解压安装。
 * 不关心排队与并发（那是 queue.ts 的事），只负责"这个任务从当前状态走到终态"。
 *
 * - 文件按顺序下载；某个文件完成就落盘，中止后下次从已完成的文件之后继续。
 * - 直链过期（403/404/410 等）时经 deps.refreshUrl 换新直链再试，最多 MAX_REFRESH 次。
 * - 需要登录而未登录：抛 LOGIN_REQUIRED，由调用方置为 login_expired。
 * - 安装失败：抛出的错误带 code，调用方据此置为 install_failed（包保留，不重下）。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import { downloadFile } from '../downloader/engine.ts'
import { checkDiskSpace, ensureDir, requiredSpace } from '../disk.ts'
import { extractArchives } from '../install/extract.ts'
import { locateExecutable } from '../install/locate.ts'
import { removePackages, selectiveCleanup } from '../install/cleanup.ts'
import { planInstallUnits } from '../paths.ts'
import { loadSettings, type StoredTask, type StoredTaskFile } from '../store.ts'
import { isAbortError } from '../util.ts'
import { touchProgress } from './taskView.ts'

/** 直链过期后最多刷新次数，超过即失败（避免死循环刷新） */
const MAX_REFRESH = 8

export interface TaskRunnerDeps {
  /** 直链过期后重新解析某个文件；拿不到新直链返回 null */
  refreshUrl(task: StoredTask, file: StoredTaskFile): Promise<{ url: string; headers?: Record<string, string> } | null>
  /** 下载前确认登录仍有效；返回 false 表示未登录 */
  verifyAccess?(task: StoredTask): Promise<boolean>
}

export interface RunResult {
  task: StoredTask
  /** 是否走到了安装并成功 */
  installed: boolean
}

/** 安装失败的标记：包已下载好，重试只重新解压 */
export class InstallError extends BackendError {
  constructor(message: string) {
    super('INSTALL_FAILED', message)
  }
}

function headersOf(file: StoredTaskFile): Record<string, string> | undefined {
  return file.headers ? { ...file.headers } : undefined
}

/** 下载一个文件，处理直链过期刷新。进度经 onBytes 实时上报（已下载字节数） */
async function downloadOne(deps: TaskRunnerDeps, task: StoredTask, file: StoredTaskFile, signal: AbortSignal, options: { connections: number; speedLimit: number }, hooks: {
  onMeta: (meta: { size: number; etag: string; lastModified: string }) => void
  onBytes: (downloaded: number, total: number) => void
}): Promise<void> {
  const adapter = getAdapter()
  let refreshes = 0
  let refreshedFor: string | null = null
  for (;;) {
    if (signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
    try {
      await downloadFile(adapter, {
        url: file.url,
        headers: headersOf(file),
        targetPath: adapter.path.join(task.downloadDir, file.name),
        signal,
        connections: options.connections,
        speedLimit: options.speedLimit,
        onMeta: hooks.onMeta,
        onProgress: hooks.onBytes,
      })
      return
    } catch (error) {
      if (isAbortError(error)) throw error
      const code = error instanceof BackendError ? error.code : ''
      const message = error instanceof Error ? error.message : String(error)
      // 直链到期的两种表现：明确的 403/404/410（URL_EXPIRED），或 CDN 直接连线掐断。
      // 后者在引擎看来是网络错误，重试耗尽后才会抛到这里；对会过期的直链再刷新一次，
      // 否则"下载到一半直链到期"会被判成下载失败。刷新过一次后仍是同样的错，才算真失败。
      const looksExpired = code === 'URL_EXPIRED'
      const networkExhausted = /UND_ERR_SOCKET|ECONNRESET|EPIPE|UND_ERR_BODY_TIMEOUT|连接提前结束|文件不完整/.test(message)
      const refreshable = Boolean(task.shareId && task.shareUrl && deps.refreshUrl)
      const shouldRefresh = refreshable && refreshes < MAX_REFRESH && (looksExpired || (networkExhausted && refreshedFor !== message))
      if (!shouldRefresh) throw error
      refreshes++
      refreshedFor = message
      // 换新直链再续传。任务 id 与文件名都不变。
      const fresh = await deps.refreshUrl(task, file)
      if (!fresh) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
      file.url = fresh.url
      file.headers = fresh.headers ?? file.headers
      if (!fresh.headers) delete file.headers
    }
  }
}

/**
 * 运行一个任务到终态。调用方负责：持有活动租约、落盘 task、推送事件。
 * 这里只修改传入的 task 对象（files 的 downloaded/state、shareId）。
 */
export async function runTask(deps: TaskRunnerDeps, task: StoredTask, signal: AbortSignal, hooks: {
  onState(task: StoredTask): void | Promise<void>
  onProgress(task: StoredTask): void | Promise<void>
}): Promise<RunResult> {
  const adapter = getAdapter()
  const settings = await loadSettings()
  const options = { connections: settings.connectionsPerTask, speedLimit: settings.speedLimit }

  // 1) 需要登录的资源先确认登录
  if (deps.verifyAccess && task.shareUrl) {
    const ok = await deps.verifyAccess(task)
    if (!ok) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
  }

  // 2) 逐个下载
  await ensureDir(adapter, task.downloadDir)
  const known = task.files.reduce((sum, file) => sum + file.size, 0)
  if (known > 0) await checkDiskSpace(adapter, task.downloadDir, requiredSpace(known))
  task.state = 'downloading'
  await hooks.onState(task)
  for (const file of task.files) {
    if (signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
    if (file.state === 'done' || file.state === 'skipped') continue
    file.state = 'downloading'
    await hooks.onState(task)
    let lastReported = 0
    await downloadOne(deps, task, file, signal, options, {
      onMeta: meta => {
        if (meta.size > 0) file.size = meta.size
        if (meta.etag) file.etag = meta.etag
        if (meta.lastModified) file.lastModified = meta.lastModified
      },
      // 引擎每完成一个分片就回调一次：把已下载字节数写进任务记录并上报进度（速度、剩余时间由此算出）
      onBytes: (downloaded) => {
        file.downloaded = downloaded
        if (downloaded !== lastReported) { lastReported = downloaded; void hooks.onProgress(task) }
      },
    })
    file.downloaded = file.size
    file.state = 'done'
    await hooks.onProgress(task)
  }

  // 3) 安装
  if (!task.autoInstall) return { task, installed: false }
  await installDownloaded(deps, task, signal, hooks)
  return { task, installed: true }
}

/** 解压已下载的文件到安装目录并定位可执行文件 */
export async function installDownloaded(deps: TaskRunnerDeps, task: StoredTask, signal: AbortSignal, hooks: { onState(task: StoredTask): void | Promise<void>; onProgress(task: StoredTask): void | Promise<void> }): Promise<void> {
  const adapter = getAdapter()
  task.state = 'installing'
  task.installError = ''
  await hooks.onState(task)

  const names = task.files.filter(file => file.state === 'done').map(file => file.name)
  const units = planInstallUnits(names)
  await ensureDir(adapter, task.installDir)

  // exe 模式：集合里只有一个 .exe，它本身就是可执行程序，不解压也不复制。
  // exe 留在下载目录，安装目录就是它所在的目录（源项目同此行为）。
  if (units.length === 1 && units[0].toLowerCase().endsWith('.exe')) {
    task.exePath = adapter.path.join(task.downloadDir, units[0])
    return
  }

  // 解压前清理安装目录里的残留，但保护安装包、续卷与控制文件
  await selectiveCleanup(adapter, task.installDir, names.map(name => adapter.path.join(task.downloadDir, name)))

  try {
    await extractArchives(adapter, units, task.downloadDir, task.installDir, signal, () => touchProgress(task.id), task.exeRel)
    const exe = await locateExecutable(adapter, task.installDir, task.exeRel)
    task.exePath = exe ?? ''
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new InstallError(error instanceof Error ? error.message : String(error))
  }

  // 安装成功后按设置删除安装包。走到这里的都是解压模式；exe 模式在上面已经返回，
  // 被"安装"的 exe 不会被删。
  if (task.removePackage) {
    await removePackages(adapter, task.downloadDir, names)
  }
}
