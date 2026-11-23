/**
 * 天翼云登录：扫码（createQrSession）与账密（loginWithPassword）。
 * 入口页 unifyLoginForPC.action 302 到 open.e.189.cn，每一跳收集 Set-Cookie，
 * 落地页正则取 lt / reqId / paramId / captchaToken / returnUrl / j_rsaKey。
 * 会话凭据通过返回值交给调用方（页面用 vault.set 保存），本模块不写任何存储。
 * 凭据不进日志、错误消息。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import { rsaEncodeGowsp, rsaEncodeTickstep } from '../crypto.ts'
import { CookieJar, FORM_HEADERS, formEncode, jarRequest, jarRequestJson, jarRequestText } from './http.ts'
import { APP_ID, CLIENT_TYPE, RETURN_URL, parseSessionResponse, timestampSeconds } from './sign.ts'

const ENTRY_URL = 'https://cloud.189.cn/unifyLoginForPC.action'
const OPEN_BASE = 'https://open.e.189.cn'

export interface LoginParams {
  lt: string
  reqId: string
  paramId: string
  captchaToken: string
  returnUrl: string
  jRsaKey: string
}

export interface LoginSuccess {
  cookie: string
  session: Record<string, string>
  redirectUrl: string
}

/** 会话凭据 JSON（交给页面 vault.set 保存） */
export type SessionCredential = string

export interface QrSession {
  /** 开始登录：取参数、生成二维码图片（data URL）。返回图片地址。 */
  start(): Promise<string>
  /** 轮询一次状态 */
  poll(): Promise<QrPollResult>
  /** 取消（清 cookie 与状态） */
  cancel(): void
  /** 成功后可取会话凭据（JSON 字符串） */
  credential(): SessionCredential
}

export type QrPollResult = 'pending' | 'scanned' | 'success' | 'expired'

const QR_STATUS: Record<string, QrPollResult> = {
  '-106': 'pending',
  '-11002': 'scanned',
  '0': 'success',
}

function nowDate(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function matchOne(html: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[1]) return match[1]
  }
  return ''
}

/** 从落地页 HTML 里取登录参数 */
function extractLoginParams(html: string): LoginParams {
  const lt = matchOne(html, [/lt\s*=\s*"(.+?)"/, /name="lt"\s+value="(.+?)"/])
  const reqId = matchOne(html, [/reqId\s*=\s*"(.+?)"/, /name="reqId"\s+value="(.+?)"/])
  const paramId = matchOne(html, [/paramId\s*=\s*"(.+?)"/, /name="paramId"\s+value="(.+?)"/])
  const captchaToken = matchOne(html, [/captchaToken' value='(.+?)'/, /captchaToken"\s+value="(.+?)"/])
  const returnUrl = matchOne(html, [/returnUrl\s*=\s*'(.+?)'/, /returnUrl\s*=\s*"(.+?)"/])
  const jRsaKey = matchOne(html, [/j_rsaKey" value="(.+?)"/, /j_rsaKey' value='(.+?)'/])
  if (!lt || !reqId || !jRsaKey) throw new BackendError('LOGIN_FAILED', '登录页面参数获取失败，请重试')
  return { lt, reqId, paramId, captchaToken, returnUrl: returnUrl || RETURN_URL, jRsaKey }
}

/** 走入口页拿登录参数与 cookie */
async function fetchLoginParams(jar: CookieJar): Promise<LoginParams> {
  const entry = `${ENTRY_URL}?appId=${APP_ID}&clientType=${CLIENT_TYPE}&returnURL=${encodeURIComponent(RETURN_URL)}&timeStamp=${Date.now()}`
  const { response, text } = await jarRequestText(jar, {
    url: entry,
    headers: { accept: 'text/html,application/xhtml+xml', referer: 'https://cloud.189.cn/' },
    maxHops: 6,
  })
  if (response.status !== 200) throw new BackendError('LOGIN_FAILED', `登录入口请求失败（HTTP ${response.status}）`)
  return extractLoginParams(text)
}

async function fetchAppConf(jar: CookieJar, params: LoginParams): Promise<void> {
  const adapter = getAdapter()
  const response = await jarRequest(jar, {
    url: `${OPEN_BASE}/api/logbox/oauth2/appConf.do`,
    method: 'POST',
    headers: {
      ...FORM_HEADERS,
      referer: `${OPEN_BASE}/`,
      origin: OPEN_BASE,
      lt: params.lt,
      reqid: params.reqId,
    },
    body: formEncode({ version: '2.0', appKey: APP_ID }),
  })
  void adapter
  const text = new TextDecoder('utf-8').decode(response.body)
  if (!/'?result'?"?\s*:\s*'?"?0/.test(text)) throw new BackendError('LOGIN_FAILED', '登录环境初始化失败')
}

function assertOk(response: { status: number }, context: string): void {
  if (response.status !== 200) throw new BackendError('LOGIN_FAILED', `${context}（HTTP ${response.status}）`)
}

/** 成功后统一换会话：getSessionForPC.action */
async function exchangeSession(jar: CookieJar, redirectUrl: string): Promise<LoginSuccess> {
  const cookie = jar.header()
  const { response, text } = await jarRequestText(jar, {
    url: 'https://api.cloud.189.cn/getSessionForPC.action',
    method: 'POST',
    headers: {
      ...FORM_HEADERS,
      cookie: cookie || jar.header(),
      referer: 'https://cloud.189.cn/',
      lt: jar.get('LT'),
      reqid: jar.get('reqId') || jar.get('REQID'),
    },
    body: formEncode({
      appId: APP_ID,
      clientType: 'TELEMAC',
      version: '1.0.0',
      channelId: 'web_cloud.189.cn',
      redirectURL: redirectUrl,
    }),
  })
  assertOk(response, '会话交换失败')
  const session = parseSessionResponse(text)
  if (!session.sessionKey && !session.accessToken) throw new BackendError('LOGIN_FAILED', '会话交换失败（响应缺少凭据）')
  return { cookie: jar.header(), session, redirectUrl }
}

function buildCredential(success: LoginSuccess): SessionCredential {
  return JSON.stringify({
    cookie: success.cookie,
    sessionKey: success.session.sessionKey ?? '',
    sessionSecret: success.session.sessionSecret ?? '',
    familySessionKey: success.session.familySessionKey ?? '',
    familySessionSecret: success.session.familySessionSecret ?? '',
    accessToken: success.session.accessToken ?? '',
    refreshToken: success.session.refreshToken ?? '',
    familyAccessToken: success.session.familyAccessToken ?? '',
    familyRefreshToken: success.session.familyRefreshToken ?? '',
    redirectUrl: success.redirectUrl,
    savedAt: timestampSeconds(),
  })
}

/** 扫码登录会话 */
export function createQrSession(): QrSession {
  const jar = new CookieJar()
  let params: LoginParams | null = null
  let encryUuid = ''
  let uuid = ''
  let qrImage = ''
  let credential = ''
  let done = false

  const session: QrSession = {
    async start() {
      params = await fetchLoginParams(jar)
      await fetchAppConf(jar, params)
      const uuidData = await jarRequestJson<{ uuid?: string; encryuuid?: string; encodeuuid?: string; result?: number }>(jar, {
        url: `${OPEN_BASE}/api/logbox/oauth2/getUUID.do?appId=${APP_ID}&timeStamp=${Date.now()}`,
        headers: { referer: `${OPEN_BASE}/`, lt: params.lt, reqid: params.reqId },
      })
      if (uuidData.data.result !== 0 || !uuidData.data.uuid) throw new BackendError('LOGIN_FAILED', '二维码生成失败')
      uuid = uuidData.data.uuid
      encryUuid = uuidData.data.encryuuid ?? ''
      const encodeUuid = uuidData.data.encodeuuid ?? uuid
      const image = await jarRequest(jar, {
        url: `${OPEN_BASE}/api/logbox/oauth2/image.do?REQID=${encodeURIComponent(params.reqId)}&uuid=${encodeURIComponent(encodeUuid)}`,
        headers: { referer: `${OPEN_BASE}/`, lt: params.lt, reqid: params.reqId, accept: 'image/png,image/*' },
      })
      assertOk(image, '二维码获取失败')
      qrImage = `data:image/png;base64,${Buffer.from(image.body).toString('base64')}`
      return qrImage
    },
    async poll() {
      if (done) return 'success'
      if (!params || !uuid) throw new BackendError('LOGIN_FAILED', '请先调用 start()')
      const { response, data } = await jarRequestJson<{ status?: number | string; msg?: string; redirectUrl?: string }>(jar, {
        url: `${OPEN_BASE}/api/logbox/oauth2/qrcodeLoginState.do`,
        method: 'POST',
        headers: {
          ...FORM_HEADERS,
          referer: `${OPEN_BASE}/`,
          origin: OPEN_BASE,
          lt: params.lt,
          reqid: params.reqId,
          'bic-qr': '1',
        },
        body: formEncode({
          appId: APP_ID,
          encryuuid: encryUuid,
          date: nowDate(),
          uuid,
          returnUrl: params.returnUrl,
          clientType: CLIENT_TYPE,
          timeStamp: timestampSeconds(),
          cb_SaveName: '0',
          isOauth2: 'false',
          state: '',
          paramId: params.paramId,
        }),
      })
      const statusKey = String(data.status ?? '')
      // 头里也可能带 status（部分网关只放头里）。
      const headerStatus = response.headers['status'] ?? ''
      const outcome = QR_STATUS[statusKey] ?? QR_STATUS[headerStatus]
      if (!outcome) return data.msg ? 'pending' : 'pending'
      if (outcome === 'success') {
        const redirectUrl = data.redirectUrl ?? ''
        if (!redirectUrl) throw new BackendError('LOGIN_FAILED', '扫码成功但缺少会话跳转地址')
        const success = await exchangeSession(jar, redirectUrl)
        credential = buildCredential(success)
        done = true
      }
      return outcome
    },
    cancel() {
      jar.clear()
      done = false
      credential = ''
    },
    credential() {
      return credential
    },
  }
  return session
}

export interface PasswordLoginInput {
  account: string
  password: string
  /** 图形验证码；空表示尚未提供 */
  captcha: string
  /** 是否记住账号密码（由调用方决定保存方式，这里只透传给返回值） */
  remember: boolean
}

export type PasswordLoginResult =
  | { kind: 'success'; credential: SessionCredential; remember: boolean }
  | { kind: 'needCaptcha'; image: string }

/** 账密登录。需要验证码且未提供时返回 { kind: 'needCaptcha', image }。 */
export async function loginWithPassword(input: PasswordLoginInput): Promise<PasswordLoginResult> {
  if (!input.account || !input.password) throw new BackendError('INVALID_ARGUMENT', '请输入账号和密码')
  const jar = new CookieJar()
  const params = await fetchLoginParams(jar)
  await fetchAppConf(jar, params)

  const rsaA = (): string => rsaEncodeTickstep(params.jRsaKey, input.account)
  const pwdA = (): string => rsaEncodeTickstep(params.jRsaKey, input.password)
  const rsaB = (): string => rsaEncodeGowsp(params.jRsaKey, input.account)
  const pwdB = (): string => rsaEncodeGowsp(params.jRsaKey, input.password)

  // 是否需要图形验证码：返回 "0" 表示不需要。
  const captchaCheck = await jarRequestText(jar, {
    url: `${OPEN_BASE}/api/logbox/oauth2/needcaptcha.do`,
    method: 'POST',
    headers: { ...FORM_HEADERS, referer: `${OPEN_BASE}/`, origin: OPEN_BASE, lt: params.lt, reqid: params.reqId },
    body: formEncode({ accountType: '01', userName: rsaA(), appKey: 'cloud' }),
  })
  const needCaptcha = captchaCheck.text.trim().replace(/^"|"$/g, '') !== '0'
  let captchaToken = params.captchaToken
  let captcha = input.captcha
  if (needCaptcha && !captcha) {
    const image = await jarRequest(jar, {
      url: `${OPEN_BASE}/api/logbox/oauth2/picCaptcha.do?token=${encodeURIComponent(captchaToken || params.lt)}`,
      headers: { referer: `${OPEN_BASE}/` },
    })
    assertOk(image, '验证码获取失败')
    return { kind: 'needCaptcha', image: `data:image/png;base64,${Buffer.from(image.body).toString('base64')}` }
  }
  if (!needCaptcha) captcha = ''

  const submit = async (encode: 'a' | 'b'): Promise<{ data: Record<string, unknown> }> => {
    const userName = encode === 'a' ? rsaA() : rsaB()
    const password = encode === 'a' ? pwdA() : pwdB()
    return jarRequestJson<Record<string, unknown>>(jar, {
      url: `${OPEN_BASE}/api/logbox/oauth2/loginSubmit.do`,
      method: 'POST',
      headers: {
        ...FORM_HEADERS,
        referer: `${OPEN_BASE}/`,
        origin: OPEN_BASE,
        lt: params.lt,
        reqid: params.reqId,
      },
      body: formEncode({
        appKey: APP_ID,
        accountType: '02',
        userName,
        password,
        validateCode: captcha,
        captchaToken,
        returnUrl: params.returnUrl,
        mailSuffix: '@189.cn',
        paramId: params.paramId,
        lt: params.lt,
        reqid: params.reqId,
      }),
    })
  }

  let attempt = await submit('a')
  let result = Number(attempt.data.result)
  let message = typeof attempt.data.msg === 'string' ? attempt.data.msg : ''
  // 编码 A 提示加密错误时换编码 B。
  if (result !== 0 && /加密|encrypt|RSA/i.test(message)) {
    attempt = await submit('b')
    result = Number(attempt.data.result)
    message = typeof attempt.data.msg === 'string' ? attempt.data.msg : ''
    captchaToken = ''
  }

  if (result !== 0) {
    if (/验证码/.test(message)) throw new BackendError('CAPTCHA_WRONG', '验证码错误')
    if (/密码|账号|用户名/.test(message)) throw new BackendError('ACCOUNT_WRONG', '账号或密码错误')
    throw new BackendError('LOGIN_FAILED', message || '登录失败，请稍后重试')
  }
  const redirectUrl = typeof attempt.data.toUrl === 'string' ? attempt.data.toUrl : ''
  if (!redirectUrl) throw new BackendError('LOGIN_FAILED', '登录成功但缺少会话跳转地址')
  const success = await exchangeSession(jar, redirectUrl)
  return { kind: 'success', credential: buildCredential(success), remember: input.remember }
}

/** 用 refreshToken 刷新会话；成功返回新凭据 JSON，失败返回 null */
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
  if (parsed.cookie) for (const pair of parsed.cookie.split('; ')) jar.store(`${pair}; Path=/`, 'https://cloud.189.cn/')
  const { response, text } = await jarRequestText(jar, {
    url: `https://api.cloud.189.cn/getSessionForPC.action?appId=${APP_ID}&accessToken=${encodeURIComponent(refreshToken)}&clientSn=${crypto.randomUUID()}&clientType=TELEMAC&version=1.0.0&channelId=web_cloud.189.cn`,
    headers: { referer: 'https://cloud.189.cn/', accept: 'application/json;charset=UTF-8' },
  })
  if (response.status !== 200) return null
  const session = parseSessionResponse(text)
  if (!session.sessionKey && !session.accessToken) return null
  return buildCredential({ cookie: jar.header(), session, redirectUrl: parsed.redirectUrl ?? '' })
}
