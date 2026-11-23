/**
 * 下载管理里的单张任务卡：封面、状态、进度、路径与按状态变化的操作区。
 * 操作按钮各自带 busy 态防连点；删除与卸载的确认由父级弹 ConfirmDialog。
 */

import { useState } from 'react'
import {
  ArrowClockwise, DownloadSimple, FolderOpen, Pause, Play, SignIn, SignOut,
  SpinnerGap, Stop, Trash, Warning,
} from '@phosphor-icons/react'
import type { Task } from '../../shared/contracts'
import { Cover, Progress, StatusBadge } from '../../components/base'
import { Button } from '../../ui'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'
import { formatBytes, formatEta, formatSpeed } from '../../js/format'
import { taskLabel, taskPercent, taskProgressTone, taskTone } from '../../js/taskLabels'

export interface RemoveRequest {
  task: Task
  deleteFiles: boolean
}

export function TaskCard({ task, onRemove, onRelogin }: {
  task: Task
  /** deleteFiles 为 true 时连本地文件一起删 */
  onRemove: (request: RemoveRequest) => void
  /** 登录过期时切到设置栏目 */
  onRelogin: () => void
}) {
  const app = useApp()
  const [busy, setBusy] = useState('')
  const percentValue = taskPercent(task)
  const tone = taskTone(task.state)

  async function run(key: string, action: () => Promise<unknown>, failure: string): Promise<void> {
    setBusy(key)
    try { await action() } catch (error) { void app.notify(`${failure}：${errorText(error)}`, 'error') } finally { setBusy('') }
  }

  const pause = () => run('pause', async () => { await api.tasks.pause(task.id); await app.refreshTasks() }, '暂停失败')
  const resume = () => run('resume', async () => { await api.tasks.resume(task.id); await app.refreshTasks() }, '继续失败')
  const retry = () => run('retry', async () => { await api.tasks.retryInstall(task.id); await app.refreshTasks() }, '重试失败')
  /**
   * 卡死时的重试：任务还处于"下载中"，直接点继续会被后端拒绝（只接受暂停 / 失败的任务）。
   * 所以先暂停——后端会掐断卡住的连接，等它收尾后再继续，从断点接着下。
   */
  const restart = () => run('restart', async () => {
    await api.tasks.pause(task.id)
    for (let waited = 0; waited < 30; waited++) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 100))
      const current = (await api.tasks.list()).find(entry => entry.id === task.id)
      if (!current) return
      if (current.state === 'paused') { await api.tasks.resume(task.id); await app.refreshTasks(); return }
    }
    throw new Error('任务没有停下来，请稍后再试')
  }, '重试失败')
  // 删除：完成态的「删除记录」与其余状态的「删除」都连本地文件一起删
  const remove = () => onRemove({ task, deleteFiles: true })
  const launch = () => run('launch', () => api.library.launch(task.itemId), '启动失败')
  const uninstall = () => run('uninstall', async () => { await api.library.uninstall(task.itemId) }, '卸载失败')
  const reveal = () => run('reveal', () => api.library.reveal(task.itemId, 'install'), '打开目录失败')

  const removing = busy.startsWith('remove')

  return (
    <article className="gh-dl-card" data-state={task.state} aria-label={`下载任务：${task.title}`}>
      {task.stalled ? (
        <div className="gh-dl-stalled" role="alert">
          <Glyph icon={Warning} size={14} />
          <span>{task.state === 'installing' ? '解压长时间无响应，可能已卡死' : '长时间无响应，可能已断开'}</span>
          <span className="gh-dl-stalled-actions">
            {task.state === 'installing'
              ? <Button size="sm" onClick={pause} disabled={busy !== ''}>重试</Button>
              : <Button size="sm" onClick={restart} disabled={busy !== ''}>{busy === 'restart' ? '正在重试…' : '重试'}</Button>}
            <Button size="sm" variant="ghost" onClick={pause} disabled={busy !== ''}><span>暂停</span></Button>
          </span>
        </div>
      ) : null}

      <div className="gh-dl-card-main">
        <Cover token={task.coverToken} alt="" className="gh-dl-cover" />
        <div className="gh-dl-info">
          <div className="gh-dl-head">
            <strong className="gh-dl-title">{task.title}</strong>
            <StatusBadge tone={tone === 'neutral' ? undefined : tone}>{taskLabel(task.state)}</StatusBadge>
            {task.files.length > 1 ? <span className="gh-dl-files">共 {task.files.length} 个文件</span> : null}
          </div>

          {task.statusText ? <span className="gh-dl-status-text">{task.statusText}</span> : null}

          {task.state !== 'complete' && task.state !== 'cancelled' ? (
            <div className="gh-dl-progress-row">
              <Progress value={percentValue} tone={taskProgressTone(task.state)} />
              {/* 总量未知（直链包站点不给大小，探测前为 0）时不显示误导性的 0.0% */}
              <span className="gh-dl-percent">{task.totalBytes > 0 ? `${percentValue.toFixed(1)}%` : task.completedBytes > 0 ? formatBytes(task.completedBytes, '') : '—'}</span>
            </div>
          ) : null}
        </div>

        <div className="gh-dl-actions">
          {renderActions()}
        </div>

        {/* 错误说明是整张卡的内容，通栏铺满：留在左列会被挤窄折成多行，右侧还空出一大块 */}
        {task.state === 'install_failed' || task.error ? (
          <div className="gh-dl-error" role="alert">
            {task.state === 'install_failed'
              ? `安装失败（重试仅重新解压，不会重新下载）：${task.installError || '未知错误'}`
              : task.error}
          </div>
        ) : null}

        {/* 底部通栏一行：速度 / 剩余时间 / 已下载字节 靠左，下载与安装目录跟在后面 */}
        <div className="gh-dl-footer">
          <div className="gh-dl-meta">
            {task.speed > 0 ? <span className="gh-dl-speed">{formatSpeed(task.speed)}</span> : null}
            {task.etaSeconds > 0 ? <span>剩余 {formatEta(task.etaSeconds)}</span> : null}
            {task.totalBytes > 0 ? <span>{formatBytes(task.completedBytes)} / {formatBytes(task.totalBytes)}</span> : null}
            {task.state === 'installing' ? <span>正在解压，请稍候</span> : null}
          </div>
          <div className="gh-dl-paths">
            {task.downloadDir ? <span className="gh-dl-path" title={task.downloadDir}>下载：{task.downloadDir}</span> : null}
            {task.installDir ? <span className="gh-dl-path" title={task.installDir}>安装：{task.installDir}</span> : null}
          </div>
        </div>
      </div>
    </article>
  )

  function renderActions(): JSX.Element {
    const disabledAll = busy !== ''
    switch (task.state) {
      case 'queued':
      case 'resolving':
        return (
          <>
            <Button size="sm" disabled aria-label={task.state === 'queued' ? '正在排队' : '正在解析下载地址'}>
              <Glyph icon={SpinnerGap} size={13} /><span>{task.state === 'queued' ? '排队中' : '启动中'}</span>
            </Button>
            {/* 排队 / 解析中也能暂停：任务和已选的目录都保留，想下的时候再继续 */}
            <Button size="sm" onClick={pause} disabled={disabledAll}><Glyph icon={Pause} size={13} /><span>暂停</span></Button>
            <Button size="sm" variant="danger" onClick={remove} disabled={disabledAll}><Glyph icon={Trash} size={13} /><span>删除</span></Button>
          </>
        )
      case 'downloading':
        return (
          <>
            <Button size="sm" onClick={pause} disabled={disabledAll}><Glyph icon={Pause} size={13} /><span>暂停</span></Button>
            <Button size="sm" variant="danger" onClick={remove} disabled={disabledAll}><Glyph icon={Trash} size={13} /><span>删除</span></Button>
          </>
        )
      case 'paused':
        return (
          <>
            <Button size="sm" onClick={resume} disabled={disabledAll}><Glyph icon={Play} size={13} /><span>继续</span></Button>
            <Button size="sm" variant="danger" onClick={remove} disabled={disabledAll}><Glyph icon={Trash} size={13} /><span>删除</span></Button>
          </>
        )
      case 'failed':
        return (
          <>
            <Button size="sm" onClick={resume} disabled={disabledAll}><Glyph icon={ArrowClockwise} size={13} /><span>重试</span></Button>
            <Button size="sm" variant="danger" onClick={remove} disabled={disabledAll}><Glyph icon={Trash} size={13} /><span>删除</span></Button>
          </>
        )
      case 'login_expired':
        return (
          <>
            <Button size="sm" onClick={onRelogin}><Glyph icon={SignIn} size={13} /><span>重新登录</span></Button>
            <Button size="sm" variant="danger" onClick={remove} disabled={disabledAll}><Glyph icon={Trash} size={13} /><span>删除</span></Button>
          </>
        )
      case 'installing':
        return (
          <>
            <Button size="sm" disabled aria-label="正在解压"><Glyph icon={SpinnerGap} size={13} /><span>解压中</span></Button>
            {/* 暂停会中止解压，安装包保留；继续时只重新解压，不会重新下载 */}
            <Button size="sm" onClick={pause} disabled={disabledAll}><Glyph icon={Pause} size={13} /><span>暂停</span></Button>
            <Button size="sm" variant="danger" onClick={remove} disabled={disabledAll}><Glyph icon={Trash} size={13} /><span>删除</span></Button>
          </>
        )
      case 'install_failed':
        return (
          <>
            <Button size="sm" onClick={retry} disabled={disabledAll}><Glyph icon={ArrowClockwise} size={13} /><span>重试</span></Button>
            <Button size="sm" variant="danger" onClick={remove} disabled={disabledAll}><Glyph icon={Trash} size={13} /><span>删除</span></Button>
          </>
        )
      case 'complete':
        // 只下载没安装（或没解出可执行文件）：没有可启动的东西，只给"打开目录"
        if (!task.installed) {
          return (
            <>
              <Button size="sm" variant="ghost" onClick={reveal} disabled={disabledAll} aria-label="打开目录"><Glyph icon={FolderOpen} size={13} /><span>打开目录</span></Button>
              <Button size="sm" variant="ghost" onClick={remove} disabled={disabledAll || removing} aria-label="删除记录"><Glyph icon={Stop} size={13} /><span>删除记录</span></Button>
            </>
          )
        }
        return (
          <>
            <Button size="sm" variant="primary" onClick={launch} disabled={disabledAll}>
              <Glyph icon={task.kind === 'software' || task.kind === 'trainer' ? DownloadSimple : Play} size={13} />
              <span>{task.kind === 'software' || task.kind === 'trainer' ? '打开' : '启动'}</span>
            </Button>
            <Button size="sm" onClick={uninstall} disabled={disabledAll}><Glyph icon={SignOut} size={13} /><span>卸载</span></Button>
            <Button size="sm" variant="ghost" onClick={reveal} disabled={disabledAll} aria-label="打开目录"><Glyph icon={FolderOpen} size={13} /></Button>
            <Button size="sm" variant="ghost" onClick={remove} disabled={disabledAll || removing} aria-label="删除记录"><Glyph icon={Stop} size={13} /></Button>
          </>
        )
      case 'cancelled':
        return (
          <Button size="sm" variant="danger" onClick={remove} disabled={disabledAll}><Glyph icon={Trash} size={13} /><span>删除</span></Button>
        )
      default:
        return <span />
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
