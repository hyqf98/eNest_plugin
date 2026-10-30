/**
 * uv 家族：PATH 探测、uv tool 全局工具清单、uv cache clean。
 */
import { run, runVersion, which } from '../exec'
import { dirSize, invalidateSizeCache, uvCacheDir, uvDataDir } from '../paths'
import type { CleanAction, CustomEnv, Dep, EnvAdapter, EnvDetail, EnvInstance } from '../types'

export const uvAdapter: EnvAdapter = {
  family: 'uv',
  label: 'uv',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const found = which('uv')
    if (found) {
      const version = await runVersion('uv')
      instances.push({ id: 'uv:system', family: 'uv', label: 'uv (PATH)', version: version ?? undefined, binPath: found })
    }
    for (const item of custom) {
      if (item.family === 'uv') instances.push({ id: `uv:custom:${item.id}`, family: 'uv', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await uvAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 uv 实例: ${id}`)
    const data = uvDataDir()
    const cache = uvCacheDir()
    const usage = [
      { label: data.label, path: data.path, bytes: await dirSize(data.path) },
      { label: cache.label, path: cache.path, bytes: await dirSize(cache.path) }
    ]
    return { instance, diskUsage: usage, keyVars: [{ name: 'uv 路径', value: instance.binPath ?? '—' }] }
  },

  async listDeps(): Promise<Dep[]> {
    const result = await run('uv', ['tool', 'list'], { timeoutMs: 60_000 })
    if (!result.ok) throw new Error(`uv tool list 失败: ${result.stderr.trim().slice(0, 300)}`)
    const deps: Dep[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      // 形如 `- name vX.Y.Z` 或 `- name v1.2.3 — note`（uv 0.9 输出 `- name vX.Y.Z`）
      const match = /^[-\s]+([a-z0-9_.@/-]+)\s+v?(\d[^\s]*)(?:\s+.*)?$/i.exec(line)
      if (match) deps.push({ name: match[1], version: match[2] })
    }
    return deps
  },

  async removeDep(name: string) {
    const result = await run('uv', ['tool', 'uninstall', name], { timeoutMs: 120_000 })
    if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'uv tool uninstall 失败' }
    return { ok: true, note: `已卸载 uv 工具 ${name}` }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const cache = uvCacheDir()
    return [
      {
        id: 'uv-cache-clean',
        label: '清空 uv 缓存',
        description: `运行 uv cache clean（缓存目录 ${cache.path}，含下载的 wheel 与编译缓存）`,
        risk: 'safe',
        command: async () => {
          const before = await dirSize(cache.path)
          const result = await run('uv', ['cache', 'clean'], { timeoutMs: 300_000 })
          invalidateSizeCache(cache.path)
          const after = await dirSize(cache.path)
          if (!result.ok) return { ok: false, note: result.stderr.trim().slice(0, 300) || 'uv cache clean 失败' }
          return { ok: true, note: 'uv 缓存已清空', freedBytes: Math.max(0, before - after) }
        },
        dryRun: async () => ['uv cache clean', `缓存目录：${cache.path}`, `当前占用：${(await dirSize(cache.path)).toLocaleString()} 字节`]
      }
    ]
  }
}
