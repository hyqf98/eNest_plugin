/**
 * 账号密码登录：账号、密码（可切换显示）、记住密码；后端返回图形验证码时
 * 显示验证码图片、输入框与「换一张」。登录成功后凭据写入系统密钥库，
 * 再把 secretRef 经 auth.saveSession 交回后端保存会话；失败 toast，不清空账号。
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowClockwise, Eye, EyeSlash, Password, SpinnerGap, User } from '@phosphor-icons/react'
import { Button, Input, Switch } from '../../ui'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'

export function PasswordLogin({ onSuccess }: { onSuccess?: () => void }) {
  const app = useApp()
  const [account, setAccount] = useState(app.auth.savedAccount)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(Boolean(app.auth.savedAccount))
  const [showPassword, setShowPassword] = useState(false)
  const [captcha, setCaptcha] = useState('')
  const [needCaptcha, setNeedCaptcha] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef(0)

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  async function login(): Promise<void> {
    const trimmed = account.trim()
    if (!trimmed || !password) return
    setSubmitting(true)
    setError('')
    try {
      const result = await api.auth.loginPassword({
        account: trimmed,
        password,
        captcha,
        remember,
      })
      if (result.needCaptcha) {
        // 后端要求图形验证码，返回的是 data URL
        setNeedCaptcha(result.needCaptcha)
        setCaptcha('')
        void app.notify('请输入图形验证码后重试', 'warn')
        return
      }
      if (!result.credential) throw new Error('登录成功但后端没有返回会话凭据')
      // 凭据先入宿主保险库，再把 secretRef 回传后端；密码等敏感值不落任何持久位置
      const sessionRef = await api.host.saveKey('tianyi.session', result.credential)
      let accountRef: string | undefined
      let passwordRef: string | undefined
      if (remember) {
        accountRef = await api.host.saveKey('tianyi.account', trimmed)
        passwordRef = await api.host.saveKey('tianyi.password', password)
      }
      await api.auth.saveSession({
        sessionRef,
        accountRef,
        passwordRef,
        account: trimmed,
        rememberPassword: remember,
      })
      setPassword('')
      setCaptcha('')
      onSuccess?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      void app.notify(`登录失败：${message}`, 'error')
    } finally { setSubmitting(false) }
  }

  return (
    <form
      className="gh-set-form"
      onSubmit={event => { event.preventDefault(); void login() }}
    >
      <div className="gh-field">
        <span className="gh-field-label">账号</span>
        <div className="gh-ps-inputwrap">
          <Glyph icon={User} size={14} />
          <Input
            value={account}
            placeholder="手机号 / 邮箱 / 用户名"
            onChange={event => setAccount(event.target.value)}
            aria-label="账号"
            autoComplete="username"
          />
        </div>
      </div>
      <div className="gh-field">
        <span className="gh-field-label">密码</span>
        <div className="gh-ps-inputwrap">
          <Glyph icon={Password} size={14} />
          <Input
            type={showPassword ? 'text' : 'password'}
            value={password}
            placeholder="请输入密码"
            onChange={event => setPassword(event.target.value)}
            aria-label="密码"
            autoComplete="current-password"
          />
          <button
            type="button"
            className="gh-ps-eye"
            onClick={() => setShowPassword(value => !value)}
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
            aria-pressed={showPassword}
          >
            <Glyph icon={showPassword ? EyeSlash : Eye} size={14} />
          </button>
        </div>
      </div>

      {needCaptcha ? (
        <div className="gh-field">
          <span className="gh-field-label">图形验证码</span>
          <div className="gh-field-row">
            <Input
              value={captcha}
              placeholder="请输入图中字符"
              maxLength={8}
              onChange={event => setCaptcha(event.target.value)}
              aria-label="图形验证码"
              style={{ maxWidth: 180 }}
            />
            {needCaptcha ? <img className="gh-set-captcha" src={needCaptcha} alt="图形验证码" /> : null}
            <Button size="sm" variant="ghost" onClick={() => setNeedCaptcha('')} aria-label="换一张">
              <Glyph icon={ArrowClockwise} size={13} />
              <span>换一张</span>
            </Button>
          </div>
        </div>
      ) : null}

      <label className="gh-switch-row">
        <div>
          <strong>记住密码</strong>
          <small>密码保存在系统密钥库，不会上传</small>
        </div>
        <Switch checked={remember} onCheckedChange={setRemember} aria-label="记住密码" />
      </label>

      {error ? <div className="gh-set-error" role="alert">{error}</div> : null}

      <div className="gh-dialog-actions">
        <Button type="submit" variant="primary" disabled={submitting || !account.trim() || !password}>
          <Glyph icon={submitting ? SpinnerGap : Password} size={14} />
          <span>{submitting ? '登录中…' : '登录'}</span>
        </Button>
      </div>
    </form>
  )
}
