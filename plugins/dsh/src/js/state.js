/* DSH 运行状态由宿主拥有；插件偏好仅保存快速对话的模型与会话选择。 */
;(() => {
  const { call, onDshEvent } = window.DshApi
  const listeners = new Set()
  const state = {
    ready: false,
    runtime: null,
    status: null,
    settings: null,
    statusError: null,
    settingsError: null,
    sessions: [],
    currentSessionId: null,
    events: [],
    liveStatus: {},
    sdkError: null,
    webBooting: false,
    webTail: '',
    upgrading: null,
    prefs: {
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      webProfile: 'web',
      sdkProfile: 'sdk',
      webPortPolicy: 'auto',
      webPort: 3000,
      quickSessionId: null
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  function commit(patch) {
    Object.assign(state, patch)
    for (const listener of listeners) listener(state)
  }

  const errorText = (error) => String(error?.message || error)
  let statusRequest = null
  async function refreshStatus() {
    if (statusRequest) return statusRequest
    statusRequest = (async () => {
      try {
        const status = await call('runtime.status')
        const web = status?.web
        commit({
          status,
          statusError: null,
          webBooting: Boolean(web?.running && !web?.readyUrl && !web?.lastError)
        })
        return status
      } catch (error) {
        commit({ statusError: errorText(error) })
        throw error
      } finally {
        statusRequest = null
      }
    })()
    return statusRequest
  }

  async function detect() {
    try {
      const runtime = await call('runtime.detect')
      commit({ runtime, ready: true })
      return runtime
    } catch (error) {
      const runtime = { available: false, error: errorText(error) }
      commit({ runtime, ready: true })
      return runtime
    }
  }

  async function loadSettings() {
    try {
      const settings = await call('settings.get')
      commit({ settings, settingsError: null, prefs: { ...state.prefs, ...settings } })
      return settings
    } catch (error) {
      commit({ settingsError: errorText(error) })
      throw error
    }
  }

  let scanTimer = null
  let scanRequest = null
  let sessionRead = 0
  function scheduleSessionScan() {
    if (scanTimer) return
    scanTimer = setTimeout(() => {
      scanTimer = null
      void scanSessions()
    }, 1200)
  }

  async function scanSessions() {
    if (scanRequest) return scanRequest
    scanRequest = (async () => {
      try {
        const result = await call('sessions.list', { limit: 60 })
        const sessions = Array.isArray(result) ? result : []
        const live = new Set(Object.keys(state.liveStatus))
        for (const session of sessions) if (live.has(session.sessionId)) session.live = true
        commit({ sessions })
        if (!state.currentSessionId && sessions.length) void loadSession(sessions[0].sessionId)
        return sessions
      } catch {
        return state.sessions
      } finally {
        scanRequest = null
      }
    })()
    return scanRequest
  }

  async function loadSession(sessionId) {
    const request = ++sessionRead
    commit({ currentSessionId: sessionId, events: [] })
    try {
      const dump = await call('sessions.read', { sessionId, maxEvents: 300 })
      if (request === sessionRead) commit({ events: Array.isArray(dump?.events) ? dump.events : [] })
    } catch (error) {
      if (request === sessionRead) commit({ sdkError: `读取会话失败：${errorText(error)}` })
    }
  }

  function handleNotify(event) {
    const params = event.params || {}
    const sessionId = String(params.sessionId ?? '')
    if (event.method === 'session.event') {
      const patch = {}
      if (sessionId && sessionId === state.currentSessionId) patch.events = [...state.events.slice(-400), params.event || {}]
      if (sessionId && !state.sessions.some((session) => session.sessionId === sessionId)) {
        patch.sessions = [{ sessionId, title: '快速对话', live: true }, ...state.sessions]
      }
      commit(patch)
      scheduleSessionScan()
    } else if (event.method === 'session.status' && sessionId) {
      commit({ liveStatus: { ...state.liveStatus, [sessionId]: params.status === 'running' ? 'running' : 'idle' } })
    }
  }

  function refreshAfterEvent() {
    void refreshStatus().catch(() => {})
  }

  onDshEvent((event) => {
    switch (event.type) {
      case 'web-ready':
        commit({ webBooting: false, webTail: '' })
        refreshAfterEvent()
        break
      case 'web-port':
      case 'web-exit':
        refreshAfterEvent()
        break
      case 'web-stderr':
        if (state.webBooting) commit({ webTail: String(event.tail || '') })
        break
      case 'sdk-exit':
        commit({ sdkError: event.lastError || null, liveStatus: {} })
        refreshAfterEvent()
        break
      case 'sdk-notify':
        handleNotify(event)
        break
      case 'runtime-progress':
        commit({ upgrading: event })
        break
      default:
        break
    }
  })

  let webRequest = null
  async function ensureWeb() {
    if (webRequest) return webRequest
    webRequest = (async () => {
      try {
        const status = await refreshStatus()
        if (status?.web?.running) return status
        commit({ webBooting: true, webTail: '' })
        await call('web.start', {})
        return await refreshStatus()
      } catch (error) {
        commit({ webBooting: false, webTail: errorText(error) })
        throw error
      } finally {
        webRequest = null
      }
    })()
    return webRequest
  }

  async function restartWeb() {
    commit({ webBooting: true, webTail: '' })
    try {
      await call('web.restart', {})
      return await refreshStatus()
    } catch (error) {
      commit({ webBooting: false, webTail: errorText(error) })
      throw error
    }
  }

  async function stopWeb() {
    await call('web.stop', {})
    commit({ webBooting: false })
    return refreshStatus()
  }

  async function waitForSdk() {
    const deadline = Date.now() + 65000
    while (Date.now() < deadline) {
      const status = await refreshStatus()
      if (status?.sdk?.initialized) return status
      if (status?.sdk?.lastError || !status?.sdk?.running) {
        throw new Error(status?.sdk?.lastError || 'SDK 进程未运行，请重启后重试')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('SDK 初始化超时，请查看诊断日志后重启')
  }

  function sdkInput() {
    return { provider: state.prefs.provider, model: state.prefs.model }
  }

  let sdkRequest = null
  async function ensureSdk() {
    if (sdkRequest) return sdkRequest
    sdkRequest = (async () => {
      try {
        const status = await refreshStatus()
        if (!status?.sdk?.running) await call('sdk.start', sdkInput())
        const ready = await waitForSdk()
        commit({ sdkError: null })
        return ready
      } catch (error) {
        commit({ sdkError: errorText(error) })
        throw error
      } finally {
        sdkRequest = null
      }
    })()
    return sdkRequest
  }

  async function restartSdk() {
    try {
      await call('sdk.restart', sdkInput())
      const status = await waitForSdk()
      commit({ sdkError: null })
      return status
    } catch (error) {
      commit({ sdkError: errorText(error) })
      throw error
    }
  }

  async function stopSdk() {
    await call('sdk.stop', {})
    commit({ liveStatus: {}, sdkError: null })
    return refreshStatus()
  }

  function newQuickId() {
    return `quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function newQuickSession() {
    const sessionId = newQuickId()
    await window.DshApi.setPref('quickSessionId', sessionId)
    sessionRead++
    commit({ prefs: { ...state.prefs, quickSessionId: sessionId }, currentSessionId: sessionId, events: [] })
    return sessionId
  }

  async function sendPrompt(text) {
    await ensureSdk()
    const sessionId = state.prefs.quickSessionId || await newQuickSession()
    commit({ currentSessionId: sessionId })
    await call('rpc.write', {
      method: 'session/prompt',
      params: { sessionId, contentBlocks: [{ type: 'text', text: String(text) }] }
    })
    return sessionId
  }

  async function loadPrefs() {
    const keys = ['provider', 'model', 'quickSessionId']
    const values = await Promise.all(keys.map((key) => window.DshApi.getPref(key, state.prefs[key])))
    const prefs = { ...state.prefs }
    keys.forEach((key, index) => { if (values[index] != null) prefs[key] = values[index] })
    commit({ prefs })
  }

  let pollTimer = null
  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      refreshAfterEvent()
      void scanSessions()
    }, 4000)
  }

  function stopPolling() {
    clearInterval(pollTimer)
    clearTimeout(scanTimer)
    pollTimer = null
    scanTimer = null
  }

  let bootRequest = null
  async function boot() {
    if (bootRequest) return bootRequest
    bootRequest = (async () => {
      await loadPrefs()
      await Promise.allSettled([loadSettings(), detect(), refreshStatus()])
      if (state.prefs.quickSessionId) commit({ currentSessionId: state.prefs.quickSessionId })
      await scanSessions()
    })()
    return bootRequest
  }

  window.DshState = {
    state, subscribe, commit, detect, refreshStatus, loadSettings,
    scanSessions, loadSession, ensureSdk, ensureWeb,
    restartWeb, restartSdk, stopWeb, stopSdk,
    sendPrompt, newQuickSession, boot, startPolling, stopPolling,
    setNotify() {}
  }
})()
