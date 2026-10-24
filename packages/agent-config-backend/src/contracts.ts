/** 配置文件格式（决定 write 合并策略） */
export type AgentConfigFormat = 'json' | 'toml' | 'yaml'

export interface AgentAdapter {
  /** 应用标识（白名单键） */
  app: string
  /** 展示名 */
  name: string
  /** 配置文件绝对路径白名单（~ 已展开） */
  configPaths: string[]
  /** 各文件格式（与 configPaths 对齐） */
  formats: AgentConfigFormat[]
  /** 当前活跃检测：默认按主配置文件存在判定，可覆盖更精细语义 */
  isActive?(): boolean
  /** 会话日志根目录白名单（只读；存在才允许 sessions.list/read 进入） */
  sessionDirs?: string[]
  /**
   * 会话目录的相对白名单校验（只允许进入白名单根目录下的已知结构）。
   * 缺省接受 sessionDirs 下任意相对路径（不越过根、拒绝 .. 与符号链接）。
   */
  sessionMatch?(relPath: string): boolean
  /**
   * 资产根目录白名单（agent.listAssets/writeAssets/deleteAssets 进入的前提；
   * 缺省 dirname(configPaths[0])）。配置文件本身不受资产通道影响：
   * 命中 configPaths 的相对路径一律拒绝，必须走 agent.write 的合并语义。
   */
  assetRoot?: string
  /** 资产通道允许操作的一级子目录白名单（空则该应用不开放资产通道） */
  assetSubdirs?: string[]
}

export interface AgentAppStatus {
  app: string
  name: string
  configPaths: string[]
  /** 主配置文件存在（视为已安装/已初始化） */
  installed: boolean
  /** 适配器活跃检测（如 codex auth 有登录材料） */
  active: boolean
}

export interface AgentFileSnapshot {
  path: string
  content: string
  parsed: unknown
  exists: boolean
}

export interface AgentReadResult {
  app: string
  files: AgentFileSnapshot[]
  active: boolean
  readAt: number
}

export interface AgentWriteInputPayload {
  app: string
  /** 顶层键 → 新值；`$file` 特殊键指定目标文件名（如 codex 的 "auth.json"） */
  changes: Record<string, unknown>
  /** Optional plugin-owned vault ref; only existing Claude/Codex/Gemini key fields are supported. */
  secretRef?: string
  /** 插件后端收到宿主原生确认后在内部设置；渲染层传入的值不能替代确认。 */
  confirmed?: boolean
}

export interface AgentWriteResultPayload {
  ok: boolean
  app: string
  written: string[]
  backupId: string
}

export interface AgentBackupEntry {
  id: string
  app: string
  createdAt: number
  files: string[]
}

export interface AgentSessionFile {
  /** 相对 sessionDirs 根的路径（读回传用 file 参数） */
  file: string
  /** 绝对路径（仅展示） */
  path: string
  bytes: number
  /** mtime 毫秒 */
  modifiedAt: number
  /** 目录段推断的项目路径（claude-code 项目目录名，其余为空） */
  project?: string
}

export interface AgentSessionsListResult {
  app: string
  root: string
  files: AgentSessionFile[]
  /** 截断（超出上限）时为 true */
  truncated: boolean
}

export interface AgentSessionLine {
  /** 行号（1 起） */
  n: number
  /** 解析后的 JSON 对象；解析失败为 null */
  json: unknown
  /** 原始行文本（超长截断） */
  raw: string
  truncated: boolean
}

export interface AgentSessionsReadResult {
  app: string
  file: string
  path: string
  bytes: number
  /** 实际读取字节数（≤ maxBytes） */
  readBytes: number
  truncated: boolean
  lines: AgentSessionLine[]
}

export interface AgentAssetEntry {
  name: string
  isDir: boolean
  size: number
  modifiedAt: number
}

export interface AgentListAssetsResult {
  app: string
  root: string
  path: string
  entries: AgentAssetEntry[]
  truncated: boolean
}

export interface AgentAssetInput {
  /** 相对 assetRoot 的路径（首段必须命中 assetSubdirs） */
  path: string
  /** 文本内容（utf-8）与 contentBase64 二选一 */
  contentText?: string
  contentBase64?: string
}

export interface AgentWriteAssetsResultPayload {
  ok: boolean
  app: string
  written: string[]
  /** 覆盖了已存在文件时的快照 id（未覆盖任何文件为 null） */
  backupId: string | null
}

export interface AgentDeleteAssetsResultPayload {
  ok: boolean
  app: string
  deleted: string[]
}
