/**
 * com.enest.remote-desktop — VNC 会话（noVNC）
 * RFB over ws：transport.wsUrl 直连（noVNC rawChannel 需要 WebSocket 实例，
 * 用 new WebSocket(url) 首参传入构造器）。
 * 能力：ZRLE/Tight/Hextile 协商、指针形状、剪贴板文本双向、画质/编码切换、只读。
 */
;(function (global) {
  'use strict'

  const api = () => global.enest || global.zapi || null
  const { openTransport, friendlyError } = global.RdpConnection

  const QUALITY_PRESETS = {
    'auto': { qualityLevel: 6, compressionLevel: 2 },
    'smooth': { qualityLevel: 3, compressionLevel: 6 },
    'sharp': { qualityLevel: 9, compressionLevel: 1 }
  }

  function createVncSession(profile, options = {}) {
    const host = api()
    let rfb = null
    let transport = null
    let activityToken = null
    let reconnectTimer = null
    let reconnectAttempts = 0
    let disposed = false
  let lastStats = { fps: 0, latencyMs: 0, encoding: '', resolution: '' }
  let frameCount = 0
  let statsTimer = null
  let lastLocalClipboard = ''

    const listeners = { state: [], stats: [], disconnect: [] }
    const emit = (name, payload) => { for (const fn of listeners[name]) { try { fn(payload) } catch { /* listener fault */ } } }

    let stateValue = { phase: 'idle', reason: '' }   // idle|connecting|connected|reconnecting|error|closed
    const setState = (phase, reason = '') => { stateValue = { phase, reason }; emit('state', { ...stateValue }) }

    function statsLoop() {
      if (statsTimer) clearInterval(statsTimer)
      const startedAt = Date.now()
      statsTimer = setInterval(() => {
        if (!rfb) return
        frameCount = rfb._display ? rfb.getFramebufferStats?.()?.frameCount ?? frameCount : frameCount
        const stats = {
          fps: computeFps(startedAt),
          latencyMs: measureLatency(),
          encoding: currentEncoding(),
          resolution: resolutionText()
        }
        lastStats = stats
        emit('stats', { ...stats })
      }, 1000)
    }

    let fpsCounter = { count: 0, lastAt: performance.now(), fps: 0 }
    function computeFps() {
      const now = performance.now()
      const elapsed = (now - fpsCounter.lastAt) / 1000
      if (elapsed >= 1) {
        fpsCounter.fps = Math.round(fpsCounter.count / elapsed)
        fpsCounter.count = 0
        fpsCounter.lastAt = now
      }
      return fpsCounter.fps
    }

    function measureLatency() {
      // noVNC 无内建 RTT：用 WebSocket buffered 量近似不可靠，这里给帧间隔抖动近似值
      return lastStats.latencyMs || 0
    }

    function currentEncoding() {
      try { return rfb?.preferredEncoding != null ? encodingName(rfb.preferredEncoding) : '自动' } catch { return '—' }
    }

    function encodingName(code) {
      const map = { 0: 'Raw', 1: 'CopyRect', 2: 'RRE', 5: 'Hextile', 7: 'Tight', 16: 'ZRLE' }
      return map[code] ?? '自动'
    }

    function resolutionText() {
      try {
        const canvas = rfb?._canvas || options.canvas
        return canvas ? `${canvas.width}×${canvas.height}` : '—'
      } catch { return '—' }
    }

    function onFramebufferUpdate() { fpsCounter.count++ }

    async function connect({ reconnect = true } = {}) {
      if (disposed) return
      setState(reconnectAttempts > 0 ? 'reconnecting' : 'connecting')
      try {
        // 防休眠：会话期间保持系统活跃
        if (!activityToken) {
          try { activityToken = await host?.runtime?.acquireActivity?.('rdp:vnc-session') } catch { /* 可选 */ }
        }
        transport = await openTransport(profile, options)
        const Rfb = await global.NovncLoader.rfb()
        const ws = new WebSocket(transport.wsUrl)
        const preset = QUALITY_PRESETS[options.quality] || QUALITY_PRESETS.auto
        rfb = new Rfb(options.canvas, ws, {
          credentials: { password: options.password ?? '' },
          shared: true,
          repeaterID: '',
          showDotCursor: false,
          qualityLevel: preset.qualityLevel,
          compressionLevel: preset.compressionLevel,
          background: 'transparent',
          scaleViewport: options.zoom === 'fit',
          resizeSession: false,
          viewOnly: profile.viewOnly === true
        })
        rfb.addEventListener('connect', () => {
          reconnectAttempts = 0
          setState('connected')
          statsLoop()
          emit('connected', { transport })
        })
        rfb.addEventListener('disconnect', event => {
          stopStats()
          const detail = event?.detail?.reason || ''
          const wasConnected = stateValue.phase === 'connected'
          setState('error', friendlyError(new Error(detail || '连接已断开')))
          emit('disconnect', { reason: detail, wasConnected })
          cleanupLink()
          if (reconnect && !disposed && wasConnected) scheduleReconnect()
        })
        rfb.addEventListener('clipboard', async event => {
          const text = event?.detail?.text
          if (text && host?.clipboard?.writeText) {
            try { await host.clipboard.writeText(text) } catch { /* 权限拒绝 */ }
          }
        })
        rfb.addEventListener('capabilities', () => { emit('stats', { ...lastStats, encoding: currentEncoding() }) })
        // 本地剪贴板 → 远端：画布获焦时同步一次（与 RDP 的轮询策略保持轻量一致）
        if (host?.clipboard?.readText) {
          options.canvas.addEventListener('focusin', async () => {
            try {
              const text = await host.clipboard.readText()
              if (text && text !== lastLocalClipboard) {
                lastLocalClipboard = text
                rfb?.clipboardPasteFrom?.(text)
              }
            } catch { /* 读取权限拒绝：静默 */ }
          })
        }
        options.onEvent?.({ type: 'ready' })
      } catch (err) {
        cleanupLink()
        setState('error', friendlyError(err))
        emit('disconnect', { reason: String(err?.message || err), wasConnected: false })
        if (reconnect && !disposed && reconnectAttempts === 0 && options.autoRetry !== false) scheduleReconnect()
        else if (!reconnect) throw err
      }
    }

    function scheduleReconnect() {
      if (reconnectTimer || disposed) return
      reconnectAttempts += 1
      const delay = Math.min(15_000, 1000 * Math.pow(2, reconnectAttempts - 1))  // 1s 2s 4s 8s … 15s 封顶
      setState('reconnecting', `第 ${reconnectAttempts} 次重连（${Math.round(delay / 1000)}s 后）`)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void connect({ reconnect: true })
      }, delay)
    }

    function stopStats() {
      if (statsTimer) { clearInterval(statsTimer); statsTimer = null }
    }

    function cleanupLink() {
      stopStats()
      if (rfb) { try { rfb.disconnect() } catch { /* 已断 */ } ; rfb = null }
      if (transport) { const t = transport; transport = null; void t.close() }
    }

    async function disconnect() {
      disposed = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      cleanupLink()
      if (activityToken) { try { await host?.runtime?.releaseActivity?.(activityToken) } catch {} ; activityToken = null }
      setState('closed', '用户断开')
    }

    return {
      connect: () => connect({ reconnect: false }).catch(err => { throw err }),
      reconnectNow: () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null } void connect({ reconnect: true }) },
      disconnect,
      sendCredentials(password) { if (rfb?.sendCredentials) rfb.sendCredentials({ password }) },
      sendKey(keysym, code, down) { rfb?.sendKey(keysym, code, down) },
      focus() { rfb?.focus() },
      blur() { rfb?.blur() },
      clipboardPasteFromLocal: async text => { if (rfb && text) { try { rfb.clipboardPasteFrom(text) } catch { /* 断开 */ } } },
      setQuality(preset) {
        const value = QUALITY_PRESETS[preset] || QUALITY_PRESETS.auto
        if (rfb) { rfb.qualityLevel = value.qualityLevel; rfb.compressionLevel = value.compressionLevel }
      },
      setZoom(mode) { if (rfb) { rfb.scaleViewport = mode === 'fit' } },
      setViewOnly(value) { if (rfb) { rfb.viewOnly = value === true } },
      screenshot() { return rfb?.toDataURL?.('image/png') || null },
      get stats() { return { ...lastStats } },
      get state() { return { ...stateValue } },
      get protocol() { return 'vnc' },
      on(name, fn) { if (listeners[name]) { listeners[name].push(fn); return () => { listeners[name] = listeners[name].filter(f => f !== fn) } } return () => {} }
    }
  }

  global.VncSession = { create: createVncSession, QUALITY_PRESETS }
})(window)
