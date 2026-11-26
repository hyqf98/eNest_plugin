import type { Client, ClientChannel, ConnectConfig } from 'ssh2'
import type { SshMonitorStatus, SshMonitorTarget, SshSystemSnapshot } from './contracts'
import { buildConnectConfig, loadSsh2, fingerprintOf } from './sshSessionManager'
import { snapshotWith, releaseSystemState, type RemoteRunner } from './sshSystem'
import { verifySshHost } from './sshTrust'
import { resolveSecret, pluginHost, acquirePluginActivity } from './hostBridge'
import { getRuntimeScope } from './runtimeScope'

/**
 * Background resource monitors for the server overview.
 *
 * A monitor authenticates and samples on one shared timer. It never opens a shell channel, never
 * joins the terminal session list and never prompts: profiles that need a person are left out by
 * the page, and anything that fails here backs off instead of retrying in a tight loop.
 */

interface Monitor {
  pluginId: string
  target: SshMonitorTarget
  /** Counter key handed to the sampler; prefixed so it can never collide with a terminal session id. */
  key: string
  client?: Client
  status: 'connecting' | 'live' | 'stale' | 'failed'
  error?: string
  sample?: SshSystemSnapshot
  sampledAt?: number
  attempts: number
  nextRetryAt?: number
  connecting?: Promise<void>
  sampling?: boolean
  releaseActivity?: () => void
  closed: boolean
}

const monitors = new Map<string, Monitor>()
const inFlight = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined
let intervalMs = 5000
/** Serialises sampling so a large fleet never opens every exec channel in the same instant. */
const SAMPLE_CONCURRENCY = 4
const MAX_MONITORS = 64
const RETRY_STEPS_MS = [5_000, 15_000, 60_000, 300_000]
export const MONITOR_KEY_PREFIX = 'monitor:'

export function monitorKey(pluginId: string, profileId: string): string { return `${pluginId}\u0000${profileId}` }

function statusOf(monitor: Monitor): SshMonitorStatus {
  const status: SshMonitorStatus = { profileId: monitor.target.profileId, state: monitor.status, attempts: monitor.attempts }
  if (monitor.error) status.error = monitor.error
  if (monitor.sample) { status.sample = monitor.sample; status.sampledAt = monitor.sampledAt }
  if (monitor.nextRetryAt) status.nextRetryAt = monitor.nextRetryAt
  return status
}

function emit(monitor: Monitor): void {
  pluginHost.sendEvent(monitor.pluginId, { type: 'ssh.monitor', profileId: monitor.target.profileId, status: statusOf(monitor) })
}

function owns(monitor: Monitor): boolean {
  const scope = getRuntimeScope(monitor.pluginId)
  return !monitor.closed && !!scope && scope.isCurrent()
}

function friendlyError(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error)
  const low = text.toLowerCase()
  if (/指纹|fingerprint|尚未信任/.test(text)) return text
  if (/authentication|permission denied|publickey|password secret|required|private key|privatekey|ssh_auth_sock|agent|all configured/.test(low)) return '认证失败，请检查登录凭据'
  if (/timeout|timed out|超时/.test(low)) return '连接超时'
  if (/econnrefused|refused/.test(low)) return '连接被拒绝'
  if (/enotfound|getaddrinfo/.test(low)) return '域名解析失败'
  if (/ehostunreach|enetunreach|network is unreachable/.test(low)) return '网络不可达'
  return text.length > 120 ? text.slice(0, 120) : text
}

function dropClient(monitor: Monitor): void {
  const client = monitor.client
  monitor.client = undefined
  if (!client) return
  try { client.removeAllListeners(); client.end() } catch { /* already closed */ }
}

function markStale(monitor: Monitor, message: string): void {
  monitor.client = undefined
  monitor.status = monitor.sample ? 'stale' : 'failed'
  monitor.error = message
  monitor.releaseActivity?.(); monitor.releaseActivity = undefined
  releaseSystemState(monitor.key)
  emit(monitor)
}

/** Resolves once the client is ready; rejects with the handshake error. The close handler outlives it. */
function handshake(client: Client, cfg: ConnectConfig, monitor: Monitor): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let trustError: Error | undefined
    const finish = (error?: Error) => { clearTimeout(limit); client.removeListener('ready', onReady); client.removeListener('error', onError); client.removeListener('close', onClose); error ? reject(error) : resolve() }
    const onReady = () => finish()
    const onError = (error: Error) => finish(trustError || error)
    const onClose = () => finish(trustError || new Error(monitor.error || '连接被服务器关闭'))
    const limit = setTimeout(() => { finish(new Error('连接超时')); try { client.destroy() } catch { /* gone */ } }, cfg.readyTimeout || 20_000)
    const verifier = cfg as ConnectConfig & { hostVerifier?: unknown }
    verifier.hostVerifier = (key: Buffer, callback: (valid: boolean) => void) => {
      void verifySshHost(monitor.pluginId, monitor.target.host, monitor.target.port || 22, fingerprintOf(key), monitor.target.fingerprintPolicy).then(
        () => callback(owns(monitor)),
        error => { trustError = error as Error; callback(false) }
      )
    }
    client.once('ready', onReady).once('error', onError).once('close', onClose)
    try { client.connect(cfg) } catch (error) { finish(error as Error) }
  })
}

async function connect(monitor: Monitor): Promise<void> {
  if (monitor.client) return
  if (monitor.connecting) return monitor.connecting
  const { pluginId, target } = monitor
  monitor.connecting = (async () => {
    const scope = getRuntimeScope(pluginId)
    if (!scope || !scope.isCurrent()) throw new Error('插件运行时已关闭')
    // The vault secret is resolved here and handed over once; it is never stored on the monitor.
    const secret = target.secretRef ? await resolveSecret(pluginId, target.secretRef) : null
    if (!owns(monitor)) throw new Error('监控已取消')
    const cfg = await buildConnectConfig({ ...target, ...(secret ? { ephemeralSecret: secret } : {}) }, pluginId)
    if (!owns(monitor)) throw new Error('监控已取消')
    const { Client } = await loadSsh2()
    const client = new Client()
    client.on('error', () => { /* the close handler owns the recovery path */ })
    client.on('close', () => { if (monitor.client === client && owns(monitor)) { markStale(monitor, '连接已断开，等待重连'); void cycle(monitor) } })
    await handshake(client, cfg, monitor)
    if (!owns(monitor)) { client.removeAllListeners(); client.destroy(); throw new Error('监控已取消') }
    monitor.client = client
    monitor.status = 'live'
    monitor.error = undefined
    monitor.releaseActivity?.()
    monitor.releaseActivity = acquirePluginActivity(pluginId, 'monitor', `SSH 资源监控 ${target.username}@${target.host}`)
  })()
  try { await monitor.connecting } finally { monitor.connecting = undefined }
}

function runner(monitor: Monitor): RemoteRunner {
  return (command, timeoutMs = 12_000) => new Promise<string>((resolve, reject) => {
    const client = monitor.client
    if (!client) return reject(new Error('连接已断开'))
    let settled = false, stdout = '', stderr = '', bytes = 0
    let channel: ClientChannel | undefined
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(limit); if (error) { try { channel?.destroy() } catch { /* gone */ } reject(error) } else resolve(stdout) }
    const limit = setTimeout(() => finish(new Error('采样超时')), timeoutMs)
    try {
      client.exec(command, (error, stream) => {
        if (error) return finish(error as Error)
        channel = stream
        stream.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 1024 * 1024) return finish(new Error('采样输出过大')); stdout += data.toString('utf8') })
        stream.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf8') })
        stream.once('error', (err: Error) => finish(err))
        stream.once('close', (code: number) => finish(code !== 0 && !stdout.trim() ? new Error((stderr.trim() || `远程命令失败 (${code})`).slice(0, 200)) : undefined))
      })
    } catch (error) { finish(error as Error) }
  })
}

async function sample(monitor: Monitor): Promise<void> {
  if (monitor.sampling) return
  monitor.sampling = true
  try {
    const value = await snapshotWith(monitor.key, runner(monitor))
    if (!owns(monitor)) return
    monitor.sample = value
    monitor.sampledAt = value.ts || Date.now()
    monitor.status = 'live'
    monitor.error = undefined
    monitor.attempts = 0
    monitor.nextRetryAt = undefined
    emit(monitor)
  } catch (error) {
    if (!owns(monitor)) return
    // A failed read keeps the last reading on screen and marks it stale rather than wiping the row.
    monitor.status = monitor.sample ? 'stale' : 'failed'
    monitor.error = friendlyError(error)
    monitor.attempts++
    monitor.nextRetryAt = Date.now() + RETRY_STEPS_MS[Math.min(monitor.attempts - 1, RETRY_STEPS_MS.length - 1)]
    emit(monitor)
  } finally { monitor.sampling = false }
}

/** Connect if needed, then sample once. Never throws: every failure becomes a status with backoff. */
async function cycle(monitor: Monitor): Promise<void> {
  if (!owns(monitor) || inFlight.has(monitor.key)) return
  inFlight.add(monitor.key)
  try {
    if (monitor.nextRetryAt && Date.now() < monitor.nextRetryAt) return
    if (!monitor.client) {
      if (monitor.status !== 'connecting') { monitor.status = 'connecting'; emit(monitor) }
      try { await connect(monitor) }
      catch (error) {
        dropClient(monitor)
        if (!owns(monitor)) return
        monitor.status = monitor.sample ? 'stale' : 'failed'
        monitor.error = friendlyError(error)
        monitor.attempts++
        monitor.nextRetryAt = Date.now() + RETRY_STEPS_MS[Math.min(monitor.attempts - 1, RETRY_STEPS_MS.length - 1)]
        emit(monitor)
        return
      }
    }
    await sample(monitor)
  } finally { inFlight.delete(monitor.key) }
}

function restartTimer(): void {
  if (timer) clearInterval(timer)
  timer = monitors.size ? setInterval(() => void runRound(), intervalMs) : undefined
  if (timer) timer.unref?.()
}

async function runRound(): Promise<void> {
  const now = Date.now()
  const due = [...monitors.values()].filter(monitor => owns(monitor) && !(monitor.nextRetryAt && now < monitor.nextRetryAt))
  let cursor = 0
  const worker = async () => { while (cursor < due.length) await cycle(due[cursor++]) }
  await Promise.all(Array.from({ length: Math.min(SAMPLE_CONCURRENCY, due.length) }, worker))
}

function normalizeTarget(raw: SshMonitorTarget): SshMonitorTarget | null {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.profileId !== 'string' || !raw.profileId || raw.profileId.length > 160) return null
  if (typeof raw.host !== 'string' || !raw.host || raw.host.length > 255) return null
  if (typeof raw.username !== 'string' || !raw.username || raw.username.length > 64) return null
  const port = raw.port == null ? 22 : Number(raw.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (raw.secretRef != null && (typeof raw.secretRef !== 'string' || !raw.secretRef || raw.secretRef.length > 512)) return null
  if (raw.privateKeyHandleId != null && (typeof raw.privateKeyHandleId !== 'string' || !raw.privateKeyHandleId || raw.privateKeyHandleId.length > 512)) return null
  const stringField = (value: unknown, max: number): string | undefined => typeof value === 'string' && value && value.length <= max ? value : undefined
  const bounded = (value: unknown, min: number, max: number, fallback: number): number => { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? n : fallback }
  const jumps = Array.isArray(raw.jumps)
    ? raw.jumps.slice(0, 8).flatMap(hop => hop && typeof hop.host === 'string' && hop.host && typeof hop.username === 'string' && hop.username ? [{
        host: hop.host.slice(0, 255), port: bounded(hop.port, 1, 65535, 22), username: hop.username.slice(0, 64),
        authType: hop.authType, privateKeyHandleId: stringField(hop.privateKeyHandleId, 512), secretRef: stringField(hop.secretRef, 512),
      }] : [])
    : []
  const proxy = raw.proxy && typeof raw.proxy === 'object' && typeof raw.proxy.host === 'string' && raw.proxy.host && (raw.proxy.type === 'http-connect' || raw.proxy.type === 'socks5')
    ? { type: raw.proxy.type, host: raw.proxy.host.slice(0, 255), port: bounded(raw.proxy.port, 1, 65535, 1080), username: stringField(raw.proxy.username, 64), secretRef: stringField(raw.proxy.secretRef, 512) }
    : undefined
  return {
    profileId: raw.profileId, host: raw.host, port, username: raw.username,
    authType: raw.authType && ['password', 'key', 'agent', 'keyboard-interactive'].includes(raw.authType) ? raw.authType : undefined,
    secretRef: stringField(raw.secretRef, 512), privateKeyHandleId: stringField(raw.privateKeyHandleId, 512),
    fingerprintPolicy: raw.fingerprintPolicy === 'accept-new' || raw.fingerprintPolicy === 'strict' ? raw.fingerprintPolicy : undefined,
    keepAliveSec: bounded(raw.keepAliveSec, 0, 600, 30), timeoutMs: bounded(raw.timeoutMs, 1000, 120000, 20000),
    ...(jumps.length ? { jumps } : {}), ...(proxy ? { proxy } : {}),
  }
}

function releaseMonitor(monitor: Monitor): void {
  monitor.closed = true
  monitor.releaseActivity?.()
  dropClient(monitor)
  releaseSystemState(monitor.key)
  monitors.delete(monitorKey(monitor.pluginId, monitor.target.profileId))
}

/** Reconciles the monitored set to `targets`: new ones start, missing ones are released, the rest keep their connection. */
export async function sshMonitorSync(pluginId: string, targets: SshMonitorTarget[]): Promise<SshMonitorStatus[]> {
  if (!Array.isArray(targets)) throw new Error('监控目标格式无效')
  if (targets.length > MAX_MONITORS) throw new Error(`一次最多监控 ${MAX_MONITORS} 台服务器`)
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent()) throw new Error('插件运行时已关闭')
  const wanted = new Map<string, SshMonitorTarget>()
  for (const raw of targets) {
    const target = normalizeTarget(raw)
    if (target) wanted.set(monitorKey(pluginId, target.profileId), target)
  }
  for (const [key, monitor] of monitors) if (monitor.pluginId === pluginId && !wanted.has(key)) releaseMonitor(monitor)
  for (const [key, target] of wanted) {
    const existing = monitors.get(key)
    if (existing) {
      // A changed secret or host must reconnect; an unchanged target keeps its live connection.
      if (JSON.stringify(existing.target) === JSON.stringify(target)) continue
      releaseMonitor(existing)
    }
    monitors.set(key, { pluginId, target, key: MONITOR_KEY_PREFIX + target.profileId, status: 'connecting', attempts: 0, closed: false })
  }
  restartTimer()
  void runRound()
  return sshMonitorList(pluginId)
}

export function sshMonitorList(pluginId: string): SshMonitorStatus[] {
  return [...monitors.values()].filter(monitor => monitor.pluginId === pluginId).map(statusOf)
}

/** Clears backoff so the next round retries immediately; omit ids to refresh everything. */
export function sshMonitorRefresh(pluginId: string, profileIds?: string[]): SshMonitorStatus[] {
  const wanted = profileIds?.length ? new Set(profileIds) : undefined
  for (const monitor of monitors.values()) {
    if (monitor.pluginId !== pluginId || (wanted && !wanted.has(monitor.target.profileId))) continue
    monitor.attempts = 0
    monitor.nextRetryAt = undefined
  }
  void runRound()
  return sshMonitorList(pluginId)
}

export function sshMonitorStop(pluginId: string, profileIds?: string[]): boolean {
  const wanted = profileIds?.length ? new Set(profileIds) : undefined
  for (const [key, monitor] of monitors) {
    if (monitor.pluginId !== pluginId || (wanted && !wanted.has(monitor.target.profileId))) continue
    releaseMonitor(monitor)
  }
  restartTimer()
  return true
}

/** Page left or plugin closing: drop every monitor for this plugin without waiting on the network. */
export function releaseMonitors(pluginId: string): void {
  for (const [key, monitor] of monitors) if (monitor.pluginId === pluginId) releaseMonitor(monitor)
  restartTimer()
}

export function setMonitorInterval(ms: number): void {
  intervalMs = Math.max(2000, Math.min(60_000, Math.round(Number(ms) || 5000)))
  restartTimer()
}

/** Test seam: drops all state without emitting events. */
export function resetMonitorsForTests(): void { for (const monitor of [...monitors.values()]) releaseMonitor(monitor); inFlight.clear() }
