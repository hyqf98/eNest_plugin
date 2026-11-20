/**
 * 统一消息提醒：错误/成功提示一律走 plugin-kit toast（宿主原生通知条），
 * 不在页面内渲染大块 ErrorBox 阻断加载；浏览器预览降级 console。
 */
let kitInstance = null
function kit() {
  if (kitInstance !== null) return kitInstance
  try {
    kitInstance = window.PluginKit?.create ? window.PluginKit.create({}) : false
  } catch {
    kitInstance = false
  }
  return kitInstance
}

export function notify(message, type = 'info') {
  const text = String(message ?? '').slice(0, 180)
  if (!text) return
  const k = kit()
  if (k?.toast) {
    try { k.toast(text, type); return } catch { /* fallthrough */ }
  }
  // 浏览器预览降级：不打断页面
  if (type === 'error') console.warn('[novel-house]', text)
}

export const notifyError = (e) => notify(e?.message || String(e), 'error')
export const notifyOk = (message) => notify(message)
