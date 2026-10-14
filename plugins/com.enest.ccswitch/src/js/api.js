/**
 * com.enest.ccswitch — 宿主 API 安全封装
 * 全部调用 try/catch；能力缺失时抛「功能未就绪」供 UI 行内展示。
 * 命名空间挂 window.CCS.api。
 */
;(function (global) {
  const api = global.enest || global.zapi || null

  function missing(name) {
    return new Error('功能未就绪：' + name)
  }
  function has(fn) {
    return typeof fn === 'function'
  }
  function errMsg(e) {
    return String((e && e.message) || e || '未知错误')
  }

  /* —— 通知 —— */
  function toast(message, type) {
    try {
      const t = api?.ui?.toast || api?.toast
      if (t) {
        const r = t.call(api.ui || api, { message: String(message), type: type || 'info' })
        if (r && typeof r.catch === 'function') r.catch(() => {})
      }
    } catch (_) { /* optional */ }
  }
  function notify(title, body) {
    try { api?.notify?.({ title, body }) } catch (_) { /* optional */ }
  }

  /* —— agent 命名空间 —— */
  async function agentApps() {
    if (!has(api?.agent?.apps)) throw missing('agent.apps')
    return api.agent.apps()
  }
  async function agentRead(app) {
    if (!has(api?.agent?.read)) throw missing('agent.read')
    return api.agent.read(String(app))
  }
  async function agentWrite(input) {
    if (!has(api?.agent?.write)) throw missing('agent.write')
    return api.agent.write(input)
  }
  async function agentBackups(app) {
    if (!has(api?.agent?.backups)) throw missing('agent.backups')
    return api.agent.backups(String(app))
  }
  async function agentRestore(app, id) {
    if (!has(api?.agent?.restore)) throw missing('agent.restore')
    return api.agent.restore({ app: String(app), id: String(id) })
  }
  async function sessionsList(app) {
    if (!has(api?.agent?.sessions?.list)) throw missing('agent.sessions.list')
    return api.agent.sessions.list(String(app))
  }
  async function sessionsRead(app, file, maxBytes) {
    if (!has(api?.agent?.sessions?.read)) throw missing('agent.sessions.read')
    return api.agent.sessions.read({ app: String(app), file: String(file), maxBytes })
  }

  /* —— net.fetch 连接测试 —— */
  async function netFetch(req) {
    if (!has(api?.net?.fetch)) throw missing('net.fetch')
    return api.net.fetch(req)
  }

  /* —— vault —— */
  async function vaultSet(key, secret) {
    if (!has(api?.vault?.set)) throw missing('vault.set')
    const res = await api.vault.set(String(key), String(secret ?? ''))
    if (res && typeof res === 'object' && res.secretRef) return res
    if (typeof res === 'string') return { secretRef: res }
    return res || {}
  }
  async function vaultHas(keyOrRef) {
    if (!has(api?.vault?.has) || !keyOrRef) return false
    try { return Boolean(await api.vault.has(keyOrRef)) } catch { return false }
  }
  async function vaultRemove(keyOrRef) {
    if (!has(api?.vault?.remove) || !keyOrRef) return false
    try { return Boolean(await api.vault.remove(keyOrRef)) } catch { return false }
  }

  /* —— storage —— */
  async function storageGet(key, fallback) {
    if (!has(api?.storage?.get)) return fallback
    try {
      const v = await api.storage.get(key)
      return v === undefined || v === null ? fallback : v
    } catch (e) {
      throw new Error('storage.get: ' + errMsg(e))
    }
  }
  async function storageSet(key, value) {
    if (!has(api?.storage?.set)) throw missing('storage.set')
    return api.storage.set(key, value)
  }

  /* —— shell / clipboard / contribute —— */
  async function saveTextFile(payload) {
    if (!has(api?.shell?.saveTextFile)) throw missing('shell.saveTextFile')
    return api.shell.saveTextFile(payload)
  }
  async function copyText(text) {
    if (!has(api?.clipboard?.writeText)) throw missing('clipboard.writeText')
    return api.clipboard.writeText(String(text))
  }
  async function registerQuickProvider(meta) {
    if (!has(api?.contribute?.registerQuickProvider)) throw missing('contribute.registerQuickProvider')
    return api.contribute.registerQuickProvider(meta)
  }
  function onQuickQuery(cb) {
    try {
      return (api?.contribute?.onQuickQuery || api?.on)?.call(api.contribute || api, cb)
    } catch { return () => {} }
  }
  function respondQuickQuery(reqId, items) {
    try { return api?.contribute?.respondQuickQuery?.(reqId, items) } catch { return Promise.resolve(false) }
  }

  /* —— 主题 / 生命周期 —— */
  async function getThemeTokens() {
    try {
      return await (api?.ui?.getThemeTokens?.() || api?.theme?.getTokens?.())
    } catch { return null }
  }
  function onThemeChange(cb) {
    try { return api?.ui?.onThemeChange?.(cb) } catch { return () => {} }
  }
  function onEnter(cb) { try { return api?.onEnter?.(cb) } catch { return () => {} } }
  function getLaunchMode() {
    try { return api?.getLaunchMode?.() || 'shell' } catch { return 'shell' }
  }
  function onModeChange(cb) { try { return api?.onModeChange?.(cb) } catch { return () => {} } }

  /* —— hotkey —— */
  async function hotkeyRegister(accelerator, label) {
    if (!has(api?.hotkey?.register)) throw missing('hotkey.register')
    return api.hotkey.register(accelerator, { label })
  }
  function onHotkey(cb) { try { return api?.hotkey?.onHotkey?.(cb) } catch { return () => {} } }

  /* —— settings —— */
  async function settingsGet(key, fallback) {
    try {
      const v = await api?.settings?.get?.(key)
      return v === undefined || v === null ? fallback : v
    } catch { return fallback }
  }
  async function settingsSet(key, value) {
    try { return await api?.settings?.set?.(key, value) } catch { return false }
  }

  global.CCS = global.CCS || {}
  global.CCS.api = {
    raw: api,
    toast, notify, errMsg,
    agentApps, agentRead, agentWrite, agentBackups, agentRestore,
    sessionsList, sessionsRead,
    netFetch, vaultSet, vaultHas, vaultRemove,
    storageGet, storageSet,
    saveTextFile, copyText,
    registerQuickProvider, onQuickQuery, respondQuickQuery,
    getThemeTokens, onThemeChange, onEnter, getLaunchMode, onModeChange,
    hotkeyRegister, onHotkey,
    settingsGet, settingsSet
  }
})(window)
