/**
 * adapter 注册表：家族 + 包管理器；平台过滤（brew 仅 mac，winget/scoop/choco 仅 win）。
 */
import { nodeAdapter, migrateNodeCache } from './adapters/node'
import { pythonAdapter } from './adapters/python'
import { uvAdapter } from './adapters/uv'
import { condaAdapter } from './adapters/conda'
import { javaAdapter } from './adapters/java'
import { mavenAdapter, migrateMavenRepo } from './adapters/maven'
import { gradleAdapter, migrateGradleHome } from './adapters/gradle'
import { goAdapter } from './adapters/go'
import { rustAdapter } from './adapters/rust'
import { brewAdapter } from './adapters/brew'
import { wingetAdapter } from './adapters/winget'
import { scoopAdapter } from './adapters/scoop'
import { chocoAdapter } from './adapters/choco'
import type { EnvAdapter, PackageManagerAdapter } from './types'

export const familyAdapters: EnvAdapter[] = [
  nodeAdapter, pythonAdapter, uvAdapter, condaAdapter, javaAdapter,
  mavenAdapter, gradleAdapter, goAdapter, rustAdapter
]

export const packageManagerAdapters: PackageManagerAdapter[] = [
  brewAdapter, wingetAdapter, scoopAdapter, chocoAdapter
]

/** 家族白名单校验。 */
export function familyAdapter(family: unknown): EnvAdapter {
  if (typeof family !== 'string') throw new Error('family 参数无效')
  const adapter = familyAdapters.find(item => item.family === family)
  if (!adapter) throw new Error(`未知环境家族: ${family}`)
  return adapter
}

/** 包管理器白名单校验。 */
export function pmAdapter(id: unknown): PackageManagerAdapter {
  if (typeof id !== 'string') throw new Error('pm 参数无效')
  const adapter = packageManagerAdapters.find(item => item.id === id)
  if (!adapter) throw new Error(`未知包管理器: ${id}`)
  return adapter
}

/** 家族专属迁移执行器（task.migrate.run 调用）。 */
export async function runFamilyMigrate(family: string, id: string, target: string, moveData: boolean): Promise<{ ok: boolean; note?: string }> {
  const instanceId = String(id)
  switch (family) {
    case 'node': return migrateNodeCache(target, moveData)
    case 'maven': return migrateMavenRepo(target, moveData)
    case 'gradle': return migrateGradleHome(target, moveData)
    default: throw new Error(`${family} 暂不支持迁移（实例 ${instanceId}）`)
  }
}
