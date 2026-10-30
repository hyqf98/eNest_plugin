/**
 * 公共迁移执行器：数据目录搬迁（复制 → 校验 → 删除旧目录），供各家族 migrateRun 使用。
 */
import * as fsp from 'node:fs/promises'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { dirSize, isDirectory } from './paths'

export interface CopyProgress { label: string }

/** 递归复制目录（普通文件与目录；符号链接按目标内容复制）。 */
export async function copyTree(from: string, to: string): Promise<void> {
  await fsp.mkdir(to, { recursive: true })
  const entries = await fsp.readdir(from, { withFileTypes: true })
  const BATCH = 64
  for (let index = 0; index < entries.length; index += BATCH) {
    const slice = entries.slice(index, index + BATCH)
    await Promise.all(slice.map(async entry => {
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      if (entry.isDirectory()) await copyTree(source, target)
      else if (entry.isFile()) await fsp.copyFile(source, target)
      else {
        try {
          const stat = await fsp.stat(source) // follows symlink
          if (stat.isDirectory()) await copyTree(source, target)
          else if (stat.isFile()) await fsp.copyFile(source, target)
        } catch { /* dangling link: skip */ }
      }
    }))
  }
}

/** 迁移数据：复制 → 大小校验（目标 ≥ 源字节数的 95%）→ 删除旧目录。 */
export async function moveData(from: string, to: string): Promise<void> {
  if (!isDirectory(from)) throw new Error(`源目录不存在: ${from}`)
  const before = await dirSize(from)
  await copyTree(from, to)
  const after = await dirSize(to)
  if (after < before * 0.95) throw new Error(`迁移校验失败：目标 ${after} 字节 < 源 ${before} 字节的 95%，已保留旧目录 ${from}`)
  await fsp.rm(from, { recursive: true, force: true })
}

/** 校验目标目录可用（不存在则创建空目录）。 */
export async function ensureTargetDir(target: string): Promise<void> {
  if (!path.isAbsolute(target)) throw new Error('目标必须是绝对路径')
  if (fs.existsSync(target)) {
    if (!isDirectory(target)) throw new Error(`目标已存在且不是目录: ${target}`)
    const entries = await fsp.readdir(target)
    if (entries.length > 0) throw new Error(`目标目录非空: ${target}（请换一个空目录）`)
  } else {
    await fsp.mkdir(target, { recursive: true })
  }
}
