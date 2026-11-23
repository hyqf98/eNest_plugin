/**
 * wallpaper-wall 前后端共享契约。
 * 只放纯类型、常量和无平台依赖的小函数；不导入 Node、Electron 或宿主模块。
 */

export const PLUGIN_ID = 'com.github.eNest.wallpaper-wall'

export const MEDIA_TYPES = ['image', 'video', 'gif', 'web'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

export const WALLPAPER_FITS = ['fill', 'fit', 'stretch', 'center', 'tile', 'span'] as const
export type WallpaperFit = (typeof WALLPAPER_FITS)[number]

export const FPS_LIMITS = [24, 30, 60] as const
export type FpsLimit = (typeof FPS_LIMITS)[number]

export type VideoQuality = 'original' | '1080p' | '720p'
export const VIDEO_QUALITIES: readonly VideoQuality[] = ['original', '1080p', '720p']

export function isVideoQuality(value: unknown): value is VideoQuality {
  return value === 'original' || value === '1080p' || value === '720p'
}

export interface WallpaperVariant {
  url: string
  width?: number
  height?: number
  mime?: string
  fileSize?: number
  label?: string
}

export type SourceFacetType = 'select' | 'multi' | 'range' | 'color' | 'tags' | 'sort' | 'toggle'

export interface SourceFacetOption {
  value: string
  label: string
}

export interface SourceFacet {
  key: string
  label: string
  type: SourceFacetType
  options?: SourceFacetOption[]
  default?: string | string[] | number | boolean
  min?: number
  max?: number
  step?: number
  placeholder?: string
  /** 颜色类过滤器的候选色板（#RRGGBB）。 */
  values?: string[]
}

export interface SourceFacets {
  items: SourceFacet[]
}

export type SourceFilterValue = string | number | boolean | string[] | null
export type SourceFilters = Record<string, SourceFilterValue>

export interface WallpaperItem {
  sourceId: string
  remoteId: string
  title: string
  mediaType: MediaType
  thumbUrl: string
  previewUrl: string
  fullUrl: string
  width?: number
  height?: number
  fileSize?: number
  mime?: string
  author?: string
  authorUrl?: string
  license?: string
  licenseUrl?: string
  sourceUrl?: string
  attribution?: string
  color?: string
  tags?: string[]
  durationMs?: number
  downloadAllowed: boolean
  exportAllowed: boolean
  thumbHeaders?: Record<string, string>
  downloadHeaders?: Record<string, string>
  variants?: WallpaperVariant[]
  meta?: Record<string, string | number | boolean | null>
}

export interface SourceDescriptor {
  id: string
  name: string
  description?: string
  homepage?: string
  mediaTypes: MediaType[]
  requiresKey: boolean
  keyLabel?: string
  keyUrl?: string
  builtin: boolean
  enabledByDefault: boolean
  supportsSearch: boolean
  supportsPagination: boolean
  facets: SourceFacets
  notices?: string[]
}

export interface SourceQuery {
  sourceId: string
  query?: string
  page?: number
  perPage?: number
  filters?: SourceFilters
  requestId: string
}

export interface SourcePage {
  items: WallpaperItem[]
  page: number
  hasMore: boolean
  total?: number
  nextCursor?: string
  facets?: SourceFacets
}

export interface SourceListEntry extends SourceDescriptor {
  enabled: boolean
  hasKey: boolean
  available: boolean
  unavailableReason?: string
}

export interface LibraryItem {
  id: string
  item: WallpaperItem
  fileName: string
  bytes: number
  sha256: string
  createdAt: number
  favorite: boolean
  width?: number
  height?: number
  /** 供界面展示；不授予页面文件访问能力。 */
  displayPath: string
  mediaType: MediaType
}

export type DownloadPhase = 'queued' | 'downloading' | 'verifying' | 'thumbnail' | 'done' | 'failed' | 'cancelled'

export interface DownloadProgress {
  jobId: string
  sourceId: string
  remoteId: string
  title: string
  phase: DownloadPhase
  receivedBytes?: number
  totalBytes?: number
  percent?: number
  message?: string
  libraryId?: string
}

export interface DownloadJobStart {
  jobId: string
}

export interface DisplayInfo {
  id: string
  index: number
  name: string
  width: number
  height: number
  primary: boolean
}

export interface StaticWallpaperCapabilities {
  supported: boolean
  platform: string
  session: string
  multiMonitor: boolean
  fits: WallpaperFit[]
  current: boolean
  reason?: string
}

export interface SetWallpaperRequest {
  libraryId?: string
  path?: string
  fit?: WallpaperFit
  displayIds?: string[]
}

export interface SetWallpaperResult {
  ok: boolean
  applied: Array<{ displayId: string; path: string }>
  message?: string
}

export interface CurrentWallpaper {
  displayId: string
  path: string
}

export type EngineDistribution = 'bundled' | 'archive' | 'installer' | 'package' | 'external'
export type EnginePlatform = 'win32' | 'darwin' | 'linux'

export interface EngineDescriptor {
  id: string
  name: string
  version: string
  description: string
  homepage: string
  license: string
  licenseUrl?: string
  distribution: EngineDistribution
  platforms: EnginePlatform[]
  mediaTypes: MediaType[]
  default?: boolean
  installHint?: string
}

export interface EngineDetection {
  supported: boolean
  installed: boolean
  detected: boolean
  version?: string
  executable?: string
  reason?: string
  installMethod?: string
}

export interface EngineCapabilities {
  mediaTypes: MediaType[]
  multipleMonitors: boolean
  perMonitorContent: boolean
  fpsLimit: boolean
  pauseOnFullscreen: boolean
  pauseOnBattery: boolean
  webContent: boolean
  requiresHelper: boolean
  notes?: string[]
}

export type EngineState = 'stopped' | 'starting' | 'running' | 'paused' | 'error'

export interface EngineStatus {
  state: EngineState
  engineId?: string
  sessionId?: string
  since?: number
  pauseReason?: string
  fps?: number
  pid?: number
  message?: string
}

export interface EngineSettings {
  fpsLimit: FpsLimit
  mute: boolean
  pauseOnFullscreen: boolean
  pauseOnBattery: boolean
  pauseOnLock: boolean
  lowPower: boolean
  quality: 'low' | 'medium' | 'high'
  videoQuality: VideoQuality
}

export interface EngineListItem {
  descriptor: EngineDescriptor
  detection: EngineDetection
  capabilities: EngineCapabilities
  active: boolean
  selected: boolean
  status: EngineStatus
  installedVersion?: string
  sizeBytes?: number
  canInstall: boolean
  canUninstall: boolean
}

export type EngineInstallPhase = 'queued' | 'download' | 'verify' | 'extract' | 'install' | 'done' | 'failed' | 'cancelled'

export interface EngineInstallProgress {
  engineId: string
  phase: EngineInstallPhase
  percent?: number
  receivedBytes?: number
  totalBytes?: number
  message?: string
}

export interface EngineInstallResult {
  ok: boolean
  version?: string
  path?: string
  message?: string
}

export interface EngineInstallStart {
  accepted: boolean
  engineId: string
}

export interface EngineInstallOutcome {
  engineId: string
  ok: boolean
  action?: 'install' | 'uninstall'
  result?: EngineInstallResult
  error?: string
}

export interface DynamicSpec {
  libraryId?: string
  url?: string
  sourceId?: string
  settings: EngineSettings
}

export interface EngineSession {
  sessionId: string
  engineId: string
  startedAt: number
  status: EngineStatus
}

export interface EngineDiagnostics {
  engineId: string
  supported: boolean
  installed: boolean
  executable?: string
  version?: string
  helperTarget?: string
  lines: string[]
}

export interface WallpaperCapabilities {
  platform: EnginePlatform
  arch: string
  session: string
  static: StaticWallpaperCapabilities
  displays: DisplayInfo[]
  engines: EngineListItem[]
  activeEngineId: string
  engineStatus: EngineStatus
}

export type RotationSource = 'library' | 'favorites'
export type RotationOrder = 'sequential' | 'random'

export interface RotationSettings {
  enabled: boolean
  intervalMinutes: number
  source: RotationSource
  order: RotationOrder
  fit: WallpaperFit
  includeDynamic: boolean
}

export interface RotationState {
  running: boolean
  nextAt?: number
  currentLibraryId?: string
  lastAppliedAt?: number
  appliedCount: number
  message?: string
}

export interface AppSettings {
  defaultFit: WallpaperFit
  backgroundEnabled: boolean
  libraryPath: string | null
  enabledSources: string[]
  sourceKeyRefs: Record<string, string>
  rotation: RotationSettings
  engineSettings: EngineSettings
  selectedEngineId: string
}

export interface BackgroundStatus {
  enabled: boolean
  rotation: RotationState
  engine: EngineStatus
  settings: AppSettings
  libraryPath: string | null
}

export interface DiagnosticsReport {
  platform: EnginePlatform
  arch: string
  node: string
  session: string
  dataRoot: string
  helperTarget: string
  helperInstalled: boolean
  helperPath?: string
  libraryPath: string | null
  libraryCount: number
  engines: Array<{ id: string; installed: boolean; detected: boolean; reason?: string }>
  notes: string[]
}

export interface ThumbRequest {
  sourceId: string
  url: string
  headers?: Record<string, string>
}

export interface ThumbResult {
  dataUrl: string | null
  bytes: number
  message?: string
}

export interface MediaPreviewRequest {
  sourceId: string
  remoteId: string
  previewUrl: string
  headers?: Record<string, string>
}

export interface MediaPreviewResult {
  dataUrl: string | null
  mediaType: MediaType
  width?: number
  height?: number
  message?: string
}

export interface VideoPreviewResult {
  url: string
  token: string
  poster?: string
}

export interface SourceKeyUpdate {
  sourceId: string
  secretRef: string
}

export interface LibraryFolderResult {
  path: string | null
  exists: boolean
  writable: boolean
  message?: string
}

export interface LibraryListResult {
  items: LibraryItem[]
  totalBytes: number
  folder: LibraryFolderResult
}

export interface EngineStartRequest {
  libraryId?: string
  url?: string
  settings?: Partial<EngineSettings>
}

export interface RotationUpdateRequest {
  patch: Partial<RotationSettings>
}

export interface EngineSelectRequest {
  engineId: string
}

export interface EngineSettingsRequest {
  settings: Partial<EngineSettings>
}

export interface LibraryRemoveRequest {
  id: string
  deleteFile: boolean
}

export interface LibraryFavoriteRequest {
  id: string
  favorite: boolean
}

export interface ImportUrlRequest {
  url: string
  title?: string
  mediaType?: MediaType
  author?: string
  license?: string
  sourceUrl?: string
}

export interface ImportLocalRequest {
  handleId: string
  title?: string
  mediaType?: MediaType
}

export interface SourceScriptInfo {
  id: string
  name: string
  version: string
  description?: string
  enabled: boolean
  mediaTypes: MediaType[]
  installedAt: number
  error?: string
}

export interface SourceScriptInstallRequest {
  source: 'file' | 'url'
  handleId?: string
  url?: string
}

export interface DiagnosticsLogRequest {
  limit?: number
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  fpsLimit: 30,
  mute: true,
  pauseOnFullscreen: true,
  pauseOnBattery: true,
  pauseOnLock: true,
  lowPower: false,
  quality: 'high',
  videoQuality: '1080p',
}

export const DEFAULT_ROTATION_SETTINGS: RotationSettings = {
  enabled: false,
  intervalMinutes: 60,
  source: 'library',
  order: 'sequential',
  fit: 'fill',
  includeDynamic: false,
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultFit: 'fill',
  backgroundEnabled: false,
  libraryPath: null,
  enabledSources: [],
  sourceKeyRefs: {},
  rotation: DEFAULT_ROTATION_SETTINGS,
  engineSettings: DEFAULT_ENGINE_SETTINGS,
  selectedEngineId: 'builtin-light',
}

export type WallpaperErrorCode =
  | 'BACKEND_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'SOURCE_UNKNOWN'
  | 'SOURCE_DISABLED'
  | 'SOURCE_KEY_REQUIRED'
  | 'SOURCE_REQUEST_FAILED'
  | 'SOURCE_RATE_LIMITED'
  | 'SOURCE_PARSE_FAILED'
  | 'LIBRARY_NOT_CONFIGURED'
  | 'LIBRARY_PATH_INVALID'
  | 'LIBRARY_FILE_MISSING'
  | 'DOWNLOAD_CANCELLED'
  | 'DOWNLOAD_FAILED'
  | 'WALLPAPER_UNSUPPORTED'
  | 'WALLPAPER_SET_FAILED'
  | 'ENGINE_UNKNOWN'
  | 'ENGINE_UNSUPPORTED'
  | 'ENGINE_NOT_INSTALLED'
  | 'ENGINE_INSTALL_FAILED'
  | 'ENGINE_START_FAILED'
  | 'ENGINE_SWITCH_FAILED'
  | 'ROTATION_INVALID'
  | 'SCRIPT_INVALID'
  | 'SCRIPT_FAILED'
  | 'PERMISSION_REQUIRED'
  | 'INTERNAL'

export interface WallpaperErrorShape {
  code: WallpaperErrorCode
  message: string
}

/** 后端把结构化错误编码进 Error.message；前端只解析前缀，不执行内容。 */
export function formatWallpaperError(code: WallpaperErrorCode, message: string): string {
  return `${code}: ${message}`
}

export function parseWallpaperError(value: unknown): WallpaperErrorShape {
  const raw = value instanceof Error ? value.message : String(value ?? '')
  const match = /^([A-Z][A-Z_]{2,}):\s*([\s\S]*)$/.exec(raw)
  if (match && match[1] && isWallpaperErrorCode(match[1])) {
    return { code: match[1], message: match[2] || raw }
  }
  return { code: 'INTERNAL', message: raw || '未知错误' }
}

export function isWallpaperErrorCode(value: string): value is WallpaperErrorCode {
  return WALLPAPER_ERROR_CODES.has(value as WallpaperErrorCode)
}

const WALLPAPER_ERROR_CODES = new Set<WallpaperErrorCode>([
  'BACKEND_UNAVAILABLE',
  'INVALID_ARGUMENT',
  'SOURCE_UNKNOWN',
  'SOURCE_DISABLED',
  'SOURCE_KEY_REQUIRED',
  'SOURCE_REQUEST_FAILED',
  'SOURCE_RATE_LIMITED',
  'SOURCE_PARSE_FAILED',
  'LIBRARY_NOT_CONFIGURED',
  'LIBRARY_PATH_INVALID',
  'LIBRARY_FILE_MISSING',
  'DOWNLOAD_CANCELLED',
  'DOWNLOAD_FAILED',
  'WALLPAPER_UNSUPPORTED',
  'WALLPAPER_SET_FAILED',
  'ENGINE_UNKNOWN',
  'ENGINE_UNSUPPORTED',
  'ENGINE_NOT_INSTALLED',
  'ENGINE_INSTALL_FAILED',
  'ENGINE_START_FAILED',
  'ENGINE_SWITCH_FAILED',
  'ROTATION_INVALID',
  'SCRIPT_INVALID',
  'SCRIPT_FAILED',
  'PERMISSION_REQUIRED',
  'INTERNAL',
])

export function isMediaType(value: string): value is MediaType {
  return (MEDIA_TYPES as readonly string[]).includes(value)
}

export function isWallpaperFit(value: string): value is WallpaperFit {
  return (WALLPAPER_FITS as readonly string[]).includes(value)
}

export function isEnginePlatform(value: string): value is EnginePlatform {
  return value === 'win32' || value === 'darwin' || value === 'linux'
}

export function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function selectVideoVariant(item: Pick<WallpaperItem, 'variants' | 'fullUrl'>, quality: VideoQuality): string {
  const variants = item.variants?.filter(variant => variant.url) ?? []
  if (!variants.length) return item.fullUrl
  if (quality === 'original') {
    return [...variants].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]?.url ?? item.fullUrl
  }
  const limit = quality === '720p' ? 720 : 1080
  const fitting = variants
    .filter(variant => variant.height && variant.height <= limit)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
  if (fitting[0]) return fitting[0].url
  return [...variants].sort((a, b) => (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER))[0]?.url ?? item.fullUrl
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0 || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function resolutionLabel(item: Pick<WallpaperItem, 'width' | 'height'>): string {
  if (!item.width || !item.height) return '—'
  return `${item.width} × ${item.height}`
}
