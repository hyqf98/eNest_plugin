/** dev-env 共享类型：家族 adapter 与包管理器 adapter 的统一契约。 */

export type Risk = 'safe' | 'cautious'

export interface EnvInstance {
  id: string
  family: string
  label: string
  version?: string
  binPath?: string
  rootPath?: string
  note?: string
}

export interface DiskUsage {
  label: string
  path: string
  bytes: number
}

export interface EnvDetail {
  instance: EnvInstance
  diskUsage?: DiskUsage[]
  keyVars?: { name: string; value: string }[]
  extra?: string[]
}

export interface Dep {
  name: string
  version?: string
  size?: number
  note?: string
}

export interface CleanResult {
  ok: boolean
  note?: string
  freedBytes?: number
}

export interface CleanAction {
  id: string
  label: string
  description: string
  risk: Risk
  command: () => Promise<CleanResult>
  dryRun?: () => Promise<string[]>
}

export interface ConfigFile {
  path: string
  exists: boolean
  bytes?: number
  preview?: string
}

export interface ConfigChange {
  file: string
  from: string
  to: string
  manual?: boolean
}

export interface MigratePlan {
  steps: string[]
  configChanges: ConfigChange[]
  dataBytes?: number
}

export interface EnvAdapter {
  family: string
  label: string
  detect(custom?: CustomEnv[]): Promise<EnvInstance[]>
  detail(id: string, custom?: CustomEnv[]): Promise<EnvDetail>
  listDeps?(): Promise<Dep[]>
  removeDep?(name: string): Promise<CleanResult>
  cleanActions?(id: string): Promise<CleanAction[]>
  configs?(id: string): Promise<ConfigFile[]>
  migrate?(id: string, target: string): Promise<MigratePlan>
}

/** 前端 enest.storage 持久化的自定义环境路径；snapshot/detail 调用时并入检测结果。 */
export interface CustomEnv {
  id: string
  family: string
  label: string
  rootPath: string
}

export interface PmItem {
  name: string
  version?: string
  type?: string
  outdated?: boolean
  id?: string
  note?: string
}

export interface InstallOptions {
  cask?: boolean
  zap?: boolean
  purge?: boolean
  exact?: boolean
}

export interface PackageManagerAdapter {
  id: string
  label: string
  available(): Promise<boolean>
  prefix?(): Promise<string>
  listInstalled(): Promise<PmItem[]>
  search(query: string): Promise<PmItem[]>
  install(name: string, opts?: InstallOptions): Promise<CleanResult>
  uninstall(name: string, opts?: InstallOptions): Promise<CleanResult>
  upgrade(name?: string): Promise<CleanResult>
  outdated(): Promise<PmItem[]>
  updateSource?(): Promise<CleanResult>
  cleanActions?(): Promise<CleanAction[]>
  detail(): Promise<EnvDetail>
}

export interface TaskSpec {
  kind: 'pm.install' | 'pm.uninstall' | 'pm.upgrade' | 'pm.updateSource' | 'clean.run' | 'migrate.run' | 'pm.clean'
  pm?: string
  name?: string
  opts?: InstallOptions
  family?: string
  id?: string
  actionId?: string
  target?: string
  moveData?: boolean
}
