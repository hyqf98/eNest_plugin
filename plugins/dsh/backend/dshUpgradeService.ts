/** DSH native release installation and rollback-safe, source-aware runtime changes. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitDshEvent, getRuntimeScope, logWarn, type PluginRuntimeScope } from '@backend/runtimeContext'
import { fetchRuntime } from '@backend/runtimeNetwork'
import { npmInstallRuntime } from '@backend/npmRuntime'
import {
  clearActiveMarker, dataRuntimeRoot, DSH_PLUGIN_ID, dshDataDirs, ensureDshDirs, getActiveMarker,
  listInstalledRuntimes, resolveRuntime, resolveRuntimeSelection, runtimeIdentity, safeRuntimeVersion,
  setActiveMarker, validateRuntimeRoot, type DshRuntimeSelection, type ResolvedRuntime
} from '@backend/dshRuntimeStore'
import { createBackup, restoreBackup } from '@backend/dshProfileService'
import {
  ownDshChild, probeDshRuntime, restartDshProcesses, snapshotDshProcesses, stopAllDshAndWait, withDshMaintenance
} from '@backend/dshRuntimeService'
import type { DshRemoteVersion, DshRuntimeVersion, DshWorkbenchEvent } from '@backend/contracts/dsh-workbench'

const NPM_REGISTRY = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'
function emit(pluginId: string, event: DshWorkbenchEvent): void { emitDshEvent(pluginId, event) }
function errorMessage(error: unknown): string { return String((error as Error)?.message ?? error) }
function operationScope(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  return scope
}
function assertCurrent(scope: PluginRuntimeScope): void {
  if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing; DSH operation cancelled')
}
async function fetchTimed(url: string, signal?: AbortSignal): Promise<Response> {
  return fetchRuntime(url, { headers: { accept: 'application/vnd.github+json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
}
interface DownloadableVersion extends DshRemoteVersion { npmInstallable?: boolean }
export async function listRemoteVersions(pluginId: string, limit = 20): Promise<DownloadableVersion[]> {
  const signal = getRuntimeScope(pluginId)?.signal
  const json = async (url: string) => { const response = await fetchTimed(url, signal); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() }
  // 版本目录直接来自 npm registry 元数据；npm 本身保证平台原生依赖与镜像兼容。
  const meta = await json(NPM_REGISTRY).catch(error => { throw new Error(`DSH 版本列表获取失败（npm registry）: ${errorMessage(error)}`) }) as {
    'dist-tags'?: Record<string, string>; time?: Record<string, string>
  } | null
  if (!meta || typeof meta !== 'object' || !meta.time) throw new Error('DSH 版本列表响应格式错误')
  const tags = meta['dist-tags'] ?? {}
  const result = new Map<string, DownloadableVersion>()
  for (const [version, date] of Object.entries(meta.time)) {
    if (['created', 'modified'].includes(version)) continue
    try { safeRuntimeVersion(version) } catch { continue }
    result.set(version, { version, date, npmInstallable: true })
  }
  for (const [tag, version] of Object.entries(tags)) {
    const entry = result.get(version)
    if (entry) entry.distTag = tag
  }
  return [...result.values()]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 20)))
}
export async function installRuntimeVersion(pluginId: string, version: string): Promise<void> {
  safeRuntimeVersion(version)
  return withDshMaintenance(pluginId, async () => {
    const scope = operationScope(pluginId)
    const { runtimeDir } = ensureDshDirs()
    const target = dataRuntimeRoot(version)
    if (existsSync(target)) { validateRuntimeRoot(target, version, true); return }
    const work = mkdtempSync(join(runtimeDir, '.install-'))
    const staging = join(work, 'runtime')
    try {
      mkdirSync(staging)
      await npmInstallRuntime(pluginId, version, staging, scope)
      // npm 只产出 @deepseek-ai/dsh；补写 enest-dsh-runtime 守护清单（身份/依赖/平台）供 validateRuntimeRoot 校验。
      writeFileSync(join(staging, 'package.json'), JSON.stringify({
        name: 'enest-dsh-runtime', version, private: true,
        dependencies: { '@deepseek-ai/dsh': version },
        platform: process.platform, arch: process.arch
      }, null, 2) + '\n')
      emit(pluginId, { type: 'runtime-progress', phase: 'extract', detail: 'npm 安装完成，校验 runtime 布局' })
      validateRuntimeRoot(staging, version, true)
      assertCurrent(scope)
      // Same filesystem, atomic promotion. Never overwrite an active/partially installed version.
      if (existsSync(dataRuntimeRoot(version))) throw new Error(`版本 ${version} 安装目录已存在，请先检查或移除`)
      renameSync(staging, target)
      emit(pluginId, { type: 'runtime-progress', phase: 'installed', detail: version })
    } finally { rmSync(work, { recursive: true, force: true }) }
  })
}

export interface SwitchDshRuntimeInput extends DshRuntimeSelection { restart?: boolean }
export interface DshRuntimeChangeResult { backupId: string; application: 'stopped' | 'restarted'; message: string }
async function healthCheck(pluginId: string, runtime: ResolvedRuntime, scope: PluginRuntimeScope): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'enest-dsh-health-'))
  const home = join(work, 'home')
  mkdirSync(home)
  try {
    assertCurrent(scope)
    const actual = await probeDshRuntime(pluginId, runtime, home)
    if (runtime.version && actual !== runtime.version && !actual.split(/\s+/).some(part => part.replace(/^v/, '') === runtime.version)) {
      throw new Error(`健康检查版本不匹配（期望 ${runtime.version}，实际 ${actual}）`)
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
}
function restoreMarker(previous: DshRuntimeSelection | null): void {
  if (previous) setActiveMarker(previous)
  else clearActiveMarker()
}
async function changeRuntime(pluginId: string, input: SwitchDshRuntimeInput, install: boolean): Promise<DshRuntimeChangeResult> {
  safeRuntimeVersion(input.version)
  if (!['data', 'bundled', 'system'].includes(input.source)) throw new Error('非法 runtime 来源')
  return withDshMaintenance(pluginId, async () => {
    const scope = operationScope(pluginId)
    const previous = getActiveMarker()
    const snapshot = snapshotDshProcesses(pluginId)
    const label = runtimeIdentity(input)
    emit(pluginId, { type: 'runtime-progress', phase: 'upgrade-start', detail: `目标 ${label}` })
    await stopAllDshAndWait(pluginId)
    assertCurrent(scope)
    ensureDshDirs()
    const backupId = await createBackup('home', `运行时变更前快照 → ${label}`)
    let committed = false
    try {
      if (install) await installRuntimeVersion(pluginId, input.version)
      const target = resolveRuntimeSelection(input)
      emit(pluginId, { type: 'runtime-progress', phase: 'health-check', detail: label })
      await healthCheck(pluginId, target, scope)
      assertCurrent(scope)
      setActiveMarker(input)
      committed = true
      if (input.restart) await restartDshProcesses(pluginId, snapshot)
      emit(pluginId, { type: 'runtime-progress', phase: 'activated', detail: label })
      emit(pluginId, { type: 'runtime-progress', phase: 'upgrade-done', detail: label })
      return { backupId, application: input.restart ? 'restarted' : 'stopped',
        message: input.restart ? '运行时已切换并重新启动原进程；就绪状态以进程握手为准' : '运行时已切换且健康检查通过；进程保持停止，下次启动生效' }
    } catch (error) {
      const detail = errorMessage(error)
      emit(pluginId, { type: 'runtime-progress', phase: 'rollback', detail: `${detail}；恢复备份 ${backupId}` })
      logWarn('dsh', `运行时变更失败，回滚: ${detail}`)
      const failures: string[] = []
      // Never mutate home while an unconfirmed child may still be writing to it.
      let stopped = false
      try { await stopAllDshAndWait(pluginId); stopped = true } catch (stopError) { failures.push(errorMessage(stopError)) }
      if (stopped) {
        if (committed) { try { restoreMarker(previous) } catch (markerError) { failures.push(`标记: ${errorMessage(markerError)}`) } }
        try { await restoreBackup(backupId, 'home') } catch (restoreError) { failures.push(`数据: ${errorMessage(restoreError)}`) }
      }
      if (failures.length) throw new Error(`运行时变更失败: ${detail}；回滚未完成: ${failures.join('；')}（备份 ${backupId} 保留）`)
      throw new Error(`运行时变更失败已回滚: ${detail}（备份 ${backupId} 保留，进程已停止）`)
    }
  })
}
export async function switchDshRuntime(pluginId: string, input: SwitchDshRuntimeInput): Promise<DshRuntimeChangeResult> {
  return changeRuntime(pluginId, input, false)
}
export async function activateRuntimeVersion(pluginId: string, version: string): Promise<DshRuntimeChangeResult> {
  return switchDshRuntime(pluginId, { source: 'data', version })
}
export async function oneClickUpgrade(pluginId: string, version: string): Promise<DshRuntimeChangeResult> {
  return changeRuntime(pluginId, { version, source: 'data' }, true)
}
export async function removeRuntimeVersion(version: string, pluginId = DSH_PLUGIN_ID): Promise<void> {
  safeRuntimeVersion(version)
  return withDshMaintenance(pluginId, async () => {
    operationScope(pluginId)
    const marker = getActiveMarker()
    const active = resolveRuntime()
    if (marker?.source === 'data' && marker.version === version || active.source === 'data' && active.version === version) {
      throw new Error(`版本 data:${version} 正在使用，先切换到其他来源/版本再移除`)
    }
    const target = dataRuntimeRoot(version)
    if (!existsSync(target)) throw new Error(`版本 ${version} 未安装`)
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error('非法 runtime 目录')
    // Quiesce before unlinking even if an older process predates the current selection marker.
    await stopAllDshAndWait(pluginId)
    dataRuntimeRoot(version)
    rmSync(target, { recursive: true, force: false })
  })
}
export function installedVersions(): DshRuntimeVersion[] { return listInstalledRuntimes() }
export function backupsDiskUsage(): { bytes: number; count: number } {
  const { backupDir } = dshDataDirs()
  if (!existsSync(backupDir)) return { bytes: 0, count: 0 }
  let bytes = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(path, depth + 1)
      else { try { bytes += statSync(path).size } catch { /* ignore inaccessible entries */ } }
    }
  }
  walk(backupDir, 0)
  return { bytes, count: readdirSync(backupDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length }
}
