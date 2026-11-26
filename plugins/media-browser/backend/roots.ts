/**
 * 授权根目录：登记、边界校验与持久化。
 *
 * 安全模型：
 * - 根目录只能来自宿主目录选择器签发的句柄（files.resolve），路径字符串不能充当授权。
 * - 句柄随运行代次失效，所以持久化里只存展示路径用于提示；每次启动都需要用户重新授权。
 * - 一旦登记，该根目录内的所有子路径操作都由 assertInside 做边界校验。
 */

import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolveFileHandle, storageGet, storageSet } from './runtime.ts'
import type { RootEntry } from '../src/shared/contracts.ts'

const STORAGE_KEY = 'roots.v1'

/** 持久化形态：只有展示信息，没有任何可作为授权的东西 */
interface StoredRoots {
  /** 上次关联过的目录展示路径，用于「上次浏览过」提示与重新授权 */
  hints: { displayPath: string; name: string }[]
}

interface RootRecord {
  rootId: string
  /** realpath 之后的规范绝对路径，所有边界校验以它为准 */
  path: string
  displayPath: string
  name: string
}

const roots = new Map<string, RootRecord>()

/** target 是否在 root 目录之内（含 root 自身） */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function toEntry(record: RootRecord, missing = false): RootEntry {
  return {
    rootId: record.rootId,
    displayPath: record.displayPath,
    name: record.name,
    ...(missing ? { missing: true } : {}),
  }
}

export function listRoots(): RootEntry[] {
  return [...roots.values()].map(record => toEntry(record))
}

export function getRoot(rootId: string): RootRecord {
  const record = roots.get(rootId)
  if (!record) throw new Error('关联目录已失效，请重新添加')
  return record
}

/**
 * 登记一个根目录。句柄必须带写权限：本插件要在所选目录内移动和删除文件。
 * 同一目录重复关联按幂等处理，返回已有条目。
 */
export async function addRoot(handleId: string): Promise<{ entry: RootEntry; added: boolean }> {
  if (typeof handleId !== 'string' || !handleId || handleId.length > 512) throw new Error('无效的目录句柄')
  const path = await resolveFileHandle(handleId, 'write')
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('目录不存在')
    throw error
  })
  if (!info.isDirectory()) throw new Error('请选择一个文件夹')
  const canonical = await realpath(path)
  for (const record of roots.values()) {
    if (record.path === canonical) return { entry: toEntry(record), added: false }
  }
  if (roots.size >= 32) throw new Error('最多关联 32 个文件夹')
  const record: RootRecord = {
    rootId: randomUUID(),
    path: canonical,
    displayPath: path,
    name: basename(canonical) || canonical,
  }
  roots.set(record.rootId, record)
  await persistHints()
  return { entry: toEntry(record), added: true }
}

export function removeRoot(rootId: string): RootEntry[] {
  if (!roots.delete(rootId)) throw new Error('关联目录已失效，请重新添加')
  void persistHints()
  return listRoots()
}

/**
 * 启动时把上次关联过的目录标成 missing：不自动恢复访问，只是告诉页面
 * 「这些目录上次关联过」，由用户点一下重新授权。
 */
export async function loadHints(): Promise<RootEntry[]> {
  const stored = await storageGet<StoredRoots>(STORAGE_KEY).catch(() => null)
  const hints = Array.isArray(stored?.hints) ? stored.hints.filter(h => h && typeof h.displayPath === 'string') : []
  const entries: RootEntry[] = []
  for (const hint of hints.slice(0, 32)) {
    entries.push({ rootId: '', displayPath: hint.displayPath, name: hint.name || basename(hint.displayPath) || hint.displayPath, missing: true })
  }
  return entries
}

async function persistHints(): Promise<void> {
  const hints = [...roots.values()].map(record => ({ displayPath: record.displayPath, name: record.name }))
  try {
    await storageSet(STORAGE_KEY, { hints } satisfies StoredRoots)
  } catch {
    // 提示信息持久化失败不影响本次会话使用。
  }
}

/**
 * 由根目录 + 根内相对路径得到条目的绝对路径。
 * relativePath 为空表示根目录本身。拒绝绝对路径、.. 逃逸与越界。
 */
export function resolveInRoot(rootId: string, relativePath: string): string {
  const root = getRoot(rootId)
  if (typeof relativePath !== 'string') throw new Error('无效的相对路径')
  if (relativePath === '') return root.path
  if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('无效的相对路径')
  const target = resolve(root.path, relativePath)
  if (!isInside(root.path, target)) throw new Error('路径超出关联目录范围')
  return target
}
