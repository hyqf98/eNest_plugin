import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { currentScope } from '@backend/runtime'

export interface PluginPaths {
  data: string
  cache: string
  thumbs: string
  bing: string
  engines: string
  scripts: string
  logs: string
  downloads: string
}

let cached: PluginPaths | undefined

/**
 * 数据子目录沿用插件改名前的名字。目录里是用户已安装的引擎与导入的源脚本，
 * 跟着插件 id 改名会让它们在新名字下"消失"，所以这里是有意不改的。
 */
const DATA_DIR = 'wallpaper-house'

export function pluginPaths(): PluginPaths {
  if (cached) return cached
  const data = join(currentScope().context.appDataPath, DATA_DIR)
  cached = {
    data,
    cache: join(data, 'cache'),
    thumbs: join(data, 'cache', 'thumbs'),
    bing: join(data, 'cache', 'bing'),
    engines: join(data, 'engines'),
    scripts: join(data, 'source-scripts'),
    logs: join(data, 'logs'),
    downloads: join(data, 'cache', 'downloads'),
  }
  return cached
}

export async function ensurePluginPaths(): Promise<PluginPaths> {
  const paths = pluginPaths()
  await Promise.all([
    mkdir(paths.cache, { recursive: true }),
    mkdir(paths.thumbs, { recursive: true }),
    mkdir(paths.bing, { recursive: true }),
    mkdir(paths.engines, { recursive: true }),
    mkdir(paths.scripts, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.downloads, { recursive: true }),
  ])
  return paths
}

export function suggestedLibraryPath(): string {
  return join(homedir(), 'Pictures', 'eNest Wallpapers')
}

export type HelperTarget = 'win32-x64' | 'darwin-arm64' | 'darwin-x64' | 'linux-x64'

export function helperTarget(): HelperTarget | null {
  const target = `${process.platform}-${process.arch}`
  return target === 'win32-x64' || target === 'darwin-arm64' || target === 'darwin-x64' || target === 'linux-x64'
    ? target
    : null
}

export function helperFileName(target: HelperTarget): string {
  return target.startsWith('win32-') ? 'wallpaper-host.exe' : 'wallpaper-host'
}

export function helperPathCandidates(target: HelperTarget): string[] {
  const packagePath = currentScope().context.packagePath
  const file = helperFileName(target)
  return [
    join(packagePath, 'runtime', 'helpers', target, file),
    join(packagePath, 'helper-cache', target, file),
    join(packagePath, 'dist', 'runtime', 'helpers', target, file),
  ]
}

export function resolveExistingHelper(target: HelperTarget): string | null {
  for (const candidate of helperPathCandidates(target)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function libraryRoot(configuredPath: string | null): string | null {
  if (!configuredPath || !configuredPath.trim()) return null
  return configuredPath
}
