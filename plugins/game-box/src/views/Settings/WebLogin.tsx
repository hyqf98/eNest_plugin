/**
 * 天翼云盘登录：在应用内窗口里打开天翼自己的登录页，用户用扫码、账号密码或短信验证任意方式登录。
 * 登录成功后宿主把这次会话的 cookie 交回来，这里拼成凭据存进系统密钥库，再让后端记住它。
 *
 * 为什么用登录窗口而不是自己发登录请求：天翼的登录接口要求官方签名并带设备校验，
 * 第三方无法复刻（详见仓库 README）。登录窗口里跑的是天翼自己的页面，不受这些限制。
 */

import { useState } from 'react'
import { ArrowSquareOut, SignIn, SpinnerGap } from '@phosphor-icons/react'
import { Button } from '../../ui'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'

const LOGIN_URL = 'https://cloud.189.cn/web/login.html'
/** 登录成功后天翼会跳到网盘主页；它以这个地址开头 */
const SUCCESS_URL_PREFIX = 'https://cloud.189.cn/web/main'

export function WebLogin({ onLoggedIn }: { onLoggedIn?: () => void }) {
  const app = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function login(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const cookies = await api.host.webLogin(LOGIN_URL, SUCCESS_URL_PREFIX, '登录天翼云盘')
      // 用户关掉了登录窗口：不算错误，不打扰
      if (!cookies) return
      await saveSession(cookies)
      await app.refreshAuth()
      void app.notify('已登录天翼云盘', 'success')
      onLoggedIn?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <div className="gh-set-weblogin">
      <p className="gh-set-weblogin-hint">
        <Glyph icon={SignIn} size={14} />
        <span>点击后在弹出的窗口里登录，可以用扫码或账号密码。登录页由天翼云盘提供，账号密码不经过本插件。</span>
      </p>
      {error ? <p className="gh-set-error" role="alert">{error}</p> : null}
      <Button variant="primary" onClick={() => void login()} disabled={busy}>
        {busy ? <Glyph icon={SpinnerGap} size={14} className="gh-spin" /> : <Glyph icon={ArrowSquareOut} size={14} />}
        <span>{busy ? '请在弹出的窗口里完成登录…' : '打开登录窗口'}</span>
      </Button>
    </div>
  )
}

/**
 * 把登录窗口交回的 cookie 存成后端能用的会话凭据。
 * 只存天翼域下的 cookie（登录页同时会带一些统计类第三方 cookie，没有用处，也不该保存）。
 * cookie 头的格式与后端 jarRequest 发请求时用的完全一致：`name=value; name=value`。
 */
async function saveSession(cookies: readonly api.WebLoginCookie[]): Promise<void> {
  const owned = cookies.filter(cookie => cookie.domain.replace(/^\./, '').endsWith('189.cn'))
  const header = owned.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  if (!header) throw new Error('没有拿到登录会话，请重试')
  const credential = JSON.stringify({ cookie: header, savedAt: Math.floor(Date.now() / 1000) })
  const sessionRef = await api.host.saveKey('tianyi.session', credential)
  await api.auth.saveSession({ sessionRef })
}
