/**
 * exec 封装：全部走 execFile（永不经过 shell），windowsHide 隐藏控制台窗口，
 * 超时兜底、输出截断到 1 MiB，错误信息保持中文可读。
 */
import { execFile } from 'node:child_process'

export const COMMAND_TIMEOUT_MS = 10000
export const ELEVATE_TIMEOUT_MS = 60000
const MAX_OUTPUT_BYTES = 1024 * 1024

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
}

function clip(text: string): string {
  return Buffer.byteLength(text) > MAX_OUTPUT_BYTES
    ? Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8')
    : text
}

export function exec(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim()
        reject(new Error(`${command} 执行失败：${detail || (error as NodeJS.ErrnoException).code || '未知错误'}`))
        return
      }
      resolve({ stdout: clip(String(stdout ?? '')), stderr: String(stderr ?? ''), code: 0 })
    })
  })
}

/** 允许非零退出但有输出的场景（提权 Start-Process 由系统接管，退出码仅作参考）。 */
export async function execBestEffort(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error && stdout === '' && !stderr) {
        reject(new Error(`${command} 执行失败：${(error as NodeJS.ErrnoException).code || error.message}`))
        return
      }
      resolve({ stdout: clip(String(stdout ?? '')), stderr: String(stderr ?? ''), code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? null) : 0 })
    })
  })
}

/** PowerShell 单引号字面量：内部单引号翻倍。 */
export function psQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/** Windows PowerShell 标准调用参数（execFile 直跑，不嵌 cmd）。 */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
}
