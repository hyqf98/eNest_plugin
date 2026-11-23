/**
 * 我的游戏：收藏与已安装条目，分「已安装 / 未安装」两个分区，行卡片铺满宽度。
 * 标签页按栏目与类型过滤；支持添加本地游戏（选 exe + 可选封面）。
 */

import { useMemo, useState } from 'react'
import {
  ArrowRight, CheckCircle, FolderOpen, Heart, Image, Pause, Play, Plus,
  SpinnerGap, Stop, Trash, X,
} from '@phosphor-icons/react'
import type { ItemKind, ManagedEntry, Section, Task } from '../../shared/contracts'
import { ACTIVE_STATES } from '../../shared/contracts'
import { Button, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle, Input } from '../../ui'
import { ConfirmDialog } from '../../components/ext'
import { Cover, Empty, Progress, StatusBadge } from '../../components/base'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'
import { taskPercent } from '../../js/taskLabels'

type MyTab = 'all' | 'pc' | 'console' | 'software' | 'trainer' | 'mod'

const TABS: Array<{ id: MyTab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'pc', label: 'PC 游戏' },
  { id: 'console', label: 'Switch' },
  { id: 'software', label: '软件' },
  { id: 'trainer', label: '修改器' },
  { id: 'mod', label: 'MOD' },
]

const KIND_LABELS: Record<ItemKind, string> = {
  game: '游戏',
  software: '软件',
  trainer: '修改器',
  mod: 'MOD',
  custom: '本地游戏',
}

export function MyGamesView() {
  const app = useApp()
  const { entries, taskList } = app
  const [tab, setTab] = useState<MyTab>('all')
  const [busyId, setBusyId] = useState('')
  const [uninstallTarget, setUninstallTarget] = useState<ManagedEntry | null>(null)
  const [uninstallBusy, setUninstallBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const taskByItem = useMemo(() => {
    const map = new Map<string, Task>()
    for (const task of taskList) {
      if (ACTIVE_STATES.includes(task.state)) map.set(task.itemId, task)
    }
    return map
  }, [taskList])

  const filtered = useMemo(() => entries.filter(entry => {
    if (tab === 'all') return true
    if (tab === 'software') return entry.item.kind === 'software'
    if (tab === 'trainer') return entry.item.kind === 'trainer'
    if (tab === 'mod') return entry.item.kind === 'mod'
    return entry.item.section === (tab as Section)
  }), [entries, tab])

  const installed = filtered.filter(entry => entry.exePath || entry.item.installed)
  const notInstalled = filtered.filter(entry => !(entry.exePath || entry.item.installed))

  async function run(key: string, action: () => Promise<unknown>, failure: string): Promise<void> {
    setBusyId(key)
    try { await action() } catch (error) {
      void app.notify(`${failure}：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setBusyId('') }
  }

  const launch = (entry: ManagedEntry) => run(entry.item.id, async () => {
    if (!entry.exePath) {
      const picked = await api.host.pickFile(['.exe'])
      if (!picked) return
      await api.library.setExe(entry.item.id, picked.handleId)
    }
    await api.library.launch(entry.item.id)
    void app.notify(`已启动「${entry.item.title}」`, 'success')
  }, '启动失败')

  const close = (entry: ManagedEntry) => run(entry.item.id, async () => {
    await api.library.close(entry.item.id)
    void app.refreshEntries()
    void app.notify(`已关闭「${entry.item.title}」`, 'success')
  }, '关闭游戏失败')

  const reveal = (entry: ManagedEntry) => run(entry.item.id, () => api.library.reveal(entry.item.id, 'install'), '打开目录失败')

  const unfavorite = (entry: ManagedEntry) => run(entry.item.id, async () => {
    await api.library.favorite(entry.item.id, false)
    void app.notify(`已取消收藏「${entry.item.title}」`, 'success')
  }, '取消收藏失败')

  async function confirmUninstall(): Promise<void> {
    const target = uninstallTarget
    if (!target) return
    setUninstallBusy(true)
    try {
      await api.library.uninstall(target.item.id)
      void app.notify(`已卸载「${target.item.title}」`, 'success')
      setUninstallTarget(null)
    } catch (error) {
      void app.notify(`卸载失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setUninstallBusy(false) }
  }

  return (
    <div className="gh-my">
      <div className="gh-my-toolbar">
        {/* 类型过滤用胶囊 chips，与页头的栏目 chips 同一套形状：它和导航是同一类"选一个看"的控件 */}
        <div className="gh-chip-row gh-my-tabs" role="group" aria-label="我的游戏类型">
          {TABS.map(item => (
            <button
              key={item.id}
              type="button"
              className="gh-chip"
              aria-pressed={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.id === 'all' && entries.length ? `全部 ${entries.length}` : item.label}
            </button>
          ))}
        </div>
        <Button size="sm" className="gh-my-add" onClick={() => setAddOpen(true)}>
          <Glyph icon={Plus} size={13} />
          <span>添加本地游戏</span>
        </Button>
      </div>

      {filtered.length === 0 ? (
        entries.length === 0 ? (
          <Empty
            className="gh-my-empty"
            icon={<Glyph icon={Heart} size={30} />}
            title="还没有收藏的游戏"
            body="在游戏卡片上点爱心收藏，也可以把本地已装好的游戏加进来"
            action={(
              <div className="gh-my-empty-actions">
                <Button variant="primary" onClick={() => app.setNav('pc')}>去发现找游戏</Button>
                <Button onClick={() => setAddOpen(true)}><Glyph icon={Plus} size={13} /><span>添加本地游戏</span></Button>
              </div>
            )}
          />
        ) : (
          <Empty
            className="gh-my-empty"
            title="这个类型下还没有游戏"
            body="换一个类型看看"
            action={<Button onClick={() => setTab('all')}>查看全部</Button>}
          />
        )
      ) : (
        <div className="gh-my-sections">
          {installed.length > 0 ? (
            <section className="gh-my-section">
              <h2 className="gh-my-section-label">已安装 · {installed.length}</h2>
              <div className="gh-list">
                {installed.map(entry => (
                  <GameRow
                    key={entry.item.id}
                    entry={entry}
                    task={taskByItem.get(entry.item.id)}
                    busy={busyId === entry.item.id}
                    onLaunch={() => void launch(entry)}
                    onClose={() => void close(entry)}
                    onReveal={() => void reveal(entry)}
                    onUninstall={() => setUninstallTarget(entry)}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {notInstalled.length > 0 ? (
            <section className="gh-my-section">
              <h2 className="gh-my-section-label">未安装 · {notInstalled.length}</h2>
              <div className="gh-list">
                {notInstalled.map(entry => (
                  <GameRow
                    key={entry.item.id}
                    entry={entry}
                    task={taskByItem.get(entry.item.id)}
                    busy={busyId === entry.item.id}
                    onLaunch={() => void launch(entry)}
                    onClose={() => void close(entry)}
                    onReveal={() => void reveal(entry)}
                    onUninstall={() => setUninstallTarget(entry)}
                    onUnfavorite={() => void unfavorite(entry)}
                    onOpenDetail={() => app.openDetail(entry.item.id)}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={uninstallTarget !== null}
        title="卸载游戏"
        body={uninstallTarget ? `确定要卸载「${uninstallTarget.item.title}」吗？` : ''}
        confirmLabel="卸载"
        danger
        busy={uninstallBusy}
        onConfirm={() => void confirmUninstall()}
        onClose={() => { if (!uninstallBusy) setUninstallTarget(null) }}
      />

      <AddGameDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => { setAddOpen(false); void app.refreshEntries() }}
      />
    </div>
  )
}

/* ---------------- 行卡片 ---------------- */

function GameRow({ entry, task, busy, onLaunch, onClose, onReveal, onUninstall, onUnfavorite, onOpenDetail }: {
  entry: ManagedEntry
  task?: Task
  busy: boolean
  onLaunch: () => void
  onClose: () => void
  onReveal: () => void
  onUninstall: () => void
  onUnfavorite?: () => void
  onOpenDetail?: () => void
}) {
  const isInstalled = Boolean(entry.exePath || entry.item.installed)
  const running = entry.running
  const category = entry.item.category || KIND_LABELS[entry.item.kind]
  const active = task && ACTIVE_STATES.includes(task.state)

  let badge: { tone: 'accent' | 'ok' | 'danger' | 'warn' | undefined; label: string }
  if (task && active) {
    const percent = taskPercent(task)
    if (task.state === 'downloading') badge = { tone: 'accent', label: percent > 0 ? `下载中 ${Math.round(percent)}%` : '下载中' }
    else if (task.state === 'paused') badge = { tone: undefined, label: '已暂停' }
    else if (task.state === 'installing') badge = { tone: 'accent', label: '解压中' }
    else badge = { tone: 'accent', label: '排队中' }
  } else if (task?.state === 'install_failed' || task?.state === 'failed') {
    badge = { tone: 'danger', label: '安装失败' }
  } else if (isInstalled) {
    badge = { tone: 'ok', label: '已安装' }
  } else {
    badge = { tone: undefined, label: '未安装' }
  }

  return (
    <div className="gh-my-row" data-installed={isInstalled ? 'true' : undefined}>
      <Cover token={entry.item.coverToken} alt="" className="gh-my-cover" />
      <div className="gh-my-main">
        <div className="gh-my-head">
          <strong className="gh-my-title">{entry.item.title}</strong>
          <span className="gh-my-category">{category}</span>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          {running ? <StatusBadge tone="accent">运行中</StatusBadge> : null}
        </div>
        {task && active && task.state !== 'installing' ? (
          <div className="gh-my-progress">
            <Progress value={taskPercent(task)} tone={task.state === 'paused' ? undefined : 'accent'} />
            <span className="gh-my-percent">{taskPercent(task).toFixed(1)}%</span>
          </div>
        ) : null}
        <div className="gh-my-meta">
          {entry.item.sizeText ? <span>{entry.item.sizeText}</span> : null}
          {entry.installDir ? <span title={entry.installDir}>{entry.installDir}</span> : null}
        </div>
      </div>
      <div className="gh-my-actions">
        {isInstalled ? (
          <>
            {running
              ? <Button size="sm" onClick={onClose} disabled={busy}><Glyph icon={busy ? SpinnerGap : Stop} size={13} /><span>关闭游戏</span></Button>
              : <Button size="sm" variant="primary" onClick={onLaunch} disabled={busy}>
                  <Glyph icon={busy ? SpinnerGap : Play} size={13} /><span>启动</span>
                </Button>}
            <Button size="sm" variant="ghost" onClick={onReveal} disabled={busy} aria-label="打开目录"><Glyph icon={FolderOpen} size={13} /></Button>
            <Button size="sm" variant="ghost" onClick={onUninstall} disabled={busy}>
              <Glyph icon={Trash} size={13} /><span>卸载</span>
            </Button>
          </>
        ) : (
          <>
            {onOpenDetail
              ? <Button size="sm" onClick={onOpenDetail}><Glyph icon={ArrowRight} size={13} /><span>进详情</span></Button>
              : null}
            {onUnfavorite
              ? <Button size="sm" variant="ghost" onClick={onUnfavorite} disabled={busy}><Glyph icon={X} size={13} /><span>取消收藏</span></Button>
              : null}
          </>
        )}
      </div>
    </div>
  )
}

/* ---------------- 添加游戏对话框 ---------------- */

function AddGameDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [exe, setExe] = useState<{ handleId: string; name: string } | null>(null)
  const [cover, setCover] = useState<{ handleId: string; name: string } | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  function pickExe(): void {
    void (async () => {
      try {
        const picked = await api.host.pickFile(['.exe'])
        if (!picked) return
        setExe({ handleId: picked.handleId, name: picked.name })
        if (!title.trim()) setTitle(picked.name.replace(/\.exe$/i, ''))
      } catch (error) {
        void api.host.toast(`选择文件失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    })()
  }

  function pickCover(): void {
    void (async () => {
      try {
        const picked = await api.host.pickFile(['.png', '.jpg', '.jpeg', '.webp'])
        if (picked) setCover({ handleId: picked.handleId, name: picked.name })
      } catch (error) {
        void api.host.toast(`选择封面失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    })()
  }

  async function confirm(): Promise<void> {
    if (!exe) return
    setBusy(true)
    try {
      await api.library.addCustom({
        title: title.trim() || exe.name.replace(/\.exe$/i, ''),
        handleId: exe.handleId,
        coverHandleId: cover?.handleId,
      })
      void api.host.toast('已添加本地游戏', 'success')
      onAdded()
    } catch (error) {
      void api.host.toast(`添加失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setBusy(false) }
  }

  function resetAndClose(): void {
    if (busy) return
    setExe(null); setCover(null); setTitle('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) resetAndClose() }}>
      <DialogOverlay />
      <DialogContent className="gh-dialog" aria-describedby="gh-addgame-desc">
        <DialogTitle>添加自定义游戏</DialogTitle>
        <DialogDescription id="gh-addgame-desc">选择一个可执行文件，添加到我的游戏。</DialogDescription>
        <div className="gh-dialog-body">
          <div className="gh-field">
            <span className="gh-field-label">游戏名称</span>
            <Input value={title} placeholder="默认使用文件名" maxLength={80} onChange={event => setTitle(event.target.value)} aria-label="游戏名称" />
          </div>
          <div className="gh-field">
            <span className="gh-field-label">游戏程序</span>
            <div className="gh-field-row">
              <input className="pk-input gh-path-input" value={exe?.name ?? ''} placeholder="请选择可执行文件（.exe）" readOnly aria-label="游戏程序" />
              <Button size="sm" onClick={pickExe} disabled={busy}><Glyph icon={FolderOpen} size={13} /><span>选择文件</span></Button>
            </div>
          </div>
          <div className="gh-field">
            <span className="gh-field-label">封面图片（可选）</span>
            <div className="gh-field-row">
              <input className="pk-input gh-path-input" value={cover?.name ?? ''} placeholder="尚未选择封面" readOnly aria-label="封面图片" />
              <Button size="sm" variant="ghost" onClick={pickCover} disabled={busy}>
                <Glyph icon={cover ? Image : Plus} size={13} /><span>{cover ? '重新选择' : '选择封面'}</span>
              </Button>
              {cover ? <Button size="sm" variant="ghost" onClick={() => setCover(null)} aria-label="清除封面"><Glyph icon={X} size={13} /></Button> : null}
            </div>
          </div>
          {exe ? (
            <div className="gh-set-okline" role="status">
              <Glyph icon={CheckCircle} size={14} />
              <span>已选择 {exe.name}</span>
            </div>
          ) : null}
          <p className="gh-field-hint"><Glyph icon={Pause} size={11} /> 添加后可在游戏库与我的游戏里启动；卸载只移除记录。</p>
        </div>
        <div className="gh-dialog-actions">
          <Button onClick={resetAndClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={busy || !exe}>确认添加</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
