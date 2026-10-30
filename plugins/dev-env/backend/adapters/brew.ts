/**
 * Homebrew 包管理器（仅 macOS 注册）：formula/cask 双轨，cleanup/autoremove 清理。
 */
import { run, which } from '../exec'
import { dirSize, invalidateSizeCache } from '../paths'
import type { CleanAction, CleanResult, EnvDetail, InstallOptions, PackageManagerAdapter, PmItem } from '../types'

const PM_TIMEOUT = 600_000

let cachedPrefix: string | null = null

interface BrewJson {
  formulae?: { name: string; installed?: string[]; outdated?: boolean; versions?: { stable?: string } }[]
  casks?: { name: string; installed?: string; outdated?: boolean; version?: string }[]
}

export const brewAdapter: PackageManagerAdapter = {
  id: 'brew',
  label: 'Homebrew',

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false
    return which('brew') !== null
  },

  async prefix(): Promise<string> {
    if (cachedPrefix) return cachedPrefix
    const result = await run('brew', ['--prefix'], { timeoutMs: 30_000 })
    cachedPrefix = result.ok ? result.stdout.trim() : '/opt/homebrew'
    return cachedPrefix
  },

  async listInstalled(): Promise<PmItem[]> {
    const outdatedMap = new Map<string, boolean>()
    try {
      const outdated = await run('brew', ['outdated', '--json=v2'], { timeoutMs: 120_000 })
      if (outdated.ok) {
        const parsed = JSON.parse(outdated.stdout) as BrewJson
        for (const item of [...parsed.formulae ?? [], ...parsed.casks ?? []]) outdatedMap.set(item.name, true)
      }
    } catch { /* outdated probe best-effort */ }
    const items: PmItem[] = []
    // formula 与 cask 分两批拿，输出更小更稳
    for (const [type, flag] of [['formula', '--formula'], ['cask', '--cask']] as const) {
      try {
        const result = await run('brew', ['list', '-1', '--versions', flag], { timeoutMs: 120_000 })
        if (!result.ok) continue
        for (const line of result.stdout.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const [name, ...versions] = trimmed.split(/\s+/)
          if (!name) continue
          items.push({ name, version: versions[versions.length - 1], type, outdated: outdatedMap.get(name) || undefined })
        }
      } catch { /* cask branch may be empty */ }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name))
  },

  async search(query: string): Promise<PmItem[]> {
    const result = await run('brew', ['search', query], { timeoutMs: 60_000 })
    if (!result.ok) throw new Error(`brew search 失败: ${result.stderr.trim().slice(0, 300)}`)
    const items: PmItem[] = []
    let type = 'formula'
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (/^==>/i.test(trimmed)) { type = /cask/i.test(trimmed) ? 'cask' : 'formula'; continue }
      if (/^(homebrew|caskroom)\//.test(trimmed)) continue // tap 前缀行
      const name = trimmed.replace(/\s+\(.*\)$/, '')
      if (name) items.push({ name, type })
    }
    return items.slice(0, 60)
  },

  async install(name: string, opts: InstallOptions = {}): Promise<CleanResult> {
    const args = opts.cask ? ['install', '--cask', name] : ['install', name]
    const result = await run('brew', args, { timeoutMs: PM_TIMEOUT })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 400) || 'brew install 失败' }
    return { ok: true, note: `已安装 ${name}` }
  },

  async uninstall(name: string, opts: InstallOptions = {}): Promise<CleanResult> {
    const args = ['uninstall']
    if (opts.cask && opts.zap) args.push('--zap')
    if (opts.cask) args.push('--cask')
    args.push(name)
    const result = await run('brew', args, { timeoutMs: PM_TIMEOUT })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 400) || 'brew uninstall 失败' }
    return { ok: true, note: `已卸载 ${name}${opts.cask && opts.zap ? '（含偏好设置 zap）' : ''}` }
  },

  async upgrade(name?: string): Promise<CleanResult> {
    const args = name ? ['upgrade', name] : ['upgrade']
    const result = await run('brew', args, { timeoutMs: 1800_000 })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 400) || 'brew upgrade 失败' }
    return { ok: true, note: name ? `已升级 ${name}` : '全部可升级项已完成' }
  },

  async outdated(): Promise<PmItem[]> {
    const result = await run('brew', ['outdated', '--json=v2'], { timeoutMs: 120_000 })
    if (!result.ok) throw new Error(`brew outdated 失败: ${result.stderr.trim().slice(0, 300)}`)
    const parsed = JSON.parse(result.stdout) as BrewJson
    const items: PmItem[] = []
    for (const item of parsed.formulae ?? []) items.push({ name: item.name, version: item.installed?.[0] ?? item.versions?.stable, type: 'formula', outdated: true })
    for (const item of parsed.casks ?? []) items.push({ name: item.name, version: item.installed ?? item.version, type: 'cask', outdated: true })
    return items
  },

  async updateSource(): Promise<CleanResult> {
    const result = await run('brew', ['update'], { timeoutMs: 600_000 })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 400) || 'brew update 失败' }
    const tail = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '已是最新'
    return { ok: true, note: tail.slice(0, 200) }
  },

  async cleanActions(): Promise<CleanAction[]> {
    return [
      {
        id: 'brew-cleanup',
        label: '清理 Homebrew 旧版本与缓存',
        description: '运行 brew cleanup --prune=all（删除旧版本包与下载缓存）',
        risk: 'safe',
        command: async () => {
          const result = await run('brew', ['cleanup', '--prune=all'], { timeoutMs: 1800_000 })
          if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 400) || 'brew cleanup 失败' }
          const freed = /Freed approximately ([\d.,]+\s*[KMGT]?i?B)/i.exec(result.stdout)?.[1]
          invalidateSizeCache()
          return { ok: true, note: freed ? `释放约 ${freed}` : '清理完成' }
        },
        dryRun: async () => ['brew cleanup --prune=all（含 --dry-run 预览）', ...(await run('brew', ['cleanup', '--prune=all', '--dry-run'], { timeoutMs: 300_000 })).stdout.split(/\r?\n/).filter(Boolean).slice(0, 60)]
      },
      {
        id: 'brew-autoremove',
        label: '移除无用依赖',
        description: '运行 brew autoremove（清理不再被任何包依赖的孤立公式）',
        risk: 'cautious',
        command: async () => {
          const result = await run('brew', ['autoremove'], { timeoutMs: 1800_000 })
          if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 400) || 'brew autoremove 失败' }
          invalidateSizeCache()
          return { ok: true, note: '孤立依赖已清理' }
        },
        dryRun: async () => {
          const result = await run('brew', ['autoremove', '--dry-run'], { timeoutMs: 120_000 })
          const lines = result.stdout.split(/\r?\n/).filter(Boolean)
          return lines.length ? lines.slice(0, 60) : ['没有可自动移除的依赖']
        }
      }
    ]
  },

  async detail(): Promise<EnvDetail> {
    const instance = { id: 'pm:brew', family: 'pm', label: 'Homebrew' }
    const usage = []
    try {
      const cellar = await run('brew', ['--cellar'], { timeoutMs: 30_000 })
      if (cellar.ok && cellar.stdout.trim()) usage.push({ label: 'Cellar（已安装包）', path: cellar.stdout.trim(), bytes: await dirSize(cellar.stdout.trim()) })
      const cache = await run('brew', ['--cache'], { timeoutMs: 30_000 })
      if (cache.ok && cache.stdout.trim()) usage.push({ label: '下载缓存', path: cache.stdout.trim(), bytes: await dirSize(cache.stdout.trim()) })
      const prefix = await brewAdapter.prefix?.()
      if (prefix) usage.push({ label: 'prefix', path: prefix, bytes: await dirSize(prefix) })
    } catch { /* brew missing */ }
    return { instance, diskUsage: usage, extra: [`brew: ${which('brew') ?? '未找到'}`] }
  }
}
