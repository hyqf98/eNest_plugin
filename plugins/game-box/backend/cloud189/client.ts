/**
 * Cloud189Client：对上层（index.ts / 下载任务）统一的天翼云门面。
 * 会话与记住的账号密码只经注入的 loadSecret / saveSecret 读写：
 * - 生产由 index.ts 用 resolveSecret（读）接上；写入由页面拿返回值去 vault.set（本模块不写保险库）；
 * - 单测注入内存假实现。
 * 凭据绝不进日志、错误消息、KV。
 */

import { BackendError } from '../adapters/types.ts'
import { CookieJar, jarRequestJson } from './http.ts'
import { loginWithPassword, createQrSession, refreshSession, type PasswordLoginInput, type PasswordLoginResult, type QrPollResult, type QrSession, type SessionCredential } from './login.ts'
import { parseShare, listShareFolder, resolveFileDownloadUrl, type ParsedShare, type ShareListResult, type DownloadUrlResult } from './share.ts'
import { accessTokenFromUrl } from './sign.ts'

export interface Cloud189ClientOptions {
  /** 读会话凭据（生产：resolveSecret(sessionRef)；单测：内存） */
  loadSession?: () => Promise<string | null>
  /** 写会话凭据的调用方句柄：返回应保存的 secretRef（生产：让页面 vault.set 后回写；单测：内存） */
  onSessionRefreshed?: (credential: SessionCredential) => Promise<string>
}

export interface LoginState {
  state: 'logged-out' | 'logged-in' | 'expired'
  nickname: string
}

interface CredentialPayload {
  cookie?: string
  sessionKey?: string
  accessToken?: string
  refreshToken?: string
  familySessionKey?: string
}

function parseCredential(credential: string | null): CredentialPayload | null {
  if (!credential) return null
  try {
    const parsed = JSON.parse(credential) as CredentialPayload
    return typeof parsed === 'object' && parsed ? parsed : null
  } catch {
    return null
  }
}

export class Cloud189Client {
  private readonly loadSession: () => Promise<string | null>
  private readonly onSessionRefreshed: ((credential: SessionCredential) => Promise<string>) | null
  /** 内存中的会话凭据（进程生命周期内） */
  private memoryCredential = ''
  private readonly jar = new CookieJar()
  private ssoToken = ''

  constructor(options: Cloud189ClientOptions = {}) {
    this.loadSession = options.loadSession ?? (async () => this.memoryCredential)
    this.onSessionRefreshed = options.onSessionRefreshed ?? null
  }

  /** 单测直接注入内存凭据 */
  setMemoryCredential(credential: string): void {
    this.memoryCredential = credential
  }

  private async currentCredential(): Promise<CredentialPayload | null> {
    if (!this.memoryCredential) {
      const stored = await this.loadSession()
      if (stored) this.memoryCredential = stored
    }
    return parseCredential(this.memoryCredential)
  }

  /** 校验登录：getUserBriefInfo.action，nickname 与 account 都为空即未登录 */
  async checkLogin(): Promise<LoginState> {
    const credential = await this.currentCredential()
    if (!credential?.cookie) return { state: 'logged-out', nickname: '' }
    const { data } = await jarRequestJson<{ nickname?: unknown; account?: unknown }>(this.jar, {
      url: 'https://cloud.189.cn/api/portal/v2/getUserBriefInfo.action',
      headers: { cookie: this.jar.header() || credential.cookie, accept: 'application/json;charset=UTF-8' },
    })
    const nickname = typeof data.nickname === 'string' ? data.nickname : ''
    const account = typeof data.account === 'string' ? data.account : ''
    if (!nickname && !account) {
      const refreshed = await this.tryRefresh(credential)
      if (refreshed) return { state: 'logged-in', nickname: (refreshed.nickname as string) ?? '' }
      return { state: 'expired', nickname: '' }
    }
    return { state: 'logged-in', nickname }
  }

  /** 尝试用 refreshToken 刷新一次；成功更新内存会话并通知调用方 */
  private async tryRefresh(credential: CredentialPayload): Promise<LoginState | null> {
    const raw = this.memoryCredential
    if (!raw) return null
    try {
      const next = await refreshSession(raw)
      if (!next) return null
      this.memoryCredential = next
      if (this.onSessionRefreshed) await this.onSessionRefreshed(next)
      const check = await this.checkLogin()
      return check.state === 'logged-in' ? check : null
    } catch {
      return null
    }
  }

  /**
   * 刷新 sso accessToken（直链解析前调用）；返回可用的 accessToken。
   * 取不到抛 LOGIN_REQUIRED。
   */
  async ensureAccessToken(): Promise<string> {
    if (this.ssoToken) return this.ssoToken
    const credential = await this.currentCredential()
    if (!credential?.cookie) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
    const { accessTokenFromUrl: extract } = await import('./sign.ts')
    // ssoAccessToken 内部走 jar 逐跳；这里给 jar 预置 cookie。
    const jar = this.jar
    jar.clear()
    for (const pair of credential.cookie.split('; ')) {
      if (pair.includes('=')) jar.store(`${pair}; Path=/`, 'https://cloud.189.cn/')
    }
    const { ssoAccessToken: obtain } = await import('./sign.ts')
    this.ssoToken = await obtain(jar)
    void extract
    return this.ssoToken
  }

  /** 退出：清内存会话（持久化由调用方删除 vault/secretRef） */
  logout(): void {
    this.memoryCredential = ''
    this.jar.clear()
    this.ssoToken = ''
  }

  /** 忘记保存的账号密码（后端只负责返回会话失效状态，vault 删除由页面执行） */
  forgetSaved(): void {
    // 与 logout 相同的内存清理；账号密码本身在 vault，由页面删。
    this.logout()
  }

  /** 扫码登录：创建会话对象（登录链路凭据通过 QrSession.credential() 交给调用方） */
  loginQr(): QrSession {
    const session = createQrSession()
    return {
      start: () => session.start(),
      poll: async (): Promise<QrPollResult> => {
        const outcome = await session.poll()
        if (outcome === 'success') this.memoryCredential = session.credential()
        return outcome
      },
      cancel: () => session.cancel(),
      credential: () => session.credential(),
    }
  }

  /** 账密登录 */
  async loginPassword(input: PasswordLoginInput): Promise<PasswordLoginResult> {
    const result = await loginWithPassword(input)
    if (result.kind === 'success') this.memoryCredential = result.credential
    return result
  }

  /** 解析分享（无需登录） */
  async parseShare(url: string, accessCode: string): Promise<ParsedShare> {
    return parseShare(url, accessCode)
  }

  /** 展开分享文件夹（无需登录） */
  async listShareFolder(jar: CookieJar, shareId: string, folderId: string, accessCode: string): Promise<ShareListResult> {
    return listShareFolder(jar, shareId, folderId, accessCode)
  }

  /**
   * 解析分享内文件的下载直链。shareId + fileId 来自 parseShare / listShareFolder。
   * 返回 url 与下载时必须携带的 headers（cookie + referer）。
   */
  async resolveDownloadUrl(shareId: string, fileId: string): Promise<DownloadUrlResult> {
    const credential = await this.currentCredential()
    if (!credential?.cookie) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
    return resolveFileDownloadUrl(credential.cookie, shareId, fileId)
  }

  /** 账号信息（昵称；未登录返回空） */
  async getAccountInfo(): Promise<{ nickname: string; loggedIn: boolean }> {
    const state = await this.checkLogin()
    return { nickname: state.nickname, loggedIn: state.state === 'logged-in' }
  }
}

export { accessTokenFromUrl }
