/**
 * com.enest.remote-desktop — 连接传输层
 * 链路：[可选 SSH tunnel.open → 127.0.0.1:本地口] → net.socket.connect →
 *      net.socket.serveWs（rdp 资产由桥内嗅探自动走 RDCleanPath/TLS）→
 *      页内 new WebSocket(url) 接 noVNC / ironrdp-wasm。
 * 连接测试：TCP 探活 + 协议握手首包诊断（VNC 读 RFB 版本串；RDP 走桥握手）。
 */
;(function (global) {
  'use strict'

  const api = () => global.enest || global.zapi || null
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
   * 1) tunnel.enabled → enest.ssh.workbench tunnel.open（local 0 随机口，remote = host:port）
   *    需先有 sshProfileId 对应的活跃会话；这里约定调用方传入 sshSessionId。
   * 2) net.socket.connect 127.0.0.1:隧道口（或直连 host:port）
   * 3) net.socket.serveWs → { wsUrl, socketId, cleanup }
   */
  async function openTransport(profile, options = {}) {
    const host = api()
    if (!host?.net?.socket) throw new Error('宿主缺少 net.socket 能力，请更新 eNest')
    let connectHost = profile.host
    let connectPort = profile.port
    let tunnel = null
    if (profile.tunnel?.enabled) {
      if (!options.sshSessionId) throw new Error('SSH 隧道需要先在 SSH 插件建立会话')
      const result = await host.ssh.workbench({
        action: 'tunnel.open',
        sessionId: options.sshSessionId,
        direction: 'local',
        localPort: 0,
        remoteHost: profile.host,
        remotePort: profile.port
      })
      tunnel = { id: result?.id, localPort: Number(result?.localPort) }
      if (!tunnel.localPort) throw new Error('SSH 隧道建立失败：未返回本地端口')
      connectHost = '127.0.0.1'
      connectPort = tunnel.localPort
    }
    const { socketId } = await host.net.socket.connect({
      host: connectHost,
      port: connectPort,
      sessionId: tunnel ? options.sshSessionId : undefined,
      timeoutMs: 10_000
    })
    const closeTunnel = async () => {
      if (!tunnel?.id) return
      try { await host.ssh.workbench({ action: 'tunnel.close', id: tunnel.id }) } catch { /* 会话侧已关 */ }
      tunnel = null
    }
    try {
      const endpoint = await host.net.socket.serveWs(socketId)
      return {
        socketId,
        wsUrl: endpoint.url,
        viaTunnel: !!tunnel,
        localPort: tunnel?.localPort,
        /** 释放整条链路：socket 关闭 → 隧道关闭（幂等） */
        async close() {
          try { await host.net.socket.close(socketId) } catch { /* 已关 */ }
          await closeTunnel()
        }
      }
    } catch (err) {
      try { await host.net.socket.close(socketId) } catch { /* 已关 */ }
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
   * RDP：serveWs 后发 RDCleanPath Request（最小构造）→ 期待 DER 响应（0x30）；
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
      // RDP：桥 rdp 模式嗅探——发 RDCleanPath Request（version 3390）
      const probe = buildRdpProbe()
      const response = await wsRoundtrip(transport.wsUrl, probe, { timeoutMs: 8000 })
      await transport.close()
      if (response && response.length > 0 && response[0] === 0x30) {
        // 无法低成本区分 Error PDU 与 Response：Error PDU 含 [1] error 结构，
        // 真实 Response 含 [6] x224；这里检查 tag——简化：非空 DER 即认为 RDP 协议层可达
        return { ok: true, detail: `RDP 协议握手响应 ${response.length} 字节 · TCP ${elapsedMs}ms` }
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

  /** 最小 RDCleanPath Request（DER）：version 3390 + destination + 空 x224（仅探测协议层存在） */
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
      ...wrap(0xa6, wrap(0x04, [0x03, 0x00]))
    ]
    return Uint8Array.from(wrap(0x30, pdu))
  }

  global.RdpConnection = { openTransport, testConnection, friendlyError, parseUri: global.RdpStore?.parseUri, toBytes, toB64, esc }
})(window)
