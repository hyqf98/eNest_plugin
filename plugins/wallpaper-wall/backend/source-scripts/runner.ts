import { createHash } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'
import type {
  MediaType,
  SourceDescriptor,
  SourceFacets,
  SourcePage,
  SourceQuery,
  SourceScriptInfo,
  WallpaperItem,
} from '@backend/contracts'
import { MEDIA_TYPES } from '@backend/contracts'
import { fetchJson, fetchText } from '@backend/net'
import { ensurePluginPaths, pluginPaths } from '@backend/paths'
import { resolveFileHandle, storageGet, storageSet } from '@backend/runtime'
import { loadSettings, updateSettings } from '@backend/store'
import { asRecord, errorMessage, fail, isHttpUrl, isSafeRelativePath, requireString, withTimeout } from '@backend/util'
import { registerScriptAdapter, unregisterScriptAdapter } from '../sources/registry'
import type { SourceAdapter, SourceContext } from '../sources/types'
import { buildUrl, decodeEntities, stripHtml } from '../sources/types'

const META_KEY = 'source.scripts'
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
const SCRIPT_TIMEOUT_MS = 5_000
const SEARCH_TIMEOUT_MS = 25_000

interface ScriptMeta {
  id: string
  name: string
  version: string
  description?: string
  mediaTypes: MediaType[]
  enabled: boolean
  installedAt: number
  file: string
  error?: string
}

interface ScriptModule {
  id?: unknown
  name?: unknown
  version?: unknown
  description?: unknown
  mediaTypes?: unknown
  requiresKey?: unknown
  keyLabel?: unknown
  keyUrl?: unknown
  facets?: unknown
  search?: unknown
  detail?: unknown
  resolve?: unknown
}

export async function listSourceScripts(): Promise<SourceScriptInfo[]> {
  const meta = await loadMeta()
  return meta.map(entry => ({
    id: entry.id,
    name: entry.name,
    version: entry.version,
    description: entry.description,
    enabled: entry.enabled,
    mediaTypes: entry.mediaTypes,
    installedAt: entry.installedAt,
    error: entry.error,
  }))
}

export async function loadInstalledScripts(): Promise<void> {
  const meta = await loadMeta()
  for (const entry of meta) {
    if (!entry.enabled) continue
    try {
      const code = await readFile(join(pluginPaths().scripts, entry.file), 'utf8')
      const adapter = createAdapter(code, entry)
      await registerScriptAdapter(adapter)
    } catch (error) {
      entry.error = errorMessage(error)
    }
  }
  await saveMeta(meta)
}

export async function installSourceScript(input: { source: 'file' | 'url'; handleId?: string; url?: string }): Promise<SourceScriptInfo> {
  await ensurePluginPaths()
  let code: string
  if (input.source === 'url') {
    const url = requireString(input.url, 'url', 8192)
    if (!isHttpUrl(url)) fail('SCRIPT_INVALID', '源脚本 URL 必须是 http(s)')
    code = await fetchText(url, { maxBytes: MAX_SCRIPT_BYTES, timeoutMs: 20_000 })
  } else {
    const handleId = requireString(input.handleId, 'handleId', 256)
    const path = await resolveFileHandle(handleId, 'read')
    code = await readFile(path, 'utf8')
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) fail('SCRIPT_INVALID', '源脚本超过 2MB')
  const parsed = parseScript(code)
  const id = requireString(parsed.id, 'id', 80)
  if (!/^[A-Za-z0-9._-]{2,80}$/.test(id)) fail('SCRIPT_INVALID', '源脚本 id 只能包含字母、数字、点、下划线与短横线')
  const name = requireString(parsed.name, 'name', 120)
  const version = typeof parsed.version === 'string' ? parsed.version.slice(0, 40) : '1.0.0'
  const mediaTypes = validateMediaTypes(parsed.mediaTypes)
  const meta = await loadMeta()
  const existing = meta.find(entry => entry.id === id)
  if (existing) await unregisterScriptAdapter(id)
  const file = `${createHash('sha256').update(code).digest('hex').slice(0, 16)}-${id}.js`
  await writeFile(join(pluginPaths().scripts, file), code, 'utf8')
  const next: ScriptMeta = {
    id,
    name,
    version,
    description: typeof parsed.description === 'string' ? parsed.description.slice(0, 500) : undefined,
    mediaTypes,
    enabled: true,
    installedAt: Date.now(),
    file,
  }
  const updated = [...meta.filter(entry => entry.id !== id), next]
  await saveMeta(updated)
  const adapter = createAdapter(code, next)
  await registerScriptAdapter(adapter)
  const settings = await loadSettings()
  await updateSettings({ enabledSources: [...new Set([...settings.enabledSources, id])] })
  return { id, name, version, description: next.description, enabled: true, mediaTypes, installedAt: next.installedAt }
}

export async function uninstallSourceScript(id: string): Promise<void> {
  const meta = await loadMeta()
  const entry = meta.find(item => item.id === id)
  if (!entry) return
  await unregisterScriptAdapter(id)
  await saveMeta(meta.filter(item => item.id !== id))
  await unlink(join(pluginPaths().scripts, entry.file)).catch(() => {})
  const settings = await loadSettings()
  await updateSettings({ enabledSources: settings.enabledSources.filter(sourceId => sourceId !== id) })
}

export async function setSourceScriptEnabled(id: string, enabled: boolean): Promise<void> {
  const meta = await loadMeta()
  const entry = meta.find(item => item.id === id)
  if (!entry) fail('SCRIPT_INVALID', '源脚本不存在')
  entry.enabled = enabled
  await saveMeta(meta)
  const settings = await loadSettings()
  const enabledSources = enabled
    ? [...new Set([...settings.enabledSources, id])]
    : settings.enabledSources.filter(sourceId => sourceId !== id)
  await updateSettings({ enabledSources })
  if (enabled) {
    const code = await readFile(join(pluginPaths().scripts, entry.file), 'utf8')
    try {
      await registerScriptAdapter(createAdapter(code, entry))
    } catch (error) {
      entry.error = errorMessage(error)
      await saveMeta(meta)
      fail('SCRIPT_FAILED', entry.error)
    }
  } else {
    await unregisterScriptAdapter(id)
  }
}

function createAdapter(code: string, meta: ScriptMeta): SourceAdapter {
  const module = parseScript(code)
  const descriptor: SourceDescriptor = {
    id: meta.id,
    name: meta.name,
    description: typeof module.description === 'string' ? module.description : meta.description,
    mediaTypes: meta.mediaTypes,
    requiresKey: module.requiresKey === true,
    keyLabel: typeof module.keyLabel === 'string' ? module.keyLabel : undefined,
    keyUrl: typeof module.keyUrl === 'string' && isHttpUrl(module.keyUrl) ? module.keyUrl : undefined,
    builtin: false,
    enabledByDefault: false,
    supportsSearch: true,
    supportsPagination: true,
    facets: normalizeFacets(module.facets),
  }
  return {
    descriptor,
    async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
      if (typeof module.search !== 'function') fail('SCRIPT_INVALID', '源脚本缺少 search 函数')
      const sandbox = createSandbox(context)
      const result = await withTimeout(
        Promise.resolve().then(() => (module.search as ScriptSearch)(query, {
          key: context.key,
          signal: context.signal,
          http: sandbox.http,
          parseHtml: sandbox.parseHtml,
          utils: sandbox.utils,
          log: context.log,
        })),
        SEARCH_TIMEOUT_MS,
        '源脚本搜索超时',
      )
      return normalizePage(result, meta.id)
    },
    async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
      if (typeof module.detail !== 'function') return null
      const sandbox = createSandbox(context)
      const result = await withTimeout(
        Promise.resolve().then(() => (module.detail as ScriptDetail)(remoteId, {
          key: context.key,
          signal: context.signal,
          http: sandbox.http,
          parseHtml: sandbox.parseHtml,
          utils: sandbox.utils,
          log: context.log,
        })),
        SEARCH_TIMEOUT_MS,
        '源脚本详情超时',
      )
      return result ? normalizeItem(result, meta.id) : null
    },
    async resolve(item: WallpaperItem, context: SourceContext) {
      if (typeof module.resolve !== 'function') return { url: item.fullUrl }
      const sandbox = createSandbox(context)
      const result = await withTimeout(
        Promise.resolve().then(() => (module.resolve as ScriptResolve)(item, {
          key: context.key,
          signal: context.signal,
          http: sandbox.http,
          parseHtml: sandbox.parseHtml,
          utils: sandbox.utils,
          log: context.log,
        })),
        SEARCH_TIMEOUT_MS,
        '源脚本解析超时',
      )
      const record = asRecord(result)
      if (!record || typeof record.url !== 'string' || !isHttpUrl(record.url)) fail('SCRIPT_INVALID', '源脚本 resolve 必须返回 http(s) url')
      return { url: record.url }
    },
  }
}

interface ScriptSearch {
  (query: SourceQuery, context: ScriptContext): unknown
}
interface ScriptDetail {
  (remoteId: string, context: ScriptContext): unknown
}
interface ScriptResolve {
  (item: WallpaperItem, context: ScriptContext): unknown
}
interface ScriptContext {
  key: string | null
  signal: AbortSignal
  http: ScriptHttp
  parseHtml: (html: string) => unknown
  utils: ScriptUtils
  log: (message: string) => void
}
interface ScriptHttp {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>
  getText(url: string, headers?: Record<string, string>): Promise<string>
}
interface ScriptUtils {
  buildUrl: typeof buildUrl
  stripHtml: typeof stripHtml
  decodeEntities: typeof decodeEntities
  absoluteUrl(base: string, value: string): string
}

function createSandbox(context: SourceContext): { http: ScriptHttp; parseHtml: (html: string) => unknown; utils: ScriptUtils } {
  const http: ScriptHttp = {
    async getJson(url, headers) {
      if (!isHttpUrl(url)) fail('SCRIPT_INVALID', '源脚本请求了非 http(s) URL')
      return fetchJson(url, { headers, signal: context.signal, maxBytes: 8 * 1024 * 1024 })
    },
    async getText(url, headers) {
      if (!isHttpUrl(url)) fail('SCRIPT_INVALID', '源脚本请求了非 http(s) URL')
      return fetchText(url, { headers, signal: context.signal, maxBytes: 8 * 1024 * 1024 })
    },
  }
  return {
    http,
    parseHtml: html => parseHTML(typeof html === 'string' ? html : String(html)).document,
    utils: {
      buildUrl,
      stripHtml,
      decodeEntities,
      absoluteUrl(base, value) {
        try {
          return new URL(value, base).toString()
        } catch {
          return value
        }
      },
    },
  }
}

function parseScript(code: string): ScriptModule {
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) fail('SCRIPT_INVALID', '源脚本超过 2MB')
  try {
    const context = vm.createContext({ URL, URLSearchParams })
    const wrapper = new vm.Script(`(function(){ const module = { exports: {} }; const exports = module.exports; ${code}\n; return module.exports; })()`, {
      filename: 'wallpaper-source.js',
    })
    const exported = wrapper.runInContext(context, { timeout: SCRIPT_TIMEOUT_MS })
    if (!exported || typeof exported !== 'object') fail('SCRIPT_INVALID', '源脚本必须导出对象')
    return exported as ScriptModule
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SCRIPT_')) throw error
    fail('SCRIPT_INVALID', `源脚本执行失败：${errorMessage(error)}`)
  }
}

function validateMediaTypes(value: unknown): MediaType[] {
  if (!Array.isArray(value)) return ['image']
  const types = value.filter((entry): entry is MediaType => typeof entry === 'string' && (MEDIA_TYPES as readonly string[]).includes(entry))
  return types.length ? [...new Set(types)] : ['image']
}

function normalizeFacets(value: unknown): SourceFacets {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.items)) return { items: [] }
  const items = record.items
    .map(item => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter(item => typeof item.key === 'string' && typeof item.label === 'string' && typeof item.type === 'string')
    .slice(0, 20)
  return { items: items as unknown as SourceFacets['items'] }
}

function normalizePage(value: unknown, sourceId: string): SourcePage {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.items)) fail('SCRIPT_INVALID', '源脚本 search 必须返回 { items: [] }')
  const items = record.items.map(item => normalizeItem(item, sourceId)).filter((item): item is WallpaperItem => Boolean(item)).slice(0, 60)
  const page = Number(record.page)
  return {
    items,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    hasMore: record.hasMore === true,
    total: Number.isFinite(Number(record.total)) ? Number(record.total) : undefined,
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor.slice(0, 256) : undefined,
  }
}

function normalizeItem(value: unknown, sourceId: string): WallpaperItem | null {
  const record = asRecord(value)
  if (!record) return null
  const remoteId = typeof record.remoteId === 'string' ? record.remoteId.slice(0, 120) : ''
  const title = typeof record.title === 'string' ? record.title.slice(0, 240) : ''
  const mediaType = typeof record.mediaType === 'string' && (MEDIA_TYPES as readonly string[]).includes(record.mediaType)
    ? record.mediaType as MediaType
    : 'image'
  const thumbUrl = typeof record.thumbUrl === 'string' && isHttpUrl(record.thumbUrl) ? record.thumbUrl : ''
  const previewUrl = typeof record.previewUrl === 'string' && isHttpUrl(record.previewUrl) ? record.previewUrl : thumbUrl
  const fullUrl = typeof record.fullUrl === 'string' && isHttpUrl(record.fullUrl) ? record.fullUrl : previewUrl
  if (!remoteId || !thumbUrl || !fullUrl) return null
  return {
    sourceId,
    remoteId,
    title: title || remoteId,
    mediaType,
    thumbUrl,
    previewUrl,
    fullUrl,
    width: positive(record.width),
    height: positive(record.height),
    fileSize: positive(record.fileSize),
    mime: typeof record.mime === 'string' ? record.mime.slice(0, 120) : undefined,
    author: text(record.author, 240),
    authorUrl: text(record.authorUrl, 2048),
    license: text(record.license, 240),
    licenseUrl: text(record.licenseUrl, 2048),
    sourceUrl: text(record.sourceUrl, 2048),
    attribution: text(record.attribution, 1024),
    color: typeof record.color === 'string' && /^#[0-9a-f]{6}$/i.test(record.color) ? record.color : undefined,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 32) : undefined,
    durationMs: positive(record.durationMs),
    downloadAllowed: record.downloadAllowed !== false,
    exportAllowed: record.exportAllowed === true,
  }
}

function positive(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined
}

function text(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, maxLength) : undefined
}

async function loadMeta(): Promise<ScriptMeta[]> {
  try {
    const raw = await storageGet(META_KEY)
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeMeta).filter((entry): entry is ScriptMeta => Boolean(entry))
  } catch {
    return []
  }
}

async function saveMeta(meta: ScriptMeta[]): Promise<void> {
  await storageSet(META_KEY, meta.map(entry => {
    const value: Record<string, unknown> = {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      mediaTypes: entry.mediaTypes,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      file: entry.file,
    }
    if (entry.description) value.description = entry.description
    if (entry.error) value.error = entry.error
    return value
  }))
}

function normalizeMeta(value: unknown): ScriptMeta | null {
  const record = asRecord(value)
  if (!record) return null
  const id = typeof record.id === 'string' ? record.id : ''
  const file = typeof record.file === 'string' ? record.file : ''
  if (!id || !file || !isSafeRelativePath(file)) return null
  return {
    id,
    name: typeof record.name === 'string' ? record.name : id,
    version: typeof record.version === 'string' ? record.version : '1.0.0',
    description: typeof record.description === 'string' ? record.description : undefined,
    mediaTypes: validateMediaTypes(record.mediaTypes),
    enabled: record.enabled !== false,
    installedAt: Number(record.installedAt) || Date.now(),
    file,
    error: typeof record.error === 'string' ? record.error.slice(0, 500) : undefined,
  }
}
