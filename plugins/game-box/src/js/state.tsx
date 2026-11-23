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
  /** 上次所在的「发现」栏目：从别的页面回到「发现」时回到它 */
  lastDiscover: NavId
}

export type NavId = 'pc' | 'console' | 'software' | 'trainer' | 'mod' | 'pansou' | 'my' | 'downloads' | 'settings'

/** 一级导航的三个页面：发现（浏览内容）、我的游戏、下载管理 */
export type PageId = 'discover' | 'my' | 'downloads'

/**
 * 栏目分两族：
 * - 内容栏目（"发现"下的子类）：PC 游戏、主机游戏、PC 软件、修改器、MOD、网盘搜索；
 * - 页面：我的游戏、下载管理。
 * 设置不是导航项，是页头右侧的入口。
 */
export const DISCOVER_ITEMS: ReadonlyArray<{ id: NavId; label: string }> = [
  { id: 'pc', label: 'PC 游戏' },
  { id: 'console', label: '主机游戏' },
  { id: 'software', label: 'PC 软件' },
  { id: 'trainer', label: '修改器' },
  { id: 'mod', label: 'MOD' },
  { id: 'pansou', label: '网盘搜索' },
]

export const PAGES: ReadonlyArray<{ id: PageId; label: string }> = [
  { id: 'discover', label: '发现' },
  { id: 'my', label: '我的游戏' },
  { id: 'downloads', label: '下载管理' },
]

/** 当前栏目所属的一级页面；设置不属于任何页面（它是页头右侧的独立入口），返回 null */
export function pageOf(nav: NavId): PageId | null {
  if (nav === 'my' || nav === 'downloads') return nav
  if (nav === 'settings') return null
  return 'discover'
}

/** 切换一级页面时进入哪个栏目：发现回到 PC 游戏（最常用），其余就是页面本身 */
export function navOfPage(page: PageId): NavId {
  return page === 'discover' ? 'pc' : page
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
        // 设置入口：从壳的设置页点"打开游戏盒子设置"进来时切到设置栏目。
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
  // 上次所在的「发现」栏目：离开发现后仍要记得它，所以单独存，不能从 nav 推
  const [lastDiscover, setLastDiscover] = useState<NavId>('pc')

  const value = useMemo<AppState>(() => ({
    ready, bootError, settings, tasks, taskList, activeCount, entries, auth,
    reload: () => { void refreshTasks(); void refreshEntries(); void refreshAuth() },
    setSettings, updateSettings, refreshTasks, refreshEntries, refreshAuth, notify,
    detailId, openDetail: setDetailId, closeDetail: () => setDetailId(''),
    // 切换栏目时关掉详情：详情是独立的一页，留着它会让新栏目看不见、导航像没反应
    nav, lastDiscover,
    setNav: (next: NavId) => {
      setDetailId('')
      setNav(next)
      if (pageOf(next) === 'discover') setLastDiscover(next)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ready, bootError, settings, tasks, taskList, activeCount, entries, auth, notify, updateSettings, refreshTasks, refreshEntries, refreshAuth, detailId, nav, lastDiscover])

  return createElement(Context.Provider, { value }, children)
}
