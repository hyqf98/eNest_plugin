/**
 * 视频：轮播里的大图播放器，以及正文里内嵌视频的源接管。
 *
 * 宿主 CSP 对页面的约束：`media-src 'self' blob:`，`connect-src 'self' http://127.0.0.1:* …`。
 * 后端的回环代理地址是 `http://127.0.0.1:<端口>/…`，与页面不同源——所以 <video src="回环地址"> 会被
 * media-src 拦掉，而 fetch 回环地址是被允许的。因此所有视频都走"fetch → blob: 媒体源"：
 * - HLS 播放列表：hls.js（它本来就用 fetch + MSE）；
 * - 普通视频（mp4 / webm）：整段取回后转成 blob: URL 再交给 <video>（正文里的短片只有几百 KB）。
 */

import { useEffect, useRef, useState } from 'react'
import type Hls from 'hls.js'

/** 由后端给出的 MIME 判断是否是 HLS 播放列表；地址以 .m3u8 结尾的也算（回环地址通常不带扩展名） */
export function isPlaylistSource(url: string, mime = ''): boolean {
  return /mpegurl/i.test(mime) || /\.m3u8(?:$|[?#])/i.test(url)
}

/** 后端给出的回环地址：只有这种地址才会被取回并转成 blob: */
export function isLoopbackUrl(url: string): boolean {
  return /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(url)
}

/** 取回一个回环地址的内容并转成 blob: URL；失败抛错。调用方负责之后 revokeObjectURL */
export async function fetchAsBlobUrl(url: string, mime = '', signal?: AbortSignal): Promise<{ url: string; size: number }> {
  if (!isLoopbackUrl(url)) throw new Error('只允许取回本机回环代理的视频地址')
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`视频加载失败（HTTP ${response.status}）`)
  const blob = await response.blob()
  const type = mime.split(';')[0].trim() || blob.type || 'video/mp4'
  return { url: URL.createObjectURL(type === blob.type ? blob : blob.slice(0, blob.size, type)), size: blob.size }
}

/** 一个视频源的准备结果：ready 解析为可直接赋给 <video src> 的 blob: 地址；HLS 则通过 attach 挂到播放器 */
export interface PreparedSource {
  ready: Promise<string>
  attach(video: HTMLVideoElement): void
  destroy(): void
}

/** 给一个 <video> 准备源（异步取回）。调用方在 ready 之后把地址赋给 <video>；HLS 由 attach 处理。 */
export function prepareVideoSource(url: string, mime = ''): PreparedSource {
  let hls: Hls | null = null
  let Engine: typeof Hls | undefined
  const controller = new AbortController()
  let objectUrl = ''
  let destroyed = false
  const playlist = isPlaylistSource(url, mime)
  const ready = (async (): Promise<string> => {
    // HLS 不在这里取回：hls.js 自己用 fetch 拉分片（见 attach）。普通视频取回后转成 blob:。
    if (!url) return ''
    if (playlist) { Engine = (await import('hls.js')).default; return '' }
    const blob = await fetchAsBlobUrl(url, mime, controller.signal)
    if (destroyed) { URL.revokeObjectURL(blob.url); return '' }
    objectUrl = blob.url
    return objectUrl
  })()
  return {
    ready,
    attach(video: HTMLVideoElement): void {
      if (destroyed || !Engine?.isSupported()) return
      hls = new Engine({ enableWorker: false, lowLatencyMode: false, backBufferLength: 30 })
      hls.on(Engine.Events.ERROR, (_event, data) => {
        if (data.fatal) { hls?.destroy(); hls = null; video.removeAttribute('src'); video.load(); video.dispatchEvent(new Event('error')) }
      })
      hls.loadSource(url)
      hls.attachMedia(video)
    },
    destroy(): void {
      destroyed = true
      controller.abort()
      hls?.destroy(); hls = null
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = '' }
    },
  }
}

/** React 绑定：源就绪后给 ref 指向的 <video> 接上地址（HLS 则挂 hls.js）；返回是否就绪，供调用方决定何时播放 */
export function useVideoSource(videoRef: React.RefObject<HTMLVideoElement>, url: string, mime = ''): boolean {
  const prepared = useRef<PreparedSource | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
    if (!url) return
    const source = prepareVideoSource(url, mime)
    prepared.current = source
    let cancelled = false
    void source.ready.then(blobUrl => {
      if (cancelled) return
      const video = videoRef.current
      if (!video) return
      // HLS 的 ready 解析为空串：由 attach 挂 hls.js；普通视频直接赋 blob: 地址
      if (blobUrl) video.src = blobUrl
      source.attach(video)
      setReady(true)
    }).catch(() => { if (!cancelled) videoRef.current?.dispatchEvent(new Event('error')) })
    return () => { cancelled = true; source.destroy(); if (prepared.current === source) prepared.current = null }
  }, [videoRef, url, mime])
  return ready
}

/**
 * 处理一段已渲染 HTML 里的全部 <video>（正文是整段注入的，无法逐个绑定 ref）。
 * 每个视频：把自身 src 与 <source> 子元素上的回环地址逐个取回、转成 blob:，再写回元素
 * （保留 <source> 的 type，让浏览器挑它支持的格式）。全部取回之前先停住播放器，
 * 避免它拿着会被 CSP 拦的地址去尝试。一个可用地址都没有的视频交给 onHide 隐藏。
 * 返回清理函数：释放所有 blob:。
 */
export function enhanceArticleVideos(root: HTMLElement, onHide?: (video: HTMLVideoElement) => void): () => void {
  const allObjectUrls: string[] = []
  const controller = new AbortController()
  for (const video of root.querySelectorAll('video')) {
    const own = video.getAttribute('src') || ''
    const sources = [...video.querySelectorAll('source')].map(element => ({ element, url: element.getAttribute('src') || '', type: element.getAttribute('type') || '' })).filter(entry => entry.url)
    if (!own && !sources.length) { onHide?.(video); continue }
    // 停住播放器并先摘掉会被拦的地址（保留 type）
    const ownMime = ''
    video.pause()
    video.removeAttribute('src')
    for (const entry of sources) entry.element.removeAttribute('src')
    const jobs: Array<Promise<{ set(url: string): void; url: string } | null>> = []
    const grab = (url: string, mime: string, set: (url: string) => void) => fetchAsBlobUrl(url, mime, controller.signal)
      .then(blob => {
        if (controller.signal.aborted) { URL.revokeObjectURL(blob.url); return null }
        allObjectUrls.push(blob.url); return { set, url: blob.url }
      })
      .catch(() => null)
    if (own && isLoopbackUrl(own)) jobs.push(grab(own, ownMime, url => video.setAttribute('src', url)))
    for (const entry of sources) if (isLoopbackUrl(entry.url)) jobs.push(grab(entry.url, entry.type, url => entry.element.setAttribute('src', url)))
    void Promise.all(jobs).then(results => {
      if (controller.signal.aborted) return
      const usable = results.filter((result): result is NonNullable<typeof result> => result !== null)
      if (!usable.length) { onHide?.(video); return }
      for (const result of usable) result.set(result.url)
      video.load()
    })
  }
  return () => { controller.abort(); for (const url of allObjectUrls.splice(0)) URL.revokeObjectURL(url) }
}
