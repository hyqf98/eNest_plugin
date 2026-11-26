/**
 * 持久化：全部落在宿主插件 KV（storage.get/set）。
 * - 写入防抖合并，降低控制通道往返；
 * - 关闭时必须 flush：宿主只给约 900ms 协作窗口，内存里没落盘的状态会丢。
 *
 * 两个存储域：
 * - items：条目记录（收藏、安装信息、可执行文件路径），一个条目一份；
 * - tasks：下载任务记录（文件、进度、状态、目录），完成后保留供"下载管理"展示，可删除。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, LIMITS, type AppSettings, type SourceId } from './contracts.ts'
import { storageGet, storageSet } from './runtime.ts'

const KEYS = {
  settings: 'settings',
  items: 'library.items',
  tasks: 'tasks',
  auth: 'auth.meta',
} as const

const DEBOUNCE_MS = 250
const pending = new Map<string, unknown>()
const timers = new Map<string, NodeJS.Timeout>()
let flushChain: Promise<void> = Promise.resolve()

async function read<T>(key: string, fallback: T): Promise<T> {
  if (pending.has(key)) return (pending.get(key) ?? fallback) as T
  const value = await storageGet<T>(key)
  return (value === null ? fallback : value) as T
}

/** 把所有待写串行落盘；关闭流程与显式提交都走这里 */
export function flushStore(): Promise<void> {
  const run = flushChain.then(async () => {
    const entries = [...pending.entries()]
    for (const [key] of entries) {
      const timer = timers.get(key)
      if (timer) { clearTimeout(timer); timers.delete(key) }
    }
    for (const [key, value] of entries) {
      try {
        await storageSet(key, value)
        if (pending.get(key) === value) pending.delete(key)
      } catch (error) {
        // 落盘失败时值留在待写队列，下次 flush 再试。
        throw error
      }
    }
  })
  flushChain = run.catch(() => undefined)
  return run
}

function write(key: string, value: unknown, immediate = false): void {
  pending.set(key, value)
  if (immediate) { void flushStore().catch(() => undefined); return }
  if (timers.has(key)) return
  const timer = setTimeout(() => { timers.delete(key); void flushStore().catch(() => undefined) }, DEBOUNCE_MS)
  timer.unref?.()
  timers.set(key, timer)
}

/* ---------------- 设置 ---------------- */

const SOURCE_IDS: SourceId[] = ['ode', 'gamer520']

/** 把设置落到合法范围：数值钳制、来源标识白名单、服务地址必须是 http(s) */
function clampSettings(value: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...value }
  merged.concurrentTasks = clamp(Number(merged.concurrentTasks), LIMITS.concurrentTasksMin, LIMITS.concurrentTasksMax, DEFAULT_SETTINGS.concurrentTasks)
  merged.connectionsPerTask = clamp(Number(merged.connectionsPerTask), LIMITS.connectionsMin, LIMITS.connectionsMax, DEFAULT_SETTINGS.connectionsPerTask)
  merged.speedLimit = Math.max(0, Number(merged.speedLimit) || 0)
  for (const key of ['sourcePc', 'sourceConsole', 'sourceSoftware'] as const) {
    if (!SOURCE_IDS.includes(merged[key])) merged[key] = DEFAULT_SETTINGS[key]
  }
  merged.pansouBaseUrl = /^https?:\/\//i.test(merged.pansouBaseUrl) ? merged.pansouBaseUrl.replace(/\/+$/, '') : DEFAULT_SETTINGS.pansouBaseUrl
  for (const key of ['downloadDir', 'installDir'] as const) merged[key] = typeof merged[key] === 'string' ? merged[key] : ''
  return merged
}

/**
 * 用户目录下的下载目录。Windows 中文系统里这个文件夹叫「下载」而不是「Downloads」，
 * 所以按「真实存在」的那个来；两个都没有时用 ~/Downloads（之后选中时会自动创建）。
 * 纯函数：存在性判定由调用方注入，mock 适配器下也能测。
 */
export function defaultDownloadsDir(home: string, exists: (path: string) => boolean = existsSync): string {
  for (const name of ['Downloads', '下载']) {
    const candidate = join(home, name)
    if (exists(candidate)) return candidate
  }
  return join(home, 'Downloads')
}

let defaultDirCache: string | null = null
/** 默认的下载 / 安装目录：用户目录下的 Downloads（见 defaultDownloadsDir） */
export function defaultDir(): string {
  if (!defaultDirCache) defaultDirCache = defaultDownloadsDir(homedir())
  return defaultDirCache
}

export async function loadSettings(): Promise<AppSettings> {
  const stored = await read<Partial<AppSettings>>(KEYS.settings, {})
  // 没设置过目录（新装或老版本）时落到 Downloads，而不是留空
  if (typeof stored.downloadDir !== 'string' || !stored.downloadDir.trim()) stored.downloadDir = defaultDir()
  if (typeof stored.installDir !== 'string' || !stored.installDir.trim()) stored.installDir = defaultDir()
  return clampSettings(stored)
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // 先合并再钳制：写入的值必须已落在合法范围内，不能只在校验读取时修正
  const next = clampSettings({ ...await loadSettings(), ...(patch && typeof patch === 'object' ? patch : {}) })
  write(KEYS.settings, next, true)
  await flushStore()
  return next
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/* ---------------- 条目记录 ---------------- */

export interface StoredItem {
  id: string
  kind: string
  section: string
  source: string
  sourceId: string
  title: string
  subtitle: string
  /** 封面的原始地址；显示时经 media.load 换取可展示地址 */
  cover: string
  category: string
  sizeText: string
  meta: string[]
  favorite: boolean
  /** 站点给出的可执行文件相对安装目录的路径 */
  exeRel: string
  /** 实际可执行文件绝对路径；安装完成或用户手动指定后有值 */
  exePath: string
  installDir: string
  /** 用户手动添加的本地条目没有下载目录 */
  downloadDir: string
  addedAt: number
}

export async function loadItems(): Promise<StoredItem[]> {
  const list = await read<StoredItem[]>(KEYS.items, [])
  return Array.isArray(list) ? list.filter(entry => entry && typeof entry.id === 'string') : []
}

export function saveItems(items: StoredItem[]): void {
  write(KEYS.items, items)
}

/** 写入或合并一个条目；返回更新后的完整列表 */
export async function upsertItem(item: Partial<StoredItem> & { id: string }): Promise<StoredItem[]> {
  const list = await loadItems()
  const index = list.findIndex(entry => entry.id === item.id)
  if (index >= 0) {
    list[index] = { ...list[index], ...item }
  } else {
    const base: StoredItem = {
      id: item.id, kind: 'game', section: 'pc', source: '', sourceId: '', title: '', subtitle: '', cover: '', category: '', sizeText: '', meta: [],
      favorite: false, exeRel: '', exePath: '', installDir: '', downloadDir: '', addedAt: Date.now(),
    }
    list.unshift({ ...base, ...item, addedAt: Date.now() })
  }
  saveItems(list)
  return list
}

export async function removeItem(id: string): Promise<StoredItem[]> {
  const list = (await loadItems()).filter(entry => entry.id !== id)
  saveItems(list)
  return list
}

/* ---------------- 下载任务记录 ---------------- */

export interface StoredTaskFile {
  /** 分享内的文件 id 或直链标识 */
  key: string
  name: string
  size: number
  downloaded: number
  state: string
  /** 直链；可能过期，续传时由解析器刷新 */
  url: string
  /** 下载该直链时必须带的请求头（天翼云直链需要 cookie + referer）；直链资源为空 */
  headers?: Record<string, string>
  /** 续传校验用的远端标识 */
  etag: string
  lastModified: string
}

export interface StoredTask {
  id: string
  itemId: string
  kind: string
  title: string
  cover: string
  state: string
  /** 分享链接与提取码；直链任务为空 */
  shareUrl: string
  accessCode: string
  /** 天翼云分享 id，解析后写入 */
  shareId: string
  files: StoredTaskFile[]
  downloadDir: string
  installDir: string
  exeRel: string
  /** 安装成功后定位到的可执行文件绝对路径（exe 模式下就是下载到的那个 exe） */
  exePath: string
  autoInstall: boolean
  removePackage: boolean
  error: string
  installError: string
  createdAt: number
  finishedAt: number
}

export async function loadTasks(): Promise<StoredTask[]> {
  const list = await read<StoredTask[]>(KEYS.tasks, [])
  return Array.isArray(list) ? list.filter(entry => entry && typeof entry.id === 'string') : []
}

export function saveTasks(tasks: StoredTask[]): void {
  write(KEYS.tasks, tasks)
}

/* ---------------- 登录元信息（不含任何凭据） ---------------- */

/** 凭据本身进宿主保险库；这里只存不透明引用与展示用昵称 */
export interface AuthMeta {
  /** 保险库引用：会话凭据 */
  sessionRef: string
  /** 保险库引用：记住的账号；空表示没记住 */
  accountRef: string
  /** 保险库引用：记住的密码；空表示没记住 */
  passwordRef: string
  nickname: string
  /** 记住的账号明文，仅用于设置页展示与下次登录预填；不是秘密 */
  account: string
  loginAt: number
}

export async function loadAuthMeta(): Promise<AuthMeta> {
  const value = await read<Partial<AuthMeta>>(KEYS.auth, {})
  return {
    sessionRef: typeof value.sessionRef === 'string' ? value.sessionRef : '',
    accountRef: typeof value.accountRef === 'string' ? value.accountRef : '',
    passwordRef: typeof value.passwordRef === 'string' ? value.passwordRef : '',
    nickname: typeof value.nickname === 'string' ? value.nickname : '',
    account: typeof value.account === 'string' ? value.account : '',
    loginAt: typeof value.loginAt === 'number' ? value.loginAt : 0,
  }
}

export function saveAuthMeta(meta: AuthMeta): void {
  write(KEYS.auth, meta, true)
}
