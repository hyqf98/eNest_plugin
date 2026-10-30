/**
 * maven 家族：mvn -v 探测 + ~/.m2 仓库占用 + settings.xml localRepository 迁移。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { run, which } from '../exec'
import { configFile, dirSize, invalidateSizeCache, isWin, joinHome } from '../paths'
import { ensureTargetDir, moveData } from '../migrate'
import type { CleanAction, ConfigFile, CustomEnv, EnvAdapter, EnvDetail, EnvInstance, MigratePlan } from '../types'

const M2 = joinHome('.m2')
const SDKMAN_MAVEN = joinHome('.sdkman', 'candidates', 'maven')
const SETTINGS_XML = path.join(M2, 'settings.xml')
const REPOSITORY = path.join(M2, 'repository')

interface MavenVersion { maven: string; javaHome: string; mavenHome: string }

async function mavenVersion(): Promise<MavenVersion | null> {
  const bin = which('mvn')
  if (!bin) return null
  try {
    const result = await run('mvn', ['-v'], { timeoutMs: 60_000 })
    if (!result.ok) return null
    const text = result.combined
    const maven = /Apache Maven\s+(\S+)/.exec(text)?.[1]
    const javaHome = /Java home:\s+(\S+)/.exec(text)?.[1]
    const mavenHome = /Maven home:\s+(\S+)/.exec(text)?.[1]
    if (!maven) return null
    return { maven, javaHome: javaHome ?? '', mavenHome: mavenHome ?? '' }
  } catch { return null }
}

/** 从 settings.xml 提取 <localRepository>。 */
function readLocalRepository(): string | null {
  try {
    const text = fs.readFileSync(SETTINGS_XML, 'utf8')
    const match = /<localRepository>\s*([^<]+?)\s*<\/localRepository>/.exec(text)
    return match ? match[1] : null
  } catch { return null }
}

export const mavenAdapter: EnvAdapter = {
  family: 'maven',
  label: 'Maven',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const version = await mavenVersion()
    if (version) instances.push({ id: 'maven:system', family: 'maven', label: 'Maven (PATH)', version: version.maven, binPath: which('mvn') ?? undefined, note: version.mavenHome ? `Maven home: ${version.mavenHome}` : undefined })
    if (fs.existsSync(SDKMAN_MAVEN)) {
      try {
        for (const entry of fs.readdirSync(SDKMAN_MAVEN, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'current') continue
          instances.push({ id: `maven:sdkman:${entry.name}`, family: 'maven', label: `sdkman · ${entry.name}`, version: entry.name, rootPath: path.join(SDKMAN_MAVEN, entry.name), note: 'sdkman 安装' })
        }
      } catch { /* unreadable */ }
    }
    if (!version && fs.existsSync(REPOSITORY)) instances.push({ id: 'maven:repo-only', family: 'maven', label: '本地仓库（mvn 未安装）', rootPath: M2, note: '仅探测到 ~/.m2' })
    for (const item of custom) {
      if (item.family === 'maven') instances.push({ id: `maven:custom:${item.id}`, family: 'maven', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await mavenAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 Maven 实例: ${id}`)
    const repo = readLocalRepository() ?? REPOSITORY
    const usage = [{ label: '本地仓库', path: repo, bytes: await dirSize(repo) }]
    const version = await mavenVersion()
    const keyVars = [{ name: 'settings.xml', value: SETTINGS_XML }, { name: 'localRepository', value: readLocalRepository() ?? '(默认 ~/.m2/repository)' }]
    return {
      instance, diskUsage: usage, keyVars,
      extra: [version?.javaHome ? `Java home: ${version.javaHome}` : 'mvn -v 未运行', '清理历史测试失败缓存的 *.lastUpdated 文件可用「清理」页']
    }
  },

  async cleanActions(): Promise<CleanAction[]> {
    const repo = readLocalRepository() ?? REPOSITORY
    return [
      {
        id: 'maven-lastupdated',
        label: '清理依赖下载失败缓存',
        description: `删除 ${repo} 下 *.lastUpdated 与 *m2e-lastUpdated.properties（拉取失败残留，可安全重建）`,
        risk: 'safe',
        command: async () => {
          let removed = 0
          let bytes = 0
          const walk = (dir: string) => {
            let entries: fs.Dirent[]
            try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
            for (const entry of entries) {
              const full = path.join(dir, entry.name)
              if (entry.isDirectory()) walk(full)
              else if (entry.isFile() && /\.lastUpdated$|m2e-lastUpdated\.properties$/.test(entry.name)) {
                try { bytes += fs.statSync(full).size; fs.rmSync(full, { force: true }); removed++ } catch { /* racing */ }
              }
            }
          }
          walk(repo)
          invalidateSizeCache(repo)
          return { ok: true, note: `已删除 ${removed} 个失败缓存文件`, freedBytes: bytes }
        },
        dryRun: async () => {
          const lines: string[] = []
          const walk = (dir: string, depth: number) => {
            if (depth > 6 || lines.length > 200) return
            let entries: fs.Dirent[]
            try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
            for (const entry of entries) {
              const full = path.join(dir, entry.name)
              if (entry.isDirectory()) walk(full, depth + 1)
              else if (entry.isFile() && /\.lastUpdated$|m2e-lastUpdated\.properties$/.test(entry.name)) lines.push(`将删除 ${full}`)
            }
          }
          walk(repo, 0)
          return lines.length ? lines.slice(0, 200) : ['没有发现 *.lastUpdated 残留文件']
        }
      }
    ]
  },

  async configs(): Promise<ConfigFile[]> {
    return [configFile(SETTINGS_XML)]
  },

  async migrate(id: string, target: string): Promise<MigratePlan> {
    const repo = readLocalRepository() ?? REPOSITORY
    const bytes = await dirSize(repo)
    const current = readLocalRepository()
    return {
      steps: [`创建目标目录 ${target}`, current ? '更新 settings.xml 的 <localRepository>' : '在 settings.xml 写入 <localRepository>', `复制仓库数据（${(bytes / 1024 / 1024).toFixed(1)} MB）并校验`, '删除旧仓库目录'],
      configChanges: [{ file: SETTINGS_XML, from: current ?? '(默认 ~/.m2/repository)', to: `<localRepository>${target}</localRepository>` }],
      dataBytes: bytes
    }
  }
}

/** maven 迁移执行：改 settings.xml localRepository + 可选搬仓库。 */
export async function migrateMavenRepo(target: string, moveDataFlag: boolean): Promise<{ ok: boolean; note?: string }> {
  if (!path.isAbsolute(target)) throw new Error('目标必须是绝对路径')
  const repo = readLocalRepository() ?? REPOSITORY
  if (moveDataFlag && fs.existsSync(repo)) {
    await ensureTargetDir(target)
    await moveData(repo, target)
  } else if (!fs.existsSync(target)) {
    const fsp = await import('node:fs/promises')
    await fsp.mkdir(target, { recursive: true })
  }
  // settings.xml：没有则创建最小骨架；有则替换/插入 localRepository。
  const fsp = await import('node:fs/promises')
  if (!fs.existsSync(M2)) await fsp.mkdir(M2, { recursive: true })
  let text = ''
  if (fs.existsSync(SETTINGS_XML)) {
    text = await fsp.readFile(SETTINGS_XML, 'utf8')
    const inline = /<localRepository>\s*[^<]+?\s*<\/localRepository>/.exec(text)
    if (inline) text = text.replace(inline[0], `<localRepository>${target}</localRepository>`)
    else text = text.replace(/<settings(\s[^>]*)?>/, `<settings$1>\n  <localRepository>${target}</localRepository>`)
  } else {
    text = `<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">\n  <localRepository>${target}</localRepository>\n</settings>\n`
  }
  await fsp.writeFile(SETTINGS_XML, text, 'utf8')
  invalidateSizeCache(repo)
  invalidateSizeCache(target)
  return { ok: true, note: `Maven 本地仓库已指向 ${target}${moveDataFlag ? '，数据已迁移' : ''}` }
}
