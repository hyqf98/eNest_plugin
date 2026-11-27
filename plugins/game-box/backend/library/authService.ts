/**
 * 天翼云登录服务：会话持久化 / 登录状态 / 退出 / 忘记密码。
 *
 * 凭据流向（后端没有保险库写能力，只有页面能写）：
 *   用户在应用内登录窗口里登录（宿主 web.login）→ 页面拿到会话 cookie 并 vault.set 入库 →
 *   带着 secretRef 调 saveSession 回传。后端只保存 secretRef（不透明引用），不接触登录过程。
 * 天翼的登录接口要求官方签名与设备校验，第三方无法复刻，所以后端不再自己发登录请求。
 *
 * 状态的唯一来源是 AuthMeta：sessionRef 变化时重建云盘客户端（它缓存内存凭据）。
 */

import { BackendError } from '../adapters/types.ts'
import { EVENTS, type AuthInfo, type SaveSessionRequest } from '../contracts.ts'
import { Cloud189Client } from '../cloud189/index.ts'
import { logMessage, postEvent, resolveSecret } from '../runtime.ts'
import { flushStore, loadAuthMeta, saveAuthMeta, type AuthMeta } from '../store.ts'

export const VAULT_KEYS = {
  session: 'tianyi.session',
  account: 'tianyi.account',
  password: 'tianyi.password',
} as const

/** 按会话保存的云盘客户端：每个客户端持有自己的内存凭据与 cookie jar */
const clients = new Map<string, Cloud189Client>()

/** 建云盘客户端；单测替换成不发网络请求的假客户端 */
let createClient: (sessionRef: string) => Cloud189Client = sessionRef =>
  new Cloud189Client({ loadSession: sessionRef ? () => resolveSecret(sessionRef) : async () => null })

function clientFor(sessionRef: string): Cloud189Client {
  const key = sessionRef || '\0none'
  let client = clients.get(key)
  if (!client) {
    client = createClient(sessionRef)
    clients.set(key, client)
  }
  return client
}

/** 单测用：换掉云盘客户端工厂并清掉缓存的客户端，返回恢复函数 */
export function mockCloudClients(replacement: (sessionRef: string) => Cloud189Client): () => void {
  const original = createClient
  createClient = replacement
  clients.clear()
  return () => { createClient = original; clients.clear() }
}

async function saveMeta(patch: Partial<AuthMeta>): Promise<AuthMeta> {
  const meta = { ...await loadAuthMeta(), ...patch }
  saveAuthMeta(meta)
  await flushStore()
  return meta
}

function infoOf(meta: AuthMeta, state: 'logged-in' | 'expired' | 'logged-out', nickname: string): AuthInfo {
  return { state, nickname, savedAccount: meta.account }
}

/**
 * 凭据的体检摘要，只用于日志：cookie 的名字与数量、有没有续期用的字段。
 * 值一概不记 —— 会话 cookie 就是登录凭据本身。
 */
export function describeCredential(raw: string | null): string {
  if (!raw) return 'none'
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const cookie = typeof parsed.cookie === 'string' ? parsed.cookie : ''
    const names = cookie.split('; ').map(pair => pair.split('=')[0]).filter(Boolean)
    const fields = ['sessionKey', 'refreshToken', 'accessToken'].filter(key => typeof parsed[key] === 'string' && parsed[key])
    return `bytes=${raw.length} cookieCount=${names.length} names=${names.join(',')} fields=${fields.join(',') || 'none'}`
  } catch {
    return `bytes=${raw.length} unparsable`
  }
}

/**
 * 换了会话或不再记住密码后，哪些保险库条目不再被引用。
 * 三类引用各有唯一的保存键（VAULT_KEYS），所以按类比较：同一类里旧引用不等于新引用，旧的就该删。
 */
export function replacedSecrets(before: AuthMeta, next: { sessionRef: string; accountRef: string; passwordRef: string }): string[] {
  const pairs: Array<[string | undefined, string]> = [
    [before.sessionRef, next.sessionRef],
    [before.accountRef, next.accountRef],
    [before.passwordRef, next.passwordRef],
  ]
  return pairs.filter(([oldRef, newRef]) => Boolean(oldRef) && oldRef !== newRef).map(([oldRef]) => oldRef as string)
}

export class AuthService {
  private checking: Promise<AuthInfo> | null = null

  /** 当前登录状态；会话凭据按 secretRef 从保险库取，取不到即未登录 */
  async info(): Promise<AuthInfo> {
    if (this.checking) return this.checking
    this.checking = (async () => {
      const meta = await loadAuthMeta()
      if (!meta.sessionRef) return infoOf(meta, 'logged-out', '')
      const state = await clientFor(meta.sessionRef).checkLogin().catch(error => {
        void logMessage('warn', 'auth.info', `登录校验抛错：${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      if (state?.state === 'logged-in') {
        const nickname = state.nickname || meta.nickname
        // 老会话（此前没存账号）在这里补齐，展示与「忘记已保存的密码」才有依据。
        const account = meta.account || state.account || ''
        if (nickname !== meta.nickname || account !== meta.account) await saveMeta({ nickname, account })
        void logMessage('info', 'auth.info', `登录有效：nickname=${nickname || '(空)'}`)
        return infoOf({ ...meta, nickname, account }, 'logged-in', nickname)
      }
      // 判为过期的原因有两种，日志里要分得开：凭据读不出来（保险库问题）还是服务端不认（会话真的失效）
      const stored = await resolveSecret(meta.sessionRef).catch(() => null)
      void logMessage('warn', 'auth.info', `判定登录过期：state=${state?.state ?? 'check-failed'} credential=${describeCredential(stored)}`)
      return infoOf(meta, 'expired', '')
    })()
    try {
      return await this.checking
    } finally {
      this.checking = null
    }
  }

  /**
   * 页面把凭据入库后调用：保存 secretRef 与展示信息，并让客户端改用保险库里的会话。
   * 这次被替换或清除的旧引用经 removeRefs 交给页面删除：只有页面能删保险库，记录一清、
   * 引用就找不回来了，不交回去的话旧密码会变成谁也删不掉的孤儿。
   */
  async saveSession(request: SaveSessionRequest): Promise<{ ok: boolean; removeRefs: string[] }> {
    if (!request.sessionRef) throw new BackendError('INVALID_ARGUMENT', '缺少会话引用')
    // 引用必须真的能解出会话，页面传错了要当场发现
    const stored = await resolveSecret(request.sessionRef).catch(() => null)
    if (!stored) throw new BackendError('INVALID_ARGUMENT', '会话保存失败，请重新登录')
    const before = await loadAuthMeta()
    const keepPassword = request.rememberPassword !== false
    const accountRef = keepPassword && request.accountRef ? request.accountRef : ''
    const passwordRef = keepPassword && request.passwordRef ? request.passwordRef : ''
    const meta = await saveMeta({
      sessionRef: request.sessionRef,
      account: request.account ?? (keepPassword ? before.account : ''),
      accountRef,
      passwordRef,
      loginAt: Date.now(),
    })
    const removeRefs = replacedSecrets(before, { sessionRef: request.sessionRef, accountRef, passwordRef })
    // 丢弃"登录中"的临时客户端；之后的请求都从保险库取会话
    clients.delete('\0none')
    const state = await clientFor(meta.sessionRef).checkLogin().catch(error => {
      void logMessage('warn', 'auth.saveSession', `保存后校验抛错：${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    const info = state?.state === 'logged-in'
      // 页面登录时只拿到 cookie，不知道账号；登录成功这一刻从天翼返回的 account 补齐，
      // 否则 savedAccount 永远是空，「忘记已保存的密码」也不会出现。
      ? infoOf(await saveMeta({
        nickname: state.nickname,
        ...(state.account && !meta.account ? { account: state.account } : {}),
      }), 'logged-in', state.nickname)
      : infoOf(meta, 'expired', '')
    if (info.state !== 'logged-in') {
      // 登录窗口刚交回会话就判过期，是这条链路最容易出错的地方，必须留痕。
      void logMessage('warn', 'auth.saveSession', `新会话校验未通过：credential=${describeCredential(stored)}`)
    }
    postEvent(EVENTS.authChanged, info)
    return { ok: true, removeRefs }
  }

  /** 退出登录。记住的账号密码保留：退出登录不等于忘记密码。旧会话引用交回页面删除 */
  async logout(): Promise<{ ok: boolean; removeRefs: string[] }> {
    const meta = await loadAuthMeta()
    if (meta.sessionRef) {
      clientFor(meta.sessionRef).logout()
      clients.delete(meta.sessionRef)
    }
    await saveMeta({ sessionRef: '', nickname: '', loginAt: 0 })
    const info = infoOf(await loadAuthMeta(), 'logged-out', '')
    postEvent(EVENTS.authChanged, info)
    return { ok: true, removeRefs: meta.sessionRef ? [meta.sessionRef] : [] }
  }

  /**
   * 忘记已保存的密码。只有页面能删保险库，所以分两步：
   * 不带 confirmed 调用时只返回应删除的引用（后端记录不动）；页面删完后带 confirmed: true
   * 再调用一次，后端才清掉记录。这样页面删除失败时引用不会丢，密码不会变成删不掉的孤儿。
   */
  async forget(confirmed = false): Promise<{ ok: boolean; removeRefs: string[] }> {
    const meta = await loadAuthMeta()
    if (!confirmed) return { ok: true, removeRefs: [meta.accountRef, meta.passwordRef].filter(Boolean) }
    await saveMeta({ accountRef: '', passwordRef: '', account: '' })
    return { ok: true, removeRefs: [] }
  }

  /** 下载任务用：当前已登录的云盘客户端；未登录时要求登录 */
  async requireClient(): Promise<Cloud189Client> {
    const meta = await loadAuthMeta()
    if (!meta.sessionRef) throw new BackendError('LOGIN_REQUIRED', '请先登录天翼云盘')
    const client = clientFor(meta.sessionRef)
    const state = await client.checkLogin().catch(() => null)
    if (state?.state !== 'logged-in') throw new BackendError('LOGIN_REQUIRED', '天翼云登录已过期，请重新登录')
    return client
  }

  /** 是否已保存会话（不发起网络请求；用于建任务前快速判断） */
  async hasSession(): Promise<boolean> {
    return Boolean((await loadAuthMeta()).sessionRef)
  }
}
