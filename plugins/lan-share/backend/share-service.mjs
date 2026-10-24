import { createServer } from 'node:http'
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
export const MAX_FILES = 64
export const MAX_CONNECTIONS = 8
export const READ_CHUNK_BYTES = 64 * 1024
const MAX_SHARES = 4
const MAX_REQUESTS_PER_SECOND = 64

export function lanIpv4Addresses(interfaces = networkInterfaces()) {
  const addresses = Object.values(interfaces).flatMap(list => list || [])
    .filter(net => net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.'))
    .map(net => net.address)
  const local = ip => ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  return [...new Set(addresses)].sort((a, b) => Number(local(b)) - Number(local(a)))
}

export function verifyShareCode(provided, expected) {
  return typeof provided === 'string' && /^\d{6}$/.test(provided)
    && timingSafeEqual(Buffer.from(provided), expected)
}

export function parseRange(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || !size || (!match[1] && !match[2])) throw new Error('range not satisfiable')
  let start, end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new Error('range not satisfiable')
    start = Math.max(0, size - suffix); end = size - 1
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('range not satisfiable')
    end = Math.min(size - 1, end)
  }
  return { start, end, partial: true }
}

const MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.zip': 'application/zip', '.csv': 'text/csv; charset=utf-8'
}

function disposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function snapshot(entry) {
  return {
    shareId: entry.shareId, port: entry.port, code: entry.code,
    files: entry.files.map(({ id, name, size }) => ({ id, name, size })),
    ips: [...entry.ips], startedAt: entry.startedAt, expiresAt: entry.expiresAt,
    stopped: entry.stopped, ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
    activeConnections: entry.sockets.size, downloads: entry.downloads
  }
}

/** All sharing policy lives here; the host only supplies selected-file capabilities. */
export function createLanShareService({ hostRequest, emit, listenHost = '0.0.0.0',
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, interfaces = networkInterfaces } = {}) {
  const shares = new Map(), completed = new Map(), starts = new Set()
  let closed = false, shutdown, activeTransfers = 0
  const assertOpen = () => { if (closed) throw new Error('plugin backend is closing') }
  const publish = (event, data) => { if (!closed) emit(event, data) }
  const closeFile = token => hostRequest('files.close', { token })
  async function closeFiles(files) {
    const failures = []
    for (let index = 0; index < files.length; index += 8) {
      const results = await Promise.allSettled(files.slice(index, index + 8).map(file => closeFile(file.token)))
      failures.push(...results.filter(result => result.status === 'rejected'))
    }
    if (failures.length) throw failures[0].reason
  }

  function publishStatus(entry) {
    if (closed || entry.stopped || entry.statusTimer) return
    entry.statusTimer = setTimer(() => {
      entry.statusTimer = undefined
      if (!entry.stopped) publish('lan.status', snapshot(entry))
    }, 100)
    entry.statusTimer.unref?.()
  }

  function stopEntry(entry, reason) {
    if (entry.stop) return entry.stop
    entry.stopped = true; entry.stopReason = reason
    if (entry.timer) clearTimer(entry.timer)
    if (entry.statusTimer) clearTimer(entry.statusTimer)
    for (const controller of entry.transfers) controller.abort(new Error('share stopped'))
    // Destroy idle, active and upgraded sockets; close() alone leaves keep-alive work alive.
    for (const socket of entry.sockets) socket.destroy()
    const serverClosed = new Promise(resolve => entry.server.close(() => resolve()))
    entry.stop = (async () => {
      await Promise.allSettled([serverClosed, ...entry.jobs])
      let failure
      try { await closeFiles(entry.files) } catch (error) { failure = error }
      try { await hostRequest('activity.release', { token: entry.activityToken }) } catch (error) { failure ??= error }
      shares.delete(entry.shareId)
      const status = snapshot(entry)
      completed.set(entry.shareId, status)
      if (completed.size > 32) completed.delete(completed.keys().next().value)
      publish('lan.stopped', { shareId: entry.shareId, reason, status })
      if (failure) throw failure
    })()
    return entry.stop
  }

  function request(entry, req, res) {
    const send = (status, body, headers = {}) => {
      if (res.destroyed || res.headersSent) return
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (closed || entry.stopped) { send(403, 'share stopped'); return }
    if (activeTransfers >= MAX_CONNECTIONS) { send(503, 'too many downloads'); return }
    const window = Math.floor(now() / 1000)
    if (entry.requestWindow !== window) { entry.requestWindow = window; entry.requests = 0 }
    if (++entry.requests > MAX_REQUESTS_PER_SECOND) { send(429, 'too many requests', { 'retry-after': '1' }); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, 'GET or HEAD only', { allow: 'GET, HEAD' }); return }
    let url
    try { url = new URL(req.url || '/', 'http://lan.share.local') } catch { send(400, 'invalid URL'); return }
    const id = /^\/d\/([a-f0-9-]+)$/.exec(url.pathname)?.[1]
    const file = entry.files.find(item => item.id === id)
    if (!file) { send(404, 'not found'); return }
    if (!verifyShareCode(url.searchParams.get('code'), entry.codeBuffer)) { send(403, 'invalid code'); return }
    let range
    try { range = parseRange(req.headers.range, file.size) }
    catch { send(416, 'range not satisfiable', { 'content-range': `bytes */${file.size}` }); return }
    const controller = new AbortController()
    entry.transfers.add(controller)
    activeTransfers++
    const abort = () => { if (!res.writableFinished) controller.abort(new Error('download connection closed')) }
    res.once('close', abort)
    const active = () => { if (closed || entry.stopped || controller.signal.aborted) throw new Error('download cancelled') }
    const read = async (offset, length) => {
      active()
      const result = await hostRequest('files.read', { token: file.token, offset, length })
      active()
      if (!(result?.bytes instanceof Uint8Array) || !Number.isSafeInteger(result.bytesRead)
        || result.bytesRead < 0 || result.bytesRead > length || result.bytes.length !== result.bytesRead) throw new Error('invalid selected file block')
      return Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength)
    }
    const transfer = (async () => {
      const length = range.end - range.start + 1
      // Read before headers, including HEAD/empty files, to detect changed or revoked grants.
      const first = await read(range.start, Math.max(1, req.method === 'HEAD' ? Math.min(1, length) : Math.min(READ_CHUNK_BYTES, length)))
      if (first.length !== Math.min(req.method === 'HEAD' ? 1 : READ_CHUNK_BYTES, length)) throw new Error('selected file changed')
      const headers = {
        'content-type': MIME_BY_EXT[extname(file.name).toLowerCase()] || 'application/octet-stream',
        'content-disposition': disposition(file.name), 'content-length': String(length),
        'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
      }
      if (range.partial) headers['content-range'] = `bytes ${range.start}-${range.end}/${file.size}`
      res.writeHead(range.partial ? 206 : 200, headers)
      publish('lan.request', { shareId: entry.shareId, file: file.name,
        ip: req.socket.remoteAddress?.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1') || 'unknown', ts: now() })
      if (req.method === 'HEAD') { res.end(); return }
      async function* blocks() {
        let offset = range.start
        if (first.length) { yield first; offset += first.length }
        while (offset <= range.end) {
          const size = Math.min(READ_CHUNK_BYTES, range.end - offset + 1)
          const chunk = await read(offset, size)
          if (chunk.length !== size) throw new Error('selected file changed')
          yield chunk; offset += chunk.length
        }
      }
      await pipeline(Readable.from(blocks(), { objectMode: false, highWaterMark: READ_CHUNK_BYTES }), res, { signal: controller.signal })
      if (!range.partial && !entry.stopped && res.writableFinished) entry.downloads++
    })().catch(() => {
      if (!res.headersSent) send(410, 'selected file changed or unavailable')
      else res.destroy()
    }).finally(() => {
      res.removeListener('close', abort)
      entry.transfers.delete(controller); entry.jobs.delete(transfer)
      activeTransfers--
      publishStatus(entry)
    })
    entry.jobs.add(transfer)
  }

  async function startInner(input) {
    assertOpen()
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid share options')
    const items = input.files
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_FILES) throw new Error('select between 1 and 64 files')
    if (items.some(item => !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.handleId !== 'string' || item.handleId.length > 128 || !item.handleId
      || Object.keys(item).some(key => key !== 'handleId'))) throw new Error('only selected file handles may be shared')
    if (new Set(items.map(item => item.handleId)).size !== items.length) throw new Error('duplicate selected file handle')
    if (input.minutes !== undefined && (!Number.isFinite(input.minutes) || input.minutes < 1 || input.minutes > 120)) throw new Error('share minutes must be between 1 and 120')
    const minutes = Math.round(input.minutes ?? 10), files = [], activityToken = randomUUID()
    let server, activity = false, entry
    try {
      for (const item of items) {
        const file = await hostRequest('files.open', { handleId: item.handleId })
        if (typeof file?.token !== 'string' || !file.token) throw new Error('invalid selected file token')
        files.push({ id: randomUUID(), token: file.token, name: file.name, size: file.size })
        assertOpen()
        if (typeof file.name !== 'string' || !file.name || file.name.length > 1024
          || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) throw new Error('selected file is invalid or larger than 4 GiB')
      }
      // Retain only active shares, not an idle native backend, as a hibernation barrier.
      await hostRequest('activity.acquire', { token: activityToken, reason: 'lan-file-share' }); activity = true
      assertOpen()
      entry = { shareId: `lan-${randomUUID()}`, files, activityToken, code: String(randomInt(1_000_000)).padStart(6, '0'),
        ips: lanIpv4Addresses(interfaces()), port: 0, startedAt: now(), expiresAt: now() + minutes * 60_000,
        stopped: false, downloads: 0, sockets: new Set(), transfers: new Set(), jobs: new Set(), requests: 0 }
      entry.codeBuffer = Buffer.from(entry.code)
      server = createServer((req, res) => request(entry, req, res)); entry.server = server
      server.maxRequestsPerSocket = 100
      server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000
      server.on('connection', socket => {
        if (closed || entry.stopped || entry.sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return }
        entry.sockets.add(socket)
        socket.setTimeout(30_000, () => socket.destroy())
        socket.once('close', () => { entry.sockets.delete(socket); publishStatus(entry) })
        publishStatus(entry)
      })
      server.on('upgrade', (_req, socket) => socket.destroy())
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, listenHost, () => { server.removeListener('error', reject); resolve() })
      })
      assertOpen()
      server.on('error', () => { void stopEntry(entry, 'server failed').catch(() => {}) })
      entry.port = server.address().port
      shares.set(entry.shareId, entry)
      entry.timer = setTimer(() => { void stopEntry(entry, 'expired').catch(() => {}) }, minutes * 60_000)
      entry.timer.unref?.()
      return snapshot(entry)
    } catch (error) {
      if (entry?.statusTimer) clearTimer(entry.statusTimer)
      if (entry) for (const socket of entry.sockets) socket.destroy()
      if (server) await new Promise(resolve => server.close(() => resolve()))
      await closeFiles(files).catch(() => {})
      if (activity) await hostRequest('activity.release', { token: activityToken }).catch(() => {})
      throw error
    }
  }

  return {
    start(input) {
      if (closed) return Promise.reject(new Error('plugin backend is closing'))
      if (shares.size + starts.size >= MAX_SHARES) return Promise.reject(new Error('active share limit reached'))
      const job = startInner(input).finally(() => starts.delete(job))
      starts.add(job)
      return job
    },
    status(shareId) { return shares.has(shareId) ? snapshot(shares.get(shareId)) : completed.get(shareId) || null },
    list() { return [...shares.values()].map(snapshot) },
    async stop(shareId) {
      const entry = shares.get(shareId)
      if (!entry) return false
      await stopEntry(entry, 'stopped by plugin')
      return true
    },
    shutdown() {
      if (shutdown) return shutdown
      closed = true
      shutdown = Promise.all([Promise.allSettled([...starts]), Promise.allSettled([...shares.values()].map(entry => stopEntry(entry, 'plugin runtime released')))]).then(([, stops]) => {
        completed.clear()
        const failure = stops.find(result => result.status === 'rejected')
        if (failure) throw failure.reason
      })
      return shutdown
    }
  }
}
