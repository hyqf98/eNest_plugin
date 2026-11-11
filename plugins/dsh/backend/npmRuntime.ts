/** 在用户机器上检测 npm 并把 @deepseek-ai/dsh 安装进插件数据目录。 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { emitDshEvent, getRuntimeScope, type PluginRuntimeScope } from '@backend/runtimeContext'
import { ownDshChild } from '@backend/dshRuntimeService'
import type { DshWorkbenchEvent } from '@backend/contracts/dsh-workbench'

const NPM_HOST_TIMEOUT_MS = 30_000
const NPM_INSTALL_TIMEOUT_MS = 15 * 60 * 1000

function emit(pluginId: string, event: DshWorkbenchEvent): void { emitDshEvent(pluginId, event) }
function assertCurrent(scope: PluginRuntimeScope): void {
  if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing; DSH operation cancelled')
}

export interface NpmRuntimeTool {
  executable: string
  baseArgs: string[]
  version: string
}

function runCaptured(executable: string, args: string[], scope: PluginRuntimeScope, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const owned = ownDshChild('com.github.eNest.dsh', child)
    let stdout = '', stderr = '', settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true; owned.stop()
      reject(new Error(`npm 命令超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)
    timer.unref()
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => {
      if (settled) return
      settled = true; clearTimeout(timer)
      reject(new Error(`无法启动 npm（${(error as NodeJS.ErrnoException).code ?? 'spawn'}）`))
    })
    child.once('close', code => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`npm 退出码 ${code ?? 'null'}: ${stderr.trim().slice(-400) || stdout.trim().slice(-400)}`))
    })
  })
}

function npmExecutableFromPath(): { executable: string; baseArgs: string[] } | null {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const candidates = new Set<string>()
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    candidates.add(join(dir, command))
    if (process.platform !== 'win32') candidates.add(join(dir, 'npm'))
  }
  // Electron 主进程环境通常没有 shell 守护的 .cmd 解析，Windows 上必须经 shell 或直接调 node npm-cli.js。
  if (process.platform === 'win32') {
    const cli = [process.env.npm_execpath, join(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js')]
      .find(file => typeof file === 'string' && file.endsWith('npm-cli.js') && existsSync(file))
    if (cli) return { executable: process.execPath, baseArgs: [cli] }
  }
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return { executable: candidate, baseArgs: [] } } catch { /* keep scanning */ }
  }
  return null
}

/** 检测本机 npm；找不到时返回 null 由调用方给出可操作的错误。 */
export async function detectNpmRuntimeTool(scope: PluginRuntimeScope): Promise<NpmRuntimeTool | null> {
  const found = npmExecutableFromPath()
  if (!found) return null
  const version = (await runCaptured(found.executable, [...found.baseArgs, '--version'], scope, NPM_HOST_TIMEOUT_MS)).trim()
  if (!/^\d+(\.\d+)*/.test(version)) throw new Error(`npm --version 输出无法识别: ${version.slice(0, 60)}`)
  return { ...found, version }
}

/**
 * 在暂存目录执行 npm install，成功后由调用方原子提升为 data runtime 目录。
 * npm 自身处理平台原生依赖与注册表镜像（用户 .npmrc 生效）。
 */
export async function npmInstallRuntime(
  pluginId: string, version: string, staging: string, scope: PluginRuntimeScope
): Promise<void> {
  const tool = await detectNpmRuntimeTool(scope)
  if (!tool) throw new Error('未在系统 PATH 中找到 npm；请安装 Node.js（含 npm）后重试')
  assertCurrent(scope)
  emit(pluginId, { type: 'runtime-progress', phase: 'download-start', detail: `npm install @deepseek-ai/dsh@${version}` })
  const work = mkdtempSync(join(tmpdir(), 'enest-dsh-npm-'))
  let output = ''
  try {
    await new Promise<void>((resolve, reject) => {
      const args = [...tool.baseArgs, 'install', `@deepseek-ai/dsh@${version}`, '--omit=dev', '--no-audit', '--no-fund',
        '--loglevel=error', `--prefix=${staging}`]
      const child = spawn(tool.executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        cwd: work, env: { ...process.env, npm_config_update_notifier: 'false' } })
      const owned = ownDshChild(pluginId, child)
      let stderr = '', settled = false
      child.stdout?.on('data', chunk => { output += String(chunk) })
      child.stderr?.on('data', chunk => { output += String(chunk); stderr += String(chunk) })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true; owned.stop()
        reject(new Error(`npm install 超时（15 分钟）`))
      }, NPM_INSTALL_TIMEOUT_MS)
      timer.unref()
      child.once('error', error => {
        if (settled) return
        settled = true; clearTimeout(timer)
        reject(new Error(`无法启动 npm（${(error as NodeJS.ErrnoException).code ?? 'spawn'}）`))
      })
      child.once('close', code => {
        if (settled) return
        settled = true; clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`npm install 失败（退出码 ${code ?? 'null'}）: ${stderr.trim().slice(-400)}`))
      })
    })
    assertCurrent(scope)
    if (!existsSync(join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
      throw new Error(`npm install 完成 but 未生成 @deepseek-ai/dsh（npm 输出: ${output.trim().slice(-300)}）`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  emit(pluginId, { type: 'runtime-progress', phase: 'extract', detail: '安装完成，校验 runtime 布局' })
}
