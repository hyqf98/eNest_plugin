/**
 * node 家族：PATH 探测 + nvm/fnm/volta 多版本枚举、npm 全局依赖、缓存清理与迁移。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { run, runVersion, which } from '../exec'
import { configFile, dirSize, exists, isDirectory, isWin, joinHome, npmCacheDir, winEnv, invalidateSizeCache } from '../paths'
import type { CleanAction, ConfigFile, CustomEnv, Dep, EnvAdapter, EnvDetail, EnvInstance, MigratePlan } from '../types'

const NVM_DIR = process.env.NVM_DIR && path.isAbsolute(process.env.NVM_DIR) ? process.env.NVM_DIR : joinHome('.nvm')
const FNM_DIR = isWin && winEnv('APPDATA') ? path.join(winEnv('APPDATA')!, 'fnm') : joinHome('Library', 'Application Support', 'fnm')
const VOLTA_DIR = joinHome('.volta')

function listSubDirs(root: string): string[] {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name) } catch { return [] }
}

export const nodeAdapter: EnvAdapter = {
  family: 'node',
  label: 'Node.js',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const found = which('node')
    if (found) {
      const version = await runVersion('node', '-v')
      instances.push({ id: 'node:system', family: 'node', label: 'Node (PATH)', version: version ?? undefined, binPath: found, note: `npm: ${which('npm') ?? '未找到'}` })
    }
    for (const name of listSubDirs(path.join(NVM_DIR, 'versions', 'node'))) {
      instances.push({ id: `node:nvm:${name}`, family: 'node', label: `nvm · ${name}`, version: name, rootPath: path.join(NVM_DIR, 'versions', 'node', name), note: 'nvm 安装' })
    }
    if (isDirectory(FNM_DIR)) {
      for (const name of listSubDirs(path.join(FNM_DIR, 'node-versions'))) {
        instances.push({ id: `node:fnm:${name}`, family: 'node', label: `fnm · ${name}`, version: name, rootPath: path.join(FNM_DIR, 'node-versions', name), note: 'fnm 安装' })
      }
    }
    if (isDirectory(VOLTA_DIR)) {
      for (const name of listSubDirs(path.join(VOLTA_DIR, 'tools', 'image', 'node'))) {
        instances.push({ id: `node:volta:${name}`, family: 'node', label: `volta · ${name}`, version: name, rootPath: path.join(VOLTA_DIR, 'tools', 'image', 'node', name), note: 'volta 安装' })
      }
    }
    for (const item of custom) {
      if (item.family === 'node') instances.push({ id: `node:custom:${item.id}`, family: 'node', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await nodeAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 Node 实例: ${id}`)
    const usage = []
    const cache = npmCacheDir()
    usage.push({ label: cache.label, path: cache.path, bytes: await dirSize(cache.path) })
    const globalRoot = await npmGlobalRoot()
    if (globalRoot) usage.push({ label: '全局包', path: globalRoot, bytes: await dirSize(globalRoot) })
    for (const dir of [NVM_DIR, FNM_DIR, VOLTA_DIR]) {
      if (isDirectory(dir)) usage.push({ label: path.basename(dir), path: dir, bytes: await dirSize(dir) })
    }
    const keyVars = [{ name: 'node 路径', value: instance.binPath ?? instance.rootPath ?? '—' }]
    if (process.env.NODE_OPTIONS) keyVars.push({ name: 'NODE_OPTIONS', value: process.env.NODE_OPTIONS })
    return { instance, diskUsage: usage, keyVars, extra: [`npm: ${which('npm') ?? '未找到'}`] }
  },

  async listDeps(): Promise<Dep[]> {
    const result = await run('npm', ['ls', '-g', '--depth=0', '--json'], { timeoutMs: 60_000 })
    if (!result.ok) throw new Error(`npm ls 失败: ${result.stderr.trim().slice(0, 300)}`)
    let parsed: { dependencies?: Record<string, { version?: string; resolved?: string }> }
    try { parsed = JSON.parse(result.stdout) } catch { throw new Error('npm ls 输出无法解析') }
    const deps: Dep[] = []
    for (const [name, info] of Object.entries(parsed.dependencies ?? {})) {
      deps.push({ name, version: typeof info?.version === 'string' ? info.version : undefined, note: info?.resolved?.startsWith('file:') ? '本地链接' : undefined })
    }
    return deps.sort((a, b) => a.name.localeCompare(b.name))
  },

  async removeDep(name: string) {
    const result = await run('npm', ['uninstall', '-g', name], { timeoutMs: 120_000 })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'npm uninstall 失败' }
    invalidateSizeCache()
    return { ok: true, note: `已卸载全局包 ${name}` }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const cache = npmCacheDir()
    return [
      {
        id: 'npm-cache-verify',
        label: '校验并整理 npm 缓存',
        description: `运行 npm cache verify，清理缓存目录中的悬空数据（${cache.path}）`,
        risk: 'safe',
        command: async () => {
          const before = await dirSize(cache.path)
          const result = await run('npm', ['cache', 'verify'], { timeoutMs: 300_000 })
          invalidateSizeCache(cache.path)
          const after = await dirSize(cache.path)
          if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'npm cache verify 失败' }
          return { ok: true, note: (result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '缓存已校验').slice(0, 200), freedBytes: Math.max(0, before - after) }
        },
        dryRun: async () => [`npm cache verify`, `缓存目录：${cache.path}`, `当前占用：${(await dirSize(cache.path)).toLocaleString()} 字节`]
      }
    ]
  },

  async configs(): Promise<ConfigFile[]> {
    const files = [configFile(joinHome('.npmrc'))]
    try {
      const result = await run('npm', ['config', 'get', 'globalconfig'], { timeoutMs: 15_000 })
      if (result.ok && result.stdout.trim()) files.push(configFile(result.stdout.trim()))
    } catch { /* npm missing */ }
    return files
  },

  async migrate(id: string, target: string): Promise<MigratePlan> {
    const cache = npmCacheDir()
    const bytes = await dirSize(cache.path)
    const npmrc = joinHome('.npmrc')
    const current = await readNpmCacheSetting(npmrc)
    return {
      steps: [
        `创建目标目录 ${target}`,
        ...(current === null ? ['写入 .npmrc 的 cache= 配置'] : ['更新 .npmrc 的 cache= 配置']),
        `复制缓存数据（${(bytes / 1024 / 1024).toFixed(1)} MB）并校验`,
        '删除旧缓存目录'
      ],
      configChanges: [{ file: npmrc, from: current ?? '(未设置，npm 默认)', to: `cache=${target}` }],
      dataBytes: bytes
    }
  }
}

async function npmGlobalRoot(): Promise<string | null> {
  try {
    const result = await run('npm', ['root', '-g'], { timeoutMs: 15_000 })
    const value = result.stdout.trim()
    return result.ok && value && path.isAbsolute(value) ? value : null
  } catch { return null }
}

async function readNpmCacheSetting(npmrc: string): Promise<string | null> {
  try {
    const text = fs.readFileSync(npmrc, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*cache\s*=\s*(.+)\s*$/.exec(line)
      if (match) return match[1]
    }
  } catch { /* no npmrc */ }
  return null
}

/** node 家族导出的迁移执行（index.ts task 调用）：改 .npmrc + 可选搬数据。 */
export async function migrateNodeCache(target: string, moveDataFlag: boolean): Promise<{ ok: boolean; note?: string }> {
  if (!path.isAbsolute(target)) throw new Error('目标必须是绝对路径')
  const cache = npmCacheDir()
  const npmrc = joinHome('.npmrc')
  if (moveDataFlag && exists(cache.path)) {
    const { ensureTargetDir, moveData } = await import('../migrate')
    await ensureTargetDir(target)
    await moveData(cache.path, target)
  } else if (!exists(target)) {
    const fsp = await import('node:fs/promises')
    await fsp.mkdir(target, { recursive: true })
  }
  const fsp = await import('node:fs/promises')
  const current = await readNpmCacheSetting(npmrc)
  const lines = exists(npmrc) ? (await fsp.readFile(npmrc, 'utf8')).split(/\r?\n/) : []
  const next = lines.filter(line => line.trim() && !/^\s*cache\s*=/.test(line))
  next.push(`cache=${target}`)
  await fsp.writeFile(npmrc, next.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', 'utf8')
  invalidateSizeCache(cache.path)
  invalidateSizeCache(target)
  return { ok: true, note: `npm 缓存已指向 ${target}${current ? `（原 ${current}）` : ''}${moveDataFlag ? '，数据已迁移' : ''}` }
}
