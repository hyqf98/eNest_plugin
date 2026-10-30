/**
 * java 家族：java_home -V（mac）/ JAVA_HOME / sdkman / where java（win）。
 * 只展示；JAVA_HOME 修改属于环境变量插件职责。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { run, runVersion, which } from '../exec'
import { dirSize, isMac, isWin, joinHome } from '../paths'
import type { CustomEnv, EnvAdapter, EnvDetail, EnvInstance } from '../types'

const SDKMAN_JAVA = joinHome('.sdkman', 'candidates', 'java')

/** mac：/usr/libexec/java_home -V 的版本列表输出在 stderr。 */
function parseJavaHomeList(output: string): { version: string; path: string }[] {
  const result: { version: string; path: string }[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d[^\s,]*(?:[^\s]*)?)[^/]*((?:\/|\\)\S+),?\s*$/.exec(line)
    if (match && path.isAbsolute(match[2])) result.push({ version: match[1].replace(/,$/, ''), path: match[2].replace(/,$/, '') })
  }
  return result
}

function parseWinWhere(output: string): string[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(line => path.isAbsolute(line) && /\.(exe|cmd)$/i.test(line))
}

export const javaAdapter: EnvAdapter = {
  family: 'java',
  label: 'Java',

  async detect(custom: CustomEnv[] = []): Promise<EnvInstance[]> {
    const instances: EnvInstance[] = []
    const found = which('java')
    if (found) {
      const version = await runVersion('java', '-version') // java -version 输出在 stderr
      instances.push({ id: 'java:system', family: 'java', label: 'JDK (PATH)', version: version ?? undefined, binPath: found })
    }
    if (isMac) {
      try {
        const result = await run('/usr/libexec/java_home', ['-V'], { timeoutMs: 15_000 })
        for (const item of parseJavaHomeList(result.stderr + result.stdout)) {
          instances.push({ id: `java:home:${item.path}`, family: 'java', label: `java_home · ${item.version}`, version: item.version, rootPath: item.path, note: '/usr/libexec/java_home -V' })
        }
      } catch { /* java_home missing */ }
    }
    if (isWin) {
      try {
        const result = await run('where', ['java'], { timeoutMs: 15_000 })
        for (const file of parseWinWhere(result.stdout)) {
          if (file === found) continue
          instances.push({ id: `java:where:${file}`, family: 'java', label: 'JDK (where java)', binPath: file, note: 'where java 发现' })
        }
      } catch { /* where missing */ }
    }
    if (fs.existsSync(SDKMAN_JAVA)) {
      try {
        for (const entry of fs.readdirSync(SDKMAN_JAVA, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          instances.push({ id: `java:sdkman:${entry.name}`, family: 'java', label: `sdkman · ${entry.name}`, version: entry.name, rootPath: path.join(SDKMAN_JAVA, entry.name), note: 'sdkman 安装' })
        }
      } catch { /* unreadable */ }
    }
    for (const item of custom) {
      if (item.family === 'java') instances.push({ id: `java:custom:${item.id}`, family: 'java', label: item.label, rootPath: item.rootPath, note: '手动添加' })
    }
    return instances
  },

  async detail(id: string): Promise<EnvDetail> {
    const instances = await javaAdapter.detect()
    const instance = instances.find(item => item.id === id)
    if (!instance) throw new Error(`未找到 Java 实例: ${id}`)
    const usage = []
    if (instance.rootPath) usage.push({ label: 'JDK 目录', path: instance.rootPath, bytes: await dirSize(instance.rootPath) })
    if (fs.existsSync(SDKMAN_JAVA)) usage.push({ label: 'sdkman java', path: SDKMAN_JAVA, bytes: await dirSize(SDKMAN_JAVA) })
    const keyVars = [{ name: 'JAVA_HOME', value: process.env.JAVA_HOME ?? '(未设置)' }]
    if (process.env.JDK_HOME) keyVars.push({ name: 'JDK_HOME', value: process.env.JDK_HOME })
    return { instance, diskUsage: usage, keyVars, extra: ['修改 JAVA_HOME 请使用环境变量类插件（本插件只读展示）'] }
  }
}
