/**
 * tvbox 后端 —— utilityProcess 入口。
 * 职责：TVBox/影视仓配置源加载（多仓 urls/内置 preset）、站点适配调度
 * （type0/1 采集站 + type3 JS Spider 沙箱 + type4）、跨站搜索、播放决策
 * （直链/解析）、媒体回环代理（m3u8 改写 + 流转发）、直播源解析。
 *
 * 存储模型（host.request storage，宿主统一插件 KV）：
 *  - `configs.index`     配置历史 [{id,name,url,addedAt}]
 *  - `config.<id>`       规范化配置（sites/parses/lives/spider/...）
 *  - `configs.current`   当前配置 id
 *  - `sites.disabled`    用户禁用的站点 key 列表（按配置 id 分组存）
 *  - `ext.cache.<sha1>`  spider 运行时/规则脚本缓存
 *  - `cookies.jar`       按 ownerKey（站点 key）隔离的 cookie
 *
 * 安全约定：
 *  - Spider 脚本在 node:vm 隔离上下文执行，无 require/process/fs/import；
 *  - 所有出网由后端真实 fetch 代发（超时/体积/并发上限）；
 *  - 慢调用一律 withTimeout 墙钟限时；unhandledRejection 进程级兜底。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeUrl, setupProxy, fetchJson } from './net'
import { rawFetch, exportCookieJar, importCookieJar, onCookiePersist, MAX_CONFIG_BYTES, MAX_MEDIA_BYTES, cookieHeaderFor } from './net'
import { asArray, plain, withTimeout } from './shared'
import {
  fetchConfigFromUrl, loadConfig, loadConfigIndex, loadCurrentId, normalizeConfig,
  readPreset, readPresetLive, saveConfig, saveConfigIndex, saveCurrentId,
  type ConfigStore, type TvboxConfig, type TvboxConfigRaw,
} from './config'
import { createCmsClient, defaultFilters } from './cms'
import { instantiateSpider, type SpiderDeps, type SpiderInstance } from './spider'
import { loadLiveSource, normalizeLiveSources, parseLiveGroupsInline, parseLiveM3u, parseLiveTxt } from './live'
import { fileToVodItem, formatSize, getFileRawUrl, isVideoFile, listFiles, loginPageUrl, probeOpenList, searchFiles, verifyToken, type OpenListAccount } from './openlist'
import { gatherFromSites, interleaveMerge, sectionOf, SECTION_SUBTYPES, STANDARD_SECTIONS, type AggregateVod } from './aggregate'
import { proxyMediaUrl, proxyImageUrl, startMediaProxy, stopMediaProxy } from './mediaProxy'
import type { CategoryPage, FilterGroup, PlayResult, SiteMeta, TypeItem, VodDetail, VodItem } from './types'

type Request = {
  type?: string
  id?: number
  pluginId?: string
  generation?: number
  method?: string
  args?: unknown[]
}
interface ParentPort {
  on(event: 'message', listener: (message: { data: Request & { ok?: boolean; data?: unknown; error?: string } }) => void): void
  postMessage(message: unknown): void
}
const maybePort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!maybePort) throw new Error('This entry requires the eNest utility process')
const port: ParentPort = maybePort

let owner: string | undefined
let packagePath = ''

setupProxy()

/* ---------------- 进程级兜底（spider 脚本第三方代码） ---------------- */
process.on('unhandledRejection', reason => {
  console.warn('[tvbox] unhandled rejection from spider script:', reason instanceof Error ? reason.message : String(reason))
})
process.on('uncaughtException', error => {
  console.error('[tvbox] uncaught exception from spider script:', error instanceof Error ? error.stack : String(error))
})

/* ---------------- 宿主控制通道 ---------------- */
interface PendingHost { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const HOST_TIMEOUT_MS = 30_000
let hostSequence = 0
const hostControls = new Map<number, PendingHost>()

function assertReady(): void {
  if (!owner) throw new Error('后端尚未就绪，请稍后重试')
}
function hostRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  assertReady()
  if (hostControls.size >= 64) return Promise.reject(new Error('后端控制请求过多，请稍后重试'))
  const id = ++hostSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { hostControls.delete(id); reject(new Error('宿主控制请求超时')) }, HOST_TIMEOUT_MS)
    timer.unref()
    hostControls.set(id, { resolve, reject, timer })
    try {
      port.postMessage({ type: 'host.request', id, method, params })
    } catch (error) {
      hostControls.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
/** JSON 洗涤：去掉 undefined 值与符号键（宿主 serializeJson 拒绝非纯 JSON，undefined 会抛 storage requires finite JSON data） */
function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => jsonSafe(v)) as T
  if (value && typeof value === 'object') {
    if (Object.getOwnPropertySymbols(value).length) return value   // 符号键只出现在运行态对象，不会入库
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k] = jsonSafe(v)
    }
    return out as T
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 0 as T
  return value
}

const store: ConfigStore = {
  get: async <T,>(key: string) => (await hostRequest('storage.get', { key })) as T | null,
  set: async (key: string, value: unknown) => { await hostRequest('storage.set', { key, value: value === null ? null : jsonSafe(value) }) },
}
/* cookie 持久化钩子（net.ts 写 jar 后异步落盘） */
let cookiePersistTimer: ReturnType<typeof setTimeout> | null = null
onCookiePersist(() => {
  if (cookiePersistTimer) return
  cookiePersistTimer = setTimeout(() => {
    cookiePersistTimer = null
    void store.set('cookies.jar', exportCookieJar()).catch(() => {})
  }, 300)
  cookiePersistTimer.unref?.()
})

/* ---------------- ext/脚本缓存（spider 运行时与规则） ---------------- */
const extMemCache = new Map<string, string>()
async function fetchTextCached(url: string): Promise<string> {
  const key = createHash('sha1').update(url).digest('hex')
  if (extMemCache.has(key)) return extMemCache.get(key)!
  const diskKey = `ext.cache.${key}`
  const disk = await store.get<string>(diskKey)
  if (typeof disk === 'string' && disk) { extMemCache.set(key, disk); return disk }
  const res = await rawFetch(normalizeUrl(url), { headers: { accept: '*/*' }, maxBytes: MAX_CONFIG_BYTES * 2 })
  if (res.status >= 400) throw new Error(`脚本下载失败 HTTP ${res.status}`)
  extMemCache.set(key, res.body)
  void store.set(diskKey, res.body).catch(() => {})
  return res.body
}

/* ---------------- 当前配置态 ---------------- */
let currentConfig: TvboxConfig | null = null
let currentConfigId = ''
/** 配置源地址（相对路径解析基） */
let configBaseUrl = ''

const spiderInstances = new Map<string, SpiderInstance>()
const siteErrors = new Map<string, string>()

/** 配置加载与站点缓存失效 */
function invalidateSites(): void {
  for (const inst of spiderInstances.values()) { try { inst.dispose() } catch { /* best effort */ } }
  spiderInstances.clear()
  siteErrors.clear()
}

async function ensureCurrentConfig(): Promise<TvboxConfig> {
  if (currentConfig) return currentConfig
  const id = await loadCurrentId(store)
  if (id) {
    const config = await loadConfig(store, id)
    if (config) {
      // 内置 preset 升级：preset 内容与缓存不一致时自动重装载（否则插件更新后仍是旧站点缓存）
      if (id === 'preset-builtin' && packagePath) {
        const preset = await readPreset(packagePath).catch(() => null)
        if (preset) {
          const fresh = normalizeConfig(preset.raw)
          const oldKeys = config.sites.map(s => s.key).join(',')
          const newKeys = fresh.sites.map(s => s.key).join(',')
          if (oldKeys !== newKeys) {
            await saveConfig(store, id, fresh)
            const disabledAll = await store.get<Record<string, string[]>>('sites.disabled') ?? {}
            delete disabledAll[id]
            await store.set('sites.disabled', disabledAll)
            const index = await loadConfigIndex(store)
            if (!index.some(r => r.id === id)) await saveConfigIndex(store, [{ id, name: preset.name, url: '', addedAt: Date.now() }, ...index])
            currentConfig = fresh
            currentConfigId = id
            configBaseUrl = ''
            console.log('[tvbox] builtin preset refreshed:', newKeys)
            return fresh
          }
        }
      }
      currentConfig = config
      currentConfigId = id
      const record = (await loadConfigIndex(store)).find(r => r.id === id)
      configBaseUrl = record?.url ?? ''
      return config
    }
  }
  // 无配置：自动装载内置 preset（保开箱可用）
  if (packagePath) {
    const preset = await readPreset(packagePath)
    if (preset) {
      const id = 'preset-builtin'
      const config = normalizeConfig(preset.raw)
      await saveConfig(store, id, config)
      await saveConfigIndex(store, [{ id, name: preset.name, url: '', addedAt: Date.now() }])
      await saveCurrentId(store, id)
      currentConfig = config
      currentConfigId = id
      configBaseUrl = ''
      return config
    }
  }
  throw new Error('尚未导入配置源：请先在配置页添加影视仓配置地址')
}

/** 配置里的 urls 多仓：加载入口地址时发现 urls 数组则登记为线路 */
async function importConfigFromRaw(raw: TvboxConfigRaw, url: string, nameHint: string): Promise<{ id: string; depot: Array<{ name: string; url: string }> }> {
  const normalized = normalizeConfig(raw)
  if (normalized.urls.length && !normalized.sites.length) {
    // 纯多仓入口：不作为可加载配置，返回线路列表
    return { id: '', depot: normalized.urls }
  }
  const id = `cfg-${createHash('sha1').update(url || JSON.stringify(normalized.sites.slice(0, 3))).digest('hex').slice(0, 10)}`
  const index = await loadConfigIndex(store)
  const record = { id, name: nameHint || url || '本地配置', url, addedAt: Date.now() }
  const next = [record, ...index.filter(r => r.id !== id)]
  await saveConfigIndex(store, next)
  await saveConfig(store, id, normalized)
  return { id, depot: normalized.urls }
}

/* ---------------- 站点适配调度 ---------------- */
function findSite(key: string): SiteMeta {
  const config = currentConfig ?? undefined
  const site = config?.sites.find(s => s.key === key)
  if (!site) throw new Error(`站点不存在：${key}`)
  return site
}

async function getDisabledKeys(): Promise<string[]> {
  const all = await store.get<Record<string, string[]>>(`sites.disabled`) ?? {}
  return all[currentConfigId] ?? []
}
async function setSiteDisabled(key: string, disabled: boolean): Promise<void> {
  const all = await store.get<Record<string, string[]>>(`sites.disabled`) ?? {}
  const list = new Set(all[currentConfigId] ?? [])
  if (disabled) list.add(key)
  else list.delete(key)
  all[currentConfigId] = [...list]
  await store.set('sites.disabled', all)
}

/** spider 实例（懒加载 + 失败缓存） */
async function getSpider(site: SiteMeta): Promise<SpiderInstance> {
  const cached = spiderInstances.get(site.key)
  if (cached) return cached
  const err = siteErrors.get(site.key)
  if (err) throw new Error(err)
  const deps: SpiderDeps = {
    configBaseUrl: configBaseUrl || undefined,
    globalSpider: currentConfig?.spider,
    readRuntimeFile: packagePath
      ? (name: string) => readFile(join(packagePath, 'runtime', 'presets', 'drpy', name), 'utf-8')
      : undefined,
    fetchText: fetchTextCached,
    log: (...a) => console.log('[tvbox]', ...a),
  }
  try {
    const inst = await withTimeout(instantiateSpider(site, deps), 120_000, 'spider 加载超时')
    spiderInstances.set(site.key, inst)
    return inst
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    siteErrors.set(site.key, msg)
    throw new Error(msg)
  }
}

/** 归一 spider/drpy 各方法返回 */
function normalizeVods(list: unknown, siteKey: string): VodItem[] {
  return asArray<any>(list).map(v => ({
    vod_id: String(v?.vod_id ?? v?.id ?? ''),
    vod_name: String(v?.vod_name ?? v?.name ?? ''),
    vod_pic: v?.vod_pic ? String(v.vod_pic) : undefined,
    vod_remarks: v?.vod_remarks ? String(v.vod_remarks) : undefined,
    type_name: v?.type_name ? String(v.type_name) : undefined,
    vod_year: v?.vod_year ? String(v.vod_year) : undefined,
    siteKey,
  })).filter(v => v.vod_id && v.vod_name)
}
function normalizeFilters(filters: unknown): Record<string, FilterGroup[]> {
  const out: Record<string, FilterGroup[]> = {}
  const obj = plain(filters)
  if (!obj || typeof obj !== 'object') return out
  for (const [tid, groups] of Object.entries(obj)) {
    const list = asArray<any>(groups).map(g => ({
      key: String(g?.key ?? ''),
      name: String(g?.name ?? ''),
      init: g?.init ? String(g.init) : undefined,
      value: asArray<any>(g?.value).map(vv => ({ n: String(vv?.n ?? ''), v: String(vv?.v ?? '') })).filter(vv => vv.n || vv.v),
    })).filter(g => g.key && g.value.length)
    if (list.length) out[tid] = list
  }
  return out
}

/** type4：ext 即接口地址，t4 协议直接返回结果 JSON */
async function callType4(site: SiteMeta, path: string, params: Record<string, string>): Promise<any> {
  const base = site.ext ?? site.api
  const url = new URL(path, base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const json = await fetchJson(url.toString(), { headers: site.header, ownerKey: site.key, timeoutMs: (site.timeout ?? 15) * 1000 })
  if (json && typeof json === 'object' && json.msg && Number(json.code) === -1) throw new Error(`站点报错：${String(json.msg).slice(0, 80)}`)
  return json
}

/* ---------------- 播放决策 ---------------- */
interface PlayDecisionInput { site: SiteMeta; flag: string; id: string }

/** spider playerContent / cms 直链 / parses Json 解析 → PlayResult */
async function decidePlay(input: PlayDecisionInput): Promise<{ parse: number; url: string; headers?: Record<string, string>; note?: string }> {
  const { site, flag, id } = input
  if (site.type === 3) {
    const spider = await getSpider(site)
    const raw = await withTimeout(spider.invoke('play', flag, id, currentConfig?.flags ?? []), 30_000, '解析播放地址超时')
    const r = plain(raw)
    if (typeof r?.url === 'string' && r.url.startsWith('json:')) {
      try {
        const inner = JSON.parse(r.url.slice(5))
        return { parse: Number(inner.parse ?? r.parse ?? 0), url: String(inner.url ?? ''), headers: inner.header, note: 'json 播放信息' }
      } catch { /* fallthrough */ }
    }
    return {
      parse: Number(r?.parse ?? 0),
      url: String(r?.url ?? ''),
      headers: r?.header && typeof r.header === 'object' ? Object.fromEntries(Object.entries(r.header).map(([k, v]) => [k, String(v)])) : undefined,
    }
  }
  if (site.type === 4) {
    const json = await callType4(site, 'play', { flag, id })
    return { parse: Number(json?.parse ?? 0), url: String(json?.url ?? ''), headers: json?.header }
  }
  // type 0/1：id 即直链（detail 已拆好）；playUrl 前缀（少数站）拼解析页
  const url = site.playUrl ? `${site.playUrl}${id}` : id
  if (site.playUrl) return { parse: 1, url, headers: site.header }
  return { parse: 0, url, headers: site.header }
}

/** parses Json 解析（type 1/2）：GET parse.url + encodeURIComponent(视频页地址) */
async function runJsonParse(parseUrl: string, target: string, headers?: Record<string, string>): Promise<{ parse: number; url: string; headers?: Record<string, string> }> {
  const url = `${parseUrl}${parseUrl.includes('=') ? '' : '='}${encodeURIComponent(target)}`
  const json = await fetchJson(url, { headers, timeoutMs: 20_000 })
  const code = Number(json?.code ?? 1)
  const playUrl = String(json?.url ?? '')
  if (code !== 1 || !playUrl) throw new Error(`解析失败：${String(json?.msg ?? '无播放地址').slice(0, 60)}`)
  return {
    parse: 0,
    url: playUrl,
    headers: json?.header && typeof json.header === 'object' ? Object.fromEntries(Object.entries(json.header).map(([k, v]) => [k, String(v)])) : headers,
  }
}

/* ---------------- 多源聚合：参与站点（启用中的 type0/1） ---------------- */
async function aggregateSites(): Promise<SiteMeta[]> {
  const config = await ensureCurrentConfig()
  const disabled = new Set(await getDisabledKeys())
  return config.sites.filter(s => !s.hide && !disabled.has(s.key) && (s.type === 0 || s.type === 1))
}

/* ---------------- backend.call 方法表 ---------------- */
const methods: Record<string, (args: unknown[]) => Promise<unknown>> = {
  /* ----- 配置管理 ----- */
  'config.list': async () => {
    const index = await loadConfigIndex(store)
    const current = currentConfigId || await loadCurrentId(store)
    const out: Array<Record<string, unknown>> = []
    for (const r of index) {
      const config = await loadConfig(store, r.id)
      out.push({ ...r, current: r.id === current, sites: config?.sites.length ?? 0, depot: config?.urls.length ? config.urls : [] })
    }
    return out
  },
  'config.add': async ([url, nameHint]) => {
    const target = normalizeUrl(url)
    const raw = await fetchConfigFromUrl(target)
    const { id, depot } = await importConfigFromRaw(raw, target, String(nameHint ?? ''))
    if (!id) return { depot }   // 纯多仓入口：返回线路列表让前端选择
    return { id, depot }
  },
  'config.addText': async ([text, nameHint]) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('配置内容不能为空')
    const raw = await Promise.resolve(JSON.parse(text.trim())) as TvboxConfigRaw
    const { id, depot } = await importConfigFromRaw(raw, '', String(nameHint ?? '粘贴配置'))
    if (!id) return { depot }
    return { id, depot }
  },
  'config.use': async ([id]) => {
    const config = await loadConfig(store, String(id))
    if (!config) throw new Error(`配置不存在：${String(id)}`)
    const record = (await loadConfigIndex(store)).find(r => r.id === String(id))
    await saveCurrentId(store, String(id))
    currentConfig = config
    currentConfigId = String(id)
    configBaseUrl = record?.url ?? ''
    invalidateSites()
    return { ok: true, name: record?.name, notice: config.notice, wallpaper: config.wallpaper, urls: config.urls }
  },
  'config.reload': async () => {
    const id = currentConfigId || await loadCurrentId(store)
    if (!id) throw new Error('没有可重载的配置')
    const record = (await loadConfigIndex(store)).find(r => r.id === id)
    if (!record?.url) throw new Error('内置配置无需重载')
    const raw = await fetchConfigFromUrl(record.url)
    const { id: newId } = await importConfigFromRaw(raw, record.url, record.name)
    if (newId !== id) {
      // 内容 hash 变化导致 id 变化：沿用原记录（同 URL 覆盖）
      const config = normalizeConfig(raw)
      await saveConfig(store, id, config)
    }
    currentConfig = await loadConfig(store, id)
    currentConfigId = id
    configBaseUrl = record.url
    invalidateSites()
    return { ok: true, notice: currentConfig?.notice }
  },
  'config.remove': async ([id]) => {
    const index = await loadConfigIndex(store).then(list => list.filter(r => r.id !== String(id)))
    await saveConfigIndex(store, index)
    await store.set(`config.${String(id)}`, null)
    if (currentConfigId === String(id)) {
      currentConfig = null
      currentConfigId = ''
      invalidateSites()
      if (index.length) return methods['config.use']([index[0].id])
    }
    return { ok: true }
  },
  'config.current': async () => {
    const config = await ensureCurrentConfig()
    const record = (await loadConfigIndex(store)).find(r => r.id === currentConfigId)
    return {
      id: currentConfigId,
      name: record?.name ?? '',
      notice: config.notice,
      wallpaper: config.wallpaper,
      logo: config.logo,
      urls: config.urls,
      parses: config.parses.length,
    }
  },

  /* ----- 站点 ----- */
  'site.list': async () => {
    const config = await ensureCurrentConfig()
    const disabled = new Set(await getDisabledKeys())
    return config.sites
      .filter(s => !s.hide)
      .map(s => ({
        key: s.key, name: s.name, type: s.type,
        searchable: s.searchable, quickSearch: s.quickSearch, changeable: s.changeable,
        disabled: disabled.has(s.key),
        error: siteErrors.get(s.key),
      }))
  },
  'site.setEnabled': async ([key, disabled]) => {
    await ensureCurrentConfig()
    await setSiteDisabled(String(key), Boolean(disabled))
    return { ok: true }
  },
  /** 首页多板块：顶级分类（电影/连续剧/综艺/动漫…）各拉最新一页（TVBox 豆瓣首页形态） */
  'site.homeBoard': async ([key]) => {
    const config = await ensureCurrentConfig()
    const site = findSite(String(key))
    if (site.type !== 0 && site.type !== 1) {
      // spider/type4 站点退化为单推荐板块
      const home = await methods['site.home']([key]) as { list?: VodItem[] }
      return { sections: [{ typeId: '', typeName: '推荐', list: home.list ?? [] }] }
    }
    const cms = createCmsClient(site)
    const home = await withTimeout(cms.home(), 30_000, '首页分类加载超时')
    const all = home.types ?? []
    // 一级分类是壳的站（量子 t=1 仅 1 条占位）：板块用一级分类下首个子分类
    const tops = all.filter(t => !t.parent).slice(0, 6)
    const pickBoardType = (top: TypeItem): TypeItem => {
      const child = all.find(t => t.parent === top.type_id)
      return child ?? top
    }
    const sections = await Promise.all(tops.map(async t => {
      try {
        const boardType = pickBoardType(t)
        const page = await withTimeout(cms.category(boardType.type_id, 1, {}), 45_000, '板块加载超时')
        // 子分类也没内容的（仍 ≤1 条且 total 异常小），回退全站最新
        let list = (page.list ?? []).slice(0, 20)
        if (list.length <= 1) {
          const fallback = await withTimeout(cms.category('', 1, {}), 45_000, '板块回退加载超时').catch(() => null)
          if (fallback && (fallback.list?.length ?? 0) > list.length) list = fallback.list.slice(0, 20)
        }
        return { typeId: t.type_id, typeName: t.type_name, list }
      } catch {
        return { typeId: t.type_id, typeName: t.type_name, list: [] }
      }
    }))
    void config
    return { sections }
  },
  'site.home': async ([key]) => {
    const config = await ensureCurrentConfig()
    const site = findSite(String(key))
    if (site.type === 0 || site.type === 1) {
      const cms = createCmsClient(site)
      const home = await withTimeout(cms.home(), 30_000, '首页加载超时')
      return {
        types: home.types as TypeItem[],
        list: home.list,
        filters: Object.keys(home.filters ?? {}).length ? home.filters : defaultFilters(),
      }
    }
    if (site.type === 3) {
      const spider = await getSpider(site)
      const [homeRes, vodRes] = await Promise.all([
        withTimeout(spider.invoke('home', true), 30_000, '首页加载超时').catch(() => null),
        withTimeout(spider.invoke('homeVod'), 30_000, '推荐加载超时').catch(() => null),
      ])
      const home = plain(homeRes)
      const vods = plain(vodRes)
      return {
        types: asArray<any>(home?.class).map((c: any) => ({ type_id: String(c?.type_id ?? ''), type_name: String(c?.type_name ?? '') })).filter((t: TypeItem) => t.type_id),
        list: normalizeVods(vods?.list ?? vods, site.key),
        filters: normalizeFilters(home?.filters),
      }
    }
    if (site.type === 4) {
      const json = await callType4(site, 'home', { filter: 'true' })
      return {
        types: asArray<any>(json?.class).map((c: any) => ({ type_id: String(c?.type_id ?? ''), type_name: String(c?.type_name ?? '') })).filter((t: TypeItem) => t.type_id),
        list: normalizeVods(json?.list, site.key),
        filters: normalizeFilters(json?.filters),
      }
    }
    throw new Error(`站点类型 ${site.type} 暂不支持`)
  },
  'site.category': async ([key, typeId, page, filters]) => {
    const site = findSite(String(key))
    const pageNo = Number(page) || 1
    const filterObj = (filters && typeof filters === 'object' ? filters : {}) as Record<string, string>
    if (site.type === 0 || site.type === 1) {
      const cms = createCmsClient(site)
      const result = await withTimeout(cms.category(String(typeId), pageNo, filterObj), 60_000, '分类加载超时')
      return result
    }
    if (site.type === 3) {
      const spider = await getSpider(site)
      const raw = await withTimeout(spider.invoke('category', String(typeId), pageNo, true, filterObj), 60_000, '分类加载超时')
      const r = plain(raw)
      const list = normalizeVods(r?.list ?? r, site.key)
      return { list, page: Number(r?.page ?? pageNo), pagecount: Number(r?.pagecount ?? (list.length >= 20 ? pageNo + 1 : pageNo)) }
    }
    if (site.type === 4) {
      const json = await callType4(site, 'category', { t: String(typeId), pg: String(pageNo) })
      const list = normalizeVods(json?.list, site.key)
      return { list, page: Number(json?.page ?? pageNo), pagecount: Number(json?.pagecount ?? 0) }
    }
    throw new Error(`站点类型 ${site.type} 暂不支持`)
  },
  'site.search': async ([key, keyword, page]) => {
    await ensureCurrentConfig()
    const site = findSite(String(key))
    if (site.searchable === 0) throw new Error(`站点「${site.name}」不支持搜索`)
    const kw = String(keyword ?? '').trim()
    if (!kw) return { list: [], page: 1, pagecount: 0 }
    const pageNo = Number(page) || 1
    if (site.type === 0 || site.type === 1) {
      const cms = createCmsClient(site)
      return withTimeout(cms.search(kw, pageNo), 60_000, '搜索超时')
    }
    if (site.type === 3) {
      const spider = await getSpider(site)
      const raw = await withTimeout(
        pageNo > 1
          ? spider.invoke('search', kw, false, String(pageNo))
          : spider.invoke('search', kw, false),
        60_000, '搜索超时')
      const r = plain(raw)
      const list = normalizeVods(r?.list ?? r, site.key)
      return { list, page: pageNo, pagecount: Number(r?.pagecount ?? 0) }
    }
    if (site.type === 4) {
      const json = await callType4(site, 'search', { wd: kw, pg: String(pageNo) })
      return { list: normalizeVods(json?.list, site.key), page: pageNo, pagecount: Number(json?.pagecount ?? 0) }
    }
    throw new Error(`站点类型 ${site.type} 暂不支持`)
  },
  'site.detail': async ([key, vodId]) => {
    await ensureCurrentConfig()
    const site = findSite(String(key))
    if (site.type === 0 || site.type === 1) {
      const cms = createCmsClient(site)
      return withTimeout(cms.detail(String(vodId)), 60_000, '详情加载超时')
    }
    if (site.type === 3) {
      const spider = await getSpider(site)
      const raw = await withTimeout(spider.invoke('detail', String(vodId)), 90_000, '详情加载超时')
      const r = plain(raw)
      const v = asArray<any>(r?.list ?? r)[0]
      if (!v) throw new Error('详情为空')
      const detail = normalizeVods([v], site.key)[0]
      const flags = String(v?.vod_play_from ?? '').split('$$$').map((s: string) => s.trim()).filter(Boolean).map((flag: string, i: number) => ({
        flag,
        episodes: String(String(v?.vod_play_url ?? '').split('$$$')[i] ?? '').split('#').filter(Boolean).map(seg => {
          const idx = seg.indexOf('$')
          if (idx <= 0) return { name: '', url: seg.trim() }
          return { name: seg.slice(0, idx).trim(), url: seg.slice(idx + 1).trim() }
        }).filter((e: { url: string }) => e.url),
      })).filter((f: { episodes: unknown[] }) => f.episodes.length)
      return {
        ...detail,
        vod_content: v?.vod_content ? String(v.vod_content).replace(/<[^>]+>/g, '').trim() : undefined,
        vod_actor: v?.vod_actor ? String(v.vod_actor) : undefined,
        vod_director: v?.vod_director ? String(v.vod_director) : undefined,
        flags,
      } as VodDetail
    }
    if (site.type === 4) {
      const json = await callType4(site, 'detail', { ids: String(vodId) })
      const v = asArray<any>(json?.list)[0]
      if (!v) throw new Error('详情为空')
      const detail = normalizeVods([v], site.key)[0]
      const flags = String(v?.vod_play_from ?? '').split('$$$').map((s: string) => s.trim()).filter(Boolean).map((flag: string, i: number) => ({
        flag,
        episodes: String(String(v?.vod_play_url ?? '').split('$$$')[i] ?? '').split('#').filter(Boolean).map((seg: string) => {
          const idx = seg.indexOf('$')
          if (idx <= 0) return { name: '', url: seg.trim() }
          return { name: seg.slice(0, idx).trim(), url: seg.slice(idx + 1).trim() }
        }).filter((e: { url: string }) => e.url),
      })).filter((f: { episodes: unknown[] }) => f.episodes.length)
      return { ...detail, vod_content: v?.vod_content ? String(v.vod_content).replace(/<[^>]+>/g, '').trim() : undefined, flags } as VodDetail
    }
    throw new Error(`站点类型 ${site.type} 暂不支持`)
  },
  /** 播放：决策 → 需要时过解析 → 生成代理 URL */
  'site.play': async ([key, flag, id]) => {
    const config = await ensureCurrentConfig()
    const site = findSite(String(key))
    const flagName = String(flag ?? '')
    let decision = await decidePlay({ site, flag: flagName, id: String(id) })
    if (decision.parse === 1 || decision.parse === 2) {
      // 走 parses：按 flag 匹配 ext.flag 的解析器优先；type 0(WebView嗅探) 不支持
      const candidates = config.parses.filter(p => p.type === 1 || p.type === 2)
      const matched = flagName ? candidates.filter(p => p.ext?.flag?.includes(flagName)) : []
      const chosen = matched[0] ?? candidates[0]
      if (!chosen) throw new Error('该资源需要解析，但配置未提供可用的 Json 解析线路（WebView 嗅探桌面端不支持）')
      decision = { ...await runJsonParse(chosen.url, decision.url, chosen.ext?.header), note: `已解析：${chosen.name}` }
    }
    if (!decision.url) throw new Error('未能取得播放地址')
    if (!/^https?:\/\//i.test(decision.url)) throw new Error(`播放地址不是直链：${decision.url.slice(0, 80)}`)
    // 生成代理播放地址
    const origin = await ensureMediaProxy()
    const kind = /\.m3u8(\?|$)/i.test(decision.url) ? 'hls' : /\.(mp4|mkv|flv|avi)(\?|$)/i.test(decision.url) ? 'mp4' : 'link'
    const proxied = proxyMediaUrl(origin, decision.url, decision.headers, site.key)
    return { url: proxied, kind: kind as PlayResult['kind'], note: decision.note }
  },
  /** 换源：全站搜同名片，返回各站匹配（前端直接展示切换） */
  'site.findSame': async ([name, excludeKey]) => {
    const config = await ensureCurrentConfig()
    const kw = String(name ?? '').trim()
    if (!kw) return []
    const disabled = new Set(await getDisabledKeys())
    const sites = config.sites.filter(s => !s.hide && !disabled.has(s.key) && s.searchable !== 0 && s.key !== String(excludeKey))
      .slice(0, 8)
    const results = await Promise.allSettled(sites.map(async s => {
      const r = await methods['site.search']([s.key, kw, 1])
      const list = (r as CategoryPage).list.slice(0, 6)
      return list.map(v => ({ ...v, siteName: s.name }))
    }))
    return results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
  },

  /* ----- 直播 ----- */
  'live.list': async () => {
    const config = await ensureCurrentConfig()
    const sources = normalizeLiveSources(config.lives)
    const inlineGroups = asArray<any>(config.lives).flatMap(raw => Array.isArray(raw?.groups) ? parseLiveGroupsInline(raw.groups) : [])
    return {
      sources: sources.map((s, i) => ({ index: i, name: s.name, url: s.url ?? '' })),
      inlineGroups,
    }
  },
  'live.groups': async ([index]) => {
    const config = await ensureCurrentConfig()
    const sources = normalizeLiveSources(config.lives)
    const idx = Number(index) || 0
    const source = sources[idx]
    if (!source?.url) throw new Error('直播源不存在')
    // preset 相对地址（./live-demo.txt）：从包内读
    if (source.url.startsWith('./') && packagePath) {
      const text = await readPresetLive(packagePath, source.url)
      if (text) return parseLiveGroupsFromText(text)
    }
    const groups = await loadLiveSource(source, `live-${idx}`)
    return groups
  },

  /* ----- 媒体/图片 ----- */
  'image.load': async ([url, ownerKey]) => {
    const target = String(url)
    const res = await rawFetch(target, { ownerKey: String(ownerKey ?? '') || undefined, maxBytes: MAX_MEDIA_BYTES, timeoutMs: 20_000 })
    if (res.status >= 400) throw new Error(`图片加载失败 HTTP ${res.status}`)
    const mime = (res.headers['content-type'] ?? '').split(';')[0].trim() || 'image/jpeg'
    return { mime: /image|octet-stream/.test(mime) ? mime : 'image/jpeg', base64: Buffer.from(res.bytes).toString('base64') }
  },
  /** 海报兜底：图片走代理 URL（CSP img 不放行外网；优先 image.load base64） */
  'proxy.imageUrl': async ([url, ownerKey]) => {
    const origin = await ensureMediaProxy()
    return proxyImageUrl(origin, String(url), String(ownerKey ?? ''))
  },

  /* ----- 网盘源（OpenList/AList） ----- */
  'openlist.accounts': async () => {
    const list = await store.get<OpenListAccount[]>('openlist.accounts')
    return Array.isArray(list) ? list : []
  },
  /** 添加网盘：先探测，再把 token 存 KV（登录页由前端打开，token 用户回填） */
  'openlist.add': async ([url, token, nameHint]) => {
    const target = normalizeUrl(url).replace(/\/+$/, '')
    const probe = await probeOpenList(target)
    if (!probe.ok) throw new Error('该地址不是可用的 OpenList/AList 站点（/api/public/settings 探测失败）')
    const tk = String(token ?? '').trim()
    if (!tk) {
      // 未带 token：探测通过即可添加（公开目录模式），登录页地址一并返回
      const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
      const id = `ol-${createHash('sha1').update(target).digest('hex').slice(0, 8)}`
      const account: OpenListAccount = { id, name: nameHint ? String(nameHint) : probe.title || '网盘', url: target, token: '', addedAt: Date.now() }
      await store.set('openlist.accounts', [account, ...accounts.filter(a => a.id !== id)])
      return { ...account, loginUrl: loginPageUrl(target), needLogin: true }
    }
    const verify = await verifyToken(target, tk)
    if (!verify.ok) throw new Error(verify.expired ? 'token 无效或已过期（401）' : 'token 校验失败')
    const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
    const id = `ol-${createHash('sha1').update(target).digest('hex').slice(0, 8)}`
    const account: OpenListAccount = { id, name: nameHint ? String(nameHint) : (verify.username ? `${probe.title || '网盘'}(${verify.username})` : probe.title || '网盘'), url: target, token: tk, addedAt: Date.now() }
    await store.set('openlist.accounts', [account, ...accounts.filter(a => a.id !== id)])
    return { ...account, needLogin: false }
  },
  'openlist.remove': async ([id]) => {
    const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
    await store.set('openlist.accounts', accounts.filter(a => a.id !== String(id)))
    return { ok: true }
  },
  /** 检查账号（401 标记过期，前端据此弹重新登录） */
  'openlist.check': async ([id]) => {
    const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
    const account = accounts.find(a => a.id === String(id))
    if (!account) throw new Error('网盘账号不存在')
    if (!account.token) return { id, state: 'need-login', loginUrl: loginPageUrl(account.url) }
    const verify = await verifyToken(account.url, account.token)
    if (verify.ok) return { id, state: 'ok', username: verify.username }
    return { id, state: verify.expired ? 'expired' : 'error', loginUrl: loginPageUrl(account.url) }
  },
  /** 更新 token（重新授权后） */
  'openlist.updateToken': async ([id, token]) => {
    const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
    const account = accounts.find(a => a.id === String(id))
    if (!account) throw new Error('网盘账号不存在')
    const verify = await verifyToken(account.url, String(token))
    if (!verify.ok) throw new Error(verify.expired ? 'token 无效或已过期（401）' : 'token 校验失败')
    await store.set('openlist.accounts', accounts.map(a => a.id === account.id ? { ...a, token: String(token) } : a))
    return { ok: true }
  },
  'openlist.loginUrl': async ([id]) => {
    const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
    const account = accounts.find(a => a.id === String(id))
    if (!account) throw new Error('网盘账号不存在')
    return loginPageUrl(account.url)
  },
  /** 网盘搜索：全部账号并行搜文件 */
  'openlist.search': async ([keyword]) => {
    const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
    const kw = String(keyword ?? '').trim()
    if (!kw) return []
    const results = await Promise.allSettled(accounts.filter(a => a.token).map(async a => {
      const { items, total } = await searchFiles(a.url, a.token, kw, 1, 24)
      return items.filter(f => !f.isDir && isVideoFile(f.name)).map(f => ({ ...fileToVodItem(f, a.id), siteName: a.name, __total: total }))
    }))
    return results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
  },
  /** 列网盘目录（详情形态：目录下视频文件=选集） */
  'openlist.list': async ([id, path, page]) => {
    const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
    const account = accounts.find(a => a.id === String(id))
    if (!account) throw new Error('网盘账号不存在')
    const { items, total } = await listFiles(account.url, account.token || ' ', String(path ?? '/'), Number(page) || 1, 100)
    return { items: items.map(f => ({ ...f, sizeText: formatSize(f.size) })), total }
  },
  /** 网盘文件直链 → 代理播放地址 */
  'openlist.play': async ([id, path]) => {
    const accounts = await store.get<OpenListAccount[]>('openlist.accounts') ?? []
    const account = accounts.find(a => a.id === String(id))
    if (!account) throw new Error('网盘账号不存在')
    const rawUrl = await getFileRawUrl(account.url, account.token, String(path))
    const origin = await ensureMediaProxy()
    const kind = /\.m3u8(\?|$)/i.test(rawUrl) ? 'hls' : /\.(mp4|mkv|flv|avi|mov|ts)(\?|$)/i.test(rawUrl) ? 'mp4' : 'link'
    return { url: proxyMediaUrl(origin, rawUrl, undefined, `openlist-${account.id}`), kind: kind as PlayResult['kind'] }
  },

  /* ----- 多源聚合（无"当前站点"：启用中的全部数据源参与） ----- */
  /** 聚合首页：剧集/综艺/动漫用全站最新（更新以剧集为主），电影板块走分类拉取
   *  （最新页电影占比天然低）→ 按标准板块归组 → 去重交错合并 */
  'aggregate.home': async () => {
    const sites = await aggregateSites()
    if (!sites.length) return { sections: STANDARD_SECTIONS.map(s => ({ ...s, list: [] as AggregateVod[] })) }
    const latest = await gatherFromSites(sites, async site => {
      const cms = createCmsClient(site)
      const page = await cms.category('', 1, {})
      // 板块命中不足的站补拉一页
      const bySec = new Map<string, number>()
      for (const v of page.list) {
        const sec = sectionOf(v.type_name)
        if (sec && sec !== 'movie') bySec.set(sec, (bySec.get(sec) ?? 0) + 1)
      }
      const weakest = Math.min(...(['series', 'show', 'anime'] as const).map(k => bySec.get(k) ?? 0))
      let list = page.list
      if (weakest < 4 && (page.pagecount ?? 0) > 1) {
        const page2 = await cms.category('', 2, {}).catch(() => null)
        if (page2) list = [...list, ...page2.list]
      }
      return list
    }, 20_000)
    // 非电影板块：最新页归组
    const sectionLists = new Map<string, Array<{ siteKey: string; siteName: string; data: VodItem[] }>>()
    for (const sec of STANDARD_SECTIONS) sectionLists.set(sec.key, [])
    for (const bucket of latest) {
      const groups = new Map<string, VodItem[]>()
      for (const v of bucket.data) {
        const sec = sectionOf(v.type_name)
        if (!sec || sec === 'movie') continue
        const list = groups.get(sec) ?? []
        if (list.length < 30) list.push(v)
        groups.set(sec, list)
      }
      for (const [sec, list] of groups) sectionLists.get(sec)?.push({ siteKey: bucket.siteKey, siteName: bucket.siteName, data: list })
    }
    // 电影板块：各站挑一个有量的电影子分类（动作片等）拉第一页
    const movieBuckets = await gatherFromSites(sites, async site => {
      const cms = createCmsClient(site)
      const home = await cms.home()
      const movieTypes = home.types.filter(t => sectionOf(t.type_name) === 'movie' && !t.parent)
      const pick = movieTypes.sort((a, b) => (b.type_name.length - a.type_name.length))[0] ?? movieTypes[0]
      if (!pick) return []
      const page = await cms.category(pick.type_id, 1, {})
      return page.list
    }, 20_000)
    for (const bucket of movieBuckets) {
      sectionLists.get('movie')?.push({ siteKey: bucket.siteKey, siteName: bucket.siteName, data: bucket.data.filter(v => sectionOf(v.type_name) === 'movie').slice(0, 24) })
    }
    return {
      sections: STANDARD_SECTIONS.map(sec => ({ ...sec, list: interleaveMerge(sectionLists.get(sec.key) ?? [], 20) })),
      sources: latest.length,
    }
  },

  /** 聚合分类：标准板块（+可选子分类）→ 各站分类树映射出板块内全部 type_id →
   *  逐站拉分类页（电影等低更新板块走分类拉取才有量）→ 同页合并去重 */
  'aggregate.category': async ([sectionKey, subTypeName, page]) => {
    const sites = await aggregateSites()
    if (!sites.length) return { list: [], page: 1, pagecount: 0 }
    const secKey = String(sectionKey ?? 'movie')
    const sub = subTypeName ? String(subTypeName) : ''
    const pageNo = Number(page) || 1
    const buckets = await gatherFromSites(sites, async site => {
      const cms = createCmsClient(site)
      const home = await cms.home()
      // 板块内全部类型（子分类时精确名匹配）
      const wanted = home.types.filter(t => {
        if (sub) return t.type_name.trim() === sub
        return sectionOf(t.type_name) === secKey
      })
      if (!wanted.length) return []
      // 无子分类时：板块大类若为壳（如量子 t=1 仅 1 条）改拉子分类并集的前 3 个
      const tops = wanted.filter(t => !t.parent)
      let useTypes = tops.length ? [tops[0]] : []
      // 探测壳：先拉大类，≤2 条则改用子类
      if (useTypes.length) {
        const probe = await cms.category(useTypes[0].type_id, 1, {}).catch(() => null)
        if (!probe || probe.list.length <= 2) {
          const subs = wanted.filter(t => t.parent)
          useTypes = subs.slice(0, 3)
        }
      } else {
        useTypes = wanted.filter(t => t.parent).slice(0, 3)
      }
      if (!useTypes.length) return []
      // 逐类型拉同页（3 个子类 × 20 条 ≈ 60 条/站）
      const lists: VodItem[] = []
      for (const t of useTypes) {
        const r = await cms.category(t.type_id, pageNo, {}).catch(() => null)
        if (r?.list?.length) lists.push(...r.list)
      }
      return lists
    }, 25_000)
    const merged = interleaveMerge(buckets, 60)
    return {
      list: merged,
      page: pageNo,
      pagecount: pageNo + 1,
      subTypes: SECTION_SUBTYPES[secKey] ?? [],
    }
  },

  /** 聚合最佳匹配（搜索框下拉）：全部可搜站并行，先返回先出 */
  'aggregate.suggest': async ([keyword]) => {
    const sites = await aggregateSites()
    const kw = String(keyword ?? '').trim()
    if (!kw) return []
    const buckets = await gatherFromSites(sites.filter(s => s.searchable !== 0), async site => {
      const cms = createCmsClient(site)
      const r = await cms.search(kw, 1)
      return r.list.slice(0, 4)
    }, 10_000)
    return interleaveMerge(buckets, 8)
  },

  /* ----- 调试 ----- */
  'debug.state': async () => ({
    configId: currentConfigId,
    sites: currentConfig?.sites.length ?? 0,
    spiders: [...spiderInstances.keys()],
    errors: Object.fromEntries(siteErrors),
  }),
}
type LiveGroupLite = { name: string; channels: Array<{ name: string; urls: string[] }> }

function parseLiveGroupsFromText(text: string): LiveGroupLite[] {
  const groups = /^#EXTM3U/i.test(text.trim()) ? parseLiveM3u(text) : parseLiveTxt(text)
  return groups.map(g => ({ name: g.name, channels: g.channels.map(c => ({ name: c.name, urls: c.urls })) }))
}

/* ---------------- 媒体代理生命周期 ---------------- */
let mediaProxyOrigin = ''
let mediaProxyStarting: Promise<void> | null = null
async function ensureMediaProxy(): Promise<string> {
  if (mediaProxyOrigin) return mediaProxyOrigin
  if (!mediaProxyStarting) {
    mediaProxyStarting = startMediaProxy(
      hostRequest,
      async (url, headers, range) => {
        const h = new Headers()
        for (const [k, v] of Object.entries(headers ?? {})) h.set(k, v)
        if (!h.has('user-agent')) h.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
        if (range) h.set('range', range)
        return fetch(url, { headers: h, redirect: 'follow' })
      },
      (...a) => console.log('[tvbox]', ...a),
    ).then(handle => {
      mediaProxyOrigin = handle.origin
    }).finally(() => {
      mediaProxyStarting = null
    })
  }
  await mediaProxyStarting
  return mediaProxyOrigin
}

/* ---------------- 进程协议 ---------------- */
port.on('message', ({ data: request }) => {
  if (request.type === 'init') {
    if (!owner && typeof request.pluginId === 'string') owner = request.pluginId
    const ctx = (request as { context?: { protocolVersion?: number; packagePath?: string; appDataPath?: string } }).context
    if (ctx && ctx.protocolVersion !== 1) throw new Error(`Unsupported backend protocol version: ${ctx.protocolVersion}`)
    if (ctx?.packagePath) packagePath = ctx.packagePath
    void store.get('cookies.jar').then(jar => {
      if (jar && typeof jar === 'object') importCookieJar(jar as Parameters<typeof importCookieJar>[0])
    }).catch(() => {})
    return
  }
  if (request.type === 'shutdown') {
    void stopMediaProxy().finally(() => {
      port.postMessage({ type: 'shutdown.complete', ok: true })
      process.exit(0)
    })
    return
  }
  if (request.type === 'host.response') {
    const pending = hostControls.get(request.id!)
    if (pending) {
      hostControls.delete(request.id!)
      clearTimeout(pending.timer)
      if (request.ok) pending.resolve(request.data)
      else pending.reject(new Error(String(request.error ?? '宿主控制请求失败')))
    }
    return
  }
  if (!Number.isSafeInteger(request.id)) return
  void (async () => {
    if (!owner || request.pluginId !== owner) throw new Error('Invalid backend owner')
    const handler = methods[request.method!]
    if (!handler) throw new Error(`Unknown backend method: ${request.method}`)
    return handler(request.args ?? [])
  })().then(
    data => port.postMessage({ id: request.id, ok: true, data }),
    error => port.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  )
})
