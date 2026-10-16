/**
 * com.github.eNest.remote-desktop — RDP 会话（ironrdp-wasm）
 * vendored：assets/vendor/rdp-wasm/（rdp_client.js + rdp_client_bg.wasm，
 * wasm-pack --target web，MIT；构建说明见 CHANGELOG）。
 * 链路：SessionBuilder.proxyAddress(桥 ws url) —— 桥（socketBridge rdp 模式）
 * 完成 RDCleanPath ASN.1 + TLS 终止，明文 RDP 流直通 wasm 客户端。
 * 键盘：quick/shell 输入策略由容器 data-input-context 控制；
 * mac Cmd → 远端 Ctrl 映射；Esc 等壳子键遵循 ui-standard（quick 下 Esc 不吞）。
 */
;(function (global) {
  'use strict'

  const api = () => global.enest || global.zapi || null
  const { openTransport, friendlyError } = global.RdpConnection

  const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent)
  /** mac 修饰键 → 远端 Ctrl：Cmd/CmdLeft/CmdRight 统一映射 Control */
  function mapModifiers(event) {
    let ctrl = event.ctrlKey
    let alt = event.altKey
    let shift = event.shiftKey
    let meta = false
    if (IS_MAC && event.metaKey) { ctrl = true; meta = false }
    return { ctrl, alt, shift, meta }
  }

  let wasmModule = null
  async function loadWasm() {
    if (wasmModule) return wasmModule
    // 本文件位于 assets/js/ → 上两级即插件根；显式相对路径，避免 baseURI 差异
    const base = new URL('assets/vendor/rdp-wasm/', document.baseURI).href
    wasmModule = await import(base + 'rdp_client.js')
    await wasmModule.default(base + 'rdp_client_bg.wasm')
    try { wasmModule.setup?.('warn') } catch { /* 日志初始化失败可容忍 */ }
    return wasmModule
  }

  function createRdpSession(profile, options = {}) {
    const host = api()
    const { SessionBuilder, DesktopSize, Extension } = {}
    let session = null
    let transport = null
    let activityToken = null
    let runPromise = null
    let disposed = false
    let reconnectTimer = null
    let reconnectAttempts = 0
    let lastStats = { fps: 0, latencyMs: 0, encoding: 'RDP', resolution: '' }
    let lastClipboard = ''

    const listeners = { state: [], stats: [], disconnect: [] }
    const emit = (name, payload) => { for (const fn of listeners[name]) { try { fn(payload) } catch { /* listener fault */ } } }
    let stateValue = { phase: 'idle', reason: '' }
    const setState = (phase, reason = '') => { stateValue = { phase, reason }; emit('state', { ...stateValue }) }

    async function connect({ reconnect = true } = {}) {
      if (disposed) return
      setState(reconnectAttempts > 0 ? 'reconnecting' : 'connecting')
      try {
        if (!activityToken) {
          try { activityToken = await host?.runtime?.acquireActivity?.('rdp:rdp-session') } catch { /* 可选 */ }
        }
        const wasm = await loadWasm()
        transport = await openTransport(profile, options)
        const builder = new wasm.SessionBuilder()
        builder.username(options.username ?? profile.username ?? '')
        builder.password(options.password ?? '')
        builder.destination(`${profile.host}:${profile.port}`)
        builder.proxyAddress(transport.wsUrl)
        builder.authToken('none')
        builder.desktopSize(new wasm.DesktopSize(1280, 720))
        builder.renderCanvas(options.canvas)
        // CredSSP 扩展：域账号密码认证路径（绝大多数场景需要）
        try { builder.extension(new wasm.Extension('enable_credssp', true)) } catch { /* 版本缺扩展可容忍 */ }
        try {
          builder.setCursorStyleCallbackContext(options.canvas)
          builder.setCursorStyleCallback(function (style) { options.canvas.style.cursor = style || 'default' })
        } catch { /* 光标回调可选 */ }
        try {
          builder.remoteClipboardChangedCallback(async function (data) {
            const text = data?.parseText?.() ?? ''
            if (text && text !== lastClipboard && host?.clipboard?.writeText) {
              lastClipboard = text
              try { await host.clipboard.writeText(text) } catch { /* 权限拒绝 */ }
            }
          })
        } catch { /* 剪贴板回调可选 */ }

        session = await builder.connect()
        const size = session.desktopSize()
        options.canvas.width = size.width
        options.canvas.height = size.height
        lastStats.resolution = `${size.width}×${size.height}`
        reconnectAttempts = 0
        setState('connected')
        emit('connected', { transport, resolution: lastStats.resolution })
        // 本地剪贴板 → 远端（本地变更后主动同步）
        hookLocalClipboard()
        runPromise = session.run()
        runPromise.then(info => {
          const reason = safeReason(info)
          stopRun()
          setState('error', reason || '会话已结束')
          emit('disconnect', { reason, wasConnected: true })
          cleanupLink()
          if (reconnect && !disposed) scheduleReconnect()
        }).catch(err => {
          stopRun()
          setState('error', friendlyError(err))
          emit('disconnect', { reason: String(err?.message || err), wasConnected: true })
          cleanupLink()
          if (reconnect && !disposed) scheduleReconnect()
        })
      } catch (err) {
        cleanupLink()
        setState('error', friendlyError(err))
        emit('disconnect', { reason: String(err?.message || err), wasConnected: false })
        if (reconnect && !disposed && reconnectAttempts === 0 && options.autoRetry !== false) scheduleReconnect()
        else if (!reconnect) throw err
      }
    }

    function safeReason(info) {
      try { return typeof info?.reason === 'function' ? info.reason() : String(info?.reason ?? '') } catch { return '' }
    }

    let clipboardHooked = false
    async function hookLocalClipboard() {
      if (clipboardHooked || !host?.clipboard?.readText) return
      clipboardHooked = true
      setInterval(async () => {
        if (disposed || !session || document.hidden) return
        try {
          const text = await host.clipboard.readText()
          if (text && text !== lastClipboard) {
            lastClipboard = text
            session.onClipboardPaste(new wasmModule.ClipboardData(text))
          }
        } catch { /* 读取权限拒绝：静默 */ }
      }, 1000)
    }

    function scheduleReconnect() {
      if (reconnectTimer || disposed) return
      reconnectAttempts += 1
      const delay = Math.min(15_000, 1000 * Math.pow(2, reconnectAttempts - 1))
      setState('reconnecting', `第 ${reconnectAttempts} 次重连（${Math.round(delay / 1000)}s 后）`)
      reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect({ reconnect: true }) }, delay)
    }

    function stopRun() { runPromise = null }

    function cleanupLink() {
      if (session) { try { session.shutdown() } catch { /* 已停 */ } ; session = null }
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
      connect: () => connect({ reconnect: false }),
      reconnectNow: () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null } void connect({ reconnect: true }) },
      disconnect,
      applyInputs(transaction) { try { session?.applyInputs(transaction) } catch { /* 会话未就绪 */ } },
      synchronizeLockKeys(caps, num, scroll) { try { session?.synchronizeLockKeys(caps, num, scroll) } catch { /* 可选 */ } },
      resize(w, h) { try { session?.resize(w, h) } catch { /* 可选 */ } },
      screenshot() {
        try { return options.canvas.toDataURL('image/png') } catch { return null }
      },
      setQuality() { /* RDP 编码由服务端协商，画质档仅 UI 占位 */ },
      setZoom() { /* 缩放由容器 data-zoom 控制，canvas 不缩放位面 */ },
      setViewOnly(value) { if (value) { options.canvas.dataset.viewOnly = '1' } else { delete options.canvas.dataset.viewOnly } },
      get stats() { return { ...lastStats } },
      get state() { return { ...stateValue } },
      get protocol() { return 'rdp' },
      on(name, fn) { if (listeners[name]) { listeners[name].push(fn); return () => { listeners[name] = listeners[name].filter(f => f !== fn) } } return () => {} }
    }
  }

  /** canvas 键鼠事件 → ironrdp DeviceEvent + InputTransaction（mac Cmd→Ctrl） */
  function attachRdpInput(canvas, sessionApi) {
    const listeners = []
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push(() => target.removeEventListener(type, fn, opts)) }
    let pendingInputs = null
    const transaction = () => {
      if (!pendingInputs) pendingInputs = []
      return {
        add: event => pendingInputs.push(event),
        commit: () => { const batch = pendingInputs; pendingInputs = null; return batch }
      }
    }

    // 输入上下文：canvas 获焦即接管（overlay），Esc 等壳子键不吞（quick 模式）
    const focusIn = () => { api()?.ui?.setInputContext?.('overlay') }
    on(canvas, 'focusin', focusIn)

    const send = events => {
      if (!events.length || canvas.dataset.viewOnly === '1') return
      try {
        const wasm = wasmModule
        const txn = new wasm.InputTransaction()
        for (const event of events) txn.add(event)
        sessionApi.applyInputs(txn)
      } catch { /* wasm 未就绪 */ }
    }

    const mouseEvent = (type, event) => {
      const rect = canvas.getBoundingClientRect()
      const x = Math.round((event.clientX - rect.left) * (canvas.width / rect.width))
      const y = Math.round((event.clientY - rect.top) * (canvas.height / rect.height))
      const wasm = wasmModule
      if (!wasm) return
      let deviceEvent
      if (type === 'move') deviceEvent = new wasm.DeviceEvent.MouseMove(x, y)
      else {
        const button = event.button === 2 ? wasm.MouseButton.RIGHT : event.button === 1 ? wasm.MouseButton.MIDDLE : wasm.MouseButton.LEFT
        deviceEvent = type === 'down' ? new wasm.DeviceEvent.MouseDown(button) : new wasm.DeviceEvent.MouseUp(button)
      }
      send([deviceEvent])
    }
    on(canvas, 'mousemove', e => mouseEvent('move', e))
    on(canvas, 'mousedown', e => { e.preventDefault(); mouseEvent('down', e) })
    on(canvas, 'mouseup', e => mouseEvent('up', e))
    on(canvas, 'contextmenu', e => e.preventDefault())

    const wheelEvent = event => {
      event.preventDefault()
      const wasm = wasmModule
      if (!wasm) return
      const steps = Math.max(-127, Math.min(127, Math.round(-event.deltaY / 100)))
      send(steps !== 0 ? [new wasm.DeviceEvent.MouseWheelVertical(steps)] : [])
    }
    on(canvas, 'wheel', wheelEvent, { passive: false })

    const keyEvent = (down, event) => {
      // 壳子键保留：quick 下 Esc 交给壳子；⌘Enter（展开桌面）不吞
      const host = api()
      const quick = document.documentElement.dataset.mode === 'quick' || document.querySelector('#app[data-mode="quick"]')
      if (event.key === 'Escape' && quick && !event.shiftKey) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') return
      event.preventDefault()
      event.stopPropagation()
      const wasm = wasmModule
      if (!wasm) return
      const mods = mapModifiers(event)
      const events = []
      const pb = (code, pressed) => events.push(new wasm.DeviceEvent.KeyCode(code, pressed))
      // 修饰键位同步（mac Cmd → Ctrl）
      if (event.ctrlKey || (IS_MAC && event.metaKey)) pb('ControlLeft', down && mods.ctrl)
      if (event.metaKey && !IS_MAC) pb('MetaLeft', down && event.metaKey)
      if (event.altKey) pb('AltLeft', down && mods.alt)
      if (event.shiftKey) pb('ShiftLeft', down && mods.shift)
      // 主键：KeyX / DigitN / 系统键名（wasm KeyCode 枚举字符串）
      const code = normalizeKeyCode(event.code)
      if (code) pb(code, down)
      send(events)
    }
    on(canvas, 'keydown', e => keyEvent(true, e))
    on(canvas, 'keyup', e => keyEvent(false, e))

    return { destroy: () => { for (const off of listeners) off() } }
  }

  /** KeyboardEvent.code → ironrdp KeyCode 名（大部分同名；个别归一） */
  function normalizeKeyCode(code) {
    if (!code) return ''
    const map = {
      OSLeft: IS_MAC ? 'ControlLeft' : 'MetaLeft',
      OSRight: IS_MAC ? 'ControlRight' : 'MetaRight',
      Semicolon: 'Semicolon',
      Quote: 'Quote',
      BracketLeft: 'BracketLeft',
      BracketRight: 'BracketRight',
      Backslash: 'Backslash',
      IntlBackslash: 'Backslash',
      Comma: 'Comma',
      Period: 'Period',
      Slash: 'Slash',
      IntlRo: 'Slash'
    }
    return map[code] || code
  }

  global.RdpSession = { create: createRdpSession, attachRdpInput, loadWasm, mapModifiers }
})(window)
