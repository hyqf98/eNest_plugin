/**
 * 安装前的选择性清理与安装后的安装包清理。
 *
 * 源项目的事故：解压前对安装目录做无差别 remove_dir_all，把和安装目录放在一起的分卷压缩包
 * 一起删了，于是 7z 报「文件不存在」、重试变成重新下载上百 GB。
 * 所以清理必须是选择性的：只删残留，保护安装包、同主干的续卷与控制文件。
 */

import type { Adapter } from '../adapters/types.ts'
import { continuationNames } from '../paths.ts'

/** 取路径最后一段（同时认 / 与 \）并转小写 */
function lowerName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? '').toLowerCase()
}

/**
 * 受保护文件集合：这些文件本身、它们的续卷、它们的 .ghctl 控制文件（全部按文件名小写比较）。
 * 续卷要到目录里实际存在的文件中去找——调用方通常只知道主卷名，
 * 而 .z01 / .r00 这些续卷是否属于同一个包，取决于它们是否真的和主卷放在一起。
 */
async function collectProtectedNames(adapter: Adapter, dir: string, protectedFiles: string[]): Promise<Set<string>> {
  const names = protectedFiles.map(lowerName).filter(Boolean)
  const present: string[] = []
  try {
    for (const entry of await adapter.files.listDir(dir)) if (!entry.isDirectory) present.push(entry.name.toLowerCase())
  } catch { /* 目录不存在：没有续卷可找 */ }
  const result = new Set<string>()
  for (const name of names) {
    result.add(name)
    result.add(`${name}.ghctl`)
    result.add(`${name}.ghctl.tmp`)
    for (const volume of continuationNames(name, present.length ? present : names)) result.add(volume)
  }
  return result
}

/** 某个文件相对于 root 的目录链（每一级都保留），超出 root 的不纳入 */
function dirsToKeep(adapter: Adapter, root: string, file: string): string[] {
  const rootResolved = adapter.path.resolve(root).toLowerCase()
  const absolute = adapter.path.resolve(adapter.path.isAbsolute(file) ? file : adapter.path.join(root, file))
  if (absolute.length <= rootResolved.length || !absolute.toLowerCase().startsWith(rootResolved)) return []
  const dirs: string[] = []
  let dir = adapter.path.dirname(absolute)
  while (dir.length > rootResolved.length && dir.toLowerCase().startsWith(rootResolved)) {
    dirs.push(adapter.path.resolve(dir))
    dir = adapter.path.dirname(dir)
  }
  return dirs
}

/**
 * 删除 outputDir 下的残留，但保留 protectedFiles 及其续卷、控制文件，以及包含它们的各级目录。
 * 不删除 outputDir 本身。
 */
export async function selectiveCleanup(adapter: Adapter, outputDir: string, protectedFiles: string[]): Promise<void> {
  // 安装包可能不在 outputDir 里，而是和它并排放（下载目录 == 安装目录是默认布局），所以到每个受保护文件各自所在的目录里找续卷
  const keepFiles = new Set<string>()
  const byDir = new Map<string, string[]>()
  for (const file of protectedFiles) {
    const absolute = adapter.path.resolve(adapter.path.isAbsolute(file) ? file : adapter.path.join(outputDir, file))
    const dir = adapter.path.dirname(absolute)
    const list = byDir.get(dir) ?? []
    list.push(absolute)
    byDir.set(dir, list)
  }
  for (const [dir, files] of byDir) {
    for (const name of await collectProtectedNames(adapter, dir, files)) keepFiles.add(name)
  }
  const keepDirs = new Set<string>()
  for (const file of protectedFiles) {
    for (const dir of dirsToKeep(adapter, outputDir, file)) keepDirs.add(dir.toLowerCase())
  }

  const walk = async (dir: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory: boolean; size: number }>
    try { entries = await adapter.files.listDir(dir) } catch { return }
    for (const entry of entries) {
      const full = adapter.path.join(dir, entry.name)
      if (entry.isDirectory) {
        // 含受保护文件的目录只清理里面的残留，不整目录删除
        if (keepDirs.has(adapter.path.resolve(full).toLowerCase())) await walk(full)
        else await adapter.files.removeDir(full)
      } else if (!keepFiles.has(entry.name.toLowerCase())) {
        await adapter.files.removeFile(full)
      }
    }
  }
  await walk(outputDir)
}

/** 删除每个安装包及其同主干续卷与控制文件；单个失败只跳过，不中断 */
export async function removePackages(adapter: Adapter, dir: string, fileNames: string[]): Promise<void> {
  let present: Array<{ name: string; isDirectory: boolean }>
  try { present = await adapter.files.listDir(dir) } catch { return }
  const presentLower = present.filter(entry => !entry.isDirectory).map(entry => entry.name.toLowerCase())
  const targets = new Set<string>()
  for (const raw of fileNames) {
    const name = lowerName(raw)
    targets.add(name)
    targets.add(`${name}.ghctl`)
    for (const volume of continuationNames(name, presentLower)) targets.add(volume)
  }
  for (const entry of present) {
    if (entry.isDirectory || !targets.has(entry.name.toLowerCase())) continue
    try { await adapter.files.removeFile(adapter.path.join(dir, entry.name)) } catch { /* best effort */ }
  }
}
