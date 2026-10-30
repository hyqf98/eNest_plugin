/**
 * python 家族：PATH/python3 探测 + pyenv 多版本 + win `py -0p`，pip 全局依赖与缓存清理。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { run, runVersion, which, whichAny } from '../exec'
import { configFile, dirSize, invalidateSizeCache, isMac, isWin, joinHome } from '../paths'
import type { CleanAction, ConfigFile, CustomEnv, Dep, EnvAdapter, EnvDetail, EnvInstance } from '../types'

const PYENV_VERSIONS = joinHome('.pyenv', 'versions')

function pythonBin(): { bin: string; path: string } | null {
  if (isWin) return whichAny(['python', 'py'])
  return whichAny(['python3', 'python'])
}

/** 解析 `py -0p` 输出的安装路径行。 */
function parsePyLauncher(output: string): { path: string; version: string }[] {
  const result: { path: string; version: string }[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /\s(-V\s+)?(\d+\.\d+(?:\.\d+)?)?\s*(.+?\.(?:exe|EXE))\s*(\*)?\s*$/.exec(line.trim())
    if (match && path.isAbsolute(match[3])) result.push({ path: match[3], version: match[2] ?? '' })
  }
  return result
}

export const pythonAdapter: EnvAdapter = {
  family: 'python',
  label: 'Python',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const found = pythonBin()
    if (found) {
      const version = await runVersion(found.bin, isWin && found.bin === 'py' ? '-V' : '--version')
      instances.push({ id: 'python:system', family: 'python', label: `Python (PATH · ${found.bin})`, version: version ?? undefined, binPath: found.path })
    }
    if (fs.existsSync(PYENV_VERSIONS)) {
      try {
        for (const entry of fs.readdirSync(PYENV_VERSIONS, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          instances.push({ id: `python:pyenv:${entry.name}`, family: 'python', label: `pyenv · ${entry.name}`, version: entry.name, rootPath: path.join(PYENV_VERSIONS, entry.name), note: 'pyenv 安装' })
        }
      } catch { /* unreadable */ }
    }
    if (isWin) {
      try {
        const result = await run('py', ['-0p'], { timeoutMs: 15_000 })
        for (const item of parsePyLauncher(result.stdout + result.stderr)) {
          instances.push({ id: `python:launcher:${item.path}`, family: 'python', label: `py 启动器 · ${item.version || '未知版本'}`, version: item.version || undefined, binPath: item.path, note: 'Windows py 启动器' })
        }
      } catch { /* py launcher missing */ }
    }
    for (const item of custom) {
      if (item.family === 'python') instances.push({ id: `python:custom:${item.id}`, family: 'python', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await pythonAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 Python 实例: ${id}`)
    const usage = []
    const pipCache = pipCacheDir()
    usage.push({ label: 'pip 缓存', path: pipCache, bytes: await dirSize(pipCache) })
    if (fs.existsSync(PYENV_VERSIONS)) usage.push({ label: 'pyenv versions', path: PYENV_VERSIONS, bytes: await dirSize(PYENV_VERSIONS) })
    const keyVars = [{ name: '解释器', value: instance.binPath ?? instance.rootPath ?? '—' }]
    if (process.env.PYTHONPATH) keyVars.push({ name: 'PYTHONPATH', value: process.env.PYTHONPATH })
    return { instance, diskUsage: usage, keyVars, extra: [`pip: ${which('pip') ?? which('pip3') ?? '未找到'}`, `pyenv: ${fs.existsSync(joinHome('.pyenv')) ? '已安装' : '未安装'}`] }
  },

  async listDeps(): Promise<Dep[]> {
    const python = pythonBin()
    const bin = python?.bin ?? (isWin ? 'python' : 'python3')
    const result = await run(bin, ['-m', 'pip', 'list', '--format=json'], { timeoutMs: 60_000 })
    if (!result.ok) throw new Error(`pip list 失败: ${result.stderr.trim().slice(0, 300)}`)
    let parsed: { name?: string; version?: string }[]
    try { parsed = JSON.parse(result.stdout) } catch { throw new Error('pip list 输出无法解析') }
    if (!Array.isArray(parsed)) throw new Error('pip list 输出无法解析')
    return parsed.filter(item => typeof item?.name === 'string').map(item => ({ name: item.name!, version: item.version })).sort((a, b) => a.name.localeCompare(b.name))
  },

  async removeDep(name: string) {
    const bin = pythonBin()?.bin ?? (isWin ? 'python' : 'python3')
    const result = await run(bin, ['-m', 'pip', 'uninstall', '-y', name], { timeoutMs: 180_000 })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'pip uninstall 失败' }
    return { ok: true, note: `已卸载 ${name}` }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const cacheDir = pipCacheDir()
    return [
      {
        id: 'pip-cache-purge',
        label: '清空 pip 缓存',
        description: `运行 python -m pip cache purge（缓存目录 ${cacheDir}）`,
        risk: 'safe',
        command: async () => {
          const before = await dirSize(cacheDir)
          const bin = pythonBin()?.bin ?? (isWin ? 'python' : 'python3')
          const result = await run(bin, ['-m', 'pip', 'cache', 'purge'], { timeoutMs: 180_000 })
          invalidateSizeCache(cacheDir)
          const after = await dirSize(cacheDir)
          if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'pip cache purge 失败' }
          return { ok: true, note: (result.stdout.trim() || '缓存已清空').slice(0, 200), freedBytes: Math.max(0, before - after) }
        },
        dryRun: async () => ['python -m pip cache purge', `缓存目录：${cacheDir}`, `当前占用：${(await dirSize(cacheDir)).toLocaleString()} 字节`]
      }
    ]
  },

  async configs(): Promise<ConfigFile[]> {
    return [configFile(pipConfigFileForPlatform())]
  }
}

function pipCacheDir(): string {
  if (isMac) return path.join(joinHome('Library', 'Caches', 'pip'))
  if (isWin) return path.join(process.env.LOCALAPPDATA ?? joinHome('AppData', 'Local'), 'pip', 'Cache')
  return path.join(joinHome('.cache'), 'pip')
}

function pipConfigFileForPlatform(): string {
  if (isWin) return path.join(process.env.APPDATA ?? joinHome('AppData', 'Roaming'), 'pip', 'pip.ini')
  return path.join(joinHome('.config'), 'pip', 'pip.conf')
}

// re-export for node-side reuse（configs 返回中的平台 pip 配置路径）
export { pipConfigFileForPlatform }
