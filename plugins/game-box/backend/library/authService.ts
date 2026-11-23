/**
 * 天翼云登录服务：扫码 / 账密 / 会话持久化 / 退出 / 忘记密码。
 *
 * 凭据流向（后端没有保险库写能力，只有页面能写）：
 *   后端登录成功 → 会话凭据随响应 / 事件交给页面 → 页面 vault.set 入库 →
 *   带着 secretRef 调 saveSession 回传。后端只保存 secretRef（不透明引用）。
 * 密码只在"账密登录"这一次请求里出现，绝不落盘、绝不进日志、错误消息与事件。
 *
 * 状态的唯一来源是 AuthMeta：sessionRef 变化时重建云盘客户端（它缓存内存凭据）。
 */

import { BackendError } from '../adapters/types.ts'
import { EVENTS, type AuthInfo, type QrPhase, type QrStatus, type SaveSessionRequest } from '../contracts.ts'
import { Cloud189Client, type QrPollResult } from '../cloud189/index.ts'
import { postEvent, resolveSecret } from '../runtime.ts'
import { flushStore, loadAuthMeta, saveAuthMeta, type AuthMeta } from '../store.ts'

/** 扫码轮询间隔 */
const QR_POLL_MS = 3000
/** 扫码会话最长存活时间；超时即使服务端没报过期也停止轮询 */
const QR_MAX_MS = 5 * 60 * 1000

export const VAULT_KEYS = {
  session: 'tianyi.session',
  account: 'tianyi.account',
  password: 'tianyi.password',
} as const

/** 进行中的扫码会话 */
interface QrRun {
  id: string
  session: ReturnType<Cloud189Client['loginQr']>
  startedAt: number
  timer?: NodeJS.Timeout
  stopped: boolean
}

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
  private qr: QrRun | null = null
  private checking: Promise<AuthInfo> | null = null

  /** 当前登录状态；会话凭据按 secretRef 从保险库取，取不到即未登录 */
  async info(): Promise<AuthInfo> {
    if (this.checking) return this.checking
    this.checking = (async () => {
      const meta = await loadAuthMeta()
      if (!meta.sessionRef) return infoOf(meta, 'logged-out', '')
      const state = await clientFor(meta.sessionRef).checkLogin().catch(() => null)
      if (state?.state === 'logged-in') {
        if (state.nickname && state.nickname !== meta.nickname) await saveMeta({ nickname: state.nickname })
        return infoOf(meta, 'logged-in', state.nickname || meta.nickname)
      }
      return infoOf(meta, 'expired', '')
    })()
    try {
      return await this.checking
    } finally {
      this.checking = null
    }
  }

  /** 开始扫码登录：立即返回 sessionId；二维码图片与后续状态经 auth.qr 事件推送 */
  async qrStart(): Promise<{ sessionId: string }> {
    if (this.qr) throw new BackendError('INVALID_ARGUMENT', '已有进行中的扫码登录')
    const session = clientFor('').loginQr()
    const run: QrRun = { id: `qr_${Date.now().toString(36)}`, session, startedAt: Date.now(), stopped: false }
    this.qr = run
    // 取二维码是网络请求，不阻塞这次响应
    void this.beginQr(run)
    return { sessionId: run.id }
  }

  private async beginQr(run: QrRun): Promise<void> {
    try {
      const image = await run.session.start()
      if (run.stopped) return
      this.pushQr(run, { phase: 'pending', image, message: '请用天翼云盘 App 扫码' })
      this.schedulePoll(run)
    } catch (error) {
      if (run.stopped) return
      run.stopped = true
      if (this.qr === run) this.qr = null
      this.pushQr(run, { phase: 'failed', image: '', message: errorText(error) })
    }
  }

  private schedulePoll(run: QrRun): void {
    run.timer = setTimeout(() => { void this.poll(run) }, QR_POLL_MS)
    run.timer.unref?.()
  }

  private async poll(run: QrRun): Promise<void> {
    if (run.stopped) return
    let result: QrPollResult
    try {
      result = await run.session.poll()
    } catch {
      // 多为网络抖动；二维码自身会过期，这里只重试
      result = 'pending'
    }
    if (run.stopped) return
    if (result === 'success') {
      run.stopped = true
      if (this.qr === run) this.qr = null
      // 会话凭据随这一次事件交给页面；页面入库后调用 saveSession
      this.pushQr(run, { phase: 'pending', image: '', message: '登录成功' }, run.session.credential())
      return
    }
    if (result === 'expired' || Date.now() - run.startedAt > QR_MAX_MS) {
      run.stopped = true
      if (this.qr === run) this.qr = null
      this.pushQr(run, { phase: 'expired', image: '', message: '二维码已过期，请刷新' })
      return
    }
    this.pushQr(run, result === 'scanned'
      ? { phase: 'scanned', image: '', message: '已扫码，请在手机上确认' }
      : { phase: 'pending', image: '', message: '请用天翼云盘 App 扫码' })
    this.schedulePoll(run)
  }

  private pushQr(run: QrRun, status: QrStatus, credential?: string): void {
    postEvent(EVENTS.qrStatus, { sessionId: run.id, status, ...(credential ? { credential } : {}) })
  }

  async qrCancel(sessionId: string): Promise<{ ok: boolean }> {
    const run = this.qr
    if (!run || run.id !== sessionId) return { ok: false }
    run.stopped = true
    if (run.timer) clearTimeout(run.timer)
    run.session.cancel()
    this.qr = null
    clients.delete('\0none')
    return { ok: true }
  }

  /**
   * 账密登录。需要图形验证码时返回 needCaptcha（验证码图片的 data URL）；
   * 成功时返回会话凭据，由页面入库后调用 saveSession。
   */
  async loginPassword(input: { account: string; password: string; captcha: string; remember: boolean }): Promise<{ sessionId: string; needCaptcha: string; credential?: string }> {
    const client = clientFor('')
    const result = await client.loginPassword({ account: input.account, password: input.password, captcha: input.captcha ?? '', remember: input.remember })
    if (result.kind === 'needCaptcha') return { sessionId: '', needCaptcha: result.image }
    return { sessionId: '', needCaptcha: '', credential: result.credential }
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
    const state = await clientFor(meta.sessionRef).checkLogin().catch(() => null)
    const info = state?.state === 'logged-in'
      ? infoOf(await saveMeta({ nickname: state.nickname }), 'logged-in', state.nickname)
      : infoOf(meta, 'expired', '')
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

  /** 关闭时停掉扫码轮询 */
  shutdown(): void {
    if (!this.qr) return
    this.qr.stopped = true
    if (this.qr.timer) clearTimeout(this.qr.timer)
    this.qr.session.cancel()
    this.qr = null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { QrPhase }
