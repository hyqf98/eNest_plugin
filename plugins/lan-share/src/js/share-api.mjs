export function createShareApi(api) {
  let currentShare = null
  const call = (method, args = []) => api.backend.call(`share.${method}`, args)
  const on = (event, listener) => api.on('backend.event', message => {
    if (message?.event === 'lan.status' && message.data?.shareId === currentShare?.shareId) currentShare = message.data
    if (event === 'lan.stopped' && message?.event === 'backend.exit' && currentShare?.shareId) {
      listener({ shareId: currentShare.shareId, reason: 'backend exited', status: { ...currentShare, stopped: true,
        stopReason: 'backend exited', activeConnections: 0 } })
      return
    }
    if (message?.event === event) listener(message.data)
  })
  return {
    async start(options) { currentShare = await call('start', [options]); return currentShare },
    async stop(id) {
      const result = await call('stop', [id])
      if (result && currentShare?.shareId === id) currentShare = null
      return result
    },
    status: id => call('status', [id]),
    list: () => call('list'),
    onRequest: listener => on('lan.request', listener),
    onStatus: listener => on('lan.status', listener),
    onStopped: listener => on('lan.stopped', listener)
  }
}
