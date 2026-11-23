/**
 * 天翼云 API 签名与 accessToken 获取：
 * - getFileDownloadUrl 的 MD5 签名串；
 * - 经 ssoH5.action 逐跳 302 换 accessToken（从任一跳 URL 的查询参数取）。
 */

import { BackendError } from '../adapters/types.ts'
import { md5Hex } from '../crypto.ts'
import { CookieJar, jarRequest } from './http.ts'

export const APP_ID = '8025431004'
export const CLIENT_TYPE = '10020'
export const RETURN_URL = 'https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html'
const SSO_URL = 'https://api.cloud.189.cn/open/oauth2/ssoH5.action'

/** 当前秒级时间戳文本 */
export function timestampSeconds(): string {
  return Math.floor(Date.now() / 1000).toString()
}

/** noCache 参数：`秒.1..61`（源项目取纳秒模 61 加一） */
export function noCacheParam(): string {
  const nanos = process.hrtime.bigint()
  const rand = Number(nanos % 61n) + 1
  return `${timestampSeconds()}.${rand}`
}

/**
 * getFileDownloadUrl 的签名：md5("AccessToken={token}&Timestamp={秒}&dt=1&fileId={fid}&shareId={sid}")
 */
export function downloadSignature(accessToken: string, timestamp: string, fileId: string, shareId: string): string {
  return md5Hex(`AccessToken=${accessToken}&Timestamp=${timestamp}&dt=1&fileId=${fileId}&shareId=${shareId}`)
}

/** 从 URL 里提取 accessToken / AccessToken 查询参数；没有返回空串 */
export function accessTokenFromUrl(url: string): string {
  for (const key of ['accessToken', 'AccessToken']) {
    try {
      const value = new URL(url).searchParams.get(key)
      if (value) return value
    } catch {
      // 非法 URL 忽略。
    }
  }
  return ''
}

/**
 * ssoH5 换 accessToken：带 cookie 逐跳跟随 302，从每一跳的 Location（或该跳的请求地址）里取 token。
 * jarRequest 不会回传最终地址，所以必须在 onHop 回调里逐跳检查；取不到即登录失效。
 */
export async function ssoAccessToken(jar: CookieJar): Promise<string> {
  let found = ''
  await jarRequest(jar, {
    url: SSO_URL,
    maxHops: 10,
    headers: { accept: 'application/json;charset=UTF-8', referer: 'https://cloud.189.cn/' },
    onHop(response, url) {
      if (found) return
      found = accessTokenFromUrl(url) || accessTokenFromUrl(response.location)
    },
  })
  if (!found) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
  return found
}

/** getSessionForPC 响应体可能是 JSON 也可能是 XML，两种都解析成扁平键值 */
export function parseSessionResponse(text: string): Record<string, string> {
  const trimmed = text.trim()
  const out: Record<string, string> = {}
  if (trimmed.startsWith('<')) {
    for (const match of trimmed.matchAll(/<([A-Za-z][A-Za-z0-9]*)>([^<]*)<\/\1>/g)) {
      const key = match[1]
      const value = decodeEntities(match[2] ?? '').trim()
      if (key && !(key in out)) out[key] = value
    }
    return out
  }
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') out[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
    }
    return out
  } catch {
    // 极少数情况下是 URL 编码的 k=v&k=v。
    for (const pair of trimmed.split('&')) {
      const eq = pair.indexOf('=')
      if (eq > 0) out[pair.slice(0, eq)] = decodeEntities(pair.slice(eq + 1)).trim()
    }
    return out
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
