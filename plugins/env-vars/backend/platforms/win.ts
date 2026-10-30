/**
 * Windows 平台实现：
 * - 读：一段 PowerShell 同时拉 User / Machine 两张注册表环境表并 ConvertTo-Json 输出
 * - 写：[Environment]::SetEnvironmentVariable(…, 'User' | 'Machine')
 * - Machine 写/删失败（权限不足）返回 needsElevation，前端确认后带 elevate:true
 *   走 Start-Process -Verb RunAs 提权执行（UAC 由系统接管）
 */
import { exec, execBestEffort, powershellArgs, psQuote } from '../exec'
import type { EnvVar, ScopeInfo, Snapshot, WriteResult } from '../types'

export const WIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_() .-]*$/

const DENIED_PATTERNS = [/access is denied/i, /拒绝访问/, /requested registry access is not allowed/i]

function isDenied(stderr: string, message: string): boolean {
  const text = `${stderr}\n${message}`
  return DENIED_PATTERNS.some(pattern => pattern.test(text))
}

interface PsTables { User?: Record<string, string>; Machine?: Record<string, string> }

function parseTables(stdout: string): PsTables {
  const text = stdout.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) {
      // PS5 ConvertTo-Json 对多属性对象可能输出 [ {...}, {...} ] 形态；逐项识别
      const tables: PsTables = {}
      for (const item of parsed as Record<string, unknown>[]) {
        if (item && typeof item === 'object' && 'User' in item && 'Machine' in item) return item as unknown as PsTables
      }
      return tables
    }
    if (parsed && typeof parsed === 'object') return parsed as PsTables
  } catch {
    // 非预期输出按空表处理
  }
  return {}
}

export async function snapshot(): Promise<Snapshot> {
  const script = [
    '$u=[Environment]::GetEnvironmentVariables("User");',
    '$m=[Environment]::GetEnvironmentVariables("Machine");',
    '$o=New-Object PSObject; $o | Add-Member NoteProperty User $u; $o | Add-Member NoteProperty Machine $m;',
    '$o | ConvertTo-Json -Compress -Depth 3'
  ].join(' ')
  const vars: EnvVar[] = []
  let tables: PsTables = {}
  try {
    const result = await exec('powershell.exe', powershellArgs(script))
    tables = parseTables(result.stdout)
  } catch {
    // 注册表读取失败时仍展示进程范围
    tables = {}
  }
  for (const [name, value] of Object.entries(tables.Machine ?? {})) {
    if (typeof value === 'string') vars.push({ name, value, scope: 'machine', origin: 'registry' })
  }
  for (const [name, value] of Object.entries(tables.User ?? {})) {
    if (typeof value === 'string') vars.push({ name, value, scope: 'user', origin: 'registry' })
  }
  const processVars: EnvVar[] = []
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') processVars.push({ name, value, scope: 'process' })
  }
  const scopes: ScopeInfo[] = [
    { id: 'user', label: '用户变量', count: vars.filter(item => item.scope === 'user').length },
    { id: 'machine', label: '系统变量', count: vars.filter(item => item.scope === 'machine').length },
    { id: 'process', label: '当前进程', count: processVars.length }
  ]
  return { platform: process.platform, scopes, vars: vars.concat(processVars) }
}

function setCommand(name: string, value: string | null, target: 'User' | 'Machine'): string {
  return `[Environment]::SetEnvironmentVariable(${psQuote(name)}, ${value === null ? '$null' : psQuote(value)}, ${psQuote(target)})`
}

async function runElevated(innerScript: string): Promise<void> {
  const script = [
    `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden`,
    `-ArgumentList ${psQuote('-NoProfile')}, ${psQuote('-Command')}, ${psQuote(innerScript)}`
  ].join(' ')
  await execBestEffort('powershell.exe', powershellArgs(script), 60000)
}

export async function setVar(name: string, value: string, scope: 'user' | 'machine', elevate: boolean): Promise<WriteResult> {
  const target = scope === 'machine' ? 'Machine' : 'User'
  const inner = setCommand(name, value, target)
  if (elevate && scope === 'machine') {
    try {
      await runElevated(inner)
      return { ok: true, elevated: true, note: '已通过管理员权限写入系统变量' }
    } catch (error) {
      throw new Error(`提权执行失败：${(error as Error).message}`)
    }
  }
  try {
    await exec('powershell.exe', powershellArgs(inner))
    return { ok: true, elevated: scope === 'machine', note: scope === 'machine' ? '已写入系统变量（当前进程具有管理员权限）' : '已写入用户变量' }
  } catch (error) {
    const message = (error as Error).message
    if (scope === 'machine' && isDenied('', message)) {
      return { ok: false, needsElevation: true, note: '写入系统变量需要管理员权限' }
    }
    throw new Error(`写入失败：${message}`)
  }
}

export async function deleteVar(name: string, scope: 'user' | 'machine', elevate: boolean): Promise<WriteResult> {
  const target = scope === 'machine' ? 'Machine' : 'User'
  const inner = setCommand(name, null, target)
  if (elevate && scope === 'machine') {
    try {
      await runElevated(inner)
      return { ok: true, elevated: true, note: '已通过管理员权限删除系统变量' }
    } catch (error) {
      throw new Error(`提权执行失败：${(error as Error).message}`)
    }
  }
  try {
    await exec('powershell.exe', powershellArgs(inner))
    return { ok: true, elevated: scope === 'machine' }
  } catch (error) {
    const message = (error as Error).message
    if (scope === 'machine' && isDenied('', message)) {
      return { ok: false, needsElevation: true, note: '删除系统变量需要管理员权限' }
    }
    throw new Error(`删除失败：${message}`)
  }
}
