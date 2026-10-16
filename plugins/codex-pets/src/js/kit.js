/**
 * kit — plugin-kit 适配层（IIFE 副作用导入后取 window.PluginKit）。
 */
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'

export function createKit(options) {
  const kit = window.PluginKit?.create?.(options)
  if (!kit) {
    // 本地浏览器直开等无宿主场景：提供最小降级（toast/copy 走 console）
    return {
      mode: 'shell',
      toast: (message) => console.log(`[toast] ${message}`),
      copy: async (text) => { await navigator.clipboard?.writeText(String(text)) },
      onMode: () => () => {},
      load: async (_k, fallback) => structuredClone(fallback),
      save: async () => true
    }
  }
  return kit
}
