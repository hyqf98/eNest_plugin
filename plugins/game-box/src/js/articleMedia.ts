/**
 * 详情正文里的媒体地址解析。
 *
 * 后端净化正文时把第三方图片 / 视频的地址都换成了令牌（`img:…` / `video:…`），页面受 CSP 限制不能
 * 直接加载外站资源。这里在把 HTML 交给 React 之前，先把所有令牌批量换成可显示的地址
 * （小图是 data URL，大图 / 视频是回环代理地址），再渲染。
 *
 * 正文是一次性整段渲染的，不能像卡片那样逐个组件订阅；所以先解析完所有令牌再输出最终 HTML。
 * 解析失败的令牌：图片去掉 src（显示 alt），视频去掉 src（挂载后被隐藏），不影响其余内容。
 */

import { useEffect, useState } from 'react'
import * as api from './api'
import { loadImage } from './media'

interface MediaPayload { url: string; mime: string }

const TOKEN_ATTRIBUTE = /\b(src|poster)="((?:img|video):[A-Za-z0-9_-]+)"/g
const VIDEO_CACHE_MAX = 48

const videoCache = new Map<string, Promise<MediaPayload>>()

/** 收集 HTML 里出现的全部媒体令牌（去重） */
export function collectMediaTokens(html: string): string[] {
  const tokens = new Set<string>()
  for (const match of html.matchAll(TOKEN_ATTRIBUTE)) tokens.add(match[2])
  return [...tokens]
}

/** 取一个令牌的可显示地址：图片令牌走图片缓存（与卡片封面共用），视频令牌单独缓存 */
export function loadMedia(token: string): Promise<MediaPayload> {
  if (token.startsWith('img:')) return loadImage(token).then(url => ({ url, mime: '' }))
  let pending = videoCache.get(token)
  if (!pending) {
    pending = api.media.load(token).catch(() => ({ url: '', mime: '' }))
    videoCache.set(token, pending)
    while (videoCache.size > VIDEO_CACHE_MAX) {
      const oldest = videoCache.keys().next().value
      if (!oldest) break
      videoCache.delete(oldest)
    }
  }
  return pending
}

/** 把 HTML 里的令牌换成可显示地址；失败的令牌去掉对应属性 */
export async function resolveMediaHtml(html: string): Promise<string> {
  const tokens = collectMediaTokens(html)
  if (!tokens.length) return html
  const resolved = new Map<string, string>()
  await Promise.all(tokens.map(async token => {
    const payload = await loadMedia(token)
    const url = payload.url
    // 只接受后端给出的 data URL 与回环代理地址；其它一律当作失败，不让页面去连任意外站
    const safe = url.startsWith('data:') || /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(url)
    resolved.set(token, safe ? url : '')
  }))
  return html.replace(TOKEN_ATTRIBUTE, (whole, attr: string, token: string) => {
    const url = resolved.get(token)
    return url ? `${attr}="${url}"` : ''
  })
}

/** React 绑定：返回已解析的 HTML；解析完成前返回空串 */
export function useResolvedHtml(html: string): string {
  const [resolved, setResolved] = useState('')
  useEffect(() => {
    let alive = true
    setResolved('')
    void resolveMediaHtml(html).then(value => { if (alive) setResolved(value) })
    return () => { alive = false }
  }, [html])
  return resolved
}

export function dropMediaCache(): void {
  videoCache.clear()
}
