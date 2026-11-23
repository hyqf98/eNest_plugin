/**
 * MOD 数据源（3DM mod 站）。当前接口返回「服务器错误」，照常实现，失败抛可展示错误。
 * 接口：POST /api/search/getModlist（{page,pageSize,gameId?,search?,gameType?,original?,order?}）、
 * POST /api/mods/{id}、POST /api/game/getData（{path}）。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import type { DetailData, LibraryItem, MediaRef, Page, ResourcePackage } from '../contracts.ts'
import { asArray, asRecord, parseSize, text } from '../util.ts'
import { itemIdOf, siteIdOf } from './registry.ts'
import type { SourceAdapter, SourceFacets } from './registry.ts'

const BASE = 'https://mod.3dmgame.com'
const PAGE_SIZE = 30

async function modPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const adapter = getAdapter()
  const response = await adapter.request({
    url: BASE + path,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', referer: `${BASE}/` },
    body: JSON.stringify(body),
    timeoutMs: 20_000,
  })
  const textBody = new TextDecoder('utf-8').decode(response.body)
  let data: Record<string, unknown>
  try {
    data = JSON.parse(textBody) as Record<string, unknown>
  } catch {
    throw new BackendError('SOURCE_ERROR', 'MOD 站点接口暂时不可用')
  }
  if (data.success !== true) {
    const message = typeof data.message === 'string' && data.message ? data.message : '接口返回失败'
    throw new BackendError('SOURCE_ERROR', `MOD 站点接口暂时不可用（${message}）`)
  }
  return data
}

interface ModResource {
  id: string
  name: string
  sizeText: string
  size: number
  url: string
}

function pickResource(mod: Record<string, unknown>): ModResource | null {
  const resources = asArray(mod.mods_resource)
    .map(entry => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
  if (resources.length === 0) return null
  const latest = resources.find(entry => entry.mods_resource_latest_version === true)
  const chosen = latest ?? resources[0]
  const sizeText = text(chosen.mods_resource_size) || text(chosen.size)
  const url = text(chosen.mods_resource_url) || text(chosen.url)
  // 站点常不给资源名单：回退成"MOD 标题 + 下载地址的扩展名"，界面与下载后的文件名都可读
  const named = text(chosen.mods_resource_title) || text(chosen.title) || text(choned(chosen))
  return {
    id: text(chosen.mods_resource_id) || text(chosen.id),
    name: named || fallbackResourceName(text(mod.mods_title) || text(mod.title), url),
    sizeText,
    size: parseSize(sizeText),
    url,
  }
}

/** MOD 标题 + 扩展名；标题里的路径分隔符等字符换成下划线，避免当文件名用时出问题 */
function fallbackResourceName(title: string, url: string): string {
  const ext = /^https?:\/\//i.test(url) ? (/[^./?#]+$/.exec(new URL(url).pathname)?.[0] ?? '') : ''
  const safe = title.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 120)
  if (safe) return ext ? `${safe}.${ext}` : safe
  return url.split('/').pop() || 'mod'
}

function choned(entry: Record<string, unknown>): unknown {
  return entry.name ?? entry.file_name
}

function imgToken(url: string): string {
  return url ? `img:${Buffer.from(url, 'utf8').toString('base64url')}` : ''
}

function mapMod(raw: Record<string, unknown>): LibraryItem {
  const cover = text(raw.mods_image) || text(raw.image) || text(raw.litpic)
  const siteId = text(raw.mods_id) || text(raw.id)
  return {
    id: itemIdOf('mod', 'mod', siteId),
    kind: 'mod',
    section: 'mod',
    source: '3dm',
    sourceId: siteId,
    title: text(raw.mods_title) || text(raw.title),
    subtitle: text(raw.game_name) || text((asRecord(raw.game) as Record<string, unknown> | null)?.game_name),
    cover,
    coverToken: imgToken(cover),
    category: text(raw.mods_classname) || text(raw.class_name),
    sizeText: '',
    meta: text(raw.mods_version) ? [`版本 ${text(raw.mods_version)}`] : [],
    favorite: false,
    installed: false,
  }
}

export function modSource(): SourceAdapter {
  const facets = (_section: string): SourceFacets => ({
    categories: [{ id: '', label: '全部分类' }],
    sorts: [
      { id: '', label: '默认' },
      { id: 'new', label: '最新' },
      { id: 'hot', label: '最热' },
    ],
  })

  return {
    kind: 'mod',
    label: 'MOD',
    facets,

    async list(query): Promise<Page<LibraryItem>> {
      const body: Record<string, unknown> = { page: query.page, pageSize: PAGE_SIZE }
      if (query.keyword) body.search = query.keyword
      if (query.sort) body.order = query.sort
      const data = await modPost('/api/search/getModlist', body)
      const payload = asRecord(data.data) ?? asRecord(data.result) ?? {}
      const list = asArray(payload.list ?? payload.mods).filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null).map(entry => asRecord(entry) as Record<string, unknown>)
      const total = Number(payload.total ?? payload.count) || list.length
      return {
        items: list.map(mapMod),
        page: query.page,
        totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        total,
      }
    },

    async detail(itemId): Promise<DetailData> {
      // 站点 id 是裸数字，条目 id 带前缀（mod:mod:站点id），这里剥掉再请求
      const siteId = siteIdOf(itemId)
      const data = await modPost(`/api/mods/${encodeURIComponent(siteId)}`, {})
      const mod = asRecord(data.data) ?? asRecord(data.result) ?? asRecord(data.mods) ?? {}
      if (!mod || Object.keys(mod).length === 0) throw new BackendError('SOURCE_ERROR', 'MOD 站点接口暂时不可用')
      const item = mapMod(mod)
      const resource = pickResource(mod)
      const intro = text(mod.mods_content) || text(mod.content)
      const cover = item.cover
      const media: MediaRef[] = []
      for (const match of intro.matchAll(/<img[^>]+src=(?:"([^"]+)"|'([^']+)')/g)) {
        const url = match[1] ?? match[2] ?? ''
        if (url && !url.startsWith('data:')) media.push({ token: imgToken(url), type: 'image' })
      }
      return {
        item,
        media: cover ? [{ token: imgToken(cover), type: 'image' }, ...media] : media,
        description: intro,
        datetime: text(mod.mods_update_time) || text(mod.update_time),
        sizeText: resource?.sizeText ?? '',
        installedSizeText: '',
        minConfig: '',
        recommendConfig: '',
        officialUrl: text(mod.mods_web_url) || `${BASE}/mods/${siteId}`,
        // 包 id 是资源下载地址：任务模块靠"包 id 是不是链接"判断它是直链，不能填资源 id
        packages: resource
          ? [{
              id: resource.url || resource.id,
              name: resource.name,
              sizeText: resource.sizeText,
              size: resource.size,
              provider: '直链下载',
              state: resource.url ? 'ready' : 'unavailable',
              exePath: '',
              updatedAt: text(mod.mods_update_time),
            }]
          : [],
        trainerOptions: [],
        trainerGuides: [],
      }
    },

    async fileList(itemId): Promise<ResourcePackage[]> {
      const data = await modPost(`/api/mods/${encodeURIComponent(siteIdOf(itemId))}`, {})
      const mod = asRecord(data.data) ?? asRecord(data.result) ?? asRecord(data.mods) ?? {}
      const resource = pickResource(mod)
      if (!resource) return []
      // 包 id 是资源下载地址，任务模块直接拿去下载
      return [{
        id: resource.url || resource.id || `mod_${siteIdOf(itemId)}`,
        name: resource.name,
        sizeText: resource.sizeText,
        size: resource.size,
        provider: '直链下载',
        state: resource.url ? 'ready' : 'unavailable',
        exePath: '',
        updatedAt: '',
      }]
    },
  }
}
