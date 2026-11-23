/**
 * 详情页状态区：按任务状态渲染主操作（安装/下载/暂停/继续/重试/启动/卸载…）。
 * 状态来自 useApp().tasks 里该条目的任务，按钮全部带 busy/disabled 防连点。
 * 未下载时显示「安装游戏 / 下载」按钮，点击后经 onDownload 打开下载确认对话框。
 */

import { useState } from 'react'
import { DownloadSimple, FolderOpen, Pause, Play, Trash, X } from '@phosphor-icons/react'
import type { DetailData, Task } from '../../shared/contracts'
import { STATE_LABELS } from '../../shared/contracts'
import { useApp } from '../../js/state'
import { Progress, Spinner, StatusBadge } from '../../components/base'
import { ConfirmDialog } from '../../components/ext'
import { Glyph } from '../../components/Glyph'
import * as api from '../../js/api'
import { formatBytes, formatEta, formatSpeed, percent } from '../../js/format'

type ConfirmKind = null | 'task' | 'uninstall'

export function StatePanel({ detail, task, onDownload }: { detail: DetailData; task: Task | null; onDownload: () => void }) {
  const app = useApp()
  const item = detail.item
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState<ConfirmKind>(null)
  const [launching, setLaunching] = useState(false)
  const [running, setRunning] = useState(false)

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    try { await action() } catch (error) {
      void app.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally { setBusy('') }
  }

  const isSoftware = item.kind === 'software'
  const state = task?.state ?? null

  const pause = () => task && void run('pause', async () => { await api.tasks.pause(task.id); await app.refreshTasks() })
  const resume = () => task && void run('resume', async () => { await api.tasks.resume(task.id); await app.refreshTasks() })
  const retryInstall = () => task && void run('retry', async () => { await api.tasks.retryInstall(task.id); await app.refreshTasks() })
  const removeTask = () => task && void run('remove', async () => {
    await api.tasks.remove(task.id, true)
    setConfirm(null)
    setRunning(false)
    await app.refreshTasks()
    await app.refreshEntries()
    void app.notify('已删除下载记录')
  })
  const uninstall = () => void run('uninstall', async () => {
    await api.library.uninstall(item.id)
    setConfirm(null)
    setRunning(false)
    await app.refreshTasks()
    await app.refreshEntries()
    void app.notify('已卸载')
  })
  const reveal = () => void run('reveal', async () => { await api.library.reveal(item.id, 'install') })

  const launch = () => {
    if (launching || busy) return
    setLaunching(true)
    void run('launch', async () => {
      const result = await api.library.launch(item.id)
      setRunning(result.running)
      await app.refreshEntries()
    }).finally(() => setLaunching(false))
  }

  const close = () => void run('close', async () => {
    await api.library.close(item.id)
    setRunning(false)
    await app.refreshEntries()
  })

  const canLaunch = item.installed || (task?.installed ?? false)
  // 下载完成但没安装（只下载、或解压后没找到可执行文件）
  const downloadedOnly = state === 'complete' && !task?.installed

  return (
    <section className="gh-panel gh-state">
      <div className="gh-state-head">
        <h3 className="gh-state-title">{downloadedOnly ? '下载完成' : !state ? (canLaunch ? '已安装' : '尚未下载') : stateTitle(state, isSoftware)}</h3>
        {state ? <StatusBadge tone={stateTone(state)}>{STATE_LABELS[state]}</StatusBadge> : null}
        {task?.stalled ? <StatusBadge tone="warn">进展缓慢</StatusBadge> : null}
      </div>

      {state === 'downloading' ? (
        <>
          <Progress value={task ? (task.totalBytes > 0 ? (task.completedBytes / task.totalBytes) * 100 : 0) : 0} />
          <div className="gh-state-meta">
            {/* 总量未知（直链包站点不给大小，探测前为 0）时不显示百分比与"未知大小"，只报已下载多少 */}
            {task && task.totalBytes > 0 ? <span>{percent(task.completedBytes / task.totalBytes * 100)}</span> : null}
            {formatSpeed(task?.speed ?? 0) ? <span>{formatSpeed(task?.speed ?? 0)}</span> : null}
            {task && task.totalBytes > 0 && formatEta(task?.etaSeconds ?? 0) ? <span>剩余 {formatEta(task?.etaSeconds ?? 0)}</span> : null}
            {task && task.totalBytes > 0
              ? <span>{formatBytes(task.completedBytes, '0 B')} / {formatBytes(task.totalBytes)}</span>
              : task && task.completedBytes > 0 ? <span>已下载 {formatBytes(task.completedBytes, '0 B')}</span> : null}
            {task?.statusText ? <span>{task.statusText}</span> : null}
          </div>
        </>
      ) : null}

      {state === 'installing' ? <Spinner label="正在解压，请稍候…" /> : null}

      {state === 'install_failed' || state === 'failed' ? (
        <div className="gh-state-error" role="alert">
          {state === 'install_failed'
            ? `安装失败（重试仅重新解压，不会重新下载）： ${task?.installError || task?.error || '未知错误'}`
            : `下载失败： ${task?.error || '未知错误'}`}
        </div>
      ) : null}

      {state === 'login_expired' ? (
        <div className="gh-state-error" role="alert">天翼云登录已过期，重新登录后可继续下载</div>
      ) : null}

      <div className="gh-state-actions">
        {!state ? (
          <button type="button" className="pk-btn pk-btn-primary" onClick={onDownload}>
            <Glyph icon={DownloadSimple} size={14} />
            <span>{canLaunch ? (isSoftware ? '打开' : '启动游戏') : (isSoftware || item.kind === 'trainer' || item.kind === 'mod' ? '下载' : '安装游戏')}</span>
          </button>
        ) : null}

        {state === 'downloading' ? (
          <>
            <button type="button" className="pk-btn" disabled={busy !== ''} onClick={pause}><Glyph icon={Pause} size={14} /><span>暂停</span></button>
            <button type="button" className="pk-btn pk-btn-danger" disabled={busy !== ''} onClick={() => setConfirm('task')}><Glyph icon={Trash} size={14} /><span>删除</span></button>
          </>
        ) : null}

        {state === 'paused' ? (
          <>
            <button type="button" className="pk-btn pk-btn-primary" disabled={busy !== ''} onClick={resume}><Glyph icon={Play} size={14} /><span>继续</span></button>
            <button type="button" className="pk-btn pk-btn-danger" disabled={busy !== ''} onClick={() => setConfirm('task')}><Glyph icon={Trash} size={14} /><span>删除</span></button>
          </>
        ) : null}

        {state === 'queued' || state === 'resolving' ? (
          <>
            <button type="button" className="pk-btn" disabled aria-busy="true"><span>{state === 'queued' ? '排队中…' : '启动中…'}</span></button>
            {/* 暂停：任务与已选目录都保留，想下的时候再继续。排队中的任务暂停后不会自动开跑 */}
            <button type="button" className="pk-btn" disabled={busy !== ''} onClick={pause}><Glyph icon={Pause} size={14} /><span>暂停</span></button>
            <button type="button" className="pk-btn pk-btn-danger" disabled={busy !== ''} onClick={() => setConfirm('task')}><Glyph icon={Trash} size={14} /><span>删除</span></button>
          </>
        ) : null}

        {state === 'installing' ? (
          <>
            {/* 暂停会中止解压，安装包保留；继续时只重新解压，不会重新下载 */}
            <button type="button" className="pk-btn" disabled={busy !== ''} onClick={pause}><Glyph icon={Pause} size={14} /><span>暂停</span></button>
            <button type="button" className="pk-btn pk-btn-danger" disabled={busy !== ''} onClick={() => setConfirm('task')}><Glyph icon={Trash} size={14} /><span>删除</span></button>
          </>
        ) : null}

        {state === 'install_failed' ? (
          <>
            <button type="button" className="pk-btn pk-btn-primary" disabled={busy !== ''} onClick={retryInstall}><span>{busy === 'retry' ? '重试中…' : '重试安装'}</span></button>
            <button type="button" className="pk-btn pk-btn-danger" disabled={busy !== ''} onClick={() => setConfirm('task')}><Glyph icon={Trash} size={14} /><span>删除</span></button>
          </>
        ) : null}

        {state === 'failed' ? (
          <>
            <button type="button" className="pk-btn pk-btn-primary" disabled={busy !== ''} onClick={resume}><span>{busy === 'resume' ? '重试中…' : '重试'}</span></button>
            <button type="button" className="pk-btn pk-btn-danger" disabled={busy !== ''} onClick={() => setConfirm('task')}><Glyph icon={Trash} size={14} /><span>删除</span></button>
          </>
        ) : null}

        {state === 'login_expired' ? (
          <>
            <button type="button" className="pk-btn pk-btn-primary" onClick={() => app.setNav('settings')}>重新登录</button>
            <button type="button" className="pk-btn pk-btn-danger" disabled={busy !== ''} onClick={() => setConfirm('task')}><Glyph icon={Trash} size={14} /><span>删除</span></button>
          </>
        ) : null}

        {state === 'complete' ? (
          // 只下载没安装（或没解出可执行文件）：没有可启动的东西，只给"打开目录"
          !task?.installed ? (
            <button type="button" className="pk-btn" disabled={busy !== ''} onClick={reveal}><Glyph icon={FolderOpen} size={14} /><span>打开目录</span></button>
          ) : (
          <>
            {running ? (
              <button type="button" className="pk-btn" onClick={close} disabled={busy !== ''}><Glyph icon={X} size={14} /><span>关闭游戏</span></button>
            ) : (
              <button type="button" className="pk-btn pk-btn-primary" onClick={launch} disabled={launching || busy !== ''} aria-busy={launching || undefined}>
                <Glyph icon={Play} size={14} />
                <span>{launching || busy === 'launch' ? '启动中…' : '运行中'}</span>
              </button>
            )}
            <button type="button" className="pk-btn" disabled={busy !== ''} onClick={reveal}><Glyph icon={FolderOpen} size={14} /><span>打开目录</span></button>
            <button type="button" className="pk-btn pk-btn-danger" disabled={busy !== ''} onClick={() => setConfirm('uninstall')}><Glyph icon={Trash} size={14} /><span>卸载</span></button>
          </>
          )
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        danger
        busy={busy !== ''}
        title={confirm === 'uninstall' ? '确认卸载' : '确认删除'}
        body={confirm === 'uninstall' ? '确定要卸载吗？将删除安装目录和下载文件' : '确定要删除吗？将删除已下载的文件和下载记录'}
        confirmLabel={confirm === 'uninstall' ? '卸载' : '删除'}
        onConfirm={() => { if (confirm === 'uninstall') void uninstall(); else void removeTask() }}
        onClose={() => setConfirm(null)}
      />
    </section>
  )
}

function stateTitle(state: Task['state'], isSoftware: boolean): string {
  switch (state) {
    case 'downloading': return '正在下载'
    case 'paused': return '已暂停'
    case 'queued': return '排队等待'
    case 'resolving': return '正在准备下载'
    case 'installing': return '正在解压安装'
    case 'install_failed': return '安装失败'
    case 'failed': return '下载失败'
    case 'login_expired': return '登录已过期'
    case 'complete': return isSoftware ? '可以打开了' : '可以启动了'
    case 'cancelled': return '已取消'
    default: return ''
  }
}

function stateTone(state: Task['state']): 'accent' | 'ok' | 'danger' | 'warn' | undefined {
  switch (state) {
    case 'downloading': case 'queued': case 'resolving': case 'installing': return 'accent'
    case 'complete': return 'ok'
    case 'install_failed': case 'failed': return 'danger'
    case 'login_expired': case 'paused': return 'warn'
    default: return undefined
  }
}
