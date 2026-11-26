/**
 * Server overview data layer: turns saved profiles into monitored rows without touching the DOM.
 *
 * Split rule: a profile that can sign in unattended (saved password, an already granted private
 * key, or a plain connection) is handed to the backend monitor. Anything that would make a person
 * answer a prompt (missing password, ungranted key, interactive auth, SSH Agent, first-time
 * trust) is reported as `manual` and never sent, so the overview can never open a dialog by itself.
 */

const HISTORY_LENGTH = 40

const MANUAL_TEXT = {
  password: '未保存登录密码',
  key: '私钥文件尚未授权',
  interactive: '需要交互认证',
  trust: '严格校验，尚未信任',
  agent: '需要授权 SSH Agent',
}

export function bytesText(value) {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)} TB`
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)} GB`
  if (value >= 1048576) return `${(value / 1048576).toFixed(0)} MB`
  return `${(value / 1024).toFixed(0)} KB`
}

export function rateText(kbps) {
  if (!Number.isFinite(kbps)) return '—'
  if (kbps >= 1048576) return `${(kbps / 1048576).toFixed(2)} GB/s`
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`
  return `${Math.round(kbps)} KB/s`
}

export function uptimeText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600)
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时` : `${Math.floor((seconds % 3600) / 60)} 分钟`
}

export function percentText(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
}

/** Sum of rx+tx across interfaces; undefined until the server has produced a second sample. */
export function networkTotal(sample) {
  if (!Array.isArray(sample?.net) || !sample.net.length) return undefined
  return sample.net.reduce((sum, item) => sum + (Number(item.rxKbps) || 0) + (Number(item.txKbps) || 0), 0)
}

/** The mount that matters most on a card: the widest mount under a name, else the first entry. */
export function rootDisk(sample) {
  const disks = Array.isArray(sample?.disks) ? sample.disks : []
  return disks.find(disk => disk.mount === '/') || disks[0] || null
}

export const sumGpu = sample => {
  const gpus = Array.isArray(sample?.gpus) ? sample.gpus : []
  if (!gpus.length) return null
  const withUtil = gpus.filter(gpu => Number.isFinite(gpu.utilPercent))
  const withMem = gpus.filter(gpu => Number.isFinite(gpu.vramTotal) && gpu.vramTotal > 0)
  const used = withMem.reduce((sum, gpu) => sum + (gpu.vramUsed || 0), 0)
  const total = withMem.reduce((sum, gpu) => sum + gpu.vramTotal, 0)
  return {
    count: gpus.length,
    name: gpus[0]?.name || '',
    utilPercent: withUtil.length ? withUtil.reduce((sum, gpu) => sum + gpu.utilPercent, 0) / withUtil.length : undefined,
    vramUsed: withMem.length ? used : undefined,
    vramTotal: withMem.length ? total : undefined,
    memPercent: total ? used / total * 100 : undefined,
    tempC: gpus.map(gpu => gpu.tempC).filter(value => Number.isFinite(value)).sort((a, b) => b - a)[0],
  }
}

/**
 * Returns null when the profile can sign in unattended, otherwise the reason it cannot.
 * Mirrors the prompts `completePayloadCredentials` would show, one branch per dialog.
 */
export function manualReason(profile, context) {
  const auth = profile.authType || (profile.privateKeyHandleId || profile.privateKeyHint ? 'key' : 'password')
  if (auth === 'keyboard-interactive') return 'interactive'
  if (auth === 'agent') return 'agent'
  if (auth === 'key' && !context.hasKeyHandle(profile.privateKeyHandleId)) return 'key'
  if (auth === 'password' && !profile.secretRef) return 'password'
  for (const hop of Array.isArray(profile.jumps) && profile.jumps.length ? profile.jumps : profile.jump?.host ? [profile.jump] : []) {
    const hopAuth = hop.authType || (hop.privateKeyHandleId || hop.privateKeyHint ? 'key' : 'password')
    if (hopAuth === 'keyboard-interactive') return 'interactive'
    if (hopAuth === 'agent') return 'agent'
    if (hopAuth === 'key' && !context.hasKeyHandle(hop.privateKeyHandleId)) return 'key'
    if (hopAuth === 'password' && !hop.secretRef) return 'password'
  }
  if (profile.proxy?.username && !profile.proxy.secretRef) return 'password'
  // `tofu` and `accept-new` record a new fingerprint silently, so only `strict` needs a person first.
  const known = context.trusted?.some(host => host.host === profile.host && Number(host.port || 22) === Number(profile.port || 22))
  if (!known && profile.fingerprintPolicy === 'strict') return 'trust'
  return null
}

export function manualText(reason) { return MANUAL_TEXT[reason] || '需要登录' }

function targetOf(profile) {
  const auth = profile.authType || (profile.privateKeyHandleId || profile.privateKeyHint ? 'key' : 'password')
  const hops = Array.isArray(profile.jumps) && profile.jumps.length ? profile.jumps : profile.jump?.host ? [profile.jump] : []
  return {
    profileId: profile.id, host: profile.host, port: Number(profile.port) || 22, username: profile.username, authType: auth,
    secretRef: profile.secretRef || undefined,
    // Only a handle granted in this runtime may travel; a stale id would fail at the host anyway.
    privateKeyHandleId: auth === 'key' ? profile.privateKeyHandleId || undefined : undefined,
    fingerprintPolicy: profile.fingerprintPolicy || 'tofu', keepAliveSec: Number(profile.keepAliveSec) || 30,
    timeoutMs: Number(profile.timeoutMs) || 20000,
    jumps: hops.map(hop => ({
      host: hop.host, port: Number(hop.port) || 22, username: hop.username,
      authType: hop.authType || (hop.privateKeyHandleId || hop.privateKeyHint ? 'key' : 'password'),
      privateKeyHandleId: hop.authType === 'key' || !hop.authType ? hop.privateKeyHandleId || undefined : undefined,
      secretRef: hop.secretRef || undefined,
    })),
    ...(profile.proxy?.type && profile.proxy.host ? { proxy: { type: profile.proxy.type, host: profile.proxy.host, port: Number(profile.proxy.port) || 1080, username: profile.proxy.username || undefined, secretRef: profile.proxy.secretRef || undefined } } : {}),
  }
}

export function createServerOverview({ monitor, profiles, hasKeyHandle, trusted, sessionProfileIds = () => new Set(), onChange }) {
  const rows = new Map()
  let synced = false

  function ensure(profile) {
    let row = rows.get(profile.id)
    if (!row) { row = { profileId: profile.id, state: 'idle', series: { cpu: [], mem: [], gpu: [], net: [] }, attempts: 0 }; rows.set(profile.id, row) }
    return row
  }

  function push(row, key, value) {
    if (!Number.isFinite(value)) return
    row.series[key].push(value)
    if (row.series[key].length > HISTORY_LENGTH) row.series[key].shift()
  }

  function absorb(row, sample, sampledAt) {
    row.sample = sample
    row.sampledAt = sampledAt || sample.ts
    push(row, 'cpu', sample.cpuPercent)
    push(row, 'mem', sample.memPercent)
    push(row, 'gpu', sumGpu(sample)?.utilPercent)
    push(row, 'net', networkTotal(sample))
  }

  /** Monitor push. The backend owns these connections, so its state is authoritative. */
  function applyStatus(status) {
    const row = rows.get(status.profileId)
    if (!row) return
    row.state = status.state
    row.error = status.error
    row.attempts = status.attempts || 0
    row.nextRetryAt = status.nextRetryAt
    if (status.sample) absorb(row, status.sample, status.sampledAt)
  }

  /** Terminal session sample. Readings feed the same row so no second connection is needed for that host. */
  function applySessionSample(profileId, sample) {
    const row = rows.get(profileId)
    if (!row || row.manualReason) return
    row.state = 'live'
    row.error = undefined
    absorb(row, sample, sample.ts)
  }

  /**
   * Reconciles the monitored set with the saved profiles. Call after any profile or session change.
   * Servers with a live terminal session are left out: their readings arrive through the session
   * (see applySessionSample), so the overview never opens a second connection to the same host.
   */
  async function sync() {
    const list = profiles()
    const live = new Set(list.map(profile => profile.id))
    const inSession = sessionProfileIds()
    for (const id of rows.keys()) if (!live.has(id)) rows.delete(id)
    const targets = []
    for (const profile of list) {
      const row = ensure(profile)
      if (inSession.has(profile.id)) { row.manualReason = undefined; continue }
      const reason = manualReason(profile, { hasKeyHandle, trusted: trusted() })
      row.manualReason = reason || undefined
      if (!reason) targets.push(targetOf(profile))
    }
    if (!targets.length) { if (synced) await monitor.stop(); synced = false; onChange?.(snapshot()); return }
    await monitor.sync(targets)
    synced = true
    onChange?.(snapshot())
  }

  function snapshot() {
    return [...rows.values()].map(row => ({
      profileId: row.profileId, state: row.manualReason ? 'manual' : row.state, manualReason: row.manualReason,
      error: row.error, sample: row.sample, sampledAt: row.sampledAt, series: row.series, attempts: row.attempts, nextRetryAt: row.nextRetryAt,
    }))
  }

  return {
    sync,
    applyStatus,
    applySessionSample,
    snapshot,
    get synced() { return synced },
    stop: () => { synced = false; return monitor.stop() },
    refresh: ids => monitor.refresh(ids),
    setInterval: ms => monitor.setInterval(ms),
  }
}
