/**
 * 启动 / 关闭 / 卸载 / 在文件管理器显示。
 * - 启动：读 exePath，调 adapter.processes.launch；运行表记 { pid, startedAt, image }；
 *   pid 为 0（提权启动）时 elevated = true，无法跟踪，按已运行处理。
 * - 关闭：先核对进程身份（adapter.terminate 内部做），避免 PID 复用误杀。
 * - 卸载：确认后只删除本条目独占的安装内容与本插件下载的安装包，清条目安装字段与任务记录。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError, type Adapter } from '../adapters/types.ts'
import { EVENTS } from '../contracts.ts'
import { confirmWithUser, postEvent, resolveFileHandle, untrackProcess } from '../runtime.ts'
import { flushStore, loadTasks, saveTasks, type StoredTask } from '../store.ts'
import { removePackages } from '../install/cleanup.ts'
import { clearInstall, listManaged, requireItem, setInstallInfo } from './items.ts'

interface RunningEntry {
  pid: number
  startedAt: number
  image: string
}

const running = new Map<string, RunningEntry>()

/** 正在运行的条目 id 集合（items.listManaged 用） */
export function runningIds(): Set<string> {
  return new Set(running.keys())
}

/** 任务状态推送给 launch 的状态视图（协调者在任务模块里调用） */
export function noteTaskStates(tasks: StoredTask[]): Array<{ itemId: string; state: string }> {
  return tasks.map(task => ({ itemId: task.itemId, state: task.state }))
}

/** 启动。elevated = pid === 0（系统提权，无 PID）。 */
export async function launch(itemId: string): Promise<{ running: boolean; elevated: boolean }> {
  const stored = await requireItem(itemId)
  const exePath = stored.exePath.trim().replace(/^"|"$/g, '')
  if (!exePath) throw new BackendError('NO_EXE', '该条目还没有可执行文件，请先安装或在「我的游戏」里手动指定')
  const adapter = getAdapter()
  const stat = await adapter.files.stat(exePath)
  if (!stat || stat.isDirectory) throw new BackendError('NO_EXE', '游戏文件不存在，可能已被移动或删除')
  let cwd = adapter.path.dirname(exePath)
  const existing = running.get(itemId)
  if (existing && existing.pid > 0) {
    const identity = await adapter.processes.identity(existing.pid)
    if (identity && identity.startedAt === existing.startedAt && identity.image === existing.image) {
      throw new BackendError('ALREADY_RUNNING', '游戏已在运行中')
    }
    running.delete(itemId)
  }
  const process = await adapter.processes.launch({ exe: exePath, cwd })
  running.set(itemId, { pid: process.pid, startedAt: process.startedAt, image: process.image })
  return { running: true, elevated: process.pid === 0 }
}

/** 关闭。返回 { running: 是否仍在运行 }。 */
export async function close(itemId: string): Promise<{ running: boolean }> {
  const entry = running.get(itemId)
  if (!entry) return { running: false }
  const adapter = getAdapter()
  if (entry.pid === 0) {
    // 提权启动拿不到 PID，无法安全结束。
    running.delete(itemId)
    return { running: false }
  }
  const outcome = await adapter.processes.terminate(entry.pid, { startedAt: entry.startedAt, image: entry.image })
  if (outcome === 'refused') return { running: true }
  // terminated / gone：都不再运行。gone 常见于玩家自己退出了游戏，按钮却显示"关闭失败"。
  running.delete(itemId)
  await untrackProcess(entry.pid).catch(() => undefined)
  return { running: false }
}

/**
 * 卸载：
 * - 先弹宿主原生确认，取消抛 CANCELLED；
 * - 安装内容：只删这个条目独占的部分。exe 位于安装根目录的某个直接子目录里时，
 *   该子目录是解压出来的游戏目录，整目录删除；exe 直接在根目录下时，根目录可能与
 *   其它游戏混用，不能整删，只删任务记录里登记过的文件；
 * - 下载内容：按任务记录删除本插件下载的安装包及其续卷、控制文件，目录空了才删目录；
 * - 清 exePath 与任务记录；条目保留（收藏不丢），本地添加的条目整条删除。
 */
export async function uninstall(itemId: string): Promise<void> {
  const stored = await requireItem(itemId)
  const confirmed = await confirmWithUser('卸载', `确定要卸载「${stored.title}」吗？将删除已安装的文件和下载的安装包`, '')
  if (!confirmed) throw new BackendError('CANCELLED', '已取消')
  const adapter = getAdapter()

  // 先关运行中的进程。
  try {
    await close(itemId)
  } catch {
    // 关不掉也继续清理。
  }

  const tasks = await loadTasks()
  const related = tasks.filter(task => task.itemId === itemId)

  // 安装内容
  const exePath = stored.exePath.trim().replace(/^"|"$/g, '')
  const installRoot = stored.installDir.trim()
  if (exePath && installRoot) {
    const exeDir = adapter.path.dirname(adapter.path.resolve(exePath))
    const root = adapter.path.resolve(installRoot)
    if (exeDir.toLowerCase() !== root.toLowerCase() && adapter.path.dirname(exeDir).toLowerCase() === root.toLowerCase()) {
      // exe 在安装根目录的直接子目录里：这个子目录整个属于本游戏
      await adapter.files.removeDir(exeDir).catch(() => undefined)
      await removeIfEmptyDir(adapter, root)
    } else if (exeDir.toLowerCase() === root.toLowerCase()) {
      // exe 直接在安装根目录：只删登记过的文件，根目录不动
      for (const task of related) {
        for (const name of task.files) await adapter.files.removeFile(adapter.path.join(root, name.name)).catch(() => undefined)
      }
    }
  }

  // 下载内容：安装包、续卷与控制文件
  for (const task of related) {
    if (!task.downloadDir) continue
    await removePackages(adapter, task.downloadDir, task.files.map(file => file.name))
    await removeIfEmptyDir(adapter, task.downloadDir)
  }

  await saveTasks(tasks.filter(task => task.itemId !== itemId))
  await flushStore()
  // 本地添加的条目整条删除；其余清安装字段，收藏保留。
  await clearInstall(itemId, stored.kind === 'custom')
  postEvent(EVENTS.libraryChanged, await listManaged())
}

async function removeIfEmptyDir(adapter: Adapter, dir: string): Promise<void> {
  try {
    const entries = await adapter.files.listDir(dir)
    if (entries.length === 0) await adapter.files.removeDir(dir)
  } catch {
    // 目录不存在或读不了，忽略。
  }
}

/** 在文件管理器中显示 */
export async function reveal(itemId: string, target: 'download' | 'install'): Promise<{ ok: boolean }> {
  const stored = await requireItem(itemId)
  const path = target === 'download' ? stored.downloadDir : stored.installDir || stored.exePath
  if (!path) throw new BackendError('INVALID_ARGUMENT', target === 'download' ? '没有下载目录' : '没有安装目录')
  const adapter = getAdapter()
  let revealPath = path
  if (target === 'install' && !stored.installDir && stored.exePath) revealPath = adapter.path.dirname(stored.exePath)
  await adapter.files.reveal(revealPath)
  return { ok: true }
}

/**
 * 指定可执行文件。只接受宿主文件选择器给的句柄：句柄在这里换成路径，
 * 路径字符串不能当授权，所以调用方不传路径。
 */
export async function setExePath(itemId: string, handleId: string, installDir: string): Promise<void> {
  const adapter = getAdapter()
  await requireItem(itemId)
  let exePath: string
  try {
    const resolved = await resolveFileHandle(handleId, 'read')
    if (typeof resolved !== 'string' || !resolved) throw new Error('invalid handle')
    exePath = resolved
  } catch {
    throw new BackendError('INVALID_ARGUMENT', '文件授权已失效，请重新选择')
  }
  const stat = await adapter.files.stat(exePath)
  if (!stat || stat.isDirectory) throw new BackendError('INVALID_ARGUMENT', '选择的文件不存在')
  if (adapter.path.extname(exePath).toLowerCase() !== '.exe') throw new BackendError('INVALID_ARGUMENT', '请选择 .exe 可执行文件')
  await setInstallInfo(itemId, { exePath, installDir: installDir || adapter.path.dirname(exePath) })
}
