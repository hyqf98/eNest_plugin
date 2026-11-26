/**
 * 条目表：entryId ↔ (rootId, 根内相对路径)。
 *
 * 页面只持有 entryId，后端每次用它反查路径，页面无法伪造或遍历出根目录之外的文件。
 * 表只存在进程内存里，随运行代次失效；容量有上限，超出后最旧的条目失效，
 * 页面需要时重新拉取目录即可重新签发。
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { resolveInRoot } from './roots.ts'

interface EntryRecord {
  rootId: string
  relativePath: string
  kind: 'file' | 'directory'
}

const MAX_ENTRIES = 60_000
const entries = new Map<string, EntryRecord>()

function issue(rootId: string, relativePath: string, kind: 'file' | 'directory'): string {
  if (entries.size >= MAX_ENTRIES) {
    // Map 保持插入顺序：删掉最早签发的一批，给新条目腾位置
    let dropped = 0
    for (const key of entries.keys()) {
      entries.delete(key)
      if (++dropped >= 2_000) break
    }
  }
  const entryId = randomUUID()
  entries.set(entryId, { rootId, relativePath, kind })
  return entryId
}

/** 为文件夹签发 ID。空 relativePath 表示根目录本身。 */
export function issueDirectory(rootId: string, relativePath: string): string {
  return issue(rootId, relativePath, 'directory')
}

export function issueFile(rootId: string, relativePath: string): string {
  return issue(rootId, relativePath, 'file')
}

function lookup(entryId: string): EntryRecord {
  const record = entries.get(entryId)
  if (!record) throw new Error('条目已失效，请刷新后重试')
  return record
}

/** 取条目的绝对路径（已经过根目录边界校验）；传 expected 可同时校验类型 */
export function pathOf(entryId: string, expected?: 'file' | 'directory'): string {
  const record = lookup(entryId)
  if (expected && record.kind !== expected) throw new Error(expected === 'directory' ? '目标不是文件夹' : '目标不是文件')
  return resolveInRoot(record.rootId, record.relativePath)
}

export function rootIdOf(entryId: string): string {
  return lookup(entryId).rootId
}

export function relativePathOf(entryId: string): string {
  return lookup(entryId).relativePath
}

/** 根内相对路径的父级（根目录返回空串） */
export function parentOf(relativePath: string): string {
  const parent = dirname(relativePath)
  return parent === '.' ? '' : parent
}

export function childPath(parentRelativePath: string, name: string): string {
  return parentRelativePath ? join(parentRelativePath, name) : name
}
