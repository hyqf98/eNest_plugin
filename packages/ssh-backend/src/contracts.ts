/** Plugin-owned SSH domain contracts transported through the generic backend API. */


export type SshAuthType = 'password' | 'key' | 'agent' | 'keyboard-interactive'

/** Per-connection TCP transport. Only the first SSH hop uses this proxy. */
export interface SshProxyConfig {
  type: 'http-connect' | 'socks5'
  host: string
  port: number
  username?: string
  /** Proxy password is kept in the requesting plugin's vault. */
  secretRef?: string
  /** One-off test credential, never saved with the profile. */
  ephemeralSecret?: string
}

export interface SshJumpConfig {
  host: string
  port?: number
  username: string
  authType?: SshAuthType
  privateKeyHandleId?: string
  secretRef?: string
  ephemeralSecret?: string
}

/** ssh.connect 入参：密钥走 secretRef / ephemeralSecret / password（一次性） */
export interface SshConnectInput {
  fingerprintPolicy?: string
  profileId?: string
  host: string
  port?: number
  username: string
  authType?: SshAuthType
  secretRef?: string
  ephemeralSecret?: string
  /** 插件 UI 一次性口令别名，等价 ephemeralSecret */
  password?: string
  privateKeyHandleId?: string
  jump?: SshJumpConfig | null
  /** Explicit proxy; omitted means direct TCP, independent of shell HTTP proxy. */
  proxy?: SshProxyConfig
  /** Ordered jump chain, from the local-facing bastion to the target. Max 8. */
  jumps?: SshJumpConfig[]
  keepAliveSec?: number
  timeoutMs?: number
  cols?: number
  rows?: number
  term?: string
  env?: string
}

export interface SshSessionInfo {
  sessionId: string
  profileId?: string
  host: string
  port?: number
  username?: string
  status?: string
  connectedAt?: number
  fingerprint?: string
  serverIdent?: string
  cols?: number
  rows?: number
}

export interface SshExecInput extends Partial<SshConnectInput> {
  sessionId?: string
  command?: string
  cmd?: string
  timeoutMs?: number
}

export interface SshExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
}

export interface SshMetricsSample {
  ts: number
  cpuPercent?: number
  memUsed?: number
  memTotal?: number
  memPercent?: number
  load1?: number
  disks?: Array<{ mount: string; usedPercent: number; used?: number; total?: number }>
  net?: Array<{ iface: string; rxKbps: number; txKbps: number }>
  uptimeSec?: number
  topProcesses?: Array<{ pid: number; cpuPercent?: number; memPercent?: number; command: string }>
  error?: string
}

export interface SshCompletionSuggestInput {
  sessionId: string
  /** 当前输入行（用于前缀匹配）；插件也可用 prefix */
  line?: string
  prefix?: string
  cursor?: number
  /** Current working directory from explicit shell integration (OSC 7). */
  cwd?: string
  history?: string[]
  snippets?: Array<{ title: string; command: string }>
}

export type SshCompletionKind = 'cmd' | 'flag' | 'path' | 'history' | 'snippet'

export interface SshCompletionItem {
  label: string
  kind: SshCompletionKind
  detail?: string
  insertText: string
  sortText: string
  /** 危险命令说明；true/字符串均可能 */
  dangerous?: boolean | string | null
}

export interface SshCompletionResult {
  items: SshCompletionItem[]
  danger?: string | null
  word?: string
}

export interface SftpListInput {
  sessionId?: string
  path?: string
  host?: string
  port?: number
  username?: string
  authType?: SshAuthType
  secretRef?: string
  ephemeralSecret?: string
  privateKeyHandleId?: string
}

export interface SftpEntry {
  name: string
  type: 'file' | 'dir' | 'other'
  size: number
  mtime: number
}

export interface SftpDownloadInput extends SftpListInput {
  remotePath?: string
  localDirectoryHandleId: string
}

export interface SftpUploadInput extends SftpListInput {
  localHandleId: string
  remotePath?: string
}

export interface SftpTransferResult {
  ok: boolean
  path?: string
  remotePath?: string
  localPath?: string
  size?: number
  bytes?: number
  message?: string
  error?: string
}

export type SshPluginEvent =
  | { type: 'ssh.auth'; sessionId: string; challengeId: string; host: string; instructions: string; prompts: Array<{ prompt: string; echo: boolean }> }
  | { type: 'ssh.data'; sessionId: string; data: string }
  | { type: 'ssh.exit'; sessionId: string; code?: number | null; signal?: string }
  | { type: 'ssh.error'; sessionId?: string; message: string }
  | { type: 'ssh.metrics'; sessionId?: string; profileId?: string; sample: SshMetricsSample }

/** SSH workbench capabilities. Remote resources stay owned by the caller's session. */
export type SshRemotePlatform = 'linux' | 'darwin' | 'win32'
export interface SshProcessInfo {
  pid: number
  name: string
  user?: string
  cpuPercent?: number
  memoryBytes?: number
  startTime: string
}
export interface SshPortInfo {
  protocol: string
  address: string
  port: number
  pid?: number
  process?: string
}
export interface SshSystemSnapshot {
  platform: SshRemotePlatform
  ts: number
  cpuPercent?: number
  memTotal?: number
  memUsed?: number
  memPercent?: number
  load1?: number
  uptimeSec?: number
  disks: Array<{ mount: string; usedPercent: number; used?: number; total?: number }>
  net: Array<{ iface: string; rxKbps: number; txKbps: number }>
}
export interface SshFileInfo {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtime: number
  mode: number
  uid?: number
  gid?: number
}
export interface SshTransferTask {
  id: string
  sessionId: string
  direction: 'upload' | 'download' | 'copy' | 'move'
  source: string
  destination: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  transferred: number
  total: number
  startedAt: number
  error?: string
  resumable?: boolean
  canRetry?: boolean
}
export interface SshWorkbenchRequest {
  action: string
  sessionId?: string
  sourceSessionId?: string
  path?: string
  paths?: string[]
  destination?: string
  content?: string
  expectedMtime?: number
  pid?: number
  startTime?: string
  signal?: 'TERM' | 'KILL'
  name?: string
  operation?: string
  confirmed?: boolean
  entries?: Array<{ path: string; name: string }>
  id?: string
  localPort?: number
  remoteHost?: string
  remotePort?: number
  direction?: 'local' | 'remote'
  overwrite?: boolean
  localHandleId?: string
  expectedHash?: string
  answers?: string[]
}
/** A user-selected local file capability, scoped to the calling plugin. */
export interface LocalFileHandle {
  id: string
  name: string
  kind: 'file' | 'directory'
  size: number
  displayPath: string
}

export interface LocalFilePickOptions {
  kind?: 'file' | 'directory' | 'any'
  multiple?: boolean
  /** Read is the default; write selection explicitly grants content changes. */
  access?: 'read' | 'write'
}

export type PluginInputContext = 'workbench' | 'terminal' | 'editor' | 'overlay'
