/**
 * 天翼云会话：用已保存的 refreshToken 续期。
 *
 * 登录本身不在这里做。天翼的登录接口要求官方签名并带设备校验，第三方无法复刻；
 * 用户在宿主提供的应用内登录窗口（web.login）里登录天翼自己的页面，页面拿到会话 cookie 后入库。
 * 这里只负责一件事：对带有 refreshToken 的旧会话尝试续期。网页登录得到的会话只有 cookie、
 * 没有 refreshToken，refreshSession 对它会直接返回 null（交给调用方按"需要重新登录"处理）。
 * 凭据不进日志、错误消息。
 */

import { CookieJar, jarRequestText, seedJarFromCredential } from './http.ts'
import { APP_ID, parseSessionResponse, timestampSeconds } from './sign.ts'

/** 会话凭据 JSON（由页面 vault.set 保存，后端只持有 secretRef） */
export type SessionCredential = string

interface SessionFields {
  sessionKey?: string
  sessionSecret?: string
  familySessionKey?: string
  familySessionSecret?: string
  accessToken?: string
  refreshToken?: string
  familyAccessToken?: string
  familyRefreshToken?: string
}

function buildCredential(cookie: string, session: SessionFields, redirectUrl: string): SessionCredential {
  return JSON.stringify({
    cookie,
    sessionKey: session.sessionKey ?? '',
    sessionSecret: session.sessionSecret ?? '',
    familySessionKey: session.familySessionKey ?? '',
    familySessionSecret: session.familySessionSecret ?? '',
    accessToken: session.accessToken ?? '',
    refreshToken: session.refreshToken ?? '',
    familyAccessToken: session.familyAccessToken ?? '',
    familyRefreshToken: session.familyRefreshToken ?? '',
    redirectUrl,
    savedAt: timestampSeconds(),
  })
}

/** 用 refreshToken 刷新会话；成功返回新凭据 JSON，失败或没有 refreshToken 返回 null */
export async function refreshSession(credential: SessionCredential): Promise<SessionCredential | null> {
  let parsed: Record<string, string>
  try {
    parsed = JSON.parse(credential) as Record<string, string>
  } catch {
    return null
  }
  const refreshToken = parsed.refreshToken
  if (!refreshToken) return null
  const jar = new CookieJar()
  seedJarFromCredential(jar, credential)
  const { response, text } = await jarRequestText(jar, {
    url: `https://api.cloud.189.cn/getSessionForPC.action?appId=${APP_ID}&accessToken=${encodeURIComponent(refreshToken)}&clientSn=${crypto.randomUUID()}&clientType=TELEMAC&version=1.0.0&channelId=web_cloud.189.cn`,
    headers: { referer: 'https://cloud.189.cn/', accept: 'application/json;charset=UTF-8' },
  })
  if (response.status !== 200) return null
  const session = parseSessionResponse(text)
  if (!session.sessionKey && !session.accessToken) return null
  return buildCredential(jar.header(), session, parsed.redirectUrl ?? '')
}
