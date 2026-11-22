import { useEffect, useState } from 'react'
import { thumbs, library } from './api'

interface CacheEntry {
  dataUrl: string | null
  error?: string
}

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<CacheEntry>>()
const queue: Array<() => void> = []
let active = 0
const MAX_ACTIVE = 4
const MAX_CACHE = 400

export function useThumbnail(url: string | undefined, headers?: Record<string, string>): { dataUrl: string | null; loading: boolean; error?: string } {
  const key = url ? `source:${url}` : ''
  const [entry, setEntry] = useState<CacheEntry | null>(() => key ? cache.get(key) ?? null : null)

  useEffect(() => {
    if (!key || !url) {
      setEntry(null)
      return
    }
    const cached = cache.get(key)
    if (cached) {
      setEntry(cached)
      return
    }
    let cancelled = false
    setEntry(null)
    void loadThumb(key, () => thumbs.get(url, headers)).then(next => {
      if (!cancelled) setEntry(next)
    })
    return () => { cancelled = true }
  }, [key, url, headers])

  return { dataUrl: entry?.dataUrl ?? null, loading: entry === null, error: entry?.error }
}

export function useLibraryThumbnail(id: string): { dataUrl: string | null; loading: boolean; error?: string } {
  const key = id ? `library:${id}` : ''
  const [entry, setEntry] = useState<CacheEntry | null>(() => key ? cache.get(key) ?? null : null)

  useEffect(() => {
    if (!id || !key) {
      setEntry(null)
      return
    }
    const cached = cache.get(key)
    if (cached) {
      setEntry(cached)
      return
    }
    let cancelled = false
    setEntry(null)
    void loadThumb(key, async () => {
      const result = await library.thumbnail(id)
      return { dataUrl: result.dataUrl, error: result.message }
    }).then(next => {
      if (!cancelled) setEntry(next)
    })
    return () => { cancelled = true }
  }, [id, key])

  return { dataUrl: entry?.dataUrl ?? null, loading: entry === null, error: entry?.error }
}

export function invalidateLibraryThumbnail(id: string): void {
  cache.delete(`library:${id}`)
}

async function loadThumb(key: string, loader: () => Promise<{ dataUrl: string | null; error?: string }>): Promise<CacheEntry> {
  const running = inFlight.get(key)
  if (running) return running
  const promise = new Promise<CacheEntry>((resolve, reject) => {
    const start = () => {
      active += 1
      loader().then(result => {
        const entry: CacheEntry = { dataUrl: result.dataUrl, error: result.error }
        remember(key, entry)
        resolve(entry)
      }).catch(error => {
        const entry: CacheEntry = { dataUrl: null, error: error instanceof Error ? error.message : String(error) }
        remember(key, entry)
        reject(error)
      }).finally(() => {
        active -= 1
        pump()
      })
    }
    queue.push(start)
    pump()
  }).catch(() => ({ dataUrl: null }))
  inFlight.set(key, promise)
  promise.finally(() => inFlight.delete(key))
  return promise
}

function pump(): void {
  while (active < MAX_ACTIVE) {
    const next = queue.shift()
    if (!next) return
    next()
  }
}

function remember(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== 'string') break
    cache.delete(oldest)
  }
}
