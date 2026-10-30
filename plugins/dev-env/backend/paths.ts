/**
 * paths —— 目录/路径工具：home、平台数据目录表、递归磁盘占用（du -sk 优先，并发限制 + 30s 缓存）。
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from './exec'

export const isMac = process.platform === 'darwin'
export const isWin = process.platform === 'win32'

export function home(): string { return os.homedir() }

export function joinHome(...parts: string[]): string { return path.join(home(), ...parts) }

/** Windows 特有的环境根（不存在时返回 undefined，调用方自行跳过）。 */
export function winEnv(name: 'APPDATA' | 'LOCALAPPDATA' | 'PROGRAMDATA'): string | undefined {
  const value = process.env[name]
  return value && path.isAbsolute(value) ? value : undefined
}

export function exists(p: string): boolean {
  try { fs.statSync(p); return true } catch { return false }
}

export function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/** 平台相关的“库目录”：mac 为 ~/Library，win 无统一概念（各数据目录自带路径）。 */
export function dirExistsOrUndefined(p: string): string | undefined { return isDirectory(p) ? p : undefined }

/* —— 磁盘占用：并发 ≤2 + 30s 结果缓存 —— */

const SIZE_CONCURRENCY = 2
const SIZE_CACHE_MS = 30_000
const sizeCache = new Map<string, { at: number; bytes: number }>()
let sizeQueue: (() => void)[] = []
let sizeActive = 0

function pumpSizeQueue(): void {
  while (sizeActive < SIZE_CONCURRENCY && sizeQueue.length > 0) {
    sizeActive++
    const task = sizeQueue.shift()!
    task()
  }
}

function withSizeSlot<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const task = () => {
      work().then(resolve, reject).finally(() => { sizeActive--; pumpSizeQueue() })
    }
    sizeQueue.push(task)
    pumpSizeQueue()
  })
}

async function dirSizeMac(dir: string): Promise<number> {
  // du -sk 一次拿到整棵树（KB 块），比逐文件 stat 快一个量级。
  const result = await run('du', ['-sk', dir], { timeoutMs: 120_000 })
  if (!result.ok || !result.stdout.trim()) return 0
  const match = /^(\d+)/.exec(result.stdout.trim())
  return match ? Number(match[1]) * 1024 : 0
}

async function dirSizeWin(dir: string): Promise<number> {
  // 递归 stat 求和；子目录分批异步，避免 UI 卡顿。
  let total = 0
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 24) return
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(current, { withFileTypes: true }) } catch { return }
    const BATCH = 128
    for (let index = 0; index < entries.length; index += BATCH) {
      const slice = entries.slice(index, index + BATCH)
      await Promise.all(slice.map(async entry => {
        const full = path.join(current, entry.name)
        try {
          if (entry.isDirectory()) await walk(full, depth + 1)
          else if (entry.isFile()) total += (await fsp.stat(full)).size
        } catch { /* permission or racing deletion */ }
      }))
    }
  }
  await walk(dir, 0)
  return total
}

/** 目录磁盘占用（字节）。不存在返回 0。并发限制 2，结果缓存 30s。 */
export async function dirSize(dir: string): Promise<number> {
  if (!isDirectory(dir)) return 0
  const cached = sizeCache.get(dir)
  if (cached && Date.now() - cached.at < SIZE_CACHE_MS) return cached.bytes
  const bytes = await withSizeSlot(async () => {
    if (isMac) { try { return await dirSizeMac(dir) } catch { /* fall through */ } }
    return dirSizeWin(dir)
  })
  sizeCache.set(dir, { at: Date.now(), bytes })
  return bytes
}

/** 失效占用缓存（清理/迁移后调用，强制下次重算）。 */
export function invalidateSizeCache(dir?: string): void {
  if (dir === undefined) sizeCache.clear()
  else sizeCache.delete(dir)
}

/* —— 平台数据目录表 —— */

export interface DirSpec { label: string; path: string }

export function npmCacheDir(): DirSpec {
  if (isWin && winEnv('APPDATA')) return { label: 'npm 缓存', path: path.join(winEnv('APPDATA')!, 'npm-cache') }
  return { label: 'npm 缓存', path: joinHome('.npm') }
}

export function uvDataDir(): DirSpec {
  if (isWin && winEnv('APPDATA')) return { label: 'UV 数据', path: path.join(winEnv('APPDATA')!, 'uv', 'data') }
  return { label: 'UV 数据', path: joinHome('.local', 'share', 'uv') }
}

export function uvCacheDir(): DirSpec {
  if (isWin && winEnv('LOCALAPPDATA')) return { label: 'UV 缓存', path: path.join(winEnv('LOCALAPPDATA')!, 'uv') }
  return { label: 'UV 缓存', path: joinHome('Library', 'Caches', 'uv') }
}

export function pipConfigFile(): string {
  if (isWin && winEnv('APPDATA')) return path.join(winEnv('APPDATA')!, 'pip', 'pip.ini')
  return joinHome('.config', 'pip', 'pip.conf')
}

export function gradleHome(): string {
  const override = process.env.GRADLE_USER_HOME
  return override && path.isAbsolute(override) ? override : joinHome('.gradle')
}

export function goEnvFile(): string {
  if (isWin && winEnv('APPDATA')) return path.join(winEnv('APPDATA')!, 'go', 'env')
  if (isMac) return joinHome('Library', 'Application Support', 'go', 'env')
  return joinHome('.config', 'go', 'env')
}

export function scoopConfigFile(): string {
  return joinHome('.config', 'scoop', 'config.json')
}

/** 读取小文本文件前 4KB（配置预览）。 */
export function readPreview(file: string, bytes = 4096): string | undefined {
  try {
    const stats = fs.statSync(file)
    if (!stats.isFile() || stats.size === 0) return ''
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(bytes, stats.size))
      const read = fs.readSync(handle, buffer, 0, buffer.length, 0)
      if (buffer.subarray(0, Math.min(read, 1024)).includes(0)) return undefined // 二进制
      return buffer.subarray(0, read).toString('utf8')
    } finally { fs.closeSync(handle) }
  } catch { return undefined }
}

export function configFile(file: string): { path: string; exists: boolean; bytes?: number; preview?: string } {
  try {
    const stats = fs.statSync(file)
    if (!stats.isFile()) return { path: file, exists: false }
    return { path: file, exists: true, bytes: stats.size, preview: readPreview(file) }
  } catch {
    return { path: file, exists: false }
  }
}
