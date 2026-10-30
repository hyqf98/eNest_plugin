/**
 * exec —— dev-env 的进程执行底座：execFile（永不走 shell）+ 版本探测 + PATH 查找。
 * 超时升级（SIGTERM → SIGKILL）参照 dsh probeDshRuntime 的做法。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export { spawn, ChildProcess }

export interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  combined: string
}

export interface RunOptions {
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

const KILL_GRACE_MS = 2500

/** execFile 语义的命令执行：参数数组直传（永不经过 shell），输出合并，超时 SIGTERM→SIGKILL。 */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runViaSpawn(cmd, args, options)
}

/** 通过 spawn 实现（等价 execFile with killSignal）：拿得到完整 stdout/stderr 与退出码。 */
function runViaSpawn(cmd: string, args: string[], options: RunOptions): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (ok: boolean, code: number | null) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      resolve({ ok, code, stdout, stderr, combined: stdout + (stderr ? (stdout ? '\n' : '') + stderr : '') })
    }
    const timeout = () => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const timer = setTimeout(timeout, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', chunk => { if (stdout.length < 2 * 1024 * 1024) stdout += String(chunk) })
    child.stderr?.on('data', chunk => { if (stderr.length < 2 * 1024 * 1024) stderr += String(chunk) })
    child.once('error', error => {
      if (stderr.length < 4096) stderr += (stderr ? '\n' : '') + String(error.message ?? error)
      finish(false, null)
    })
    child.once('close', code => {
      clearTimeout(timer)
      finish(code === 0, code)
    })
  })
}

/** 探测 `bin --version` 风格的版本字符串（首段非空输出）。超时 10s。 */
export async function runVersion(bin: string, flag = '--version', timeoutMs = 10_000): Promise<string | null> {
  try {
    const result = await runViaSpawn(bin, [flag], { timeoutMs })
    if (!result.ok) return null
    const line = result.stdout.trim() || result.stderr.trim()
    if (!line) return null
    return line.split(/\r?\n/).filter(Boolean).pop()!.slice(0, 200)
  } catch {
    return null
  }
}

const WIN_EXTS = ['.cmd', '.exe', '.bat']

/** PATH 遍历找可执行文件（参照 dsh systemDshBin：X_OK 校验，win32 补 .cmd/.exe/.bat）。 */
export function which(bin: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(path.delimiter)
  if (process.platform === 'win32') {
    const candidates = WIN_EXTS.map(ext => bin + ext).concat([bin])
    for (const dir of dirs) {
      if (!dir) continue
      for (const name of candidates) {
        const candidate = path.join(dir, name)
        try {
          if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate }
        } catch { /* continue */ }
      }
    }
    return null
  }
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, bin)
    try {
      if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate }
    } catch { /* continue */ }
  }
  return null
}

/** 家族首候选二进制：按序返回第一个 PATH 上存在的。 */
export function whichAny(bins: string[]): { bin: string; path: string } | null {
  for (const bin of bins) {
    const found = which(bin)
    if (found) return { bin, path: found }
  }
  return null
}

/** 基础名字清洗：拒绝 shell 元字符（execFile 不走 shell，此处纯防御）。 */
export function assertSafeName(input: unknown, label = 'name'): string {
  if (typeof input !== 'string') throw new Error(`${label} 参数无效`)
  const value = input.trim()
  if (!value || value.length > 256) throw new Error(`${label} 参数无效`)
  if (/[;|&$`><\n\r]/.test(value) || value.includes('\0')) throw new Error(`${label} 含非法字符`)
  return value
}
