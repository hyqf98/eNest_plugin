import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dialog, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from '@dsh/ui/index.jsx'
import { EmptyState, InlineMessage, InstallProgress, LoadingBlock } from './SettingsPrimitives.jsx'
import { errorText, formatTime } from './SettingsController.jsx'

const RELEASES_URL = 'https://github.com/hyqf98/eNest_plugin/releases'
const isVerified = (version) => Boolean(version.assetUrl && /^[a-f\d]{64}$/i.test(version.sha256 || ''))

/** First-run guidance when no DSH runtime is available: install a published release online. */
export function KernelSetupDialog({ state, onClose }) {
  const [remote, setRemote] = useState({ loading: false, loaded: false, error: '', data: null })
  const [pending, setPending] = useState(null)
  const [error, setError] = useState('')
  const requests = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadRemote = useCallback(async () => {
    const requestId = ++requests.current
    if (alive.current) setRemote((current) => ({ ...current, loading: true, error: '' }))
    try {
      const data = await window.DshApi.call('runtime.versions.available', { limit: 20 })
      if (alive.current && requests.current === requestId) setRemote({ loading: false, loaded: true, error: '', data: Array.isArray(data) ? data : [] })
    } catch (exception) {
      if (alive.current && requests.current === requestId) setRemote((current) => ({ ...current, loading: false, loaded: true, error: errorText(exception) }))
    }
  }, [])

  useEffect(() => { void loadRemote() }, [loadRemote])

  const markDone = useCallback(async (value) => {
    try { await window.DshApi.setPref('kernelGuide', value) } catch { /* marker is best-effort */ }
  }, [])

  const dismiss = useCallback(async () => {
    if (pending) return
    await markDone('skipped')
    if (alive.current) onClose()
  }, [markDone, onClose, pending])

  const install = useCallback((version) => {
    if (pending) return
    setError('')
    setPending(`安装内核 v${version.version}`)
    void (async () => {
      try {
        await window.DshApi.call('upgrade.oneClick', { version: version.version })
        await window.DshState.detect()
        await markDone('done')
        if (!alive.current) return
        window.DshApi.notice(`DSH 内核 v${version.version} 已安装并激活`, 'success')
        onClose()
        if (window.DshApi.raw?.getLaunchMode?.() !== 'quick') void window.DshState.ensureWeb().catch(() => {})
      } catch (exception) {
        if (alive.current) setError(errorText(exception))
      } finally {
        if (alive.current) setPending(null)
      }
    })()
  }, [markDone, onClose, pending])

  const blocked = Boolean(pending)
  const items = (remote.data || []).filter(isVerified)
  return (
    <div className="dsh-settings dsh-kernel-setup-mount">
      <Dialog open onOpenChange={(next) => { if (!next && !blocked) void dismiss() }}>
        <DialogOverlay className="pk-dialog-overlay" />
        <DialogContent
          className="dsh-settings-dialog dsh-kernel-setup-dialog"
          onEscapeKeyDown={(event) => { if (blocked) event.preventDefault() }}
          onInteractOutside={(event) => { if (blocked) event.preventDefault() }}
        >
          <DialogTitle>安装 DSH 内核</DialogTitle>
          <DialogDescription>
            插件发行包不再内置 DSH 内核。选择一个已发布的版本在线安装：宿主会下载并做 SHA-256 校验、
            健康检查后激活；失败自动回滚，Profile 与会话不受影响。
          </DialogDescription>
          <InstallProgress progress={state.upgrading} pending={pending} title="安装进度" />
          {remote.error ? <InlineMessage>获取版本列表失败：{remote.error}{remote.data?.length ? '。下方保留上次成功的列表。' : ''}</InlineMessage> : null}
          <InlineMessage>{error}</InlineMessage>
          {remote.loading ? <LoadingBlock label="正在获取可安装的内核版本…" /> : items.length ? (
            <div className="dsh-settings-remote-list">
              {items.map((version) => (
                <article className="dsh-settings-remote-version" key={version.version}>
                  <div className="dsh-settings-heading-copy">
                    <div className="dsh-settings-version-name"><strong>v{version.version}</strong>{version.distTag && <span>{version.distTag}</span>}</div>
                    <p>{version.date ? formatTime(version.date) : '发布时间未提供'} · 提供 SHA-256 校验</p>
                  </div>
                  <div className="dsh-settings-actions">
                    <Button variant="primary" disabled={blocked} onClick={() => install(version)}>安装并使用</Button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="暂无当前平台可安装的内核资产">
              插件发布仓库尚未提供与本机平台匹配、且带校验信息的内核资产。可以稍后重新获取列表，
              或在「管理中心 → 内核版本」中随时重试；系统已安装的 dsh 也会被自动识别。
            </EmptyState>
          )}
          <div className="dsh-settings-dialog-actions">
            <Button variant="ghost" disabled={blocked} onClick={() => void window.DshApi.openExternal(RELEASES_URL)}>查看内核发布</Button>
            <Button disabled={blocked || remote.loading} onClick={() => void loadRemote()}>{remote.loaded ? '重新获取列表' : '获取版本'}</Button>
            <Button disabled={blocked} onClick={() => void dismiss()}>稍后处理</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
