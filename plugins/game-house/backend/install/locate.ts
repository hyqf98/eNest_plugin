/**
 * 定位游戏的可执行文件（三层回退）。
 *
 * 压缩包结构千差万别：有的内嵌一层游戏目录，有的没有；站点给的 exe 相对路径可能过时。
 * 1. 站点给出的相对路径直接命中；
 * 2. 以该路径第一段为子目录，广度优先找 exe；
 * 3. 在整个输出目录下广度优先找 exe。
 *
 * 候选里排除卸载器、运行库安装器等，并优先选体积最大的（游戏主程序通常最大）。
 */

import type { Adapter } from '../adapters/types.ts'

/** 不是游戏主程序的可执行文件（文件名小写前缀） */
const EXCLUDED_PREFIXES = ['unins', 'uninstall', 'vc_redist', 'vcredist', 'dotnet', 'directx', 'dxsetup', 'dxwebsetup', 'setup', 'install', 'crash', 'report', 'unitycrashhandler', 'redist']
const MAX_ENTRIES = 20_000

function isCandidate(name: string): boolean {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.exe')) return false
  return !EXCLUDED_PREFIXES.some(prefix => lower.startsWith(prefix))
}

/** 广度优先遍历目录找 exe；按体积降序返回（最多 limit 个） */
async function findExecutables(adapter: Adapter, root: string, limit = 8): Promise<Array<{ path: string; size: number }>> {
  const found: Array<{ path: string; size: number }> = []
  let queue = [root]
  let visited = 0
  while (queue.length && found.length < 200 && visited < MAX_ENTRIES) {
    const next: string[] = []
    for (const dir of queue) {
      let entries: Array<{ name: string; isDirectory: boolean; size: number }>
      try { entries = await adapter.files.listDir(dir) } catch { continue }
      for (const entry of entries) {
        if (++visited > MAX_ENTRIES) break
        const full = adapter.path.join(dir, entry.name)
        if (entry.isDirectory) next.push(full)
        else if (isCandidate(entry.name)) found.push({ path: full, size: entry.size })
      }
    }
    queue = next
  }
  return found.sort((a, b) => b.size - a.size).slice(0, limit)
}

/** 返回可执行文件的绝对路径；找不到返回 null */
export async function locateExecutable(adapter: Adapter, outputDir: string, exeRel: string): Promise<string | null> {
  const root = adapter.path.resolve(outputDir)
  const rel = String(exeRel ?? '').trim().replace(/\\/g, '/')
  // 1. 站点给出的相对路径
  if (rel) {
    const direct = adapter.path.join(root, ...rel.split('/').filter(Boolean))
    const info = await adapter.files.stat(direct)
    if (info && !info.isDirectory && isCandidate(adapter.path.basename(direct))) return direct
  }
  // 2. 以相对路径第一段为子目录
  const firstSegment = rel.split('/').find(Boolean)
  if (firstSegment) {
    const sub = adapter.path.join(root, firstSegment)
    if (await adapter.files.isDirectory(sub)) {
      const candidates = await findExecutables(adapter, sub, 1)
      if (candidates[0]) return candidates[0].path
    }
  }
  // 3. 整个输出目录
  const candidates = await findExecutables(adapter, root, 1)
  return candidates[0]?.path ?? null
}
