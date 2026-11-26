/**
 * 任务服务：对外方法（建任务 / 列表 / 暂停 / 继续 / 重试安装 / 删除 / 改选项）与队列生命周期。
 *
 * 状态流转：
 *   queued → resolving → downloading → installing → complete
 *                                   ↘ paused（用户暂停 / 关闭插件）
 *                                   ↘ failed（下载出错）/ login_expired（需要登录）
 *                              installing ↘ install_failed（包已下载好，重试只重新解压）
 *
 * - 启动时把所有进行中的任务置为 paused，不自动续传。
 * - 同一条目同时只允许一个进行中的任务。
 * - 目录只认宿主句柄换出的路径；没有句柄就拒绝建任务。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import type { CreateTaskRequest, Task } from '../contracts.ts'
import { DownloadQueue } from '../downloader/queue.ts'
import { ensureDir } from '../disk.ts'
import { sanitizeSegment } from '../paths.ts'
import { acquireActivity, resolveFileHandle } from '../runtime.ts'
import { flushStore, loadSettings, loadTasks, saveTasks, type StoredTask, type StoredTaskFile } from '../store.ts'
import { newId } from '../util.ts'
import { requireItem, setInstallInfo } from './items.ts'
import { InstallError, runTask, type TaskRunnerDeps } from './taskRunner.ts'
import { activeCounts, beginLive, clearEmitters, emitFinished, emitState, emitTask, endLive, noteProgress, toTask } from './taskView.ts'

export interface TaskServiceDeps extends TaskRunnerDeps {
  /**
   * 把建任务请求解析成文件清单。需要登录而未登录时抛 LOGIN_REQUIRED。
   * 返回的每个文件至少要有 name；size / url / headers 可在 resolving 阶段补齐。
   */
  resolveFiles(request: { itemId: string; packageIds: string[]; share?: CreateTaskRequest['share']; shareFileIds?: string[] }): Promise<{ shareId: string; files: StoredTaskFile[] }>
}

const MAX_FILES = 400
const ACTIVE_STATES = ['queued', 'resolving', 'downloading', 'installing']
/** 关闭时等任务收尾的上限：宿主只给约 900ms，留出落盘与应答的时间 */
const SHUTDOWN_DRAIN_MS = 700

export class TaskService {
  private readonly deps: TaskServiceDeps
  private queue: DownloadQueue
  /** 运行中任务的中止器（暂停 / 移除 / 关闭时用） */
  private readonly controllers = new Map<string, AbortController>()
  /** 各任务运行体结束的 Promise（关闭时等它们收尾：引擎要在中止后把控制文件写盘） */
  private readonly running = new Map<string, Promise<void>>()
  /** 写盘串行化：所有提交排成一条链，后到的旧快照不会覆盖先到的新状态 */
  private writes: Promise<unknown> = Promise.resolve()
  /** 关闭中 / 已关闭：之后到达的进度提交一律丢弃，否则会把 paused 又写回 downloading */
  private closing = false

  constructor(deps: TaskServiceDeps) {
    this.deps = deps
    this.queue = new DownloadQueue(3)
  }

  /** 启动：读设置里的并发数；把上次未完成的任务置为暂停 */
  async init(): Promise<void> {
    const settings = await loadSettings()
    this.queue = new DownloadQueue(settings.concurrentTasks)
    const tasks = await loadTasks()
    let changed = false
    for (const task of tasks) {
      if (!ACTIVE_STATES.includes(task.state)) continue
      task.state = 'paused'
      for (const file of task.files) if (file.state === 'downloading') file.state = 'pending'
      changed = true
    }
    if (changed) await persist(tasks)
  }

  list(): Promise<Task[]> {
    return loadTasks().then(tasks => tasks.map(toTask))
  }

  counts(): Promise<{ active: number }> {
    return loadTasks().then(activeCounts)
  }

  /** 设置页改了"同时下载任务数"后调用 */
  setConcurrency(limit: number): void {
    this.queue.setLimit(limit)
  }

  async create(request: CreateTaskRequest): Promise<{ taskId: string }> {
    // 目录只认句柄：选择即授权，路径字符串不能当授权。
    // 句柄换出的是用户选的根目录；每个条目在根目录下各占一个以标题命名的子目录，
    // 下载、解压、安装都在这一个文件夹里，多个游戏下到同一根目录也不会混在一起。
    // 请求里的 downloadDir / installDir 只用于界面展示，这里不信任它们。
    const downloadRoot = await authorizedDir(request.downloadTarget, '下载目录')
    let installRoot = downloadRoot
    if (request.installTarget) installRoot = await authorizedDir(request.installTarget, '安装目录')
    if (request.autoInstall && !request.installTarget) {
      throw new BackendError('INVALID_ARGUMENT', '请选择安装目录')
    }

    const resolved = await this.deps.resolveFiles({
      itemId: request.itemId,
      packageIds: Array.isArray(request.packageIds) ? request.packageIds : [],
      share: request.share,
      shareFileIds: Array.isArray(request.shareFileIds) ? request.shareFileIds : [],
    })
    if (!resolved.files.length) throw new BackendError('INVALID_ARGUMENT', '没有可下载的文件')
    if (resolved.files.length > MAX_FILES) throw new BackendError('INVALID_ARGUMENT', `文件过多（超过 ${MAX_FILES} 个）`)

    const tasks = await loadTasks()
    if (request.itemId) {
      const clash = tasks.find(task => task.itemId === request.itemId && ACTIVE_STATES.includes(task.state))
      if (clash) throw new BackendError('TASK_EXISTS', '这个条目已有进行中的任务')
    }

    let title = request.share?.title ?? ''
    let kind = 'game'
    let cover = ''
    let exeRel = ''
    if (request.itemId) {
      const item = await requireItem(request.itemId)
      title = item.title
      kind = item.kind
      cover = item.cover
      exeRel = item.exeRel
    }
    // 标题可能含 Windows 非法字符、保留名或过长，按路径段规则清洗后再作文件夹名；目录不存在时 ensureDir 会创建
    const folder = sanitizeSegment(title || 'Download', 'Download')
    const downloadDir = getAdapter().path.join(downloadRoot, folder)
    const installDir = getAdapter().path.join(installRoot, folder)
    const now = Date.now()
    const task: StoredTask = {
      id: newId('task'),
      itemId: request.itemId ?? '',
      kind,
      title: title || '下载任务',
      cover,
      state: 'queued',
      shareUrl: request.share?.url ?? '',
      accessCode: request.share?.accessCode ?? '',
      shareId: resolved.shareId,
      files: resolved.files.map(file => ({ ...file, downloaded: 0, state: 'pending' })),
      downloadDir,
      installDir,
      exeRel,
      exePath: '',
      autoInstall: request.autoInstall,
      removePackage: request.removePackage,
      error: '',
      installError: '',
      createdAt: now,
      finishedAt: 0,
    }
    await getAdapter().files.ensureDir(downloadDir)
    if (request.autoInstall) await getAdapter().files.ensureDir(installDir)
    // "查重 → 入列 → 落盘"必须是一个原子步骤：与进度提交交错的话，新任务可能被一份不含它的快照覆盖掉
    await this.enqueueWrite(async () => {
      const current = await loadTasks()
      if (request.itemId && current.some(entry => entry.itemId === request.itemId && ACTIVE_STATES.includes(entry.state))) {
        throw new BackendError('TASK_EXISTS', '这个条目已有进行中的任务')
      }
      current.unshift(task)
      await persist(current)
    })
    this.start(task.id)
    return { taskId: task.id }
  }

  async pause(id: string): Promise<{ ok: boolean }> {
    const task = await findTask(id)
    if (!ACTIVE_STATES.includes(task.state)) return { ok: false }
    // 还在排队（没开始跑）：直接置为暂停并移出队列。只给队列打标记的话，前面的任务一结束它照样开跑，
    // 而它的状态还是 queued，用户再点"继续"又会被拒绝——暂停按钮等于没按
    if (!this.running.has(id)) {
      await this.enqueueWrite(async () => {
        if (!ACTIVE_STATES.includes(task.state)) return
        this.queue.remove(id)
        task.state = 'paused'
        for (const file of task.files) if (file.state === 'downloading') file.state = 'pending'
        await persist(await loadTasks())
        emitFinished(task, await loadTasks())
      })
      return { ok: true }
    }
    this.queue.pause(id)
    return { ok: true }
  }

  async resume(id: string): Promise<{ ok: boolean }> {
    const ok = await this.enqueueWrite(async () => {
      const task = await findTask(id)
      if (!['paused', 'failed', 'login_expired', 'install_failed'].includes(task.state)) return false
      task.error = ''
      task.installError = ''
      task.state = 'queued'
      await persist(await loadTasks())
      return true
    })
    if (ok) this.start(id)
    return { ok }
  }

  /** 重试安装：只重新解压，绝不重新下载 */
  async retryInstall(id: string): Promise<{ ok: boolean }> {
    const ok = await this.enqueueWrite(async () => {
      const task = await findTask(id)
      if (task.state !== 'install_failed') return false
      task.installError = ''
      task.state = 'queued'
      await persist(await loadTasks())
      return true
    })
    if (ok) this.start(id)
    return { ok }
  }

  /** 改任务的自动安装 / 删包选项；只对还没结束的任务有意义 */
  async updateOptions(id: string, patch: { autoInstall?: boolean; removePackage?: boolean }): Promise<{ ok: boolean }> {
    await this.enqueueWrite(async () => {
      const task = await findTask(id)
      if (typeof patch.autoInstall === 'boolean') task.autoInstall = patch.autoInstall
      if (typeof patch.removePackage === 'boolean') task.removePackage = patch.removePackage
      await persist(await loadTasks())
    })
    return { ok: true }
  }

  /** 删除任务；deleteFiles 为 true 时连本地文件一起删 */
  async remove(id: string, deleteFiles: boolean): Promise<{ ok: boolean }> {
    let removed: StoredTask | undefined
    const rest = await this.enqueueWrite(async () => {
      const tasks = await loadTasks()
      const task = tasks.find(entry => entry.id === id)
      if (!task) return null
      this.queue.remove(id)
      removed = task
      const remaining = tasks.filter(entry => entry.id !== id)
      await persist(remaining)
      return remaining
    })
    if (!rest || !removed) return { ok: false }
    endLive(id)
    // 等任务体真正停下再删文件：它的连接可能还在写这个文件，Windows 上占用的文件删不掉
    await this.waitStopped(id)
    if (deleteFiles) {
      const adapter = getAdapter()
      for (const file of removed.files) {
        const target = adapter.path.join(removed.downloadDir, file.name)
        await adapter.files.removeFile(target).catch(() => undefined)
        await adapter.files.removeFile(`${target}.ghctl`).catch(() => undefined)
        await adapter.files.removeFile(`${target}.ghctl.tmp`).catch(() => undefined)
      }
    }
    emitFinished(removed, rest)
    return { ok: true }
  }

  /** 等某个任务体结束（上限同关闭收尾） */
  private async waitStopped(id: string): Promise<void> {
    const run = this.running.get(id)
    if (!run) return
    await Promise.race([
      run.catch(() => undefined).then(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref?.()),
    ])
  }

  /**
   * 关闭：中止全部任务，等它们把进度落盘，再置为暂停。
   * 必须等收尾：中止信号发出后，引擎要把已完成 / 进行中的分片写进控制文件，这个任务体才会结束。
   * 不等的话进程随后就退出，控制文件没写成，下次打开只能从头下。
   */
  async shutdown(): Promise<void> {
    this.closing = true
    this.queue.shutdown()
    clearEmitters()
    // 中止之后任务体自己会把状态写成 paused 并落盘；给它们一点时间，超时也不强留
    const pending = [...this.running.values()]
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending).then(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref?.()),
      ])
    }
    const tasks = await loadTasks()
    for (const task of tasks) {
      if (!ACTIVE_STATES.includes(task.state)) continue
      task.state = 'paused'
      for (const file of task.files) if (file.state === 'downloading') file.state = 'pending'
    }
    await this.persistFinal(tasks)
  }

  /** 把任务交给队列；运行中的任务在各自的中止信号下执行 */
  private start(id: string): void {
    this.queue.add(id, signal => {
      const run = this.runTask(id, signal)
      this.running.set(id, run)
      // 任务体结束后从运行表移除；无论成败都要移除，否则关闭时会等到一个早已结束的任务
      void run.finally(() => { this.running.delete(id) }).catch(() => undefined)
      return run
    }, undefined)
  }

  private async runTask(id: string, signal: AbortSignal): Promise<void> {
    const task = await findTask(id)
    if (!task) return
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    beginLive(id, sumDownloaded(task))
    // 任务运行期间持有活动租约，避免下载 / 解压时实例被空闲回收
    const release = await acquireActivity(`下载任务：${task.title}`.slice(0, 160))
    try {
      task.error = ''
      task.installError = ''
      // 文件都已下载好（安装失败后重试、或关闭时正在安装）：直接进入安装阶段，不重新下载
      const allDownloaded = task.files.length > 0 && task.files.every(file => file.state === 'done')
      task.state = allDownloaded ? 'installing' : 'resolving'
      await this.commit(task)
      await runTask(this.deps, task, controller.signal, {
        onState: async current => { await this.commit(current); emitState(current) },
        onProgress: current => { noteProgress(id, sumDownloaded(current), sumSize(current)); emitTask(current, snapshot => { void this.commit(snapshot).catch(() => undefined) }) },
      })
      task.state = 'complete'
      task.finishedAt = Date.now()
      const all = await this.commit(task)
      if (task.exePath) await markInstalled(task)
      // 先清掉运行态再发"已完成"：否则完成事件里还带着最后一刻的速度，任务卡上"已完成"旁边挂着 8 MB/s
      endLive(id)
      emitFinished(task, all)
    } catch (error) {
      // 把运行中的这个对象交过去：它身上才有最新的进度。按 id 重新读出来的是上次落盘的快照，
      // 用它写回的话，暂停 / 失败那一刻已经写到盘上的进度会被旧值盖掉
      await this.fail(task, error)
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.controllers.delete(id)
      endLive(id)
      await release()
    }
  }

  /** 把任务写回列表并落盘；返回写回后的完整列表。关闭后到达的进度提交直接丢弃 */
  private async commit(task: StoredTask): Promise<StoredTask[]> {
    if (this.closing) return loadTasks()
    return this.enqueueWrite(async () => {
      const tasks = await loadTasks()
      const index = tasks.findIndex(entry => entry.id === task.id)
      if (index < 0) return tasks
      tasks[index] = task
      tasks[index] = task
      await persist(tasks)
      return tasks
    })
  }

  /** 把一次"读列表 → 改 → 落盘"排到写链末尾执行：提交之间不会交错，后到的旧快照覆盖不了新状态 */
  private enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writes.then(write, write)
    // 写链本身不因某次失败而断；失败的错误照常抛给调用方
    this.writes = result.catch(() => undefined)
    return result
  }

  /** 关闭时的最后一次写入：不走 commit（它在关闭后丢弃提交），但要排在之前的写入之后 */
  /** 关闭时的最后一次写入：不走 commit（它在关闭后丢弃提交），但排在之前的写入之后 */
  private async persistFinal(tasks: StoredTask[]): Promise<void> {
    await this.enqueueWrite(() => persist(tasks))
  }

  /** 任务失败：区分暂停 / 登录过期 / 安装失败 / 下载失败 */
  private async fail(task: StoredTask, error: unknown): Promise<void> {
    const id = task.id
    const aborted = error instanceof Error && error.name === 'AbortError'
    await this.enqueueWrite(async () => {
      const tasks = await loadTasks()
      const index = tasks.findIndex(entry => entry.id === id)
      if (index < 0) return
      if (aborted) {
        // 被暂停 / 移除 / 关闭而中止。任务已被删除时什么都不用写。
        if (!tasks.some(entry => entry.id === id)) return
        // 下载中的文件复位为待下载，下次续传从控制文件记录的进度继续
        for (const file of task.files) if (file.state === 'downloading') file.state = 'pending'
        task.state = 'paused'
        tasks[index] = task
        await persist(tasks)
        // 立即通知页面：否则任务卡会一直显示"下载中"，直到下次主动刷新
        if (!this.closing) emitFinished(task, tasks)
        return
      }
      if (error instanceof InstallError) {
        task.state = 'install_failed'
        task.installError = error.message
      } else if (error instanceof BackendError && ['LOGIN_REQUIRED', 'LOGIN_EXPIRED'].includes(error.code)) {
        task.state = 'login_expired'
        task.error = '天翼云登录已过期，重新登录后可以继续下载'
      } else {
        task.state = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
      }
      for (const file of task.files) if (file.state === 'downloading') file.state = 'pending'
      tasks[index] = task
      await persist(tasks)
      if (!this.closing) emitFinished(task, tasks)
    })
  }
}

function sumDownloaded(task: StoredTask): number {
  return task.files.reduce((sum, file) => sum + file.downloaded, 0)
}

function sumSize(task: StoredTask): number {
  return task.files.reduce((sum, file) => sum + file.size, 0)
}

async function findTask(id: string): Promise<StoredTask> {
  const task = (await loadTasks()).find(entry => entry.id === id)
  if (!task) throw new BackendError('NOT_FOUND', '任务不存在')
  return task
}

/** 句柄换路径；没有句柄、或句柄已失效都拒绝 */
async function authorizedDir(target: { handleId: string; displayPath: string } | undefined, label: string): Promise<string> {
  if (!target?.handleId) throw new BackendError('INVALID_ARGUMENT', `请选择${label}`)
  let path: string
  try {
    const resolved = await resolveFileHandle(target.handleId, 'write')
    if (typeof resolved !== 'string' || !resolved) throw new Error('invalid or expired local file handle')
    path = resolved
  } catch {
    throw new BackendError('INVALID_ARGUMENT', `${label}授权已失效，请重新选择`)
  }
  await ensureDir(getAdapter(), path)
  return path
}

/**
 * 写回任务列表并返回。saveTasks 只是防抖写入（250ms 后才真正落盘），这里必须等到真正写完：
 * 关闭插件时后端在 shutdown.complete 之后 50ms 就退出，防抖定时器等不到，落盘的会是 250ms 前的旧状态。
 */
async function persist(tasks: StoredTask[]): Promise<StoredTask[]> {
  saveTasks(tasks)
  await flushStore()
  return tasks
}

/** 安装成功：把 exe 路径与安装目录写进条目 */
async function markInstalled(task: StoredTask): Promise<void> {
  if (!task.itemId) return
  await setInstallInfo(task.itemId, { exePath: task.exePath, installDir: task.installDir, downloadDir: task.downloadDir, exeRel: task.exeRel })
}
