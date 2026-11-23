/**
 * 扫码登录：向宿主申请二维码（auth.qrStart），按 sessionId 订阅 auth.qr 事件，
 * 用扩展控件 QrCode 展示图片与状态；离开或取消时调用 auth.qrCancel。
 * 登录成功那次事件会带会话凭据：凭据入库后经 auth.saveSession 回传后端。
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowClockwise, QrCode, X } from '@phosphor-icons/react'
import type { QrStatus } from '../../shared/contracts'
import { Button } from '../../ui'
import { QrCode as QrCodeView } from '../../components/ext'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import { onQrStatus } from '../../js/api'
import * as api from '../../js/api'

export function QrLogin({ onSuccess }: { onSuccess?: () => void }) {
  const app = useApp()
  const [sessionId, setSessionId] = useState('')
  const [status, setStatus] = useState<QrStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const sessionRef = useRef('')
  const aliveRef = useRef(true)

  // 订阅二维码状态事件（按 sessionId 匹配）；登录成功那次带凭据，入库后回传后端
  useEffect(() => {
    return onQrStatus(event => {
      if (event.sessionId !== sessionRef.current) return
      setStatus(event.status)
      const credential = event.credential
      if (!credential) return
      const id = sessionRef.current
      sessionRef.current = ''
      void (async () => {
        try {
          const savedRef = await api.host.saveKey('tianyi.session', credential)
          if (!aliveRef.current) return
          // 扫码登录不带密码；后端由此知道不必保存密码引用
          await api.auth.saveSession({ sessionRef: savedRef, rememberPassword: false })
          if (!aliveRef.current) return
          setSessionId('')
          await app.refreshAuth()
          onSuccess?.()
        } catch (error) {
          if (!aliveRef.current) return
          const message = error instanceof Error ? error.message : String(error)
          setError(`登录凭据保存失败：${message}`)
        }
        // 会话已结束，无论成败都取消剩余的扫码轮询
        if (id) void api.auth.qrCancel(id).catch(() => undefined)
      })()
    })
  }, [])

  // 登录成功（父级会在 auth.state 变化后重渲染）时结束会话
  useEffect(() => {
    if (app.auth.state === 'logged-in' && sessionRef.current) {
      void api.auth.qrCancel(sessionRef.current).catch(() => undefined)
      sessionRef.current = ''
      setSessionId('')
    }
  }, [app.auth.state])

  // 卸载时停止事件回调的后续处理，并取消未完成的扫码
  useEffect(() => () => {
    aliveRef.current = false
    if (sessionRef.current) void api.auth.qrCancel(sessionRef.current).catch(() => undefined)
  }, [])

  async function start(): Promise<void> {
    setStarting(true)
    setError('')
    setStatus(null)
    try {
      const result = await api.auth.qrStart()
      sessionRef.current = result.sessionId
      setSessionId(result.sessionId)
      setStatus({ phase: 'loading', image: '', message: '正在获取二维码…' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setStarting(false) }
  }

  function cancel(): void {
    if (sessionRef.current) void api.auth.qrCancel(sessionRef.current).catch(() => undefined)
    sessionRef.current = ''
    setSessionId('')
    setStatus(null)
  }

  async function restart(): Promise<void> {
    cancel()
    await start()
  }

  if (app.auth.state === 'logged-in') {
    return (
      <div className="gh-set-okline" role="status">
        <Glyph icon={QrCode} size={14} />
        <span>登录成功，当前账号：{app.auth.nickname || '天翼云盘用户'}</span>
      </div>
    )
  }

  if (!sessionId) {
    return (
      <div className="gh-qr">
        {error ? <div className="gh-set-error" role="alert">{error}</div> : null}
        <Button variant="primary" onClick={() => void start()} disabled={starting}>
          <Glyph icon={starting ? ArrowClockwise : QrCode} size={14} />
          <span>{starting ? '正在获取…' : '获取二维码'}</span>
        </Button>
        <p className="gh-qr-message">使用天翼云盘 App 扫码登录</p>
      </div>
    )
  }

  const phase = status?.phase ?? 'loading'
  const message = status?.message
    ?? (phase === 'pending' ? '请用天翼云盘 App 扫码' : '正在获取二维码…')

  return (
    <div className="gh-qr">
      <QrCodeView image={status?.image ?? ''} status={phase} message={message} />
      {phase === 'expired' || phase === 'failed' ? (
        <Button size="sm" onClick={() => void restart()}>
          <Glyph icon={ArrowClockwise} size={13} />
          <span>{phase === 'expired' ? '刷新二维码' : '重试'}</span>
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={cancel}>
        <Glyph icon={X} size={13} />
        <span>取消</span>
      </Button>
    </div>
  )
}
