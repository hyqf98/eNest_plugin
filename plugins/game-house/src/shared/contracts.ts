/**
 * 游戏屋前后端共享契约：数据结构、后端方法名、事件名。
 * 前端（src/）与后端（backend/）都从这里取类型，是双方唯一的对齐依据。
 */

/* ---------------- 条目（游戏 / 软件 / 修改器 / MOD / 本地添加） ---------------- */

export type ItemKind = 'game' | 'software' | 'trainer' | 'mod' | 'custom'
export type Section = 'pc' | 'console' | 'software' | 'trainer' | 'mod'
export type SourceId = 'ode' | 'gamer520'

/** 资源包的状态标记：warehousing = 站点正在打包，不可下载 */
export type PackageState = 'ready' | 'warehousing' | 'unavailable' | 'folder'

export interface ResourcePackage {
  /** 在所属条目内唯一 */
  id: string
  name: string
  /** 展示用的大小文本，例如 "145.55 GB"；未知时为空串 */
  sizeText: string
  /** 字节数；未知为 0 */
  size: number
  /** 资源所在网盘或类型：天翼云盘 / 直链 / 文件夹 等 */
  provider: string
  state: PackageState
  /** 游戏可执行文件相对安装目录的路径，可能为空 */
  exePath: string
  /** 更新时间文本，可能为空 */
  updatedAt: string
  /** 子项数量，仅文件夹有 */
  childCount?: number
}

export interface LibraryItem {
  id: string
  kind: ItemKind
  section: Section
  source: string
  sourceId: string
  title: string
  subtitle: string
  cover: string
  /** 封面加载令牌，交给 media.load 取 base64；为空表示无封面 */
  coverToken: string
  category: string
  sizeText: string
  /** 修改器的版本、支持版本等附加展示信息 */
  meta: string[]
  favorite: boolean
  /** 该条目是否有已安装的可启动程序 */
  installed: boolean
}

export interface Page<T> {
  items: T[]
  page: number
  totalPages: number
  total: number
}

export interface LibraryQuery {
  section: Section
  source: SourceId
  page: number
  keyword: string
  /** 分类 id；空串表示全部分类 */
  category: string
  /** 排序 id；空串表示默认排序 */
  sort: string
}

export interface CategoryOption {
  id: string
  label: string
}

export interface SortOption {
  id: string
  label: string
}

export interface SourceOption {
  id: SourceId
  label: string
  hint: string
  /** 当前是否可用；不可用时列表请求会返回错误态 */
  available: boolean
}

export interface LibraryFacets {
  categories: CategoryOption[]
  sorts: SortOption[]
  sources: SourceOption[]
}

/* ---------------- 详情 ---------------- */

export interface MediaRef {
  /** 交给 media.load 换取可显示地址 */
  token: string
  type: 'image' | 'video'
  /** 视频项的封面令牌（缩略图与播放前的占位用）；图片项没有 */
  poster?: string
}

export interface DetailData {
  item: LibraryItem
  /** 头图与截图轮播 */
  media: MediaRef[]
  /** 净化后的介绍 HTML */
  description: string
  datetime: string
  sizeText: string
  /** 安装后占用估算文本，可能为空 */
  installedSizeText: string
  minConfig: string
  recommendConfig: string
  officialUrl: string
  packages: ResourcePackage[]
  /** 修改器功能项 */
  trainerOptions: TrainerOption[]
  /** 修改器使用指南 */
  trainerGuides: TrainerGuide[]
}

export interface TrainerOption {
  name: string
  hotkey: string
  type: number
  text: string
  tooltip: string
}

export interface TrainerGuide {
  id: number
  title: string
  url: string
}

/* ---------------- 登录 ---------------- */

export type AuthState = 'unknown' | 'logged-out' | 'logged-in' | 'expired'

export interface AuthInfo {
  state: AuthState
  nickname: string
  /** 已保存的账号（仅账号，不含密码），为空表示没有记住 */
  savedAccount: string
}

/**
 * 登录成功后后端交还的会话凭据。它只能由页面写入宿主保险库（后端没有保险库写能力），
 * 再把 secretRef 回传给 auth.saveSession；不要展示、记录或放进普通设置。
 */
export interface SessionHandoff {
  credential: string
}

/** 登录成功后页面把凭据入库，再带着 secretRef 调用；rememberPassword 为 false 时后端清掉已记住的密码 */
export interface SaveSessionRequest {
  sessionRef: string
  /** 记住了密码时：账号与密码的保险库引用 */
  accountRef?: string
  passwordRef?: string
  /** 明文账号，仅用于设置页展示；不进日志 */
  account?: string
  /** 为 false 表示用户取消了记住密码，后端删除已存的密码引用 */
  rememberPassword?: boolean
}

/** 扫码登录过程中后端推给页面的会话凭据（登录成功那一次），页面需入库后回传 auth.saveSession */
export interface QrSuccessHandoff {
  sessionId: string
  credential: string
}

export type QrPhase = 'loading' | 'pending' | 'scanned' | 'expired' | 'failed'

export interface QrStatus {
  phase: QrPhase
  /** 二维码图片的 data URL，phase 为 pending 时有值 */
  image: string
  message: string
}

/* ---------------- 下载任务 ---------------- */

export type TaskState =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'paused'
  | 'install_failed'
  | 'installing'
  | 'complete'
  | 'failed'
  | 'login_expired'
  | 'cancelled'

export type TaskFileState = 'pending' | 'downloading' | 'done' | 'failed' | 'skipped'

export interface TaskFile {
  name: string
  size: number
  downloaded: number
  state: TaskFileState
}

export interface Task {
  id: string
  itemId: string
  title: string
  coverToken: string
  kind: ItemKind
  state: TaskState
  /** 用户可见的状态说明，例如 "正在下载 3/19" */
  statusText: string
  files: TaskFile[]
  totalBytes: number
  completedBytes: number
  /** 字节每秒 */
  speed: number
  /** 预计剩余秒数；未知为 0 */
  etaSeconds: number
  /** 下载错误说明 */
  error: string
  /** 解压安装错误说明；下载成功但安装失败时有值 */
  installError: string
  downloadDir: string
  installDir: string
  autoInstall: boolean
  removePackage: boolean
  /** 已安装：任务完成且定位到了可执行文件。只下载未安装（或没解出 exe）时为 false，此时不能启动 / 卸载 */
  installed: boolean
  /** 超过阈值没有字节进展 */
  stalled: boolean
  createdAt: number
  finishedAt: number
}

/**
 * 一个目标目录：displayPath 只用于展示与预填；
 * handleId 是宿主文件选择器给的句柄，后端经 files.resolve 换成真实路径——选择即授权，
 * 没有句柄的路径字符串不能当授权用。
 */
export interface DirTarget {
  handleId: string
  displayPath: string
}

export interface CreateTaskRequest {
  itemId: string
  /** 选中的资源包 id；条目详情里为空时按 share 指定的全部分享文件 */
  packageIds: string[]
  downloadDir: string
  installDir: string
  /** 下载 / 安装目录的授权句柄；缺句柄时后端拒绝创建 */
  downloadTarget?: DirTarget
  installTarget?: DirTarget
  autoInstall: boolean
  removePackage: boolean
  /** 直接用分享链接建任务时填写（粘贴链接入口 / 网盘搜索结果） */
  share?: { url: string; accessCode: string; title: string }
  /** 建任务时选中的分享内文件 id；为空表示全部分享文件 */
  shareFileIds?: string[]
}

export interface TaskCounts {
  active: number
}

/* ---------------- 条目管理 ---------------- */

export interface ManagedEntry {
  item: LibraryItem
  state: TaskState | 'none'
  exePath: string
  installDir: string
  running: boolean
}

/* ---------------- 设置 ---------------- */

export interface AppSettings {
  downloadDir: string
  installDir: string
  concurrentTasks: number
  connectionsPerTask: number
  /** 限速，字节每秒；0 表示不限速 */
  speedLimit: number
  pansouBaseUrl: string
  autoInstall: boolean
  removePackage: boolean
  sourcePc: SourceId
  sourceConsole: SourceId
  sourceSoftware: SourceId
}

/* ---------------- 网盘搜索 ---------------- */

export interface PanSouResult {
  url: string
  accessCode: string
  note: string
  datetime: string
  source: string
  /** 是否是天翼云盘链接（可一键下载） */
  downloadable: boolean
}

export interface PanSouGroup {
  /** 云盘类型标识，例如 tianyi / ali / quark */
  type: string
  label: string
  results: PanSouResult[]
}

export interface PanSouResponse {
  total: number
  groups: PanSouGroup[]
}

/* ---------------- 图片 ---------------- */

export interface MediaPayload {
  /** data URL（小图）或回环代理地址（大图 / 视频） */
  url: string
  mime: string
}

/* ---------------- 后端方法名 ---------------- */

export const METHODS = {
  systemHello: 'system.hello',
  settingsGet: 'settings.get',
  settingsUpdate: 'settings.update',
  facets: 'library.facets',
  list: 'library.list',
  detail: 'library.detail',
  mediaLoad: 'media.load',
  favorite: 'library.favorite',
  managed: 'library.managed',
  setExe: 'library.setExe',
  addCustom: 'library.addCustom',
  launch: 'library.launch',
  closeApp: 'library.close',
  uninstall: 'library.uninstall',
  reveal: 'library.reveal',
  parseShare: 'share.parse',
  taskCreate: 'task.create',
  taskList: 'task.list',
  taskPause: 'task.pause',
  taskResume: 'task.resume',
  taskRetryInstall: 'task.retryInstall',
  taskRemove: 'task.remove',
  taskUpdateOptions: 'task.updateOptions',
  authInfo: 'auth.info',
  authQrStart: 'auth.qrStart',
  authQrCancel: 'auth.qrCancel',
  authLoginPassword: 'auth.loginPassword',
  /** 登录成功后由页面调用：入库后的 secretRef 回传后端保存 */
  authSaveSession: 'auth.saveSession',
  authLogout: 'auth.logout',
  authForget: 'auth.forget',
  panSouHealth: 'pansou.health',
  panSouSearch: 'pansou.search',
} as const

export type MethodName = (typeof METHODS)[keyof typeof METHODS]

/* ---------------- 后端事件名 ---------------- */

export const EVENTS = {
  taskUpdated: 'task.updated',
  taskFinished: 'task.finished',
  libraryChanged: 'library.changed',
  authChanged: 'auth.changed',
  qrStatus: 'auth.qr',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

export interface QrEvent {
  sessionId: string
  status: QrStatus
  /** 仅登录成功那一次带上：会话凭据，页面入库后回传 auth.saveSession */
  credential?: string
}

/** 分享解析结果：根层文件与子文件夹；下载时需要数字 shareId */
export interface ShareParseResult {
  title: string
  shareId: string
  files: ShareFileEntry[]
  folders: Array<{ id: string; name: string }>
}

export interface ShareFileEntry {
  /** 天翼云文件 id */
  id: string
  name: string
  size: number
  sizeText: string
}

/* ---------------- 默认值与常量 ---------------- */

export const DEFAULT_SETTINGS: AppSettings = {
  downloadDir: '',
  installDir: '',
  concurrentTasks: 3,
  connectionsPerTask: 16,
  speedLimit: 0,
  pansouBaseUrl: 'https://so.252035.xyz',
  autoInstall: true,
  removePackage: true,
  sourcePc: 'ode',
  sourceConsole: 'ode',
  sourceSoftware: 'ode',
}

export const LIMITS = {
  concurrentTasksMin: 1,
  concurrentTasksMax: 5,
  connectionsMin: 1,
  connectionsMax: 32,
  /** 下载 120 秒没有字节进展视为卡死 */
  stallMs: 120_000,
  /** 安装 10 分钟没有进展视为卡死 */
  installStallMs: 600_000,
} as const

/**
 * 后端推事件的节流间隔：下载进度约每秒一次。
 * 前端不要再做二次节流以外的推断。
 */
export const EVENT_THROTTLE_MS = 1000

/** 任务处于这些状态时视为「进行中」 */
export const ACTIVE_STATES: readonly TaskState[] = ['queued', 'resolving', 'downloading', 'installing']

export const STATE_LABELS: Record<TaskState, string> = {
  queued: '等待中',
  resolving: '正在解析',
  downloading: '下载中',
  paused: '已暂停',
  install_failed: '安装失败',
  installing: '解压中',
  complete: '已完成',
  failed: '下载失败',
  login_expired: '登录已过期',
  cancelled: '已取消',
}

/** 这些状态可以「继续」 */
export const RESUMABLE_STATES: readonly TaskState[] = ['paused', 'failed', 'login_expired']
/** 这些状态可以「删除」 */
export const REMOVABLE_STATES: readonly TaskState[] = ['queued', 'resolving', 'downloading', 'paused', 'install_failed', 'failed', 'login_expired']
