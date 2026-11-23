/**
 * 解压安装：依次把安装单元（主卷）解压到输出目录。
 *
 * 7-Zip 退出码语义（源项目曾把 exit=2 也当成成功，导致损坏的包被标记为安装完成）：
 *   0 成功；1 警告（跳过了个别坏文件，关键 exe 已解出才算成功）；其余一律失败。
 *
 * WinZip 分卷（.zip + .z01…）实测 7-Zip 打不开末卷，需要先按序拼接成完整 zip 再解。
 */

import { BackendError, type Adapter } from '../adapters/types.ts'
import { KeyedMutex, isAbortError } from '../util.ts'
import { classifyArchive, continuationNames, splitName } from '../paths.ts'
import { checkDiskSpace } from '../disk.ts'
import { locateExecutable } from './locate.ts'

/** 同一个输出目录同一时刻只允许一个解压任务 */
const installLocks = new KeyedMutex()

export interface ExtractOutcome {
  /** 解压时的非致命警告（例如跳过了个别坏文件） */
  warnings: string[]
}

/**
 * 依次解压每个安装单元。units 是文件名（位于 dir 内），outputDir 是解压目标。
 * 单个 .exe 单元不解压（它本身就是可执行文件，由调用方直接使用）。
 */
export async function extractArchives(adapter: Adapter, units: string[], dir: string, outputDir: string, signal: AbortSignal, onProgress: () => void, exeRel = ''): Promise<ExtractOutcome> {
  const key = adapter.path.resolve(outputDir).toLowerCase()
  return installLocks.run(key, async () => {
    const warnings: string[] = []
    for (const unit of units) {
      if (signal.aborted) throw abortErrorOf()
      if (splitName(unit).ext === 'exe') continue
      const archive = adapter.path.join(dir, unit)
      const outcome = await extractOne(adapter, archive, dir, outputDir, signal, onProgress, exeRel)
      warnings.push(...outcome)
    }
    return { warnings }
  })
}

/** 解压一个主卷；WinZip 分卷在直接解压失败时回退为拼接后再解 */
async function extractOne(adapter: Adapter, archive: string, dir: string, outputDir: string, signal: AbortSignal, onProgress: () => void, exeRel: string): Promise<string[]> {
  try {
    return await runExtract(adapter, archive, outputDir, signal, onProgress, exeRel)
  } catch (error) {
    if (isAbortError(error) || (error as { code?: string }).code !== 'EXTRACT_FAILED') throw error
    const name = adapter.path.basename(archive)
    const info = classifyArchive(name)
    if (!info || info.family !== 'zip-split') throw error
    const volumes = await sortedContinuationVolumes(adapter, dir, name)
    if (!volumes.length) throw error
    // 回退：把 .z01…zNN 与 .zip 按序拼接成一个完整 zip（需要额外一倍分卷总大小的空间）
    const sizes = await Promise.all(volumes.concat(archive).map(async path => (await adapter.files.stat(path))?.size ?? 0))
    await checkDiskSpace(adapter, dir, sizes.reduce((sum, size) => sum + size, 0) * 1.05)
    const joined = adapter.path.join(dir, `${splitName(name).stem}.joined.zip`)
    try {
      await adapter.files.concatFiles([...volumes, archive], joined, signal)
      return await runExtract(adapter, joined, outputDir, signal, onProgress, exeRel)
    } finally {
      // 拼接文件可能有上百 GB，无论成败都必须删除
      await adapter.files.removeFile(joined).catch(() => undefined)
    }
  }
}

async function runExtract(adapter: Adapter, archive: string, outputDir: string, signal: AbortSignal, onProgress: () => void, exeRel: string): Promise<string[]> {
  await adapter.files.ensureDir(outputDir)
  const result = await adapter.archive.extract({ archive, outputDir, signal, onProgress })
  const tail = (result.tail || '').trim().split(/\r?\n/).filter(Boolean)
  const lastLine = tail[tail.length - 1] ?? ''
  if (result.exitCode === 0) return []
  if (result.exitCode === 1) {
    // 警告：仅当关键 exe 已解出才算成功
    const exe = await locateExecutable(adapter, outputDir, exeRel)
    if (exe) return [`解压时有警告：${lastLine || '个别文件未能解压'}`]
    throw new BackendError('EXTRACT_WARNING', `解压过程出错(7z警告且关键文件缺失)：${lastLine || 'exit=1'}`)
  }
  throw new BackendError('EXTRACT_FAILED', `解压失败(7z exit=${result.exitCode})：${lastLine || '未知错误'}`)
}

/** 同主干的续卷（.z01…zNN），按数字升序 */
async function sortedContinuationVolumes(adapter: Adapter, dir: string, mainVolume: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: boolean }>
  try { entries = await adapter.files.listDir(dir) } catch { return [] }
  const names = entries.filter(entry => !entry.isDirectory).map(entry => entry.name)
  return continuationNames(mainVolume, names)
    .map(name => ({ name, number: Number(splitName(name).ext.replace(/\D/g, '')) || 0 }))
    .sort((a, b) => a.number - b.number)
    .map(item => adapter.path.join(dir, item.name))
}

function abortErrorOf(): Error {
  return Object.assign(new Error('已取消'), { name: 'AbortError' })
}
