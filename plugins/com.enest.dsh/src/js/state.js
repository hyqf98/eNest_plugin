/* DshState — 运行时探测 / 进程状态 / 会话数据 / 事件流的共享状态层
   订阅式：视图经 subscribe(render) 拿到变更通知；数据层负责轮询与事件归并。 */
;(() => {
  const { call, onDshEvent } = window.DshApi
  const listeners = new Set()
  let mode = 'shell' // quick | shell（初始值由 main.js 依 launch mode 覆盖）
  let notify = () => {}

  const state = {
    ready: false, // detect 完成
    runtime: null, // runtime.detect 结果
    status: null, // runtime.status 结果
    sessions: [], // DshSessionHeader[]
    currentSessionId: null, // 当前查看的会话
    events: [], // 当前会话事件（sdk 实时追加 / 历史读取）
    liveStatus: {}, // sessionId -> 'running' | 'idle'（sdk session.status）
    sdkError: null,
    webBooting: false,
    upgrading: null, // runtime-progress 事件累积
    prefs: {
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      webPortPolicy: 'auto', // auto | fixed
      webPort: 3080,
      autoRestart: true,
      quickSessionId: null
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
  function commit(patch) {
    Object.assign(state, patch)
    for (const fn of listeners) fn(state)
  }

  // —— 事件流归并 ——
  onDshEvent((event) => {
    switch (event.type) {
      case 'web-ready':
        commit({ webBooting: false })
        void refreshStatus()
        break
      case 'web-port':
        void refreshStatus()
        break
      case 'web-exit':
        commit({ webBooting: false })
        void refreshStatus()
        break
      case 'web-stderr':
        // 引导态展示错误尾
        if (state.webBooting) state.webTail = String(event.tail || '')
        break
      case 'sdk-exit':
        commit({ sdkError: event.lastError || 'sdk 进程退出' })
        break
      case 'sdk-notify':
        handleNotify(event)
        break
      case 'runtime-progress':
        state.upgrading = event
        notify()
        break
      default:
        break
    }
  })

  function handleNotify(event) {
    const params = event.params || {}
    if (event.method === 'session.event') {
      const sid = String(params.sessionId ?? '')
      const ev = params.event || {}
      if (sid && sid === state.currentSessionId) {
        state.events = [...state.events.slice(-400), ev]
      }
      // 会话列表懒登记（sdk 新建的快速会话）
      if (sid && !state.sessions.some((s) => s.sessionId === sid)) {
        state.sessions = [{ sessionId: sid, title: '快速对话', live: true }, ...state.sessions]
      }
      notify()
      scheduleSessionScan()
    } else if (event.method === 'session.status') {
      const sid = String(params.sessionId ?? '')
      if (sid) state.liveStatus[sid] = params.status === 'running' ? 'running' : 'idle'
      notify()
    }
  }

  // —— 动作 ——
  async function detect() {
    try {
      const runtime = await call('runtime.detect')
      commit({ runtime, ready: true })
      return runtime
    } catch (error) {
      commit({ runtime: { available: false, error: String(error.message || error) }, ready: true })
      return state.runtime
    }
  }

  async function refreshStatus() {
    try {
      const status = await call('runtime.status')
      commit({ status })
      return status
    } catch {
      return null
    }
  }

  let scanTimer = null
  function scheduleSessionScan() {
    if (scanTimer) return
    scanTimer = setTimeout(() => {
      scanTimer = null
      void scanSessions()
    }, 1200)
  }

  async function scanSessions() {
    try {
      const sessions = await call('sessions.list', { limit: 60 })
      if (Array.isArray(sessions)) {
        // 保留 sdk 实时登记项的 live 标记
        const live = new Set(Object.keys(state.liveStatus))
        for (const s of sessions) if (live.has(s.sessionId)) s.live = true
        commit({ sessions })
        if (!state.currentSessionId && sessions.length) {
          state.currentSessionId = sessions[0].sessionId
          void loadSession(sessions[0].sessionId)
        }
      }
    } catch {
      /* 无会话目录 */
    }
  }

  async function loadSession(sessionId) {
    state.currentSessionId = sessionId
    state.events = []
    notify()
    try {
      const dump = await call('sessions.read', { sessionId, maxEvents: 300 })
      state.events = Array.isArray(dump?.events) ? dump.events : []
    } catch (error) {
      state.events = []
    }
    notify()
  }

  async function ensureSdk() {
    const status = state.status || (await refreshStatus())
    if (status?.sdk?.running) return status
    try {
      await call('sdk.start', {
        cwd: state.runtime?.dshHome || '.',
        provider: state.prefs.provider,
        model: state.prefs.model
      })
      commit({ sdkError: null })
    } catch (error) {
      commit({ sdkError: String(error.message || error) })
    }
  }

  async function sendPrompt(text) {
    const sessionId = state.prefs.quickSessionId || newQuickId()
    if (!state.prefs.quickSessionId) {
      state.prefs.quickSessionId = sessionId
      await window.DshApi.setPref('quickSessionId', sessionId)
    }
    state.currentSessionId = sessionId
    await call('rpc.write', {
      method: 'session/prompt',
      params: { sessionId, contentBlocks: [{ type: 'text', text: String(text) }] }
    })
    return sessionId
  }

  function newQuickId() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `quick-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  async function newQuickSession() {
    const sessionId = newQuickId()
    state.prefs.quickSessionId = sessionId
    state.currentSessionId = sessionId
    state.events = []
    await window.DshApi.setPref('quickSessionId', sessionId)
    notify()
  }

  async function ensureWeb() {
    const status = state.status || (await refreshStatus())
    if (status?.web?.running && status?.web?.readyUrl) return status
    if (state.webBooting) return status
    commit({ webBooting: true, webTail: '' })
    const input = state.prefs.webPortPolicy === 'fixed' ? { port: Number(state.prefs.webPort) || 3080 } : {}
    try {
      await call('web.start', input)
    } catch (error) {
      commit({ webBooting: false })
      window.DshApi.notice(`DSH 启动失败：${String(error.message || error)}`, 'error')
    }
    return state.status
  }

  async function loadPrefs() {
    const keys = ['provider', 'model', 'webPortPolicy', 'webPort', 'quickSessionId']
    const values = await Promise.all(keys.map((k) => window.DshApi.getPref(k, state.prefs[k])))
    keys.forEach((k, i) => {
      if (values[i] !== undefined && values[i] !== null) state.prefs[k] = values[i]
    })
  }

  let pollTimer = null
  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      void refreshStatus()
      void scanSessions()
    }, 4000)
  }
  function stopPolling() {
    clearInterval(pollTimer)
    pollTimer = null
  }

  async function boot(initialMode) {
    mode = initialMode
    notify = () => commit({}) // boot 后通知即触发渲染
    await loadPrefs()
    await detect()
    await refreshStatus()
    await scanSessions()
    if (state.prefs.quickSessionId) state.currentSessionId = state.prefs.quickSessionId
  }

  window.DshState = {
    state,
    subscribe,
    commit,
    detect,
    refreshStatus,
    scanSessions,
    loadSession,
    ensureSdk,
    ensureWeb,
    sendPrompt,
    newQuickSession,
    boot,
    startPolling,
    stopPolling,
    setNotify(fn) {
      notify = fn
    }
  }
})()
