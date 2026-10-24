/* DshApi: plugin-owned jobs over the standard native backend transport. */
;(() => {
  const api = window.enest || window.zapi
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  const pending = new Map()
  const listeners = new Set()
  const unsubscribe = api.on('backend.event', (message) => {
    if (message?.event === 'dsh.event') {
      for (const listener of listeners) {
        try { listener(message.data) } catch { /* One consumer cannot break the job bridge. */ }
      }
      return
    }
    if (message?.event !== 'dsh.job') return
    const result = message.data
    const request = pending.get(result?.jobId)
    if (!request) return
    pending.delete(result.jobId)
    clearTimeout(request.timer)
    if (result.ok === true) request.resolve(result.data)
    else request.reject(new Error(String(result.error || 'DSH operation failed')))
  })

  function createJobId() {
    const random = globalThis.crypto
    if (typeof random?.randomUUID === 'function') return random.randomUUID()
    if (typeof random?.getRandomValues !== 'function') throw new Error('Secure random generation is unavailable')
    // Custom-scheme pages may lack randomUUID while retaining cryptographic getRandomValues.
    const bytes = random.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  function call(action, input) {
    const jobId = createJobId()
    return new Promise((resolve, reject) => {
      // Downloads are bounded by the backend's ten-minute deadline, not the shell RPC timer.
      const timer = setTimeout(() => {
        pending.delete(jobId)
        reject(new Error('DSH operation timed out; check runtime status before retrying'))
      }, 15 * 60 * 1000)
      pending.set(jobId, { resolve, reject, timer })
      Promise.resolve().then(() => api.backend.call('workbench', [{ action, input: input ?? {} }, jobId])).then((ack) => {
        if (ack?.jobId !== jobId) throw new Error('Invalid DSH job acknowledgement')
      }).catch((error) => {
        const request = pending.get(jobId)
        if (!request) return
        pending.delete(jobId)
        clearTimeout(request.timer)
        request.reject(error)
      })
    })
  }

  window.addEventListener('pagehide', () => {
    unsubscribe?.()
    listeners.clear()
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('DSH page closed')) }
    pending.clear()
  }, { once: true })

  async function getPref(key, fallback) {
    try {
      const v = await api.storage.get(`dsh.${key}`)
      return v === undefined || v === null ? fallback : v
    } catch {
      return fallback
    }
  }
  async function setPref(key, value) {
    await api.storage.set(`dsh.${key}`, value)
  }

  function onDshEvent(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
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
