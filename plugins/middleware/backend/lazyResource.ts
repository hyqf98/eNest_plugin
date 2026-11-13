/** One initialization per owner; a failed attempt is retryable until the owner closes. */
export function createLazyResource<T>(create: () => T | Promise<T>, dispose: (value: T) => void | Promise<void> = () => {}) {
  let flight: Promise<T> | undefined
  let value: T | undefined
  let available = false, closed = false
  let disposal: Promise<void> | undefined, shutdown: Promise<void> | undefined
  const closedError = () => new Error('Lazy resource owner is closing')
  function disposeValue(): Promise<void> {
    if (!available) return Promise.resolve()
    if (!disposal) disposal = Promise.resolve().then(() => dispose(value as T)).finally(() => { value = undefined; available = false })
    return disposal
  }
  return {
    get(): Promise<T> {
      if (closed) return Promise.reject(closedError())
      if (!flight) {
        const pending = Promise.resolve().then(() => {
          if (closed) throw closedError()
          return create()
        }).then(async resource => {
          value = resource; available = true
          if (closed) { await disposeValue(); throw closedError() }
          return resource
        }).catch(error => {
          if (flight === pending) flight = undefined
          throw error
        })
        flight = pending
      }
      return flight
    },
    close(): Promise<void> {
      if (shutdown) return shutdown
      closed = true
      shutdown = (async () => {
        // A late initializer must dispose its result before shutdown can complete.
        await flight?.catch(() => undefined)
        if (disposal) await disposal
        else await disposeValue()
      })().finally(() => { flight = undefined })
      return shutdown
    }
  }
}

export type LazyResource<T> = ReturnType<typeof createLazyResource<T>>
