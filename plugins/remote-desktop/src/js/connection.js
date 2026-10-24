import { createSshHost } from '@enest/ssh-backend/client'

/**
 * com.github.eNest.remote-desktop — 连接传输层
 * 链路：[可选 SSH tunnel.open → 127.0.0.1:本地口] →
 *      VNC: 通用 net.socket；RDP: 本插件 backend 的 RDCleanPath/TLS 桥 →
 *      页内 new WebSocket(url) 接 noVNC / ironrdp-wasm。
 * 连接测试：TCP 探活 + 协议握手首包诊断（VNC 读 RFB 版本串；RDP 走桥握手）。
 */
;(function (global) {
  'use strict'

  const api = () => createSshHost(global.enest || global.zapi || null)
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  function friendlyError(err) {
    const raw = String(err?.message || err || '未知错误')
    if (/ECONNREFUSED|connection refused/i.test(raw)) return '连接被拒绝（端口未开放或服务未启动）'
    if (/ENOTFOUND|EAI_AGAIN|host not found/i.test(raw)) return '主机名解析失败（检查地址或代理）'
    if (/ETIMEDOUT|timeout/i.test(raw)) return '连接超时（网络不可达或被防火墙拦截）'
    if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) return '网络不可达'
    if (/socket limit/i.test(raw)) return '并发连接数已达上限（8），请先关闭部分会话'
    return raw
  }

  /**
   * 建立到资产的传输：
   * 1) tunnel.enabled → 插件私有 SSH backend（local 0 随机口，remote = host:port）
   *    仅接受本插件会话或本插件持有的 SSH 连接资料，不借用其它插件的会话 / vault。
   * 2) VNC 使用宿主透明 TCP/WebSocket；RDP 使用本插件独立协议服务
   * 3) 返回 wsUrl 和幂等 close，同时持有该插件自己的 SSH 隧道
   */
  async function openTransport(profile, options = {}) {
    const host = api()
    if (profile.protocol === 'rdp' ? !host?.backend?.call : !host?.net?.socket) throw new Error('宿主缺少远程桌面传输能力，请更新 eNest')
    let connectHost = profile.host
    let connectPort = profile.port
    let tunnel = null, ownedSessionId = '', sshSessionId = '', socketId = '', bridgeId = ''
    const closeConnection = async () => {
      const rdp = bridgeId, socket = socketId
      bridgeId = ''; socketId = ''
      if (rdp) { try { await host.backend.call('rdp.close', [rdp]) } catch { /* 后端已回收 */ } }
      if (socket) { try { await host.net.socket.close(socket) } catch { /* 已关 */ } }
    }
    const closeTunnel = async () => {
      const id = tunnel?.id, ownSession = ownedSessionId
      tunnel = null
      ownedSessionId = ''
      if (id) { try { await host.ssh.workbench({ action: 'tunnel.close', id }) } catch { /* 会话侧已关 */ } }
      if (ownSession) { try { await host.ssh.disconnect(ownSession) } catch { /* 后端已关 */ } }
    }
    try {
      if (profile.tunnel?.enabled) {
        const connection = options.sshConnection || profile.tunnel.connection
        if (connection?.host && connection?.username) {
          const session = await host.ssh.connect(connection)
          ownedSessionId = String(session?.sessionId || '')
          if (!ownedSessionId) throw new Error('SSH 隧道连接未返回会话')
          sshSessionId = ownedSessionId
        } else if (options.sshSessionId) {
          const sessions = await host.ssh.listSessions()
          if (!sessions.some(session => session.sessionId === options.sshSessionId)) throw new Error('该 SSH 会话不属于远程桌面；请在本插件配置独立 SSH 连接')
          sshSessionId = options.sshSessionId
        } else {
          throw new Error('此连接缺少远程桌面专用的 SSH 主机、用户名和凭据；SSH 插件的会话不能跨插件复用。请补充独立配置或关闭 SSH 隧道后直连。')
        }
        const result = await host.ssh.workbench({
          action: 'tunnel.open', sessionId: sshSessionId, direction: 'local', localPort: 0,
          remoteHost: profile.host, remotePort: profile.port
        })
        tunnel = { id: result?.id, localPort: Number(result?.localPort) }
        if (!tunnel.id || !Number.isInteger(tunnel.localPort) || tunnel.localPort < 1 || tunnel.localPort > 65535) throw new Error('SSH 隧道建立失败：未返回本地端口')
        connectHost = '127.0.0.1'
        connectPort = tunnel.localPort
      }
      let wsUrl
      if (profile.protocol === 'rdp') {
        const result = await host.backend.call('rdp.open', [{ host: connectHost, port: connectPort }])
        bridgeId = result.bridgeId
        wsUrl = result.wsUrl
      } else {
        ;({ socketId } = await host.net.socket.connect({ host: connectHost, port: connectPort, sessionId: sshSessionId || undefined, timeoutMs: 10_000 }))
        wsUrl = (await host.net.socket.serveWs(socketId)).url
      }
      return {
        socketId,
        bridgeId,
        wsUrl,
        viaTunnel: !!tunnel,
        localPort: tunnel?.localPort,
        /** 释放整条链路：socket 关闭 → 隧道关闭（幂等） */
        async close() {
          await closeConnection()
          await closeTunnel()
        }
      }
    } catch (err) {
      await closeConnection()
      await closeTunnel()
      throw err
    }
  }

  /** b64 ↔ bytes */
  const toBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const toB64 = bytes => btoa(String.fromCharCode(...bytes))

  /**
   * 连接测试：TCP 探活 + 协议握手首包
   * VNC：发送 RFB 003.008\n → 期待回 RFB 003.00x\n 版本串
   * RDP：插件桥发送有效 X.224 协商，用户确认服务端证书后期待成功响应；
   *      假服务器/非 RDP 端口会以错误或超时暴露。
   * 返回 { ok, reason?, detail? }。
   */
  async function testConnection(profile, options = {}) {
    const host = api()
    let transport = null
    const startedAt = Date.now()
    try {
      transport = await openTransport(profile, options)
    } catch (err) {
      return { ok: false, reason: friendlyError(err), detail: String(err?.message || err) }
    }
    const elapsedMs = Date.now() - startedAt
    try {
      if (profile.protocol === 'vnc') {
        // RFB 版本协商：server 先发言（ServerProtocolVersion）
        const version = await readFirstMessage(transport.socketId, { timeoutMs: 6000 })
        const text = new TextDecoder().decode(version)
        const match = /^RFB (\d{3}\.\d{3})\n/.exec(text)
        if (match) {
          await transport.close()
          return { ok: true, detail: `RFB ${match[1]} · TCP ${elapsedMs}ms` }
        }
        await transport.close()
        return { ok: false, reason: '端口开放但未返回 RFB 版本串（可能不是 VNC 服务）', detail: text.slice(0, 64) }
      }
      // RDP 的成功必须包含 X.224 和证书字段；错误 DER 不能算作握手成功。
      const probe = buildRdpProbe()
      const response = await wsRoundtrip(transport.wsUrl, probe, { timeoutMs: 120000 })
      await transport.close()
      if (isRdpProbeSuccess(response)) {
        return { ok: true, detail: `RDP 协议握手响应 ${response.length} 字节 · 协商 ${Date.now() - startedAt}ms` }
      }
      return { ok: false, reason: '端口开放但 RDP 握手无响应（可能不是 RDP 服务或被代理拦截）' }
    } catch (err) {
      try { await transport.close() } catch { /* 已关 */ }
      return { ok: false, reason: friendlyError(err), detail: String(err?.message || err) }
    }
  }

  /** 订阅某个 socket 的首包（net.data base64 节流合并后即首个事件） */
  function readFirstMessage(socketId, { timeoutMs = 6000 } = {}) {
    const host = api()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('等待协议首包超时')) }, timeoutMs)
      const off = host.net.onNetData(event => {
        if (event.socketId !== socketId) return
        clearTimeout(timer)
        off()
        resolve(toBytes(event.chunk))
      })
    })
  }

  /** ws 一发一收（RDP 探测）：连 serveWs url → 发 binary → 收首帧 binary */
  function wsRoundtrip(wsUrl, bytes, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('RDP 握手等待超时')) }, timeoutMs)
      ws.onopen = () => { ws.send(bytes) }
      ws.onmessage = event => {
        clearTimeout(timer)
        const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(0)
        try { ws.close() } catch {}
        resolve(data)
      }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 桥连接失败')) }
      ws.onclose = () => { clearTimeout(timer); reject(new Error('WebSocket 桥被关闭')) }
    })
  }

  function isRdpProbeSuccess(bytes) {
    if (!bytes || bytes.length > 2 * 1024 * 1024) return false
    const read = offset => {
      if (offset + 2 > bytes.length) throw new Error('Truncated DER')
      const tag = bytes[offset++]
      let length = bytes[offset++]
      if (length & 0x80) {
        const count = length & 0x7f
        if (!count || count > 4 || offset + count > bytes.length) throw new Error('Invalid DER')
        length = 0
        for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++]
      }
      if (offset + length > bytes.length) throw new Error('Truncated DER')
      return { tag, start: offset, end: offset + length }
    }
    try {
      const outer = read(0)
      if (outer.tag !== 0x30 || outer.end !== bytes.length) return false
      const tags = new Set()
      let offset = outer.start
      while (offset < outer.end) {
        const child = read(offset)
        if (child.end > outer.end || tags.has(child.tag)) return false
        tags.add(child.tag); offset = child.end
      }
      return !tags.has(0xa1) && tags.has(0xa0) && tags.has(0xa6) && tags.has(0xa7)
    } catch { return false }
  }

  /** X.224 CR + RDP_NEG_REQ (TLS and HYBRID) wrapped in RDCleanPath version 3390. */
  function buildRdpProbe() {
    const wrap = (tag, content) => {
      const len = content.length
      const lenBytes = len < 0x80 ? [len] : [0x81, len]
      return [tag, ...lenBytes, ...content]
    }
    const integer = value => {
      const bytes = []
      let temp = value
      while (temp > 0) { bytes.unshift(temp & 0xff); temp >>= 8 }
      return wrap(0x02, bytes)
    }
    const utf8 = str => {
      const bytes = [...new TextEncoder().encode(str)]
      return wrap(0x0c, bytes)
    }
    const pdu = [
      ...wrap(0xa0, integer(3390)),
      ...wrap(0xa2, utf8('probe')),
      ...wrap(0xa6, wrap(0x04, [0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00]))
    ]
    return Uint8Array.from(wrap(0x30, pdu))
  }

  global.RdpConnection = { openTransport, testConnection, friendlyError, parseUri: global.RdpStore?.parseUri, toBytes, toB64, esc }
})(window)
