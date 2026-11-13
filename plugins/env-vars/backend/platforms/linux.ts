/**
 * Linux 平台实现：
 * - process 范围直接读 process.env
 * - persistent 范围解析 ~/.profile 受管块（bash/zsh 登录 shell 通用）
 * - 写入目标固定 ~/.profile，写入前自动备份（保留最近 5 份）
 * - 受管块外的用户内容一字不动；原子写（临时文件 + rename）
 * - 无 launchctl 对应物：设置中 launchctlSync 恒为 false，macTarget 仅在 macOS 生效
 * - PATH 来源视图（/etc/paths 聚合）不适用，见 index.ts 的 pathParts 分发
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { mergeManaged, parseShellFile, splitManaged } from '../parser'
import type { BackupEntry, EnvVar, PluginSettings, ScopeInfo, Snapshot, WriteResult } from '../types'

const TARGET_FILES = ['.profile'] as const
const BACKUP_PREFIX = '.enest-backup-'
const MAX_BACKUPS = 5

/** POSIX shell 变量名（与 macOS 实现同规则：字母/数字/下划线，字母或下划线开头）。 */
export const POSIX_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function defaultSettings(): PluginSettings {
  // Linux 写入目标固定 ~/.profile，无 launchctl 对应物。
  return { macTarget: 'zshenv', launchctlSync: false }
}

export function parseSettings(input: unknown): PluginSettings {
  // 设置项在 Linux 无可调内容：launchctlSync 恒 false，macTarget 由 macOS 分支自行解析。
  void input
  return defaultSettings()
}

function targetPath(): string {
  return path.join(os.homedir(), '.profile')
}

/** 白名单校验：只允许 homedir 下的 .profile 及其备份/临时文件。 */
function assertWhitelisted(filePath: string, kind: 'target' | 'backup' | 'tmp'): void {
  const home = os.homedir()
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(home + path.sep)) throw new Error('路径超出允许范围')
  const base = path.basename(resolved)
  const dir = path.dirname(resolved)
  if (dir !== home) throw new Error('路径超出允许范围')
  if (kind === 'target') {
    if (!(TARGET_FILES as readonly string[]).includes(base)) throw new Error('目标文件不受支持')
    return
  }
  const stem = base.replace(new RegExp(`^(\\.profile)(${BACKUP_PREFIX.replace('.', '\\.')}\\d{8}-\\d{6}|\\.enest-tmp)$`), '$1')
  if (stem === base || !(TARGET_FILES as readonly string[]).includes(stem)) throw new Error('备份文件名无效')
}

function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function snapshot(): Snapshot {
  const vars: EnvVar[] = []
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') vars.push({ name, value, scope: 'process' })
  }
  const persistent: EnvVar[] = []
  const filePath = targetPath()
  const content = readIfExists(filePath)
  if (content !== null) {
    for (const entry of parseShellFile(content)) {
      persistent.push({
        name: entry.name, value: entry.value, scope: 'persistent',
        origin: filePath, line: entry.line, managed: entry.managed,
        exported: entry.exported, hasReference: entry.hasReference
      })
    }
  }
  const scopes: ScopeInfo[] = [
    { id: 'process', label: '当前进程', count: vars.length },
    { id: 'persistent', label: '持久化（~/.profile）', count: persistent.length }
  ]
  return { platform: process.platform, scopes, vars: vars.concat(persistent) }
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 写前备份 + 滚动清理（按前缀 glob 只保留最近 MAX_BACKUPS 份）。 */
function backupFile(target: string): string {
  const stamp = timestamp()
  const backup = `${target}${BACKUP_PREFIX}${stamp}`
  fs.copyFileSync(target, backup)
  const prefix = `${target}${BACKUP_PREFIX}`
  const all = fs.readdirSync(path.dirname(target))
    .filter(name => name.startsWith(path.basename(prefix)))
    .map(name => path.join(path.dirname(target), name))
    .filter(name => fs.statSync(name).isFile())
    .sort((a, b) => b.localeCompare(a))
  for (const stale of all.slice(MAX_BACKUPS)) {
    try { fs.rmSync(stale, { force: true }) } catch { /* 清理失败不阻断 */ }
  }
  return backup
}

function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.enest-tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, target)
}

export function setVar(name: string, value: string): WriteResult {
  const target = targetPath()
  assertWhitelisted(target, 'target')
  let backupNote = ''
  const content = readIfExists(target) ?? ''
  if (content !== '' || fs.existsSync(target)) {
    try {
      backupFile(target)
      backupNote = '已自动备份原文件'
    } catch {
      // 备份失败不阻断写入，但要在 note 中说明
      backupNote = '警告：写前备份失败'
    }
  }
  const split = splitManaged(content)
  const kept = split.managedVars.filter(item => item.name !== name).map(item => ({ name: item.name, value: item.value }))
  const next = kept.concat([{ name, value }]).sort((a, b) => a.name.localeCompare(b.name))
  atomicWrite(target, mergeManaged(content, next))
  const noteParts = [`已写入 ${target}`]
  if (backupNote) noteParts.push(backupNote)
  return { ok: true, elevated: false, note: noteParts.join('；') }
}

export function deleteVar(name: string): WriteResult {
  const target = targetPath()
  assertWhitelisted(target, 'target')
  const content = readIfExists(target) ?? ''
  const split = splitManaged(content)
  if (!split.managedVars.some(item => item.name === name)) {
    return { ok: false, note: '该变量不在 eNest 受管块中' }
  }
  try { backupFile(target) } catch { /* 备份失败不阻断 */ }
  const next = split.managedVars.filter(item => item.name !== name)
  atomicWrite(target, mergeManaged(content, next))
  return { ok: true, elevated: false, note: `已从 ${target} 移除` }
}

export function listBackups(): BackupEntry[] {
  const home = os.homedir()
  const results: BackupEntry[] = []
  const prefix = `.profile${BACKUP_PREFIX}`
  let names: string[] = []
  try { names = fs.readdirSync(home) } catch { return results }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const full = path.join(home, name)
    try {
      const stats = fs.statSync(full)
      if (!stats.isFile()) continue
      results.push({ file: full, size: stats.size, createdAt: Math.round(stats.mtimeMs) })
    } catch { /* 单个备份损坏不阻断 */ }
  }
  return results.sort((a, b) => b.createdAt - a.createdAt)
}

export function restoreBackup(file: string): { ok: boolean } {
  const target = file.replace(new RegExp(`${BACKUP_PREFIX.replace('.', '\\.')}\\d{8}-\\d{6}$`), '')
  assertWhitelisted(target, 'target')
  assertWhitelisted(file, 'backup')
  if (!fs.existsSync(file)) throw new Error('备份文件不存在')
  if (fs.existsSync(target)) {
    try { backupFile(target) } catch { /* 当前版备份失败仍允许恢复 */ }
  }
  fs.copyFileSync(file, target)
  return { ok: true }
}
