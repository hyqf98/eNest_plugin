import type { SourceDescriptor, SourceFilters, SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'

export interface SourceContext {
  signal: AbortSignal
  key: string | null
  log(message: string): void
}

export interface ResolvedAsset {
  url: string
  headers?: Record<string, string>
}

export interface SourceAdapter {
  descriptor: SourceDescriptor
  search(query: SourceQuery, context: SourceContext): Promise<SourcePage>
  detail?(remoteId: string, context: SourceContext): Promise<WallpaperItem | null>
  resolve?(item: WallpaperItem, context: SourceContext): Promise<ResolvedAsset>
}

export function filtersOf(query: SourceQuery): SourceFilters {
  return query.filters && typeof query.filters === 'object' ? query.filters : {}
}

export function filterString(filters: SourceFilters, key: string, fallback = ''): string {
  const value = filters[key]
  return typeof value === 'string' ? value : fallback
}

export function filterNumber(filters: SourceFilters, key: string, fallback: number): number {
  const value = filters[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

export function filterBoolean(filters: SourceFilters, key: string, fallback = false): boolean {
  const value = filters[key]
  return typeof value === 'boolean' ? value : fallback
}

export function filterList(filters: SourceFilters, key: string): string[] {
  const value = filters[key]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (typeof value === 'string' && value) return [value]
  return []
}

export function pageNumber(query: SourceQuery): number {
  const page = Number(query.page)
  return Number.isSafeInteger(page) && page > 0 ? page : 1
}

export function pageSize(query: SourceQuery, fallback = 24, max = 60): number {
  const size = Number(query.perPage)
  return Number.isSafeInteger(size) && size > 0 ? Math.min(max, size) : fallback
}

export function buildUrl(base: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

export function normalizeRemoteId(value: string | number): string {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

export function displayResolution(width?: number, height?: number): string {
  return width && height ? `${width} × ${height}` : '未知分辨率'
}

export function requireSourceKey(context: SourceContext): string {
  if (!context.key) throw new Error('SOURCE_KEY_REQUIRED: 此数据源需要 API Key，请在设置中填写')
  return context.key
}
