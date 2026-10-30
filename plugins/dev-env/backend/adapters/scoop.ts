/**
 * scoop 包管理器（仅 Windows 注册）：scoop.cmd 调用，list/search/update/cleanup。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { run, which } from '../exec'
import { configFile, dirSize, invalidateSizeCache, joinHome } from '../paths'
import type { CleanAction, CleanResult, ConfigFile, EnvDetail, InstallOptions, PackageManagerAdapter, PmItem } from '../types'

const PM_TIMEOUT = 1800_000

function scoopBin(): string | null { return which('scoop.cmd') ?? which('scoop') }

/** scoop list 表格行：`name version updated info`（新版本为表头 + 空格列）。 */
function parseScoopTable(output: string): PmItem[] {
  const items: PmItem[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^[-─]+$/.test(trimmed) || /^Name\s+/i.test(trimmed)) continue
    const cells = trimmed.split(/\s{2,}/)
    if (cells.length < 2) continue
    const name = cells[0]
    const version = cells[1]
    if (!name || !version || version.includes(' ')) continue
    const failed = /failed/i.test(cells[cells.length - 1])
    items.push({ name, version: /^[0-9]/.test(version) ? version : undefined, note: failed ? '安装失败残留' : undefined })
  }
  return items
}

export const scoopAdapter: PackageManagerAdapter = {
  id: 'scoop',
  label: 'Scoop',

  async available(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    return scoopBin() !== null
  },

  async listInstalled(): Promise<PmItem[]> {
    const result = await run(scoopBin()!, ['list'], { timeoutMs: 300_000 })
    if (!result.ok) throw new Error(`scoop list 失败: ${result.stderr.trim().slice(0, 300)}`)
    return parseScoopTable(result.stdout)
  },

  async search(query: string): Promise<PmItem[]> {
    const result = await run(scoopBin()!, ['search', query], { timeoutMs: 120_000 })
    if (!result.ok) throw new Error(`scoop search 失败: ${result.stderr.trim().slice(0, 300)}`)
    return parseScoopTable(result.stdout).slice(0, 60)
  },

  async install(name: string): Promise<CleanResult> {
    const result = await run(scoopBin()!, ['install', name], { timeoutMs: PM_TIMEOUT })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'scoop install 失败' }
    return { ok: true, note: `已安装 ${name}` }
  },

  async uninstall(name: string, opts: InstallOptions = {}): Promise<CleanResult> {
    const args = ['uninstall', name]
    if (opts.purge) args.push('--purge')
    const result = await run(scoopBin()!, args, { timeoutMs: PM_TIMEOUT })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'scoop uninstall 失败' }
    return { ok: true, note: `已卸载 ${name}${opts.purge ? '（--purge 清除配置）' : ''}` }
  },

  async upgrade(name?: string): Promise<CleanResult> {
    const args = name ? ['update', name] : ['update', '*']
    const result = await run(scoopBin()!, args, { timeoutMs: 3600_000 })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'scoop update 失败' }
    return { ok: true, note: name ? `已升级 ${name}` : '全部应用已升级' }
  },

  async outdated(): Promise<PmItem[]> {
    const result = await run(scoopBin()!, ['status'], { timeoutMs: 300_000 })
    if (!result.ok) throw new Error(`scoop status 失败: ${result.stderr.trim().slice(0, 300)}`)
    const items: PmItem[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      // 形如 `name    1.2.3    1.4.0    available` 或含 * 前缀
      const match = /^\*?\s*([a-z0-9_.-]+)\s+([\d.]+)\s+([\d.]+)\s+/i.exec(line.trim())
      if (match) items.push({ name: match[1], version: match[2], outdated: true, note: `可升级到 ${match[3]}` })
    }
    return items
  },

  async updateSource(): Promise<CleanResult> {
    const result = await run(scoopBin()!, ['update'], { timeoutMs: 600_000 })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'scoop update 失败' }
    return { ok: true, note: 'bucket 源已更新' }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const cacheDir = path.join(joinHome('AppData', 'Local'), 'Scoop', 'cache')
    return [
      {
        id: 'scoop-cleanup',
        label: '清理 scoop 旧版本',
        description: '运行 scoop cleanup *（移除所有应用的旧版本）',
        risk: 'safe',
        command: async () => {
          const result = await run(scoopBin()!, ['cleanup', '*'], { timeoutMs: 1800_000 })
          if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'scoop cleanup 失败' }
          invalidateSizeCache()
          return { ok: true, note: '旧版本已清理' }
        },
        dryRun: async () => ['scoop cleanup *', ...(await run(scoopBin()!, ['cleanup', '*', '--dry-run'], { timeoutMs: 300_000 })).stdout.split(/\r?\n/).filter(Boolean).slice(0, 50)]
      },
      {
        id: 'scoop-cache-rm',
        label: '清空 scoop 下载缓存',
        description: `运行 scoop cache rm *（安装包缓存目录 ${cacheDir}）`,
        risk: 'safe',
        command: async () => {
          const before = await dirSize(cacheDir)
          const result = await run(scoopBin()!, ['cache', 'rm', '*'], { timeoutMs: 600_000 })
          invalidateSizeCache(cacheDir)
          const after = await dirSize(cacheDir)
          if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'scoop cache rm 失败' }
          return { ok: true, note: '下载缓存已清空', freedBytes: Math.max(0, before - after) }
        },
        dryRun: async () => [`scoop cache rm *`, `缓存目录：${cacheDir}`, `当前占用：${(await dirSize(cacheDir)).toLocaleString()} 字节`]
      }
    ]
  },

  async detail(): Promise<EnvDetail> {
    const instance = { id: 'pm:scoop', family: 'pm', label: 'Scoop' }
    const usage = []
    const scoopHome = process.env.SCOOP && path.isAbsolute(process.env.SCOOP) ? process.env.SCOOP : joinHome('scoop')
    if (fs.existsSync(scoopHome)) usage.push({ label: 'Scoop 目录', path: scoopHome, bytes: await dirSize(scoopHome) })
    const cacheDir = path.join(joinHome('AppData', 'Local'), 'Scoop', 'cache')
    if (fs.existsSync(cacheDir)) usage.push({ label: '下载缓存', path: cacheDir, bytes: await dirSize(cacheDir) })
    return { instance, diskUsage: usage, extra: [`scoop: ${scoopBin() ?? '未找到'}`] }
  },

  async configs(): Promise<ConfigFile[]> {
    return [configFile(joinHome('.config', 'scoop', 'config.json'))]
  }
} as PackageManagerAdapter & { configs?(): Promise<ConfigFile[]> }
