/**
 * macOS 平台实现：
 * - process 范围直接读 process.env
 * - persistent 范围解析 ~/.zshenv / ~/.zprofile / ~/.zshrc / ~/.zlogin
 * - 写入目标文件由前端传入的 settings.macTarget 决定，写入前自动备份（保留最近 5 份）
 * - 受管块外的用户内容一字不动；原子写（临时文件 + rename）
 * - launchctl setenv/unsetenv 同步失败不阻断
 * - path 范围聚合 /etc/paths、/etc/paths.d/* 与当前 process PATH
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { exec } from '../exec'
import { mergeManaged, parseShellFile, splitManaged } from '../parser'
import type { BackupEntry, EnvVar, MacTarget, PathParts, PluginSettings, ScopeInfo, Snapshot, WriteResult } from '../types'

const TARGET_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const
const BACKUP_PREFIX = '.enest-backup-'
const MAX_BACKUPS = 5

export const MAC_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function defaultSettings(): PluginSettings {
  return { macTarget: 'zshenv', launchctlSync: false }
}

export function parseSettings(input: unknown): PluginSettings {
  if (input === undefined || input === null) return defaultSettings()
  if (typeof input !== 'object' || Array.isArray(input)) return defaultSettings()
  const raw = input as Record<string, unknown>
  const target = raw.macTarget
  return {
    macTarget: target === 'zprofile' || target === 'zshrc' ? target : 'zshenv',
    launchctlSync: raw.launchctlSync === true
  }
}

function targetPath(target: MacTarget): string {
  const file = `.${target}`
  if (!(TARGET_FILES as readonly string[]).includes(file)) throw new Error('写入目标无效')
  return path.join(os.homedir(), file)
}

/** 白名单校验：只允许 homedir 下的 .zshenv/.zprofile/.zshrc/.zlogin 及其备份/临时文件。 */
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
  const stem = base.replace(new RegExp(`^(\\.zshenv|\\.zprofile|\\.zshrc|\\.zlogin)(${BACKUP_PREFIX.replace('.', '\\.')}\\d{8}-\\d{6}|\\.enest-tmp)$`), '$1')
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
  for (const file of TARGET_FILES) {
    const filePath = path.join(os.homedir(), file)
    const content = readIfExists(filePath)
    if (content === null) continue
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
    { id: 'persistent', label: '持久化（shell 配置）', count: persistent.length },
    { id: 'path', label: 'PATH 来源', count: 0 }
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

async function launchctl(args: string[]): Promise<void> {
  await exec('/bin/launchctl', args)
}

export async function setVar(name: string, value: string, settings: PluginSettings): Promise<WriteResult> {
  const target = targetPath(settings.macTarget)
  assertWhitelisted(target, 'target')
  const notes: string[] = []
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
  if (settings.launchctlSync) {
    try {
      await launchctl(['setenv', name, value])
    } catch (error) {
      notes.push(`launchctl setenv 同步失败：${(error as Error).message}`)
    }
  }
  const noteParts = [`已写入 ${target}`]
  if (backupNote) noteParts.push(backupNote)
  if (notes.length) noteParts.push(notes.join('；'))
  return { ok: true, elevated: false, note: noteParts.join('；') }
}

export async function deleteVar(name: string, settings: PluginSettings): Promise<WriteResult> {
  const target = targetPath(settings.macTarget)
  assertWhitelisted(target, 'target')
  const content = readIfExists(target) ?? ''
  const split = splitManaged(content)
  if (!split.managedVars.some(item => item.name === name)) {
    return { ok: false, note: '该变量不在 eNest 受管块中' }
  }
  try { backupFile(target) } catch { /* 备份失败不阻断 */ }
  const next = split.managedVars.filter(item => item.name !== name)
  atomicWrite(target, mergeManaged(content, next))
  const notes: string[] = [`已从 ${target} 移除`]
  if (settings.launchctlSync) {
    try {
      await launchctl(['unsetenv', name])
    } catch (error) {
      notes.push(`launchctl unsetenv 同步失败：${(error as Error).message}`)
    }
  }
  return { ok: true, elevated: false, note: notes.join('；') }
}

export function listBackups(): BackupEntry[] {
  const home = os.homedir()
  const results: BackupEntry[] = []
  for (const file of TARGET_FILES) {
    const prefix = `.${file.slice(1)}${BACKUP_PREFIX}`
    let names: string[] = []
    try { names = fs.readdirSync(home) } catch { continue }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const full = path.join(home, name)
      try {
        const stats = fs.statSync(full)
        if (!stats.isFile()) continue
        results.push({ file: full, size: stats.size, createdAt: Math.round(stats.mtimeMs) })
      } catch { /* 单个备份损坏不阻断 */ }
    }
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

export async function pathParts(): Promise<PathParts> {
  const entries = String(process.env.PATH ?? '').split(':').filter(Boolean)
  const sources: { file: string; entries: string[] }[] = []
  const readLines = (file: string): string[] => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    } catch { return [] }
  }
  const pathsMain = readLines('/etc/paths')
  if (pathsMain.length) sources.push({ file: '/etc/paths', entries: pathsMain })
  let extra: string[] = []
  try { extra = fs.readdirSync('/etc/paths.d').sort() } catch { extra = [] }
  for (const name of extra) {
    const file = `/etc/paths.d/${name}`
    try {
      if (!fs.statSync(file).isFile()) continue
    } catch { continue }
    const items = readLines(file)
    if (items.length) sources.push({ file, entries: items })
  }
  return { entries, sources }
}
