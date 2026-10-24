import * as net from 'node:net'
import * as tls from 'node:tls'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { domainToASCII } from 'node:url'
import type { SshWorkerExtensionContext } from '@enest/ssh-backend/runtime'
import { openSocketProxy } from './socketProxy'
import { parseRdpCleanPathRequest, buildRdpCleanPathResponse, buildRdpCleanPathError, extractCertChain, validateX224Pdu } from './rdpProtocol'
import { decodeWsFrame, encodeWsBinary, encodeWsClose, encodeWsPong, handshakeResponse, WS_OPCODE } from './wsFrames'

const MAX_BRIDGES = 8
const MAX_STREAM_BYTES = 4 * 1024 * 1024
const MAX_HANDSHAKE_BYTES = 64 * 1024
const SEND_RATE = 1024 * 1024
const SEND_BURST = 2 * SEND_RATE

interface Bridge {
  id: string
  host: string
  port: number
  token: string
  server: net.Server
  localPort: number
  controller: AbortController
  clients: Set<net.Socket>
  client?: net.Socket
  raw?: net.Socket
  secure?: tls.TLSSocket
  buffer: Buffer
  fragments: Buffer[]
  fragmentBytes: number
  phase: 'request' | 'negotiating' | 'ready'
  pending: Buffer[]
  pendingBytes: number
  tokens: number
  tokenTime: number
  consumed: boolean
  closed: boolean
  activity: boolean
  endpoint: boolean
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
}

function target(input: unknown): { host: string; port: number } {
  const value = input as { host?: unknown; port?: unknown } | undefined
  let host = typeof value?.host === 'string' ? value.host.trim() : ''
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host || host.length > 253 || /[\s\x00-\x1f\x7f/@?#\\%]/.test(host)) throw new Error('RDP host invalid')
  if (!net.isIP(host)) {
    host = domainToASCII(host)
    if (!host || !/^[a-z0-9._-]+$/i.test(host)) throw new Error('RDP host invalid')
  }
  const port = value?.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RDP port invalid')
  return { host, port }
}

/** Never silently bypass a selected unsupported or failed proxy. */
export function parseProxyRoute(pac: string): { type: 'http-connect' | 'socks5'; host: string; port: number } | null {
  const route = String(pac).split(';', 1)[0].trim()
  if (route === 'DIRECT') return null
  const match = /^(PROXY|HTTP|SOCKS5)\s+(\[[^\]]+\]|[^:\s]+):(\d+)$/i.exec(route)
  if (!match) throw new Error('RDP cannot use the configured proxy rule')
  const address = target({ host: match[2], port: Number(match[3]) })
  return { type: /^(PROXY|HTTP)$/i.test(match[1]) ? 'http-connect' : 'socks5', ...address }
}

/** X.224 TCP records may be split across packets; stop exactly at the TPKT boundary. */
export function readX224Record(socket: net.Socket, signal: AbortSignal, timeoutMs = 10_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), done = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.removeListener('data', data).removeListener('error', fail).removeListener('end', ended).removeListener('close', ended)
    }
    const fail = (error: Error): void => { if (!done) { done = true; cleanup(); reject(error) } }
    const abort = (): void => fail(new Error('RDP connection closed'))
    const ended = (): void => fail(new Error('RDP server closed during X.224 negotiation'))
    const data = (chunk: Buffer): void => {
      if (buffer.length + chunk.length > 128 * 1024) { fail(new Error('RDP negotiation buffer exceeded')); return }
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const length = buffer.readUInt16BE(2)
      if (buffer[0] !== 3 || buffer[1] !== 0 || length < 11) { fail(new Error('Invalid RDP TPKT response')); return }
      if (buffer.length < length) return
      const record = buffer.subarray(0, length)
      try { validateX224Pdu(record, 'confirm') } catch (error) { fail(error as Error); return }
      done = true
      socket.pause()
      cleanup()
      if (buffer.length > length) socket.unshift(buffer.subarray(length))
      resolve(record)
    }
    const timer = setTimeout(() => fail(new Error('RDP X.224 negotiation timeout')), timeoutMs)
    timer.unref?.()
    socket.on('data', data).once('error', fail).once('end', ended).once('close', ended)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else socket.resume()
  })
}

export class RdpBridgeService {
  private bridges = new Map<string, Bridge>()
  private draining = new Map<net.Socket, ReturnType<typeof setTimeout>>()
  private releases = new Set<Promise<unknown>>()
  private disposed = false
  private detachScope: () => void

  constructor(private readonly context: SshWorkerExtensionContext) {
    this.detachScope = context.scope.addDisposer(() => this.dispose())
  }

  private assertCurrent(entry?: Bridge): void {
    if (this.disposed || !this.context.scope.isCurrent() || this.context.scope.signal.aborted || entry?.closed) throw new Error('RDP backend is closing')
  }

  private release(method: string, token: string): void {
    const pending = this.context.hostCall(method, { token }).catch(() => {})
    this.releases.add(pending)
    void pending.finally(() => this.releases.delete(pending))
  }

  private closeEntry(entry: Bridge): void {
    if (entry.closed) return
    entry.closed = true
    entry.controller.abort()
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.buffer = Buffer.alloc(0)
    entry.fragments = []
    entry.pending = []
    for (const client of entry.clients) client.destroy()
    entry.clients.clear()
    entry.secure?.destroy()
    entry.raw?.destroy()
    try { entry.server.close() } catch { /* not listening yet */ }
    if (entry.endpoint) { entry.endpoint = false; this.release('endpoint.revoke', entry.id) }
    if (entry.activity) { entry.activity = false; this.release('activity.release', entry.id) }
    this.bridges.delete(entry.id)
  }

  private failEntry(entry: Bridge): void {
    if (entry.closed) return
    const client = entry.phase === 'negotiating' ? entry.client : undefined
    if (client && !client.destroyed) {
      // An absolute deadline, not an idle timeout, bounds even a backpressured peer.
      const timer = setTimeout(() => client.destroy(), 1000)
      timer.unref?.()
      this.draining.set(client, timer)
      client.once('close', () => { clearTimeout(timer); this.draining.delete(client) })
      entry.clients.delete(client)
      entry.client = undefined
      try { client.end(Buffer.concat([encodeWsBinary(buildRdpCleanPathError(1)), encodeWsClose(1011)]), () => client.destroy()) }
      catch { client.destroy() }
    }
    this.closeEntry(entry)
  }

  async open(input: unknown): Promise<{ bridgeId: string; wsUrl: string }> {
    this.assertCurrent()
    const { host, port } = target(input)
    const origin = this.context.pageOrigin
    if (!origin || origin !== 'enest://plugin' && !/^https?:\/\/[^/]+$/.test(origin)) throw new Error('RDP page origin unavailable')
    if (this.bridges.size + this.draining.size >= MAX_BRIDGES) throw new Error('RDP socket limit reached (8)')
    const entry: Bridge = {
      id: `rdp-${randomUUID()}`, host, port, token: randomBytes(32).toString('hex'),
      server: undefined as never, localPort: 0, controller: new AbortController(), clients: new Set(),
      buffer: Buffer.alloc(0), fragments: [], fragmentBytes: 0, phase: 'request', pending: [], pendingBytes: 0,
      tokens: SEND_BURST, tokenTime: Date.now(), consumed: false, closed: false, activity: false, endpoint: false, expiresAt: 0
    }
    entry.server = net.createServer(client => this.accept(entry, client, origin))
    entry.server.on('error', () => this.closeEntry(entry))
    this.bridges.set(entry.id, entry)
    try {
      await this.context.hostCall('activity.acquire', { token: entry.id, reason: 'Remote Desktop RDP connection' })
      entry.activity = true
      if (entry.closed) { entry.activity = false; this.release('activity.release', entry.id) }
      this.assertCurrent(entry)
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { cleanup(); reject(new Error('RDP backend is closing')) }
        const fail = (error: Error): void => { cleanup(); reject(error) }
        const cleanup = (): void => { entry.controller.signal.removeEventListener('abort', abort); entry.server.removeListener('error', fail) }
        entry.server.once('error', fail)
        entry.controller.signal.addEventListener('abort', abort, { once: true })
        entry.server.listen(0, '127.0.0.1', () => {
          cleanup()
          if (entry.closed) { entry.server.close(); reject(new Error('RDP backend is closing')); return }
          entry.localPort = (entry.server.address() as net.AddressInfo).port
          resolve()
        })
      })
      this.assertCurrent(entry)
      const url = `ws://127.0.0.1:${entry.localPort}/rdp`
      await this.context.hostCall('endpoint.allow', { token: entry.id, pid: process.pid, url, kind: 'webSocket' })
      entry.endpoint = true
      if (entry.closed) { entry.endpoint = false; this.release('endpoint.revoke', entry.id) }
      this.assertCurrent(entry)
      entry.expiresAt = Date.now() + 30_000
      entry.timer = setTimeout(() => this.closeEntry(entry), 30_000)
      entry.timer.unref?.()
      return { bridgeId: entry.id, wsUrl: `${url}?token=${entry.token}` }
    } catch (error) { this.closeEntry(entry); throw error }
  }

  close(id: unknown): void {
    if (typeof id !== 'string') throw new Error('RDP bridge id invalid')
    const entry = this.bridges.get(id)
    if (entry) this.closeEntry(entry)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.bridges.values()) this.closeEntry(entry)
    for (const [socket, timer] of this.draining) { clearTimeout(timer); socket.destroy() }
    this.draining.clear()
    this.detachScope?.()
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.releases]) }

  private accept(entry: Bridge, client: net.Socket, origin: string): void {
    if (entry.closed || entry.consumed || !entry.endpoint || entry.clients.size >= 4) { client.destroy(); return }
    entry.clients.add(client)
    let upgraded = false, header = Buffer.alloc(0)
    client.setTimeout(5000, () => { if (!upgraded) client.destroy() })
    client.on('error', () => client.destroy())
    client.on('close', () => { entry.clients.delete(client); if (entry.client === client) this.closeEntry(entry) })
    client.on('data', chunk => {
      try {
        this.assertCurrent(entry)
        if (!upgraded) {
          if (header.length + chunk.length > MAX_HANDSHAKE_BYTES + 16 * 1024) throw new Error('RDP WebSocket handshake too large')
          header = Buffer.concat([header, chunk])
          const boundary = header.indexOf('\r\n\r\n')
          if (boundary < 0) { if (header.length > 16 * 1024) throw new Error('WebSocket headers too large'); return }
          if (boundary > 16 * 1024) throw new Error('WebSocket headers too large')
          const lines = header.subarray(0, boundary).toString('latin1').split('\r\n')
          const match = /^GET (\/rdp\?token=([a-f0-9]{64})) HTTP\/1\.1$/.exec(lines.shift() ?? '')
          if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(entry.token))) throw new Error('Invalid WebSocket token')
          const headers = new Map<string, string>()
          for (const line of lines) {
            const split = line.indexOf(':')
            if (split <= 0) throw new Error('Invalid WebSocket header')
            const name = line.slice(0, split).toLowerCase(), value = line.slice(split + 1).trim()
            if (headers.has(name)) throw new Error('Duplicate WebSocket header')
            headers.set(name, value)
          }
          const key = headers.get('sec-websocket-key')
          if (entry.consumed || Date.now() > entry.expiresAt || headers.get('origin') !== origin
            || headers.get('host') !== `127.0.0.1:${entry.localPort}` || headers.get('upgrade')?.toLowerCase() !== 'websocket'
            || !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade')
            || headers.get('sec-websocket-version') !== '13'
            || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) throw new Error('Invalid WebSocket upgrade')
          entry.consumed = true
          upgraded = true
          entry.client = client
          if (entry.timer) clearTimeout(entry.timer)
          entry.timer = setTimeout(() => this.closeEntry(entry), 120_000)
          entry.timer.unref?.()
          client.setTimeout(0)
          // Browsers offer permessage-deflate by default; omit the response header to decline it.
          client.write(handshakeResponse(key))
          entry.buffer = header.subarray(boundary + 4)
          header = Buffer.alloc(0)
          for (const candidate of entry.clients) if (candidate !== client) candidate.destroy()
        } else {
          const budget = entry.phase === 'ready' ? MAX_STREAM_BYTES : MAX_HANDSHAKE_BYTES
          if (entry.buffer.length + chunk.length > budget + 14) throw new Error('RDP WebSocket buffer exceeded')
          entry.buffer = Buffer.concat([entry.buffer, chunk])
        }
        this.consume(entry)
      } catch { if (upgraded) this.closeEntry(entry); else client.destroy() }
    })
  }

  private consume(entry: Bridge): void {
    while (!entry.closed) {
      if (entry.buffer.length >= 2 && (!(entry.buffer[1] & 0x80) || (entry.buffer[0] & 0x70))) throw new Error('Invalid WebSocket frame')
      const decoded = decodeWsFrame(entry.buffer)
      if (!decoded) return
      entry.buffer = entry.buffer.subarray(decoded.offset)
      let { opcode, payload } = decoded.frame
      const { fin } = decoded.frame
      if (![0, 2, 8, 9, 10].includes(opcode) || opcode >= 8 && (!fin || payload.length > 125)) throw new Error('Invalid RDP WebSocket frame')
      const budget = entry.phase === 'ready' ? MAX_STREAM_BYTES : MAX_HANDSHAKE_BYTES
      if (opcode === WS_OPCODE.continuation) {
        if (!entry.fragments.length || entry.fragments.length >= 256) throw new Error('Invalid WebSocket continuation')
        entry.fragmentBytes += payload.length
        if (entry.fragmentBytes > budget) throw new Error('RDP fragmented message too large')
        entry.fragments.push(payload)
        if (!fin) continue
        payload = Buffer.concat(entry.fragments)
        opcode = WS_OPCODE.binary
        entry.fragments = []
        entry.fragmentBytes = 0
      } else if (opcode === WS_OPCODE.binary) {
        if (entry.fragments.length || payload.length > budget) throw new Error('Invalid RDP message')
        if (!fin) { entry.fragments = [payload]; entry.fragmentBytes = payload.length; continue }
      }
      if (opcode === WS_OPCODE.close) { this.closeEntry(entry); return }
      if (opcode === WS_OPCODE.ping) { this.send(entry, encodeWsPong(payload)); continue }
      if (opcode !== WS_OPCODE.binary || !payload.length) continue
      if (entry.phase === 'request') {
        const request = parseRdpCleanPathRequest(payload)
        entry.phase = 'negotiating'
        // The renderer's DER destination is not a routing authority; only rdp.open owns it.
        void this.negotiate(entry, request.x224ConnectionRequest).catch(() => this.failEntry(entry))
      } else if (entry.phase === 'negotiating') {
        if (entry.pending.length >= 256 || entry.pendingBytes + payload.length > MAX_HANDSHAKE_BYTES) throw new Error('RDP pre-approval buffer exceeded')
        entry.pending.push(payload)
        entry.pendingBytes += payload.length
      } else this.write(entry, payload)
    }
  }

  private send(entry: Bridge, frame: Buffer): void {
    const client = entry.client
    if (!client || client.destroyed || client.writableLength + frame.length > MAX_STREAM_BYTES) throw new Error('RDP receive buffer exceeded')
    client.write(frame)
  }

  private write(entry: Bridge, payload: Buffer): void {
    const now = Date.now()
    entry.tokens = Math.min(SEND_BURST, entry.tokens + Math.max(0, now - entry.tokenTime) * SEND_RATE / 1000)
    entry.tokenTime = now
    if (!entry.secure || payload.length > entry.tokens || entry.secure.writableLength + payload.length > SEND_BURST) throw new Error('RDP send buffer exceeded')
    entry.tokens -= payload.length
    entry.secure.write(payload)
  }

  private own(entry: Bridge, socket: net.Socket): void {
    entry.raw = socket
    socket.on('error', () => this.failEntry(entry))
    socket.on('close', () => this.failEntry(entry))
    if (entry.closed) socket.destroy()
  }

  private async connect(entry: Bridge): Promise<net.Socket> {
    const signal = entry.controller.signal
    let proxy = null
    if (!['localhost', '127.0.0.1', '::1'].includes(entry.host)) {
      const authority = net.isIP(entry.host) === 6 ? `[${entry.host}]` : entry.host
      const result = await this.context.hostCall<{ proxy: string }>('network.resolveProxy', { url: `https://${authority}:${entry.port}` })
      this.assertCurrent(entry)
      proxy = parseProxyRoute(result.proxy)
    }
    if (proxy) return openSocketProxy(proxy, entry, null, { signal, timeoutMs: 10_000, ownSocket: socket => this.own(entry, socket) })
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = new net.Socket()
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); socket.removeListener('error', fail).removeListener('connect', connected) }
      const fail = (error: Error): void => { cleanup(); socket.destroy(); reject(error) }
      const abort = (): void => fail(new Error('RDP connection closed'))
      const connected = (): void => { cleanup(); socket.pause(); resolve(socket) }
      const timer = setTimeout(() => fail(new Error('RDP connection timeout')), 10_000)
      timer.unref?.()
      this.own(entry, socket)
      socket.once('error', fail).once('connect', connected)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else socket.connect(entry.port, entry.host)
    })
  }

  private async negotiate(entry: Bridge, request: Buffer): Promise<void> {
    const raw = await this.connect(entry)
    this.assertCurrent(entry)
    const response = readX224Record(raw, entry.controller.signal)
    raw.write(request)
    const x224 = await response
    this.assertCurrent(entry)
    const secure = tls.connect({ socket: raw, rejectUnauthorized: false, servername: net.isIP(entry.host) ? undefined : entry.host })
    entry.secure = secure
    secure.pause()
    secure.on('error', () => this.failEntry(entry)).on('close', () => this.failEntry(entry))
    await new Promise<void>((resolve, reject) => {
      const signal = entry.controller.signal
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); secure.removeListener('error', fail).removeListener('secureConnect', connected) }
      const fail = (error: Error): void => { cleanup(); reject(error) }
      const abort = (): void => fail(new Error('RDP connection closed'))
      const connected = (): void => { cleanup(); resolve() }
      const timer = setTimeout(() => fail(new Error('RDP TLS handshake timeout')), 10_000)
      timer.unref?.()
      secure.once('error', fail).once('secureConnect', connected)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    this.assertCurrent(entry)
    const peer = secure.getPeerCertificate(true)
    if (!peer?.fingerprint256 || !peer.raw) throw new Error('RDP server certificate unavailable')
    const certificates = extractCertChain(peer)
    const approved = await this.context.hostCall<boolean>('dialog.confirm', {
      title: '确认 RDP 服务器证书',
      message: `是否信任 ${entry.host}:${entry.port} 的服务器证书？`,
      detail: `请通过独立可信渠道核对 SHA-256 指纹，再发送登录凭据。\n\n${peer.fingerprint256}`
    })
    this.assertCurrent(entry)
    if (approved !== true) throw new Error('RDP server certificate rejected')
    const serverAddress = `${net.isIP(entry.host) === 6 ? `[${entry.host}]` : entry.host}:${entry.port}`
    this.send(entry, encodeWsBinary(buildRdpCleanPathResponse(serverAddress, x224, certificates)))
    entry.phase = 'ready'
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    secure.on('data', (chunk: Buffer) => {
      try { this.assertCurrent(entry); this.send(entry, encodeWsBinary(chunk)) } catch { this.closeEntry(entry) }
    })
    for (const chunk of entry.pending) this.write(entry, chunk)
    entry.pending = []
    entry.pendingBytes = 0
    secure.resume()
  }
}
