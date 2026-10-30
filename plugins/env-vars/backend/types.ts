/** 跨端 DTO：环境变量条目、范围信息、设置与备份记录。 */

export type EnvScope = 'user' | 'machine' | 'process' | 'persistent'
export type MacTarget = 'zshenv' | 'zprofile' | 'zshrc'

export interface EnvVar {
  name: string
  value: string
  scope: EnvScope
  /** 来源文件路径或 'registry' */
  origin?: string
  /** 来自 eNest 受管块 */
  managed?: boolean
  /** 源文件行号 */
  line?: number
  /** 无 export 前缀（mac shell 文件） */
  exported?: boolean
  /** 值含 $(...) / 反引号 / ${...} 动态引用 */
  hasReference?: boolean
}

export interface ScopeInfo {
  id: EnvScope | 'path'
  label: string
  count: number
}

export interface Snapshot {
  platform: NodeJS.Platform
  scopes: ScopeInfo[]
  vars: EnvVar[]
}

export interface WriteResult {
  ok: boolean
  elevated?: boolean
  /** 权限不足，需要提权重试（前端确认后带 elevate:true 重发） */
  needsElevation?: boolean
  note?: string
}

export interface PluginSettings {
  macTarget: MacTarget
  launchctlSync: boolean
}

export interface BackupEntry {
  file: string
  size: number
  createdAt: number
}

export interface PathParts {
  entries: string[]
  /** mac path 范围：/etc/paths 与 /etc/paths.d/* 的来源明细 */
  sources?: { file: string; entries: string[] }[]
}
