/**
 * winget 包管理器（仅 Windows 注册）：表格输出解析，--exact --silent 安装协议。
 */
import { run, which } from '../exec'
import type { CleanResult, EnvDetail, InstallOptions, PackageManagerAdapter, PmItem } from '../types'

const PM_TIMEOUT = 1800_000

/** winget 表格行：`Name   Id   Version   Available   Source`，列间两个以上空格。 */
function parseTable(output: string): PmItem[] {
  const items: PmItem[] = []
  const lines = output.split(/\r?\n/)
  let headerIndex = -1
  for (let index = 0; index < lines.length; index++) {
    if (/^Name\s{2,}/.test(lines[index].trim()) || /名称\s{2,}/.test(lines[index].trim())) { headerIndex = index; break }
  }
  if (headerIndex < 0) return items
  for (const line of lines.slice(headerIndex + 2)) { // 跳过分隔线
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('-')) continue
    const cells = trimmed.split(/\s{2,}/)
    if (cells.length < 2) continue
    const [name, id, version, available] = cells
    if (!id || id.includes(' ')) continue // 无 id 的装饰行
    items.push({ name, id, version: version && !/^[—-]+$/.test(version) ? version : undefined, outdated: Boolean(available && !/^[—-]+$/.test(available)) || undefined, note: available && !/^[—-]+$/.test(available) ? `可升级到 ${available}` : undefined })
  }
  return items
}

export const wingetAdapter: PackageManagerAdapter = {
  id: 'winget',
  label: 'winget',

  async available(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    return which('winget') !== null
  },

  async listInstalled(): Promise<PmItem[]> {
    const result = await run('winget', ['list', '--disable-interactivity'], { timeoutMs: 300_000 })
    if (!result.ok) throw new Error(`winget list 失败: ${result.stderr.trim().slice(0, 300)}`)
    return parseTable(result.stdout)
  },

  async search(query: string): Promise<PmItem[]> {
    const result = await run('winget', ['search', query, '--disable-interactivity'], { timeoutMs: 120_000 })
    if (!result.ok) throw new Error(`winget search 失败: ${result.stderr.trim().slice(0, 300)}`)
    return parseTable(result.stdout).slice(0, 60)
  },

  async install(name: string, opts: InstallOptions = {}): Promise<CleanResult> {
    const id = opts.exact ? name : name
    const result = await run('winget', ['install', '--id', id, '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements'], { timeoutMs: PM_TIMEOUT })
    if (!result.ok && result.code !== 0) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'winget install 失败' }
    return { ok: true, note: `已安装 ${name}` }
  },

  async uninstall(name: string): Promise<CleanResult> {
    const result = await run('winget', ['uninstall', '--id', name, '--exact', '--silent'], { timeoutMs: PM_TIMEOUT })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'winget uninstall 失败' }
    return { ok: true, note: `已卸载 ${name}` }
  },

  async upgrade(name?: string): Promise<CleanResult> {
    const args = name ? ['upgrade', '--id', name, '--exact', '--silent', '--include-unknown'] : ['upgrade', '--all', '--include-unknown', '--silent']
    const result = await run('winget', args, { timeoutMs: 3600_000 })
    if (!result.ok) return { ok: false, note: (result.stderr || result.stdout).trim().slice(0, 400) || 'winget upgrade 失败' }
    return { ok: true, note: name ? `已升级 ${name}` : '全部可升级项已完成' }
  },

  async outdated(): Promise<PmItem[]> {
    const result = await run('winget', ['upgrade', '--disable-interactivity'], { timeoutMs: 300_000 })
    if (!result.ok) throw new Error(`winget upgrade 列表失败: ${result.stderr.trim().slice(0, 300)}`)
    return parseTable(result.stdout).filter(item => item.outdated)
  },

  async detail(): Promise<EnvDetail> {
    return { instance: { id: 'pm:winget', family: 'pm', label: 'winget' }, extra: [`winget: ${which('winget') ?? '未找到'}`] }
  }
}
