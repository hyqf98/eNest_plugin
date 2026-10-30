const copy = value => JSON.parse(JSON.stringify(value))

function assertActive(signal, disposed) {
  if (disposed) throw new Error('Launch index operation was cancelled')
  signal?.throwIfAborted?.()
}

/** A plugin owns the records and projection; the host receives public launch metadata only. */
export function createLaunchIndex({ api, storageKey, toEntries, onIndexError = () => {} }) {
  let tail = Promise.resolve()
  let disposed = false
  let retryTimer = null
  let retryDelay = 1000
  let notified = false
  let revision = 0
  const supported = () => typeof api?.contribute?.replaceLaunchIndex === 'function'
  const serial = run => {
    const task = tail.then(() => { assertActive(undefined, disposed); return run() })
    tail = task.catch(() => {})
    return task
  }
  const read = async signal => {
    assertActive(signal, disposed)
    if (typeof api?.storage?.get !== 'function') throw new Error('Plugin storage is unavailable')
    const value = await api.storage.get(storageKey)
    assertActive(signal, disposed)
    if (value != null && !Array.isArray(value)) throw new Error('Saved records are invalid')
    const records = value ?? []
    toEntries(records)
    return records
  }
  const retry = () => {
    if (disposed || retryTimer || !supported()) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void refresh().catch(() => { retryDelay = Math.min(retryDelay * 2, 30000); retry() })
    }, retryDelay)
  }
  const publish = async records => {
    if (!supported()) return
    assertActive(undefined, disposed)
    try {
      const result = await api.contribute.replaceLaunchIndex(toEntries(records))
      assertActive(undefined, disposed)
      if (!Number.isSafeInteger(result?.revision)) throw new Error('Launch index acknowledgement is invalid')
      revision = Math.max(revision, result.revision)
      notified = false
      retryDelay = 1000
      clearTimeout(retryTimer)
      retryTimer = null
    } catch (error) {
      if (disposed) return
      // Saving and publishing are separate commits. A failed projection must not undo saved records.
      try { await api.contribute.markLaunchIndexDirty() } catch { /* The local retry also remains active. */ }
      if (!notified) { notified = true; try { onIndexError(error) } catch { /* Reporting cannot reject a committed save. */ } }
      retryDelay = Math.min(retryDelay * 2, 30000)
      retry()
    }
  }
  const refresh = () => serial(async () => publish(await read()))
  const dispose = () => {
    disposed = true
    clearTimeout(retryTimer)
    retryTimer = null
  }
  api?.onDestroy?.(dispose)
  return {
    async readRecords(options = {}) { await tail; return read(options.signal) },
    indexSync: ({ signal } = {}) => serial(async () => {
      const records = await read(signal)
      assertActive(signal, disposed)
      return toEntries(records)
    }),
    commit(records) {
      const snapshot = copy(records)
      toEntries(snapshot)
      return serial(async () => {
        if (typeof api?.storage?.commit !== 'function') throw new Error('Durable plugin storage is unavailable')
        // Persist invalidation first so a crash between the two commits is repaired after restart.
        if (supported()) await api.contribute.markLaunchIndexDirty()
        const receipt = await api.storage.commit([{ op: 'set', key: storageKey, value: snapshot }])
        await publish(snapshot)
        return receipt
      })
    },
    refresh,
    dispose,
    get revision() { return revision }
  }
}

/** Hidden index repair never imports the UI. prepareView waits for the real business handlers. */
export function createIndexedView({ api, index, acceptsEnter = () => false, onError = () => {} }) {
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})
  let resolveHandler, rejectHandler
  const handlerReady = new Promise((resolve, reject) => { resolveHandler = resolve; rejectHandler = reject })
  handlerReady.catch(() => {})
  let enterTail = Promise.resolve()
  let loading
  let registerTask
  let disposed = false
  const report = error => {
    if (disposed) return
    try { onError(error) } catch { /* Error presentation does not own lifecycle delivery. */ }
  }
  api?.onEnter?.(event => {
    if (!acceptsEnter(event)) return
    enterTail = enterTail.then(async () => {
      const handler = await handlerReady
      assertActive(undefined, disposed)
      await handler(event)
    }).catch(report)
  })
  api?.onDestroy?.(() => {
    disposed = true
    const error = new Error('Plugin view was retired')
    rejectReady(error)
    rejectHandler(error)
  })
  return {
    ready() { if (!disposed) resolveReady() },
    setEnterHandler(handler) { if (!disposed) resolveHandler(handler) },
    fail(error) { rejectReady(error); rejectHandler(error) },
    start(loadView) {
      const prepareView = async ({ signal } = {}) => {
        assertActive(signal, disposed)
        if (!loading) {
          loading = Promise.resolve().then(loadView).then(() => ready)
          loading.catch(report)
        }
        await loading
        assertActive(signal, disposed)
      }
      if (!registerTask && typeof api?.launch?.registerHandlers === 'function') {
        registerTask = api.launch.registerHandlers({ indexSync: index.indexSync, prepareView })
        registerTask.catch(report)
      }
      if (!['index-sync', 'command', 'resident'].includes(api?.launch?.getContext?.())) {
        void prepareView().catch(() => {})
      }
      return registerTask ?? Promise.resolve()
    }
  }
}
