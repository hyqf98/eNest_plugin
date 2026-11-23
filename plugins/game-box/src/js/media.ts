/**
 * 图片加载：封面、截图都是第三方站点直链，页面受 CSP 限制不能直接加载，
 * 统一经后端 media.load 换成可显示地址（小图 data URL，大图走回环代理）。
 * 带 LRU 缓存、并发闸、同地址去重；失败不缓存（避免偶发失败后整张图一直空白）。
 */

import { useEffect, useState } from 'react'
import * as api from './api'

const CACHE_MAX = 300
const CONCURRENCY = 6
const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()
let active = 0
const queue: Array<() => void> = []

function trim(): void {
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}

async function acquire(): Promise<() => void> {
  if (active < CONCURRENCY) { active++; return () => { active--; queue.shift()?.() } }
  await new Promise<void>(resolve => queue.push(resolve))
  active++
  let released = false
  return () => {
    if (released) return
    released = true
    active--
    queue.shift()?.()
  }
}

/** token 为空直接返回空串（调用方显示占位） */
export function loadImage(token: string): Promise<string> {
  if (!token) return Promise.resolve('')
  const cached = cache.get(token)
  if (cached !== undefined) {
    cache.delete(token); cache.set(token, cached)
    return Promise.resolve(cached)
  }
  const pending = inflight.get(token)
  if (pending) return pending
  const task = (async () => {
    const release = await acquire()
    try {
      const payload = await api.media.load(token)
      cache.set(token, payload.url)
      trim()
      return payload.url
    } catch {
      return ''
    } finally {
      release()
      inflight.delete(token)
    }
  })()
  inflight.set(token, task)
  return task
}

export function dropImageCache(): void {
  cache.clear()
}

/** React 绑定：返回可显示地址，加载中为空串 */
export function useMedia(token: string): string {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let alive = true
    setUrl(cache.get(token) ?? '')
    void loadImage(token).then(value => { if (alive) setUrl(value) })
    return () => { alive = false }
  }, [token])
  return url
}
