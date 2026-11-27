/**
 * Cloud189Client：对上层（index.ts / 下载任务）统一的天翼云门面。
 * 会话与记住的账号密码只经注入的 loadSecret / saveSecret 读写：
 * - 生产由 index.ts 用 resolveSecret（读）接上；写入由页面拿返回值去 vault.set（本模块不写保险库）；
 * - 单测注入内存假实现。
 * 凭据绝不进日志、错误消息、KV。
 */

import { BackendError } from '../adapters/types.ts'
import { CookieJar, jarRequestJson, seedJarFromCredential } from './http.ts'
import { refreshSession, type SessionCredential } from './session.ts'
import { parseShare, listShareFolder, resolveFileDownloadUrl, type ParsedShare, type ShareListResult, type DownloadUrlResult } from './share.ts'
import { accessTokenFromUrl } from './sign.ts'
import { logMessage } from '../runtime.ts'

export interface Cloud189ClientOptions {
  /** 读会话凭据（生产：resolveSecret(sessionRef)；单测：内存） */
  loadSession?: () => Promise<string | null>
  /** 写会话凭据的调用方句柄：返回应保存的 secretRef（生产：让页面 vault.set 后回写；单测：内存） */
  onSessionRefreshed?: (credential: SessionCredential) => Promise<string>
}

export interface LoginState {
  state: 'logged-out' | 'logged-in' | 'expired'
  nickname: string
  /** 账号（天翼返回的 account 字段，通常是手机号或邮箱）；未登录或未返回时为空 */
  account?: string
}

interface CredentialPayload {
  cookie?: string
  /** 逐条带 domain/path 的 cookie（网页登录保存的正确形态） */
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
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
  /** 凭据里带过来的 cookie（逐条带域名），按当前凭据重建 */
  private credentialJar = new CookieJar()
  /** 这轮请求里服务端新下发 / 更新的 cookie */
  private readonly jar = new CookieJar()
  private ssoToken = ''

  constructor(options: Cloud189ClientOptions = {}) {
    this.loadSession = options.loadSession ?? (async () => this.memoryCredential)
    this.onSessionRefreshed = options.onSessionRefreshed ?? null
  }

  /** 单测直接注入内存凭据 */
  setMemoryCredential(credential: string): void {
    this.memoryCredential = credential
    this.reseedCredentialJar()
  }

  private reseedCredentialJar(): void {
    this.credentialJar = new CookieJar()
    if (this.memoryCredential) seedJarFromCredential(this.credentialJar, this.memoryCredential)
  }

  private async currentCredential(): Promise<CredentialPayload | null> {
    if (!this.memoryCredential) {
      const stored = await this.loadSession()
      if (stored) {
        this.memoryCredential = stored
        this.reseedCredentialJar()
      }
    }
    return parseCredential(this.memoryCredential)
  }

  /**
   * 某个地址要带的完整 cookie 头：凭据里的登录 cookie 为底，叠加这轮请求新拿到的同名项。
   *
   * 不能写成 `jar.header() || credential.cookie`：jar 初始为空，第一次校验用完整凭据能成功，
   * 但 jarRequest 会把响应的 Set-Cookie 收进 jar；第二次校验时 jar 非空却只有那几个新增 cookie，
   * 反而把完整登录凭据整个遮蔽掉 —— 表现为刚登录、紧接着刷新状态就显示「已过期」。
   *
   * 合并也按 (domain, path, name) 三元组进行，不按名字：天翼会在 cloud 与 open.e 子域下发
   * 同名不同值的 cookie，服务端靠 domain 区分，按名字合并会丢掉真正的会话 cookie。
   */
  private cookieHeaderFor(url: string): string {
    const merged = this.credentialJar.clone()
    for (const entry of this.jar.all()) merged.storeEntry(entry)
    return merged.headerFor(url)
  }

  /**
   * 校验登录：getUserBriefInfo.action，nickname 与 account 都为空即未登录。
   *
   * 诊断日志只记 cookie 的**名字**与数量、HTTP 状态和响应键，绝不记值：
   * 登录失败以前被 `.catch(() => null)` 静默吞掉，日志里什么都看不到，只能靠猜。
   */
  async checkLogin(): Promise<LoginState> {
    const credential = await this.currentCredential()
    if (!credential?.cookie && !credential?.cookies?.length) return { state: 'logged-out', nickname: '' }
    const url = 'https://cloud.189.cn/api/portal/v2/getUserBriefInfo.action'
    const cookieHeader = this.cookieHeaderFor(url)
    const names = cookieHeader.split('; ').map(pair => pair.split('=')[0]).filter(Boolean)
    try {
      const { response, data } = await jarRequestJson<{ nickname?: unknown; account?: unknown }>(this.jar, {
        url,
        headers: { cookie: cookieHeader, accept: 'application/json;charset=UTF-8' },
      })
      const nickname = typeof data.nickname === 'string' ? data.nickname : ''
      const account = typeof data.account === 'string' ? data.account : ''
      if (!nickname && !account) {
        void logMessage('warn', 'cloud189.checkLogin', `登录校验返回空身份：status=${response.status} cookieCount=${names.length} names=${names.join(',')} keys=${Object.keys(data).join(',')}`)
        const refreshed = await this.tryRefresh(credential)
        if (refreshed) return refreshed
        return { state: 'expired', nickname: '' }
      }
      return { state: 'logged-in', nickname, ...(account ? { account } : {}) }
    } catch (error) {
      // 网络错误 / 非 JSON 响应以前会被上层 catch 成 null，看起来和"过期"一模一样。
      void logMessage('warn', 'cloud189.checkLogin', `登录校验请求失败：${error instanceof Error ? error.message : String(error)} cookieCount=${names.length} names=${names.join(',')}`)
      throw error
    }
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
    if (!credential) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
    const { accessTokenFromUrl: extract } = await import('./sign.ts')
    // ssoAccessToken 内部走 jar 逐跳；这里把凭据 cookie 按域名预置进 jar。
    const jar = new CookieJar()
    seedJarFromCredential(jar, this.memoryCredential)
    for (const entry of this.jar.all()) jar.storeEntry(entry)
    const { ssoAccessToken: obtain } = await import('./sign.ts')
    this.ssoToken = await obtain(jar)
    void extract
    return this.ssoToken
  }

  /** 退出：清内存会话（持久化由调用方删除 vault/secretRef） */
  logout(): void {
    this.memoryCredential = ''
    this.credentialJar = new CookieJar()
    this.jar.clear()
    this.ssoToken = ''
  }

  /** 忘记保存的账号密码（后端只负责返回会话失效状态，vault 删除由页面执行） */
  forgetSaved(): void {
    // 与 logout 相同的内存清理；账号密码本身在 vault，由页面删。
    this.logout()
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
    if (!credential) throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
    // 直链解析自己建 jar，把凭据 cookie（逐条带域名）与这轮新拿到的都灌进去。
    const jar = new CookieJar()
    seedJarFromCredential(jar, this.memoryCredential)
    for (const entry of this.jar.all()) jar.storeEntry(entry)
    return resolveFileDownloadUrl(jar, shareId, fileId)
  }

  /** 账号信息（昵称；未登录返回空） */
  async getAccountInfo(): Promise<{ nickname: string; loggedIn: boolean }> {
    const state = await this.checkLogin()
    return { nickname: state.nickname, loggedIn: state.state === 'logged-in' }
  }
}

export { accessTokenFromUrl }
