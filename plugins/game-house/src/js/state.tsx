/**
 * 全局状态：设置、任务、条目库、登录状态。
 *
 * 原则：后端是状态的唯一来源。前端启动时拉一次快照，之后只订阅后端事件，
 * 不轮询、不自行推断状态（源项目里大量"gid 变更 / 旧任务残留 / 进度翻倍"的问题都源于前端轮询对账）。
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, AuthInfo, ManagedEntry, Task } from '../shared/contracts'
import { ACTIVE_STATES } from '../shared/contracts'
import * as api from './api'

export interface AppState {
  ready: boolean
  bootError: string
  settings: AppSettings | null
  tasks: Record<string, Task>
  /** 任务按创建时间倒序 */
  taskList: Task[]
  /** 进行中的任务数 */
  activeCount: number
  entries: ManagedEntry[]
  auth: AuthInfo
  reload: () => void
  setSettings: (settings: AppSettings) => void
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  refreshTasks: () => Promise<void>
  refreshEntries: () => Promise<void>
  refreshAuth: () => Promise<void>
  notify: (body: string, level?: 'info' | 'success' | 'warn' | 'error') => void
  /** 当前打开的详情条目 id；空串表示未打开 */
  detailId: string
  openDetail: (itemId: string) => void
  closeDetail: () => void
  /** 当前所在栏目 */
  nav: NavId
  setNav: (nav: NavId) => void
}

export type NavId = 'pc' | 'console' | 'software' | 'trainer' | 'mod' | 'pansou' | 'my' | 'downloads' | 'settings'

export const NAV_GROUPS: Array<{ label: string; items: Array<{ id: NavId; label: string; icon: string }> }> = [
  { label: '游戏', items: [{ id: 'pc', label: 'PC 游戏', icon: 'Desktop' }, { id: 'console', label: '主机游戏', icon: 'GameController' }] },
  { label: '软件', items: [{ id: 'software', label: 'PC 软件', icon: 'Package' }] },
  { label: '工具', items: [{ id: 'trainer', label: '修改器', icon: 'Wrench' }, { id: 'mod', label: 'MOD', icon: 'PuzzlePiece' }, { id: 'pansou', label: '网盘搜索', icon: 'MagnifyingGlass' }] },
  { label: '我的', items: [{ id: 'my', label: '我的游戏', icon: 'Heart' }, { id: 'downloads', label: '下载管理', icon: 'DownloadSimple' }, { id: 'settings', label: '设置', icon: 'GearSix' }] },
]

export const NAV_LABELS: Record<NavId, string> = Object.fromEntries(NAV_GROUPS.flatMap(group => group.items.map(item => [item.id, item.label]))) as Record<NavId, string>

/** 当前栏目所在的分组：主分段用分组名，分组内多个栏目时再显示为分类 chips */
export function navGroupOf(nav: NavId): { label: string; items: Array<{ id: NavId; label: string }> } {
  return NAV_GROUPS.find(group => group.items.some(item => item.id === nav)) ?? NAV_GROUPS[0]
}

const Context = createContext<AppState | null>(null)

export function useApp(): AppState {
  const value = useContext(Context)
  if (!value) throw new Error('useApp 必须在 AppProvider 内使用')
  return value
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [bootError, setBootError] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [tasks, setTasks] = useState<Record<string, Task>>({})
  const [entries, setEntries] = useState<ManagedEntry[]>([])
  const [auth, setAuth] = useState<AuthInfo>({ state: 'unknown', nickname: '', savedAccount: '' })
  const [nav, setNav] = useState<NavId>('pc')
  const [detailId, setDetailId] = useState('')
  // 进度事件约每秒一次，同一次事件循环里的多次更新合并成一次渲染。
  // 不能用 requestAnimationFrame：内嵌的插件视图里动画帧不一定派发（页面明明可见也不触发），
  // 进度事件会被攒着永远不落地，任务下完了页面还显示"启动中"。
  const pendingTasks = useRef(new Map<string, Task>())
  const flushScheduled = useRef(false)
  const flushTimer = useRef(0)

  const applyTask = useCallback((task: Task) => {
    pendingTasks.current.set(task.id, task)
    if (flushScheduled.current) return
    flushScheduled.current = true
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = 0
      flushScheduled.current = false
      const batch = pendingTasks.current
      pendingTasks.current = new Map()
      setTasks(current => {
        let next = current
        for (const [id, value] of batch) {
          if (next === current) next = { ...current }
          next[id] = value
        }
        return next
      })
    }, 0)
  }, [])

  const refreshTasks = useCallback(async () => {
    const list = await api.tasks.list()
    setTasks(Object.fromEntries(list.map(task => [task.id, task])))
  }, [])

  const refreshEntries = useCallback(async () => {
    setEntries(await api.library.managed())
  }, [])

  const refreshAuth = useCallback(async () => {
    setAuth(await api.auth.info())
  }, [])

  const notify = useCallback(async (body: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    await api.host.toast(body, level)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await api.settings.update(patch)
    setSettings(next)
    return next
  }, [])

  useEffect(() => {
    let disposed = false
    const offs: Array<() => void> = []
    void (async () => {
      try {
        const [loadedSettings, taskList, entryList, authInfo] = await Promise.all([
          api.settings.get(),
          api.tasks.list().catch(() => [] as Task[]),
          api.library.managed().catch(() => [] as ManagedEntry[]),
          api.auth.info().catch(() => null),
        ])
        if (disposed) return
        setSettings(loadedSettings)
        setTasks(Object.fromEntries(taskList.map(task => [task.id, task])))
        setEntries(entryList)
        if (authInfo) setAuth(authInfo)
        offs.push(api.onTaskUpdated(applyTask))
        offs.push(api.onTaskFinished(task => { applyTask(task); void refreshEntries() }))
        offs.push(api.onLibraryChanged(setEntries))
        offs.push(api.onAuthChanged(setAuth))
        // 设置入口：从壳的设置页点"打开游戏屋设置"进来时切到设置栏目。
        const hostApi = window.enest || window.zapi
        if (hostApi?.getEnterCode?.() === 'settings') setNav('settings')
        offs.push(hostApi?.onEnter?.(event => { if (event.code === 'settings') setNav('settings') }) ?? (() => undefined))
        setReady(true)
      } catch (error) {
        if (!disposed) setBootError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      disposed = true
      for (const off of offs) { try { off() } catch { /* 已释放 */ } }
      if (flushTimer.current) { window.clearTimeout(flushTimer.current); flushTimer.current = 0; flushScheduled.current = false }
    }
  }, [applyTask, refreshEntries])

  const taskList = useMemo(() => Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt), [tasks])
  const activeCount = useMemo(() => taskList.filter(task => ACTIVE_STATES.includes(task.state)).length, [taskList])

  const value = useMemo<AppState>(() => ({
    ready, bootError, settings, tasks, taskList, activeCount, entries, auth,
    reload: () => { void refreshTasks(); void refreshEntries(); void refreshAuth() },
    setSettings, updateSettings, refreshTasks, refreshEntries, refreshAuth, notify,
    detailId, openDetail: setDetailId, closeDetail: () => setDetailId(''),
    // 切换栏目时关掉详情：详情是独立的一页，留着它会让新栏目看不见、工具栏像没反应
    nav, setNav: (next: NavId) => { setDetailId(''); setNav(next) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ready, bootError, settings, tasks, taskList, activeCount, entries, auth, notify, updateSettings, refreshTasks, refreshEntries, refreshAuth, detailId, nav])

  return createElement(Context.Provider, { value }, children)
}
