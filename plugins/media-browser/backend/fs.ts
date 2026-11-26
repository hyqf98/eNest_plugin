/**
 * 文件系统操作：目录扫描、移动、真删。
 * 所有入口都从 entryId 反查路径，路径永远不离开后端。
 */

import { readdir, rename, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { childPath, issueDirectory, issueFile, parentOf, pathOf, relativePathOf, rootIdOf } from './entries.ts'
import { listRoots, resolveInRoot } from './roots.ts'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, type DeleteResult, type FolderNode, type MediaItem, type MediaKind, type MoveResult } from '../src/shared/contracts.ts'

/** 单次目录读取的条目上限，防止超大目录把后端拖死 */
const MAX_DIR_ENTRIES = 20_000
/** 递归统计时最多走访的目录数，到达后停止并按已走访的数字显示 */
const MAX_WALK_DIRS = 3_000

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

export function mediaKindOf(name: string): MediaKind | null {
  const ext = extname(name).slice(1).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return null
}

/** 隐藏文件与系统伴随文件不展示、不计入统计 */
function ignorable(name: string): boolean {
  return name.startsWith('.') || name === 'Thumbs.db' || name === 'desktop.ini'
}

/** 同目录内按名称排序（数字感知：IMG_2 排在 IMG_10 前面） */
function byName<T extends { name: string }>(a: T, b: T): number {
  return collator.compare(a.name, b.name)
}

interface DirSnapshot {
  folders: { name: string; path: string }[]
  files: { name: string; path: string; kind: MediaKind }[]
}

/**
 * 读一个目录并分类。符号链接与 junction 一律跳过：
 * 跟随它们可能读到关联目录之外的内容。
 */
async function readDirectory(rootId: string, relativePath: string): Promise<DirSnapshot> {
  const dirents = await readdir(resolveInRoot(rootId, relativePath), { withFileTypes: true })
  const snapshot: DirSnapshot = { folders: [], files: [] }
  for (const dirent of dirents) {
    if (snapshot.folders.length + snapshot.files.length >= MAX_DIR_ENTRIES) break
    const name = dirent.name
    if (ignorable(name) || dirent.isSymbolicLink()) continue
    const childRelative = childPath(relativePath, name)
    if (dirent.isDirectory()) snapshot.folders.push({ name, path: childRelative })
    else if (dirent.isFile()) {
      const kind = mediaKindOf(name)
      if (kind) snapshot.files.push({ name, path: childRelative, kind })
    }
  }
  return snapshot
}

/** 根目录本身还在不在（U 盘拔出、目录被删） */
async function isLiveDirectory(rootId: string): Promise<boolean> {
  try {
    return (await stat(resolveInRoot(rootId, ''))).isDirectory()
  } catch {
    return false
  }
}

/** 递归统计媒体数与子文件夹数；广度优先，到达走访上限即停 */
async function countDeep(rootId: string, relativePath: string): Promise<{ media: number; folders: number }> {
  let media = 0
  let folders = 0
  let visited = 0
  const queue = [relativePath]
  while (queue.length && visited < MAX_WALK_DIRS) {
    visited++
    const current = queue.shift()!
    const snapshot = await readDirectory(rootId, current).catch(() => null)
    if (!snapshot) continue
    media += snapshot.files.length
    folders += snapshot.folders.length
    for (const folder of snapshot.folders) queue.push(folder.path)
  }
  return { media, folders }
}

async function folderNode(rootId: string, name: string, relativePath: string, depth: number): Promise<FolderNode> {
  const deep = await countDeep(rootId, relativePath)
  return { entryId: issueDirectory(rootId, relativePath), rootId, name, depth, hasChildren: deep.folders > 0, mediaCount: deep.media }
}

/** 左侧树：每个根目录 + 它的直接子文件夹；更深的层级展开时再加载 */
export async function loadTree(): Promise<{ node: FolderNode; children: FolderNode[] }[]> {
  const trees: { node: FolderNode; children: FolderNode[] }[] = []
  for (const root of listRoots()) {
    if (!(await isLiveDirectory(root.rootId))) continue
    const snapshot = await readDirectory(root.rootId, '').catch(() => null)
    if (!snapshot) continue
    const children: FolderNode[] = []
    for (const folder of snapshot.folders.sort(byName)) {
      children.push(await folderNode(root.rootId, folder.name, folder.path, 1))
    }
    // folderNode 已经递归统计了根目录下的全部媒体，直接用它
    trees.push({
      node: await folderNode(root.rootId, root.name, '', 0),
      children,
    })
  }
  return trees
}

/** 展开某个文件夹：返回它的直接子文件夹 */
export async function listSubfolders(entryId: string): Promise<FolderNode[]> {
  const rootId = rootIdOf(entryId)
  const relativePath = relativePathOf(entryId)
  const snapshot = await readDirectory(rootId, relativePath)
  const depth = relativePath ? relativePath.split('/').length + 1 : 1
  const nodes: FolderNode[] = []
  for (const folder of snapshot.folders.sort(byName)) {
    nodes.push(await folderNode(rootId, folder.name, folder.path, depth))
  }
  return nodes
}

/** 右侧网格：某个文件夹内的直接媒体文件，按名称排序后分页 */
export async function listMedia(entryId: string, offset = 0, limit = 200): Promise<{ items: MediaItem[]; total: number }> {
  const rootId = rootIdOf(entryId)
  const relativePath = relativePathOf(entryId)
  const snapshot = await readDirectory(rootId, relativePath)
  const files = snapshot.files.sort(byName)
  const items: MediaItem[] = []
  for (const file of files.slice(offset, offset + limit)) {
    let size = 0
    let mtime = 0
    try {
      const info = await stat(resolveInRoot(rootId, file.path))
      size = info.size
      mtime = info.mtimeMs
    } catch {
      // 列表期间被外部删掉了：仍展示条目，缩略图阶段会报「文件不存在」
    }
    items.push({
      entryId: issueFile(rootId, file.path),
      rootId,
      parentEntryId: entryId,
      name: file.name,
      kind: file.kind,
      ext: extname(file.name).slice(1).toLowerCase(),
      size,
      mtime,
    })
  }
  return { items, total: files.length }
}

interface SourceRecord { rootId: string; relativePath: string; name: string; isDirectory: boolean }

async function describe(entryId: string): Promise<SourceRecord> {
  const absolute = pathOf(entryId)
  const info = await stat(absolute).catch(() => null)
  const rootId = rootIdOf(entryId)
  return {
    rootId,
    relativePath: relativePathOf(entryId),
    name: absolute.split('/').pop() || absolute,
    isDirectory: Boolean(info?.isDirectory()),
  }
}

function safeName(entryId: string): string {
  return pathOf(entryId).split('/').pop() || '条目'
}

/** 真删一个文件或目录（不进回收站）；目录递归 */
async function destroy(absolute: string, isDirectory: boolean): Promise<void> {
  await rm(absolute, { recursive: isDirectory, force: false })
}

/**
 * 移动条目到目标文件夹。逐个校验：
 * - 目标必须是文件夹，且与源同属一个根目录（跨根目录可能是跨磁盘，rename 会失败）
 * - 源不能是目标自身的祖先（把文件夹拖进自己里面）
 * - 目标里已有同名条目时拒绝覆盖
 */
export async function moveItems(sourceIds: string[], targetFolderId: string): Promise<MoveResult> {
  if (!Array.isArray(sourceIds) || !sourceIds.length) throw new Error('没有选择要移动的条目')
  if (sourceIds.length > 500) throw new Error('一次最多移动 500 个条目')
  const targetRootId = rootIdOf(targetFolderId)
  const targetRelative = relativePathOf(targetFolderId)
  const targetPath = pathOf(targetFolderId, 'directory')
  const failures: { name: string; reason: string }[] = []
  let moved = 0
  for (const entryId of new Set(sourceIds)) {
    try {
      const source = await describe(entryId)
      // 根目录就是用户关联的那个文件夹本身：移动它等于把整个关联目录挪走
      if (source.relativePath === '') throw new Error('不能移动关联的根目录')
      if (source.rootId !== targetRootId) throw new Error('不能跨关联目录移动')
      if (entryId === targetFolderId) throw new Error('不能移动到自身')
      const sourcePath = pathOf(entryId)
      // 把文件夹拖进自己的子文件夹会让它从树里消失
      if (source.isDirectory && (targetRelative === source.relativePath || targetRelative.startsWith(source.relativePath + '/'))) {
        throw new Error('不能把文件夹移动到它自己的子文件夹')
      }
      const destination = join(targetPath, source.name)
      if (await exists(destination)) throw new Error('目标文件夹已有同名条目')
      if (parentOf(source.relativePath) === targetRelative) continue // 已经在这里：按成功处理，不重复 rename
      await rename(sourcePath, destination)
      moved++
    } catch (error) {
      failures.push({ name: await safeNameOf(entryId), reason: messageOf(error) })
    }
  }
  return { moved, failed: failures }
}

async function safeNameOf(entryId: string): Promise<string> {
  try { return safeName(entryId) } catch { return '条目' }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/**
 * 真删条目（不进回收站）：文件直接删，文件夹递归删。
 * 调用方（index.ts 的分发）已对批量与文件夹做过确认。
 */
export async function deleteItems(entryIds: string[]): Promise<DeleteResult> {
  if (!Array.isArray(entryIds) || !entryIds.length) throw new Error('没有选择要删除的条目')
  if (entryIds.length > 500) throw new Error('一次最多删除 500 个条目')
  const failures: { name: string; reason: string }[] = []
  let deleted = 0
  // 先删文件后删目录，避免父目录先被删掉导致子项报「不存在」
  const ordered = await orderForDelete(entryIds)
  for (const entryId of ordered) {
    try {
      // 根目录是用户关联的整个文件夹：删除它等于清空用户的照片库。取消关联不会动磁盘上的文件。
      if (relativePathOf(entryId) === '') throw new Error('不能删除关联的根目录；如需移除请取消关联')
      const absolute = pathOf(entryId)
      const info = await stat(absolute).catch(() => null)
      if (!info) throw new Error('文件不存在或已被移走')
      await destroy(absolute, info.isDirectory())
      deleted++
    } catch (error) {
      failures.push({ name: await safeNameOf(entryId), reason: messageOf(error) })
    }
  }
  return { deleted, failed: failures }
}

/** 同批里既有文件夹又有其中的文件时，先删文件再删文件夹，避免父目录先没了 */
async function orderForDelete(entryIds: string[]): Promise<string[]> {
  const unique = [...new Set(entryIds)]
  const keyed = await Promise.all(unique.map(async entryId => {
    let depth = Number.MAX_SAFE_INTEGER
    try { depth = relativePathOf(entryId).split('/').length } catch { /* 失效条目保留，主循环会报错 */ }
    return { entryId, depth }
  }))
  return keyed.sort((a, b) => b.depth - a.depth).map(item => item.entryId)
}
