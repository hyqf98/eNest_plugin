/**
 * 磁盘与目录准备。
 */

import type { Adapter } from './adapters/types.ts'
import { BackendError } from './adapters/types.ts'
import { formatSize } from './util.ts'

/** 下载所需空间：文件大小再留一成余量（解压临时文件、分卷拼接等）。整数运算，避免浮点误差 */
export function requiredSpace(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0
  return Math.ceil(Math.round(totalBytes) * 11 / 10)
}

/** 建目录（含多级），并写一个临时文件再删除以确认可写 */
export async function ensureDir(adapter: Adapter, dir: string): Promise<void> {
  try {
    await adapter.files.ensureDir(dir)
    const probe = adapter.path.join(dir, `.gh-write-probe-${Date.now()}`)
    await adapter.files.writeFile(probe, new Uint8Array(1))
    await adapter.files.removeFile(probe)
  } catch (error) {
    throw new BackendError('DIR_NOT_WRITABLE', `无法创建或写入目录 ${dir}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 空间不足时抛 DISK_FULL；无法获取可用空间时跳过检查 */
export async function checkDiskSpace(adapter: Adapter, dir: string, neededBytes: number): Promise<void> {
  if (neededBytes <= 0) return
  let free: number | null = null
  try { free = await adapter.files.freeSpace(dir) } catch { free = null }
  if (free === null || !Number.isFinite(free)) return
  if (free < neededBytes) {
    throw new BackendError('DISK_FULL', `磁盘空间不足：需要 ${formatSize(neededBytes)}，可用 ${formatSize(free)}`)
  }
}
