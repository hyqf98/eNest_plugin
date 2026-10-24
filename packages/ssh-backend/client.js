const clients = new WeakMap()
const events = new Set(['ssh.data', 'ssh.exit', 'ssh.error', 'ssh.auth', 'ssh.metrics', 'ssh.transfer'])

/** Browser-only domain adapter. Never mutates the frozen preload bridge. */
export function createSshHost(host) {
  if (!host || typeof host !== 'object') return host
  if (clients.has(host)) return clients.get(host)
  const listeners = new Map()
  const call = (method, args) => {
    if (typeof host.backend?.call !== 'function') return Promise.reject(new Error('请更新 eNest 以使用插件自有 SSH 后端'))
    const timeoutMs = method === 'ssh.connect' ? 1_200_000
      : ['ssh.sftp.download', 'ssh.sftp.upload'].includes(method) ? 86_400_000 : 180_000
    return host.backend.call(method, args, { timeoutMs })
  }
  const sessionId = input => typeof input === 'object' && input ? input.sessionId : input
  const adapter = {
    ...host,
    ssh: {
      connect: input => call('ssh.connect', [input]),
      write: (id, data) => call('ssh.write', [id, data]),
      resize: (id, cols, rows) => call('ssh.resize', [id, cols, rows]),
      disconnect: id => call('ssh.disconnect', [sessionId(id)]),
      listSessions: () => call('ssh.listSessions', []),
      exec: input => call('ssh.exec', [input]),
      workbench: input => call('ssh.workbench', [input]),
      metrics: {
        start: (input, intervalMs) => call('ssh.metrics.start', [sessionId(input), typeof input === 'object' && input ? input.intervalMs : intervalMs]),
        stop: input => call('ssh.metrics.stop', [sessionId(input)]),
        latest: input => call('ssh.metrics.latest', [sessionId(input)])
      },
      completion: { suggest: input => call('ssh.completion.suggest', [input]) },
      sftp: {
        list: input => call('ssh.sftp.list', [input]),
        download: input => call('ssh.sftp.download', [input]),
        upload: input => call('ssh.sftp.upload', [input]),
        mkdir: (id, path) => call('ssh.sftp.mkdir', [id, path]),
        rename: (id, path, newPath) => call('ssh.sftp.rename', [id, path, newPath]),
        delete: (id, path, recursive) => call('ssh.sftp.delete', [id, path, recursive]),
        chmod: (id, path, mode) => call('ssh.sftp.chmod', [id, path, mode])
      },
      pickLocalFile: async options => (await host.localFiles.pick(options))[0] ?? null
    },
    on(event, listener) {
      if (!events.has(event)) return host.on?.(event, listener)
      if (typeof listener !== 'function' || typeof host.on !== 'function') return () => {}
      let group = listeners.get(event)
      if (!group) { group = new Map(); listeners.set(event, group) }
      if (group.has(listener)) return group.get(listener)
      const relay = envelope => {
        if (envelope?.event === event) listener(envelope.data)
        else if (event === 'ssh.error' && envelope?.event === 'backend.exit' && envelope.data?.unexpected === true) {
          const code = Number.isFinite(envelope.data.code) ? `（${envelope.data.code}）` : ''
          listener({ type: 'ssh.error', message: `SSH 后端已退出${code}，请重新连接` })
        }
      }
      const unsubscribe = host.on('backend.event', relay)
      let removed = false
      const off = () => {
        if (removed) return
        removed = true
        if (typeof unsubscribe === 'function') unsubscribe()
        else host.off?.('backend.event', relay)
        group.delete(listener)
        if (!group.size) listeners.delete(event)
      }
      group.set(listener, off)
      return off
    },
    off(event, listener) {
      if (events.has(event)) listeners.get(event)?.get(listener)?.()
      else host.off?.(event, listener)
    }
  }
  clients.set(host, adapter)
  return adapter
}
