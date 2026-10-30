/**
 * chocolatey 包管理器（仅 Windows 注册，可用则展示）：-r 机器可读输出。
 */
import { run, which } from '../exec'
import type { CleanResult, EnvDetail, PackageManagerAdapter, PmItem } from '../types'

const PM_TIMEOUT = 3600_000

function chocoBin(): string | null { return which('choco') ?? which('choco.exe') }

/** choco list -r 输出行：`name|version`。 */
function parsePipeLines(output: string): PmItem[] {
  const items: PmItem[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-zA-Z0-9_.-]+)\|([^|]+)$/.exec(line.trim())
    if (match) items.push({ name: match[1], version: match[2] })
  }
  return items
}

export const chocoAdapter: PackageManagerAdapter = {
  id: 'choco',
  label: 'Chocolatey',

  async available(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    return chocoBin() !== null
  },

  async listInstalled(): Promise<PmItem[]> {
    const result = await run(chocoBin()!, ['list', '-r'], { timeoutMs: 300_000 })
    if (!result.ok) throw new Error(`choco list 失败: ${result.stderr.trim().slice(0, 300)}`)
    return parsePipeLines(result.stdout)
  },

  async search(query: string): Promise<PmItem[]> {
    const result = await run(chocoBin()!, ['search', query, '-r'], { timeoutMs: 120_000 })
    if (!result.ok) throw new Error(`choco search 失败: ${result.stderr.trim().slice(0, 300)}`)
    return parsePipeLines(result.stdout).slice(0, 60)
  },

  async install(name: string): Promise<CleanResult> {
    const result = await run(chocoBin()!, ['install', name, '-y'], { timeoutMs: PM_TIMEOUT })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'choco install 失败' }
    return { ok: true, note: `已安装 ${name}` }
  },

  async uninstall(name: string): Promise<CleanResult> {
    const result = await run(chocoBin()!, ['uninstall', name, '-y'], { timeoutMs: PM_TIMEOUT })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'choco uninstall 失败' }
    return { ok: true, note: `已卸载 ${name}` }
  },

  async upgrade(name?: string): Promise<CleanResult> {
    const args = name ? ['upgrade', name, '-y'] : ['upgrade', 'all', '-y']
    const result = await run(chocoBin()!, args, { timeoutMs: 3600_000 })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'choco upgrade 失败' }
    return { ok: true, note: name ? `已升级 ${name}` : '全部包已升级' }
  },

  async outdated(): Promise<PmItem[]> {
    const result = await run(chocoBin()!, ['outdated', '-r'], { timeoutMs: 300_000 })
    if (!result.ok) throw new Error(`choco outdated 失败: ${result.stderr.trim().slice(0, 300)}`)
    // 行格式 `name|current|available|...`
    const items: PmItem[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const cells = line.trim().split('|')
      if (cells.length >= 3 && cells[0]) items.push({ name: cells[0], version: cells[1], outdated: true, note: `可升级到 ${cells[2]}` })
    }
    return items
  },

  async detail(): Promise<EnvDetail> {
    return { instance: { id: 'pm:choco', family: 'pm', label: 'Chocolatey' }, extra: [`choco: ${chocoBin() ?? '未找到'}`] }
  }
}
