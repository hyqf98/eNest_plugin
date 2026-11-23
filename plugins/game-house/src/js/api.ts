/**
 * 前后端桥接：backend.call 封装 + 宿主能力（选目录、保存密钥、提示、事件订阅）。
 * 所有与后端的通信都从这里走，视图不直接碰 window.enest.backend。
 */

import type {
  AppSettings,
  AuthInfo,
  CreateTaskRequest,
  DetailData,
  LibraryFacets,
  LibraryItem,
  LibraryQuery,
  ManagedEntry,
  MediaPayload,
  Page,
  PanSouResponse,
  QrEvent,
  QrStatus,
  SaveSessionRequest,
  ShareParseResult,
  Task,
  TaskCounts,
} from '../shared/contracts'
import { EVENTS, METHODS } from '../shared/contracts'

type BackendEvent = { event: string; data: unknown }
type Listener = (payload: BackendEvent) => void

export function getApi() {
  const enest = window.enest || window.zapi
  if (!enest?.backend?.call) throw new Error('游戏屋需要 eNest 宿主后端支持（backend.node）')
  return enest
}

export async function call<T>(method: string, args: unknown[] = [], timeoutMs = 60_000): Promise<T> {
  return getApi().backend.call<T>(method, args, { timeoutMs })
}

export function onBackendEvent(listener: Listener): () => void {
  const api = getApi()
  const wrapped = (data: unknown) => listener(data as BackendEvent)
  api.on('backend.event', wrapped)
  return () => api.off('backend.event', wrapped)
}

export async function flushStorage(): Promise<void> {
  try { await getApi().storage.flush() } catch { /* 宿主不支持显式提交时不影响业务 */ }
}

/* ---------------- 领域接口 ---------------- */

export const system = {
  hello: () => call<{ pluginId: string; platform: string; node: string }>(METHODS.systemHello),
}

export const settings = {
  get: () => call<AppSettings>(METHODS.settingsGet),
  update: (patch: Partial<AppSettings>) => call<AppSettings>(METHODS.settingsUpdate, [patch]),
}

export const library = {
  facets: (section: string) => call<LibraryFacets>(METHODS.facets, [section], 30_000),
  list: (query: LibraryQuery) => call<Page<LibraryItem>>(METHODS.list, [query], 45_000),
  detail: (itemId: string) => call<DetailData>(METHODS.detail, [itemId], 45_000),
  favorite: (itemId: string, favorite: boolean) => call<{ ok: boolean }>(METHODS.favorite, [itemId, favorite]),
  managed: () => call<ManagedEntry[]>(METHODS.managed, [], 30_000),
  setExe: (itemId: string, handleId: string) => call<ManagedEntry[]>(METHODS.setExe, [itemId, handleId], 30_000),
  addCustom: (input: { title: string; handleId: string; coverHandleId?: string }) => call<ManagedEntry[]>(METHODS.addCustom, [input], 30_000),
  launch: (itemId: string) => call<{ running: boolean; elevated: boolean }>(METHODS.launch, [itemId], 60_000),
  close: (itemId: string) => call<{ running: boolean }>(METHODS.closeApp, [itemId], 30_000),
  uninstall: (itemId: string) => call<ManagedEntry[]>(METHODS.uninstall, [itemId], 120_000),
  reveal: (itemId: string, target: 'download' | 'install') => call<{ ok: boolean }>(METHODS.reveal, [itemId, target], 15_000),
}

export const media = {
  load: (token: string) => call<MediaPayload>(METHODS.mediaLoad, [token], 30_000),
}

export const share = {
  parse: (url: string, accessCode: string) => call<ShareParseResult>(METHODS.parseShare, [url, accessCode], 30_000),
}

export const tasks = {
  create: (request: CreateTaskRequest) => call<{ taskId: string }>(METHODS.taskCreate, [request], 60_000),
  list: () => call<Task[]>(METHODS.taskList, [], 30_000),
  pause: (taskId: string) => call<{ ok: boolean }>(METHODS.taskPause, [taskId], 15_000),
  resume: (taskId: string) => call<{ ok: boolean }>(METHODS.taskResume, [taskId], 60_000),
  retryInstall: (taskId: string) => call<{ ok: boolean }>(METHODS.taskRetryInstall, [taskId], 15_000),
  remove: (taskId: string, deleteFiles: boolean) => call<{ ok: boolean }>(METHODS.taskRemove, [taskId, deleteFiles], 120_000),
  updateOptions: (taskId: string, patch: { autoInstall?: boolean; removePackage?: boolean }) => call<{ ok: boolean }>(METHODS.taskUpdateOptions, [taskId, patch], 15_000),
}

export const auth = {
  info: () => call<AuthInfo>(METHODS.authInfo, [], 20_000),
  qrStart: () => call<{ sessionId: string }>(METHODS.authQrStart, [], 15_000),
  qrCancel: (sessionId: string) => call<{ ok: boolean }>(METHODS.authQrCancel, [sessionId], 5_000),
  loginPassword: (input: { account: string; password: string; captcha: string; remember: boolean }) =>
    call<{ sessionId: string; needCaptcha: string; credential?: string }>(METHODS.authLoginPassword, [input], 30_000),
  /**
   * 登录成功后调用：把已入库的 secretRef 回传后端保存。
   * 后端会把这次被替换或清除的旧引用（旧会话、不再记住的账号密码）交回来，由这里从保险库删除；
   * 只有页面能删保险库，后端的记录一清，旧密码就再也找不到了。
   */
  saveSession: async (input: SaveSessionRequest): Promise<{ ok: boolean }> => {
    const result = await call<{ ok: boolean; removeRefs: string[] }>(METHODS.authSaveSession, [input], 15_000)
    await host.releaseRefs(result.removeRefs)
    return { ok: result.ok }
  },
  /** 退出登录；后端不再引用的旧会话由这里从保险库删除（记住的账号密码保留） */
  logout: async (): Promise<{ ok: boolean }> => {
    const result = await call<{ ok: boolean; removeRefs: string[] }>(METHODS.authLogout, [], 15_000)
    await host.releaseRefs(result.removeRefs)
    return { ok: result.ok }
  },
  /** 忘记已保存的密码。先不带参数调用取得应删除的保险库引用，页面删除后再以 confirmed 调用让后端清记录 */
  forget: (confirmed = false) => call<{ ok: boolean; removeRefs: string[] }>(METHODS.authForget, [confirmed], 15_000),
}

export const panSou = {
  health: () => call<{ available: boolean; baseUrl: string }>(METHODS.panSouHealth, [], 15_000),
  search: (keyword: string, cloudTypes: string[]) => call<PanSouResponse>(METHODS.panSouSearch, [keyword, cloudTypes], 60_000),
}

export function onTaskUpdated(listener: (task: Task) => void): () => void {
  return onBackendEvent(payload => {
    if (payload.event === EVENTS.taskUpdated) listener(payload.data as Task)
  })
}

export function onTaskFinished(listener: (task: Task, counts: TaskCounts) => void): () => void {
  return onBackendEvent(payload => {
    if (payload.event === EVENTS.taskFinished) {
      const data = payload.data as { task: Task; counts: TaskCounts }
      listener(data.task, data.counts)
    }
  })
}

export function onLibraryChanged(listener: (entries: ManagedEntry[]) => void): () => void {
  return onBackendEvent(payload => {
    if (payload.event === EVENTS.libraryChanged) listener(payload.data as ManagedEntry[])
  })
}

export function onAuthChanged(listener: (info: AuthInfo) => void): () => void {
  return onBackendEvent(payload => {
    if (payload.event === EVENTS.authChanged) listener(payload.data as AuthInfo)
  })
}

export function onQrStatus(listener: (event: QrEvent) => void): () => void {
  return onBackendEvent(payload => {
    if (payload.event === EVENTS.qrStatus) listener(payload.data as QrEvent)
  })
}

/* ---------------- 宿主能力 ---------------- */

export const host = {
  /** 让用户选一个目录，返回句柄 id；取消返回 null */
  async pickDirectory(): Promise<{ handleId: string; displayPath: string } | null> {
    const handles = await getApi().localFiles.pick({ kind: 'directory', access: 'write' })
    const handle = handles[0]
    return handle ? { handleId: handle.id, displayPath: handle.displayPath } : null
  },
  /** 让用户选一个文件，返回句柄 id；取消返回 null */
  async pickFile(extensions: string[] = []): Promise<{ handleId: string; name: string; displayPath: string } | null> {
    const handles = await getApi().localFiles.pick({ kind: 'file', access: 'read' })
    const handle = handles[0]
    if (!handle) return null
    if (extensions.length) {
      const lower = handle.name.toLowerCase()
      if (!extensions.some(extension => lower.endsWith(extension))) throw new Error(`请选择 ${extensions.join(' / ')} 文件`)
    }
    return { handleId: handle.id, name: handle.name, displayPath: handle.displayPath }
  },
  async toast(body: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): Promise<void> {
    try { await getApi().ui.toast({ body, level }) } catch { /* 提示失败不影响业务 */ }
  },
  async saveKey(key: string, value: string): Promise<string> {
    const result = await getApi().vault.set(key, value)
    return result.secretRef
  },
  async removeKey(secretRef: string): Promise<void> {
    await getApi().vault.remove(secretRef)
  },
  /** 删除一批不再被后端引用的保险库条目；单个失败不影响其余（下次替换时不会再有机会，所以逐个尽力） */
  async releaseRefs(refs: string[]): Promise<void> {
    for (const ref of refs ?? []) {
      if (ref) await getApi().vault.remove(ref).catch(() => undefined)
    }
  },
  hasKey: (key: string) => getApi().vault.has(key),
  async openExternal(url: string): Promise<void> {
    await getApi().shell.openExternal(url)
  },
  async copyText(text: string): Promise<void> {
    await navigator.clipboard.writeText(text)
  },
  /** 设置目录：把句柄交给后端换取路径并持久化 */
  async chooseDirectory(): Promise<string | null> {
    const picked = await this.pickDirectory()
    return picked ? picked.handleId : null
  },
}

export type { QrStatus }
