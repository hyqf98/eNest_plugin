/**
 * 下载管理：任务列表、批量操作与确认对话框。
 * 视图根节点撑满 .gh-view；任务卡铺满宽度，按进行中优先、创建时间倒序排列。
 */

import '../../css/views-local.css'

import { useMemo, useState } from 'react'
import { Broom, Pause, Play } from '@phosphor-icons/react'
import { ACTIVE_STATES, RESUMABLE_STATES } from '../../shared/contracts'
import type { Task } from '../../shared/contracts'
import { Button } from '../../ui'
import { ConfirmDialog } from '../../components/ext'
import { Empty, Spinner } from '../../components/base'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'
import { TaskCard, type RemoveRequest } from './TaskCard'

const FINISHED_STATES: readonly Task['state'][] = ['complete', 'cancelled']

export function DownloadsView() {
  const app = useApp()
  const { taskList } = app
  const [bulkBusy, setBulkBusy] = useState<'pause' | 'resume' | 'clear' | ''>('')
  const [pendingRemove, setPendingRemove] = useState<RemoveRequest | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)

  const ordered = useMemo(() => {
    const activeFirst = (a: Task, b: Task): number => {
      const aActive = ACTIVE_STATES.includes(a.state) ? 1 : 0
      const bActive = ACTIVE_STATES.includes(b.state) ? 1 : 0
      if (aActive !== bActive) return bActive - aActive
      return b.createdAt - a.createdAt
    }
    return [...taskList].sort(activeFirst)
  }, [taskList])

  const activeCount = useMemo(
    () => taskList.filter(task => ACTIVE_STATES.includes(task.state)).length,
    [taskList],
  )
  const finishedCount = useMemo(
    () => taskList.filter(task => FINISHED_STATES.includes(task.state)).length,
    [taskList],
  )

  async function bulkPause(): Promise<void> {
    const targets = taskList.filter(task => task.state === 'downloading')
    if (!targets.length) return
    setBulkBusy('pause')
    const results = await Promise.allSettled(targets.map(task => api.tasks.pause(task.id)))
    const failed = results.filter(result => result.status === 'rejected').length
    if (failed) void app.notify(`${failed} 个任务暂停失败`, 'error')
    // 状态迁移的 task.updated 可能因事件流延迟晚于点击，主动对账一次
    await app.refreshTasks()
    setBulkBusy('')
  }

  async function bulkResume(): Promise<void> {
    const targets = taskList.filter(task => RESUMABLE_STATES.includes(task.state))
    if (!targets.length) return
    setBulkBusy('resume')
    const results = await Promise.allSettled(targets.map(task => api.tasks.resume(task.id)))
    const failed = results.filter(result => result.status === 'rejected').length
    if (failed) void app.notify(`${failed} 个任务继续失败`, 'error')
    await app.refreshTasks()
    setBulkBusy('')
  }

  async function clearFinished(): Promise<void> {
    const targets = taskList.filter(task => FINISHED_STATES.includes(task.state))
    if (!targets.length) return
    setBulkBusy('clear')
    setClearOpen(false)
    const results = await Promise.allSettled(targets.map(task => api.tasks.remove(task.id, false)))
    const failed = results.filter(result => result.status === 'rejected').length
    if (failed) void app.notify(`${failed} 条记录清除失败`, 'error')
    else void app.notify(`已清除 ${targets.length - failed} 条已结束记录`, 'success')
    await app.refreshTasks()
    setBulkBusy('')
  }

  async function confirmRemove(): Promise<void> {
    const request = pendingRemove
    if (!request) return
    setRemoveBusy(true)
    try {
      await api.tasks.remove(request.task.id, request.deleteFiles)
      void app.notify(request.deleteFiles ? '已删除任务及本地文件' : '已移除任务记录', 'success')
      setPendingRemove(null)
      // 后端删除后未必推送 task.updated（例如任务已不在 running 中），主动对账一次
      await app.refreshTasks()
    } catch (error) {
      void app.notify(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setRemoveBusy(false)
    }
  }

  return (
    <div className="gh-dl">
      <div className="gh-dl-toolbar">
        <span className="gh-dl-summary">共 {taskList.length} 个任务 · 进行中 {activeCount}</span>
        <span className="gh-toolbar-spacer" />
        <Button
          size="sm"
          onClick={() => void bulkPause()}
          disabled={bulkBusy !== '' || activeCount === 0}
          aria-label="全部暂停"
        >
          <Glyph icon={Pause} size={13} />
          <span>全部暂停</span>
        </Button>
        <Button
          size="sm"
          onClick={() => void bulkResume()}
          disabled={bulkBusy !== '' || !taskList.some(task => RESUMABLE_STATES.includes(task.state))}
          aria-label="全部继续"
        >
          <Glyph icon={Play} size={13} />
          <span>全部继续</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setClearOpen(true)}
          disabled={bulkBusy !== '' || finishedCount === 0}
          aria-label="清除已结束"
        >
          <Glyph icon={Broom} size={13} />
          <span>清除已结束</span>
        </Button>
      </div>

      {bulkBusy !== '' ? <Spinner label={bulkBusy === 'clear' ? '正在清除记录…' : '正在批量调整任务…'} /> : null}

      {ordered.length === 0 ? (
        <Empty title="暂无下载任务" body="在游戏库中选择资源即可开始下载" />
      ) : (
        <div className="gh-list gh-dl-list">
          {ordered.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              onRemove={setPendingRemove}
              onRelogin={() => app.setNav('settings')}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        title="删除下载任务"
        body={pendingRemove
          ? `${pendingRemove.deleteFiles ? '确定要删除下载任务及本地文件吗？' : '确定要移除该任务记录吗？'}（${pendingRemove.task.title}）`
          : ''}
        confirmLabel={pendingRemove?.deleteFiles ? '删除' : '移除'}
        danger
        busy={removeBusy}
        onConfirm={() => void confirmRemove()}
        onClose={() => { if (!removeBusy) setPendingRemove(null) }}
      />

      <ConfirmDialog
        open={clearOpen}
        title="清除已结束任务"
        body={`确定要清除 ${finishedCount} 条已完成或已取消的记录吗？只移除记录，不删除本地文件。`}
        confirmLabel="清除"
        busy={bulkBusy === 'clear'}
        onConfirm={() => void clearFinished()}
        onClose={() => { if (bulkBusy !== 'clear') setClearOpen(false) }}
      />
    </div>
  )
}
