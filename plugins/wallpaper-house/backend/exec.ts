import { execFile as execFileCallback } from 'node:child_process'
import { errorMessage } from './util'

export interface ExecFileOptions {
  timeoutMs?: number
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
}

export interface ExecFileResult {
  stdout: string
  stderr: string
}

export function execFile(command: string, args: string[], options: ExecFileOptions = {}): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(command, args, {
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      windowsHide: true,
      env: options.env ?? process.env,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim() || errorMessage(error)
        reject(new Error(detail.slice(0, 4096)))
        return
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}
