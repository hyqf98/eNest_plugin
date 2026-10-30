/**
 * conda 家族：anaconda3/miniconda3 目录探测、conda info/env list、依赖与 clean --all。
 */
import * as path from 'node:path'
import { run, runVersion, which } from '../exec'
import { configFile, dirSize, invalidateSizeCache, joinHome } from '../paths'
import type { CleanAction, ConfigFile, CustomEnv, Dep, EnvAdapter, EnvDetail, EnvInstance } from '../types'

const CONDA_ROOTS = [joinHome('anaconda3'), joinHome('miniconda3'), joinHome('miniforge3')]

interface CondaInfo { root_prefix?: string; pkgs_dirs?: string[]; conda_version?: string }

async function condaInfo(): Promise<CondaInfo | null> {
  const bin = which('conda')
  if (!bin) return null
  try {
    const result = await run('conda', ['info', '--json'], { timeoutMs: 30_000 })
    if (!result.ok) return null
    return JSON.parse(result.stdout) as CondaInfo
  } catch { return null }
}

export const condaAdapter: EnvAdapter = {
  family: 'conda',
  label: 'Conda',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const info = await condaInfo()
    if (info) {
      instances.push({ id: 'conda:primary', family: 'conda', label: info.root_prefix?.includes('anaconda') ? 'Anaconda' : info.root_prefix?.includes('miniforge') ? 'Miniforge' : 'Miniconda', version: info.conda_version, binPath: which('conda') ?? undefined, rootPath: info.root_prefix })
      try {
        const envs = await run('conda', ['env', 'list'], { timeoutMs: 30_000 })
        if (envs.ok) {
          for (const line of envs.stdout.split(/\r?\n/)) {
            const match = /^([a-zA-Z0-9_.-]+)\s+\*(?:\s+(\S+))?$/.exec(line.trim())
            if (match && match[1] !== 'base') instances.push({ id: `conda:env:${match[1]}`, family: 'conda', label: `env · ${match[1]}`, rootPath: match[2] ?? path.join(info.root_prefix ?? '', 'envs', match[1]), note: 'conda 环境' })
          }
        }
      } catch { /* env list failed */ }
    }
    for (const root of CONDA_ROOTS) {
      if (!info?.root_prefix || path.resolve(root) !== path.resolve(info.root_prefix)) {
        try {
          const stat = await import('node:fs').then(fs => fs.existsSync(path.join(root, 'conda-meta')) || fs.existsSync(path.join(root, 'bin', 'conda')) || fs.existsSync(path.join(root, 'Scripts', 'conda.exe')))
          if (stat) instances.push({ id: `conda:root:${path.basename(root)}`, family: 'conda', label: path.basename(root), rootPath: root, note: '目录探测（conda 不在 PATH）' })
        } catch { /* skip */ }
      }
    }
    for (const item of custom) {
      if (item.family === 'conda') instances.push({ id: `conda:custom:${item.id}`, family: 'conda', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await condaAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 Conda 实例: ${id}`)
    const info = await condaInfo()
    const usage = []
    if (instance.rootPath) usage.push({ label: '安装根目录', path: instance.rootPath, bytes: await dirSize(instance.rootPath) })
    for (const dir of info?.pkgs_dirs ?? []) usage.push({ label: 'pkgs 缓存', path: dir, bytes: await dirSize(dir) })
    const keyVars = [{ name: 'CONDA_PREFIX', value: process.env.CONDA_PREFIX ?? '—' }]
    if (process.env.CONDA_DEFAULT_ENV) keyVars.push({ name: 'CONDA_DEFAULT_ENV', value: process.env.CONDA_DEFAULT_ENV })
    const version = instance.version ?? await runVersion('conda')
    return { instance, diskUsage: usage, keyVars, extra: version ? [`conda 版本：${version}`] : [] }
  },

  async listDeps(): Promise<Dep[]> {
    const result = await run('conda', ['list', '--json'], { timeoutMs: 120_000 })
    if (!result.ok) throw new Error(`conda list 失败: ${result.stderr.trim().slice(0, 300)}`)
    let parsed: { name?: string; version?: string; channel?: string }[]
    try { parsed = JSON.parse(result.stdout) } catch { throw new Error('conda list 输出无法解析') }
    if (!Array.isArray(parsed)) throw new Error('conda list 输出无法解析')
    return parsed.filter(item => typeof item?.name === 'string').map(item => ({ name: item.name!, version: item.version, note: item.channel && item.channel !== 'defaults' ? item.channel : undefined })).sort((a, b) => a.name.localeCompare(b.name))
  },

  async removeDep(name: string) {
    const result = await run('conda', ['remove', '-y', '-n', 'base', name], { timeoutMs: 300_000 })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'conda remove 失败' }
    return { ok: true, note: `已从 base 环境移除 ${name}` }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const info = await condaInfo()
    const dirs = info?.pkgs_dirs ?? []
    return [
      {
        id: 'conda-clean-all',
        label: '清理 conda 缓存',
        description: '运行 conda clean --all -y（索引缓存、未用包与 tarball）。注意：可能影响依赖硬链接的环境，清理后首次使用需重建缓存',
        risk: 'cautious',
        command: async () => {
          const before = await Promise.all(dirs.map(dir => dirSize(dir)))
          const result = await run('conda', ['clean', '--all', '-y'], { timeoutMs: 600_000 })
          for (const dir of dirs) invalidateSizeCache(dir)
          const after = await Promise.all(dirs.map(dir => dirSize(dir)))
          if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'conda clean 失败' }
          const freed = before.reduce((sum, value, index) => sum + Math.max(0, value - after[index]), 0)
          return { ok: true, note: 'conda 缓存已清理', freedBytes: freed }
        },
        dryRun: async () => {
          const lines = ['conda clean --all -y']
          for (const dir of dirs) lines.push(`pkgs 目录：${dir}（${(await dirSize(dir)).toLocaleString()} 字节）`)
          return lines
        }
      }
    ]
  },

  async configs(): Promise<ConfigFile[]> {
    return [configFile(joinHome('.condarc'))]
  }
}
