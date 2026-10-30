/** A plugin-private facade; the frozen host API contains no clipboard history business methods. */
export const HISTORY_UNAVAILABLE_MESSAGE = '当前 eNest 版本不提供剪贴板历史后台（需要 0.0.1 或更高版本）。请在插件市场同时更新 eNest 与本插件；若仍失败，请检查是否还安装了旧版「剪贴板」插件，卸载旧版后重试。'

/**
 * Build the history facade over the plugin's own background service.
 * A host without `background.call` still gets a working api: only the history methods reject,
 * and they reject with a readable, actionable message. Throwing here would blank the whole page
 * before any empty state could explain what to do.
 */
export function createClipboardApi(host) {
  const api = host && typeof host === 'object' ? host : {}
  const clipboard = api.clipboard && typeof api.clipboard === 'object' ? api.clipboard : {}
  const supported = typeof api.background?.call === 'function'
  const call = (method, args = []) => {
    if (!supported) return Promise.reject(new Error(HISTORY_UNAVAILABLE_MESSAGE))
    return api.background.call(`history.${method}`, args, { timeoutMs: 600000 })
  }
  const native = (name, fallbackMessage) => {
    const method = clipboard[name]
    if (typeof method !== 'function') throw new Error(fallbackMessage)
    return method.bind(clipboard)
  }
  async function inspect(entry) {
    if (!entry?.files) return entry
    let values = []
    if (typeof clipboard.inspectFiles === 'function') values = await clipboard.inspectFiles(entry.files.map(file => file.path))
    const byPath = new Map(values.map(file => [file.path, file]))
    return { ...entry, files: entry.files.map(file => ({ ...file, exists: byPath.get(file.path)?.exists ?? null, directory: byPath.get(file.path)?.directory })) }
  }
  const get = async id => inspect(await call('get', [id]))
  async function copy(id, options = {}) {
    const entry = await get(id)
    if (!entry) throw new Error('该记录已删除')
    if (entry.type === 'image') {
      if (!entry.dataUrl) throw new Error('图片原始数据已丢失')
      await native('writeImage', '当前 eNest 版本不支持写入图片，请更新 eNest')(entry.dataUrl)
    } else if (entry.type === 'files') {
      const paths = (entry.files || []).map(file => file.path)
      if (options.paths) await native('writeText', '当前 eNest 版本不支持写入剪贴板，请更新 eNest')(paths.join('\n'))
      else {
        if (entry.files.some(file => file.exists === false)) throw new Error('文件已移动或删除')
        await native('writeFiles', '当前 eNest 版本不支持写入文件，请更新 eNest')(paths)
      }
    } else await native('writeText', '当前 eNest 版本不支持写入剪贴板，请更新 eNest')(entry.text || entry.preview)
    return true
  }
  const history = Object.freeze({
    /** Whether this host can serve history at all; callers use it to render a capability empty state. */
    supported,
    unavailableReason: supported ? '' : HISTORY_UNAVAILABLE_MESSAGE,
    async query(options) {
      const result = await call('query', [options])
      return { ...result, items: await Promise.all(result.items.map(inspect)) }
    },
    list: options => call('list', [options]),
    get,
    copy,
    async paste(id) {
      await copy(id)
      if (typeof clipboard.paste !== 'function') return { pasted: false, reason: '当前 eNest 版本不支持回贴，已复制' }
      return clipboard.paste()
    },
    async reveal(id, index = 0) {
      const entry = await get(id), file = entry?.files?.[Math.max(0, Math.floor(Number(index) || 0))]
      if (!file) throw new Error('文件记录不存在')
      // The host confirms this exact target through localFiles before granting/revealing it.
      return native('revealFile', '当前 eNest 版本不支持定位文件，请更新 eNest')(file.path)
    },
    remove: id => call('remove', [id]),
    clear: () => call('clear'),
    togglePin: id => call('togglePin', [id]),
    preferencesChanged: () => call('preferencesChanged'),
    onChange(callback) {
      if (typeof api.on !== 'function') return () => {}
      const listener = payload => { if (payload?.event === 'history.changed') callback(payload.data) }
      api.on('background.event', listener)
      return () => api.off?.('background.event', listener)
    }
  })
  // Keep the native surface usable in an old host; a missing capability answers instead of throwing.
  const capabilities = typeof clipboard.capabilities === 'function'
    ? () => clipboard.capabilities()
    : async () => ({ paste: false, reason: '当前 eNest 版本不支持剪贴板回贴，复制始终可用', permissionRequired: false })
  return Object.freeze({ ...api, clipboard: Object.freeze({ ...clipboard, capabilities, history }) })
}
