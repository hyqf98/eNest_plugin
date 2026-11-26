/**
 * 缩略图磁盘缓存：{appDataPath}/media-browser/thumbs/<key>.jpg
 *
 * key 由「绝对路径 + 文件大小 + 修改时间 + 扩展名」哈希得到，文件一变 key 就变，
 * 旧缓存自然失效；目录惰性创建，首次使用时清理超过 30 天的条目。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { currentScope } from './runtime.ts'

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

let cacheDir = ''
let initialized = false

/** 返回缓存目录；创建失败返回空串表示禁用缓存 */
export function thumbCacheDir(): string {
  if (initialized) return cacheDir
  initialized = true
  try {
    const dir = join(currentScope().context.appDataPath, 'media-browser', 'thumbs')
    mkdirSync(dir, { recursive: true })
    cacheDir = dir
    pruneCache()
  } catch {
    cacheDir = ''
  }
  return cacheDir
}

/** 文件的缩略图缓存路径；缓存禁用时返回空串 */
export function thumbCacheFile(absolute: string, size: number, mtimeMs: number, ext: string): string {
  const dir = thumbCacheDir()
  if (!dir) return ''
  const key = createHash('sha256').update(`${absolute}|${size}|${Math.floor(mtimeMs)}|${ext}|v1`).digest('hex').slice(0, 32)
  return join(dir, `${key}.jpg`)
}

function pruneCache(): void {
  const cutoff = Date.now() - CACHE_MAX_AGE_MS
  let names: string[]
  try {
    names = readdirSync(cacheDir)
  } catch {
    return
  }
  for (const name of names) {
    const file = join(cacheDir, name)
    try {
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
    } catch {
      // 单个条目清不掉不影响其它
    }
  }
}
