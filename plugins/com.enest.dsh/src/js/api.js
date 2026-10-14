/* DshApi — 宿主 dsh.workbench / 事件 / 存储 的薄封装 */
;(() => {
  const api = window.enest || window.zapi
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  async function call(action, input) {
    const res = await api.dsh.workbench({ action, input: input ?? {} })
    return res
  }

  async function getPref(key, fallback) {
    try {
      const v = await api.storage.get(`dsh.${key}`)
      return v === undefined || v === null ? fallback : v
    } catch {
      return fallback
    }
  }
  async function setPref(key, value) {
    try {
      await api.storage.set(`dsh.${key}`, value)
    } catch {
      /* 存储不可用时静默降级（内存态） */
    }
  }

  function onDshEvent(cb) {
    return api.dsh.onDshEvent(cb)
  }

  function notice(message, type) {
    try {
      api.ui.toast({ message: String(message), type: type || 'info' })
    } catch {
      /* ignore */
    }
  }

  async function openExternal(url) {
    try {
      return (await api.shell.openExternal(String(url))) !== false
    } catch {
      return false
    }
  }

  window.DshApi = { call, getPref, setPref, onDshEvent, notice, openExternal, esc, raw: api }
})()
