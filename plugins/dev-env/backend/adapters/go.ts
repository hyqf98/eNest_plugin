/**
 * go 家族：go version 探测 + GOPATH/bin 全局工具 + go clean -modcache/-cache。
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { run, runVersion, which } from '../exec'
import { configFile, dirSize, goEnvFile, invalidateSizeCache, isWin } from '../paths'
import type { CleanAction, ConfigFile, CustomEnv, Dep, EnvAdapter, EnvDetail, EnvInstance } from '../types'

async function goEnvValue(key: string): Promise<string | null> {
  try {
    const result = await run('go', ['env', key], { timeoutMs: 20_000 })
    const value = result.stdout.trim()
    return result.ok && value && !value.startsWith('(') ? value : null
  } catch { return null }
}

export const goAdapter: EnvAdapter = {
  family: 'go',
  label: 'Go',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const found = which('go')
    if (found) {
      const version = await runVersion('go', 'version')
      instances.push({ id: 'go:system', family: 'go', label: 'Go (PATH)', version: version ?? undefined, binPath: found })
    }
    for (const item of custom) {
      if (item.family === 'go') instances.push({ id: `go:custom:${item.id}`, family: 'go', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await goAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 Go 实例: ${id}`)
    const gopath = await goEnvValue('GOPATH')
    const goroot = await goEnvValue('GOROOT')
    const gomodcache = await goEnvValue('GOMODCACHE')
    const gocache = await goEnvValue('GOCACHE')
    const usage = []
    if (gopath) usage.push({ label: 'GOPATH', path: gopath, bytes: await dirSize(gopath) })
    if (goroot) usage.push({ label: 'GOROOT', path: goroot, bytes: await dirSize(goroot) })
    if (gomodcache) usage.push({ label: '模块缓存 GOMODCACHE', path: gomodcache, bytes: await dirSize(gomodcache) })
    if (gocache) usage.push({ label: '构建缓存 GOCACHE', path: gocache, bytes: await dirSize(gocache) })
    const keyVars = [
      { name: 'GOPATH', value: gopath ?? '(未设置)' },
      { name: 'GOROOT', value: goroot ?? '(未设置)' }
    ]
    return { instance, diskUsage: usage, keyVars }
  },

  async listDeps(): Promise<Dep[]> {
    const gopath = await goEnvValue('GOPATH')
    if (!gopath) throw new Error('go env GOPATH 不可用')
    const binDir = path.join(gopath, 'bin')
    const deps: Dep[] = []
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(binDir, { withFileTypes: true }) } catch { return deps }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (isWin && !/\.(exe|bat)$/i.test(entry.name)) continue // win 只保留 .exe/.bat
      const full = path.join(binDir, entry.name)
      let size: number | undefined
      try { size = (await fsp.stat(full)).size } catch { /* racing */ }
      deps.push({ name: entry.name, note: 'GOPATH/bin 工具', size })
    }
    return deps.sort((a, b) => a.name.localeCompare(b.name))
  },

  async removeDep(name: string) {
    const gopath = await goEnvValue('GOPATH')
    if (!gopath) return { ok: false, note: 'go env GOPATH 不可用' }
    const file = path.join(gopath, 'bin', name)
    if (!fs.existsSync(file)) return { ok: false, note: `未找到 ${file}` }
    await fsp.rm(file, { force: true })
    return { ok: true, note: `已删除 ${name}` }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const gocache = await goEnvValue('GOCACHE')
    const gomodcache = await goEnvValue('GOMODCACHE')
    const actions: CleanAction[] = []
    if (gomodcache) {
      actions.push({
        id: 'go-clean-modcache',
        label: '清理 Go 模块缓存',
        description: `运行 go clean -modcache（${gomodcache}）。注意：模块缓存含只读文件，命令会先 chmod 再删除；下次构建重新下载`,
        risk: 'cautious',
        command: async () => {
          const before = await dirSize(gomodcache)
          const result = await run('go', ['clean', '-modcache'], { timeoutMs: 600_000 })
          invalidateSizeCache(gomodcache)
          const after = await dirSize(gomodcache)
          if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'go clean -modcache 失败' }
          return { ok: true, note: '模块缓存已清理', freedBytes: Math.max(0, before - after) }
        },
        dryRun: async () => ['go clean -modcache', `缓存目录：${gomodcache}`, `当前占用：${(await dirSize(gomodcache)).toLocaleString()} 字节`]
      })
    }
    if (gocache) {
      actions.push({
        id: 'go-clean-cache',
        label: '清理 Go 构建缓存',
        description: `运行 go clean -cache（${gocache}，纯构建产物，可安全重建）`,
        risk: 'safe',
        command: async () => {
          const before = await dirSize(gocache)
          const result = await run('go', ['clean', '-cache'], { timeoutMs: 300_000 })
          invalidateSizeCache(gocache)
          const after = await dirSize(gocache)
          if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'go clean -cache 失败' }
          return { ok: true, note: '构建缓存已清理', freedBytes: Math.max(0, before - after) }
        },
        dryRun: async () => ['go clean -cache', `缓存目录：${gocache}`, `当前占用：${(await dirSize(gocache)).toLocaleString()} 字节`]
      })
    }
    return actions
  },

  async configs(): Promise<ConfigFile[]> {
    return [configFile(goEnvFile())]
  }
}
