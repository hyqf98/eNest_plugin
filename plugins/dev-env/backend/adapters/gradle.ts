/**
 * gradle 家族：gradle -v 探测 + ~/.gradle 占用分析 + caches/wrapper 清理。
 * 迁移只能提示用户设置 GRADLE_USER_HOME 环境变量（env-vars 插件职责），数据照搬。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { run, which } from '../exec'
import { configFile, dirSize, gradleHome, invalidateSizeCache, joinHome } from '../paths'
import { ensureTargetDir, moveData } from '../migrate'
import type { CleanAction, ConfigFile, CustomEnv, EnvAdapter, EnvDetail, EnvInstance, MigratePlan } from '../types'

const SDKMAN_GRADLE = joinHome('.sdkman', 'candidates', 'gradle')

async function gradleVersion(): Promise<string | null> {
  const bin = which('gradle')
  if (!bin) return null
  try {
    const result = await run('gradle', ['-v'], { timeoutMs: 90_000 })
    if (!result.ok) return null
    return /^Gradle\s+(\S+)/m.exec(result.combined)?.[1] ?? null
  } catch { return null }
}

export const gradleAdapter: EnvAdapter = {
  family: 'gradle',
  label: 'Gradle',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const version = await gradleVersion()
    if (version) instances.push({ id: 'gradle:system', family: 'gradle', label: 'Gradle (PATH)', version, binPath: which('gradle') ?? undefined })
    if (fs.existsSync(SDKMAN_GRADLE)) {
      try {
        for (const entry of fs.readdirSync(SDKMAN_GRADLE, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'current') continue
          instances.push({ id: `gradle:sdkman:${entry.name}`, family: 'gradle', label: `sdkman · ${entry.name}`, version: entry.name, rootPath: path.join(SDKMAN_GRADLE, entry.name), note: 'sdkman 安装' })
        }
      } catch { /* unreadable */ }
    }
    const home = gradleHome()
    if (!version && fs.existsSync(home)) instances.push({ id: 'gradle:home-only', family: 'gradle', label: 'Gradle 用户目录（gradle 未安装）', rootPath: home, note: '仅探测到 ~/.gradle' })
    for (const item of custom) {
      if (item.family === 'gradle') instances.push({ id: `gradle:custom:${item.id}`, family: 'gradle', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await gradleAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 Gradle 实例: ${id}`)
    const home = gradleHome()
    const usage = [{ label: '~/.gradle 总占用', path: home, bytes: await dirSize(home) }]
    for (const part of ['caches', 'wrapper', 'daemon']) {
      const dir = path.join(home, part)
      if (fs.existsSync(dir)) usage.push({ label: part, path: dir, bytes: await dirSize(dir) })
    }
    return { instance, diskUsage: usage, keyVars: [{ name: 'GRADLE_USER_HOME', value: process.env.GRADLE_USER_HOME ?? '(未设置，默认 ~/.gradle)' }] }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const home = gradleHome()
    const cachesModules = path.join(home, 'caches', 'modules-2')
    const dists = path.join(home, 'wrapper', 'dists')
    const actions: CleanAction[] = []
    if (fs.existsSync(cachesModules)) {
      actions.push({
        id: 'gradle-modules2',
        label: '清理依赖缓存 modules-2',
        description: `删除 ${cachesModules}（依赖缓存，下次构建自动重新下载）`,
        risk: 'safe',
        command: async () => {
          const bytes = await dirSize(cachesModules)
          await fs.promises.rm(cachesModules, { recursive: true, force: true })
          invalidateSizeCache(cachesModules)
          return { ok: true, note: 'modules-2 已删除，下次构建将重新下载依赖', freedBytes: bytes }
        },
        dryRun: async () => [`将删除目录 ${cachesModules}`, `当前占用：${(await dirSize(cachesModules)).toLocaleString()} 字节`]
      })
    }
    if (fs.existsSync(dists)) {
      actions.push({
        id: 'gradle-old-dists',
        label: '清理旧版本 Gradle 发行版',
        description: `删除 ${dists} 下非最新版本的 wrapper 发行版（保留每个大版本目录中最新的一个）`,
        risk: 'cautious',
        command: async () => {
          let bytes = 0
          const groups = new Map<string, string[]>()
          try {
            for (const entry of fs.readdirSync(dists, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue
              // 目录名形如 gradle-9.5.1-bin/<hash>；按大版本分组取字典序最大保留
              const match = /^(gradle-[\d.]+?)-[a-z]+$/i.exec(entry.name)
              const major = match ? match[1] : entry.name
              groups.set(major, [...(groups.get(major) ?? []), entry.name])
            }
            for (const [major, names] of groups) {
              if (names.length < 2) continue
              const sorted = names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
              for (const name of sorted.slice(0, -1)) {
                const dir = path.join(dists, name)
                bytes += await dirSize(dir)
                await fs.promises.rm(dir, { recursive: true, force: true })
              }
            }
          } catch (error) { return { ok: false, note: String(error) } }
          invalidateSizeCache(dists)
          return { ok: true, note: '旧版本发行版已清理', freedBytes: bytes }
        },
        dryRun: async () => {
          const lines: string[] = []
          try {
            for (const entry of fs.readdirSync(dists, { withFileTypes: true })) {
              if (entry.isDirectory()) lines.push(`${path.join(dists, entry.name)}（${(await dirSize(path.join(dists, entry.name))).toLocaleString()} 字节）`)
            }
          } catch { /* unreadable */ }
          return lines.length ? ['dists 目录内容（保留每组最新）：', ...lines.slice(0, 50)] : ['没有可清理的发行版']
        }
      })
    }
    return actions
  },

  async configs(): Promise<ConfigFile[]> {
    return [configFile(path.join(gradleHome(), 'gradle.properties'))]
  },

  async migrate(id: string, target: string): Promise<MigratePlan> {
    const home = gradleHome()
    const bytes = await dirSize(home)
    return {
      steps: [`创建目标目录 ${target}`, `复制 Gradle 用户目录数据（${(bytes / 1024 / 1024).toFixed(1)} MB）并校验`, '删除旧目录', '⚠️ 需要你手动设置 GRADLE_USER_HOME 环境变量指向新目录'],
      configChanges: [{ file: '(环境变量)', from: process.env.GRADLE_USER_HOME ?? '(未设置)', to: `GRADLE_USER_HOME=${target}`, manual: true }],
      dataBytes: bytes
    }
  }
}

/** gradle 迁移执行：数据照搬 + 环境变量由用户手动设置（插件不写系统环境变量）。 */
export async function migrateGradleHome(target: string, moveDataFlag: boolean): Promise<{ ok: boolean; note?: string }> {
  if (!path.isAbsolute(target)) throw new Error('目标必须是绝对路径')
  const home = gradleHome()
  if (moveDataFlag && fs.existsSync(home)) {
    await ensureTargetDir(target)
    await moveData(home, target)
  } else if (!fs.existsSync(target)) {
    const fsp = await import('node:fs/promises')
    await fsp.mkdir(target, { recursive: true })
  }
  invalidateSizeCache(home)
  invalidateSizeCache(target)
  return { ok: true, note: `数据已${moveDataFlag ? '迁移' : '准备'}到 ${target}；请在系统环境变量中设置 GRADLE_USER_HOME=${target}（本插件不代改环境变量）` }
}
