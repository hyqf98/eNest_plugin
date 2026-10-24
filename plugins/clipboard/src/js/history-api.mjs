/** A plugin-private facade; the frozen host API contains no clipboard history business methods. */
export function createClipboardApi(host) {
  if (!host?.background?.call) throw new Error('剪贴板 1.4.0 需要 eNest 0.2.3 或更高版本')
  const call = (method, args = []) => host.background.call(`history.${method}`, args, { timeoutMs: 600000 })
  async function inspect(entry) {
    if (!entry?.files) return entry
    let values = []
    if (typeof host.clipboard.inspectFiles === 'function') values = await host.clipboard.inspectFiles(entry.files.map(file => file.path))
    const byPath = new Map(values.map(file => [file.path, file]))
    return { ...entry, files: entry.files.map(file => ({ ...file, exists: byPath.get(file.path)?.exists ?? null, directory: byPath.get(file.path)?.directory })) }
  }
  const get = async id => inspect(await call('get', [id]))
  async function copy(id, options = {}) {
    const entry = await get(id)
    if (!entry) throw new Error('该记录已删除')
    if (entry.type === 'image') {
      if (!entry.dataUrl) throw new Error('图片原始数据已丢失')
      await host.clipboard.writeImage(entry.dataUrl)
    } else if (entry.type === 'files') {
      const paths = (entry.files || []).map(file => file.path)
      if (options.paths) await host.clipboard.writeText(paths.join('\n'))
      else {
        if (entry.files.some(file => file.exists === false)) throw new Error('文件已移动或删除')
        await host.clipboard.writeFiles(paths)
      }
    } else await host.clipboard.writeText(entry.text || entry.preview)
    return true
  }
  const history = Object.freeze({
    async query(options) {
      const result = await call('query', [options])
      return { ...result, items: await Promise.all(result.items.map(inspect)) }
    },
    list: options => call('list', [options]),
    get,
    copy,
    async paste(id) { await copy(id); return host.clipboard.paste() },
    async reveal(id, index = 0) {
      const entry = await get(id), file = entry?.files?.[Math.max(0, Math.floor(Number(index) || 0))]
      if (!file) throw new Error('文件记录不存在')
      // The host confirms this exact target through localFiles before granting/revealing it.
      return host.clipboard.revealFile(file.path)
    },
    remove: id => call('remove', [id]),
    clear: () => call('clear'),
    togglePin: id => call('togglePin', [id]),
    preferencesChanged: () => call('preferencesChanged'),
    onChange(callback) {
      const listener = payload => { if (payload?.event === 'history.changed') callback(payload.data) }
      host.on('background.event', listener)
      return () => host.off('background.event', listener)
    }
  })
  return Object.freeze({ ...host, clipboard: Object.freeze({ ...host.clipboard, history }) })
}
