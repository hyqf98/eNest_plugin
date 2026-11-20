/**
 * tvbox 配置层：TVBox/影视仓配置 JSON 的加载、多仓（urls）拆分、历史管理、内置 preset。
 * 存储（宿主 KV）：
 *  - `configs.index`   [{id,name,url,addedAt}]
 *  - `config.<id>`     规范化后的配置（sites/parses/lives/spider/wallpaper/notice/urls）
 *  - `configs.current` 当前启用配置 id
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchJson, rawFetch, MAX_CONFIG_BYTES } from './net'
import { asArray } from './shared'
import type { LiveGroup, ParseMeta, SiteMeta } from './types'

export interface TvboxConfigRaw {
  spider?: string
  wallpaper?: string
  logo?: string
  notice?: string
  msg?: string
  flags?: string[]
  sites?: unknown[]
  parses?: unknown[]
  lives?: unknown[]
  urls?: Array<{ name?: string; url?: string }>
  rules?: unknown[]
  hosts?: string[]
  headers?: Record<string, Record<string, string>>
  ads?: string[]
  proxy?: unknown[]
  danmaku?: string
}

export interface TvboxConfig {
  spider?: string
  wallpaper?: string
  logo?: string
  notice?: string
  flags: string[]
  sites: SiteMeta[]
  parses: ParseMeta[]
  lives: unknown[]
  urls: Array<{ name: string; url: string }>
  rules: unknown[]
  hosts: string[]
  headers: Record<string, Record<string, string>>
}

export interface ConfigRecord { id: string; name: string; url: string; addedAt: number }

export interface ConfigStore {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
}

/* ---------------- 归一化 ---------------- */
function normalizeSite(raw: unknown): SiteMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (typeof s.key !== 'string' || !s.key || typeof s.name !== 'string' || !s.name) return null
  if (s.key === 'push_agent' || s.key === 'local_file') return null   // 保留键：桌面端无对应功能
  const type = Number(s.type ?? 0)
  if (![0, 1, 3, 4].includes(type)) return null
  return {
    key: s.key,
    name: s.name,
    type,
    api: String(s.api ?? ''),
    ext: typeof s.ext === 'string' ? s.ext : s.ext && typeof s.ext === 'object' ? JSON.stringify(s.ext) : undefined,
    jar: typeof s.jar === 'string' ? s.jar : undefined,
    searchable: Number(s.searchable ?? 1),
    quickSearch: Number(s.quickSearch ?? 1),
    changeable: Number(s.changeable ?? 1),
    hide: Number(s.hide ?? 0),
    timeout: s.timeout ? Number(s.timeout) : undefined,
    playUrl: typeof s.playUrl === 'string' ? s.playUrl : undefined,
    header: s.header && typeof s.header === 'object'
      ? Object.fromEntries(Object.entries(s.header as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined,
    categories: Array.isArray(s.categories) ? s.categories.map(String) : undefined,
  }
}
function normalizeParse(raw: unknown): ParseMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.url !== 'string' || !p.url) return null
  return {
    name: String(p.name ?? '解析'),
    type: Number(p.type ?? 0),
    url: p.url,
    ext: p.ext && typeof p.ext === 'object' ? {
      flag: Array.isArray((p.ext as any).flag) ? (p.ext as any).flag.map(String) : undefined,
      header: (p.ext as any).header && typeof (p.ext as any).header === 'object'
        ? Object.fromEntries(Object.entries((p.ext as any).header).map(([k, v]) => [k, String(v)])) : undefined,
    } : undefined,
  }
}

export function normalizeConfig(raw: TvboxConfigRaw): TvboxConfig {
  return {
    spider: typeof raw.spider === 'string' ? raw.spider : undefined,
    wallpaper: typeof raw.wallpaper === 'string' ? raw.wallpaper : undefined,
    logo: typeof raw.logo === 'string' ? raw.logo : undefined,
    notice: typeof raw.notice === 'string' ? raw.notice : undefined,
    flags: asArray<string>(raw.flags).map(String),
    sites: asArray(raw.sites).map(normalizeSite).filter((s): s is SiteMeta => !!s),
    parses: asArray(raw.parses).map(normalizeParse).filter((p): p is ParseMeta => !!p),
    lives: asArray(raw.lives),
    urls: asArray(raw.urls)
      .filter(u => u && typeof u === 'object' && typeof (u as any).url === 'string' && (u as any).url)
      .map(u => ({ name: String((u as any).name ?? (u as any).url), url: String((u as any).url) })),
    rules: asArray(raw.rules),
    hosts: asArray<string>(raw.hosts).map(String),
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
  }
}

/* ---------------- 配置获取（URL/文本/preset） ---------------- */
export function parseConfigText(text: string): TvboxConfigRaw {
  const trimmed = text.trim()
  // 加密配置（2423 开头的 base64 变体）不支持，直接抛错让界面明示
  try {
    return JSON.parse(trimmed) as TvboxConfigRaw
  } catch {
    throw new Error('配置不是合法 JSON（加密配置暂不支持）')
  }
}

export async function fetchConfigFromUrl(url: string): Promise<TvboxConfigRaw> {
  const res = await rawFetch(url, { headers: { accept: 'application/json,text/plain,*/*' }, maxBytes: MAX_CONFIG_BYTES })
  if (res.status >= 400) throw new Error(`配置拉取失败 HTTP ${res.status}`)
  return parseConfigText(res.body)
}

/** 内置 preset 目录（后端私有 runtime/presets/） */
export function presetsDir(packagePath: string): string {
  return join(packagePath, 'runtime', 'presets')
}

export async function readPreset(packagePath: string): Promise<{ raw: TvboxConfigRaw; name: string } | null> {
  const file = join(presetsDir(packagePath), 'preset.json')
  try {
    const text = await readFile(file, 'utf-8')
    const raw = parseConfigText(text)
    const name = asArray<any>(raw.sites).length
      ? '默认数据源（' + asArray<any>(raw.sites).slice(0, 3).map((s: any) => String(s?.name ?? '')).join(' / ') + (asArray<any>(raw.sites).length > 3 ? ' 等' : '') + '）'
      : '默认数据源'
    return { raw, name }
  } catch {
    return null
  }
}

/** preset 的 lives 若引用 ./xxx.txt 相对文件，读出来内联 */
export async function readPresetLive(packagePath: string, url: string): Promise<string | null> {
  if (!url.startsWith('./')) return null
  try {
    return await readFile(join(presetsDir(packagePath), url.slice(2)), 'utf-8')
  } catch {
    return null
  }
}

export async function listRuntimeFiles(packagePath: string): Promise<string[]> {
  try {
    return (await readdir(presetsDir(packagePath))).sort()
  } catch {
    return []
  }
}

/* ---------------- 历史管理 ---------------- */
export async function loadConfigIndex(store: ConfigStore): Promise<ConfigRecord[]> {
  const value = await store.get<ConfigRecord[]>('configs.index')
  return Array.isArray(value) ? value : []
}
export async function saveConfigIndex(store: ConfigStore, list: ConfigRecord[]): Promise<void> {
  await store.set('configs.index', list)
}
export async function loadConfig(store: ConfigStore, id: string): Promise<TvboxConfig | null> {
  const value = await store.get<TvboxConfig>(`config.${id}`)
  return value && typeof value === 'object' && Array.isArray(value.sites) ? value : null
}
export async function saveConfig(store: ConfigStore, id: string, config: TvboxConfig): Promise<void> {
  await store.set(`config.${id}`, config)
}
export async function loadCurrentId(store: ConfigStore): Promise<string | null> {
  return await store.get<string>('configs.current')
}
export async function saveCurrentId(store: ConfigStore, id: string): Promise<void> {
  await store.set('configs.current', id)
}
