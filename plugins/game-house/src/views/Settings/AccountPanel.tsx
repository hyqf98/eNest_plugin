/**
 * 天翼云盘账号面板：未登录时提供扫码 / 账号密码两个标签页；已登录显示昵称与
 * 已保存账号（后端 auth.info 返回的明文账号，仅展示）、退出登录与忘记密码；
 * 过期时给出警告条与重新登录入口。
 */

import { useState } from 'react'
import { SignIn, SignOut, Users, Warning } from '@phosphor-icons/react'
import { Button } from '../../ui'
import { ConfirmDialog } from '../../components/ext'
import { Empty, Spinner } from '../../components/base'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'
import { QrLogin } from './QrLogin'
import { PasswordLogin } from './PasswordLogin'

type LoginTab = 'qr' | 'password'

export function AccountPanel() {
  const app = useApp()
  const { auth } = app
  const [tab, setTab] = useState<LoginTab>('qr')
  const [busy, setBusy] = useState<'logout' | 'forget' | ''>('')
  const [logoutOpen, setLogoutOpen] = useState(false)

  async function logout(): Promise<void> {
    setBusy('logout')
    setLogoutOpen(false)
    try {
      await api.auth.logout()
      await app.refreshAuth()
      void app.notify('已退出天翼云盘登录', 'success')
    } catch (error) {
      void app.notify(`退出失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setBusy('') }
  }

  async function forget(): Promise<void> {
    setBusy('forget')
    try {
      // 只有页面能删保险库。先向后端要应删除的引用，删成功后再让后端清掉记录；
      // 顺序反过来一旦删除失败，密码就成了后端再也找不到的孤儿条目。
      const { removeRefs } = await api.auth.forget()
      const failed: string[] = []
      for (const ref of removeRefs) {
        try { await api.host.removeKey(ref) } catch { failed.push(ref) }
      }
      if (failed.length) {
        void app.notify('已保存的密码未能删除，请重试', 'warn')
        return
      }
      await api.auth.forget(true)
      await app.refreshAuth()
      void app.notify('已忘记保存的密码', 'success')
    } catch (error) {
      void app.notify(`操作失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setBusy('') }
  }

  return (
    <section className="gh-panel gh-set-panel" aria-label="天翼云盘账号">
      <h2><Glyph icon={Users} size={15} /> 天翼云盘账号</h2>

      {auth.state === 'expired' ? (
        <div className="gh-set-expired" role="alert">
          <Glyph icon={Warning} size={15} />
          <span>登录已过期，需要重新登录后才能继续下载。</span>
          <Button size="sm" onClick={() => setTab('qr')}>重新登录</Button>
        </div>
      ) : null}

      {auth.state === 'logged-in' ? (
        <div className="gh-set-account">
          <div className="gh-set-account-main">
            <span className="gh-set-account-name">{auth.nickname || '天翼云盘用户'}</span>
            <span className="gh-status" data-tone="ok">当前账号</span>
            {auth.savedAccount ? <span className="gh-set-account-id">{auth.savedAccount}</span> : null}
          </div>
          <div className="gh-set-account-actions">
            {/* savedAccount 是明文账号展示，记住的密码由 auth.forget 清理 */}
            {auth.savedAccount ? (
              <Button size="sm" variant="ghost" onClick={() => void forget()} disabled={busy !== ''}>
                忘记已保存的密码
              </Button>
            ) : null}
            <Button size="sm" variant="danger" onClick={() => setLogoutOpen(true)} disabled={busy !== ''}>
              <Glyph icon={SignOut} size={13} />
              <span>退出登录</span>
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="gh-tabs" role="tablist" aria-label="登录方式">
            <button type="button" role="tab" aria-selected={tab === 'qr'} onClick={() => setTab('qr')}>扫码登录</button>
            <button type="button" role="tab" aria-selected={tab === 'password'} onClick={() => setTab('password')}>账号密码登录</button>
          </div>
          <div className="gh-set-login-body" role="tabpanel">
            {tab === 'qr'
              ? <QrLogin onSuccess={() => void app.refreshAuth()} />
              : <PasswordLogin onSuccess={() => void app.refreshAuth()} />}
          </div>
        </>
      )}

      {busy === 'logout' || busy === 'forget' ? <Spinner label={busy === 'logout' ? '正在退出…' : '正在处理…'} /> : null}

      <p className="gh-set-note">
        <Glyph icon={SignIn} size={12} />
        登录状态保存在系统密钥库，插件不会上传你的账号信息。
      </p>

      <ConfirmDialog
        open={logoutOpen}
        title="退出登录"
        body="确定要退出天翼云盘登录吗？进行中的下载任务会暂停。"
        confirmLabel="退出登录"
        danger
        busy={busy === 'logout'}
        onConfirm={() => void logout()}
        onClose={() => { if (busy !== 'logout') setLogoutOpen(false) }}
      />
    </section>
  )
}

/** 面板内部使用的空态占位（登录不可用时显示） */
export function AccountUnavailable({ message }: { message: string }) {
  return <Empty title="登录服务不可用" body={message} />
}
