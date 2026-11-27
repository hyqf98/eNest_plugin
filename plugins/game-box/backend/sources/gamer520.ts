/**
 * gamer520 数据源（WordPress REST）。当前站点被 Cloudflare 人机挑战拦截时抛可展示错误。
 * 中文搜索把连续中文按单字拆开用空格连接（split_chinese_keywords）。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import type { DetailData, LibraryItem, LibraryQuery, MediaRef, Page, ResourcePackage } from '../contracts.ts'
import { asArray, asRecord, stripHtml, text } from '../util.ts'
import type { SourceAdapter, SourceFacets } from './registry.ts'

const BASE = 'https://www.gamer520.com'
const CAT_PC = '1471'
const CAT_SWITCH = '2'

/** 连续中文按单字拆开空格连接；已含空格原样返回 */
export function splitChineseKeywords(keyword: string): string {
  if (!keyword) return ''
  if (keyword.includes(' ')) return keyword
  const parts: string[] = []
  let current = ''
  for (const char of keyword) {
    if (char.charCodeAt(0) < 128) current += char
    else {
      if (current) parts.push(current)
      current = ''
      parts.push(char)
    }
  }
  if (current) parts.push(current)
  return parts.join(' ')
}

/** 被 Cloudflare 拦截（403 cf-mitigated: challenge）时抛 SOURCE_BLOCKED */
function assertNotBlocked(response: { status: number; headers: Record<string, string> }, body: string): void {
  if (response.status === 403 || response.status === 503) {
    const mitigated = response.headers['cf-mitigated'] ?? ''
    if (mitigated === 'challenge' || /just a moment|cf-browser-verification|challenge-platform/i.test(body)) {
      throw new BackendError('SOURCE_BLOCKED', '数据源2 暂时无法访问（站点启用了人机验证）')
    }
  }
}

function firstImage(html: string): string {
  const match = /<img[^>]+src=(?:"([^"]+)"|'([^']+)')/.exec(html)
  const url = match?.[1] ?? match?.[2] ?? ''
  return url && !url.startsWith('data:') ? url : ''
}

function imgToken(url: string): string {
  return url ? `img:${Buffer.from(url, 'utf8').toString('base64url')}` : ''
}

export function mapPost(raw: Record<string, unknown>, section: string): LibraryItem {
  const title = stripHtml(text((asRecord(raw.title) as Record<string, unknown> | null)?.rendered))
  const content = text((asRecord(raw.content) as Record<string, unknown> | null)?.rendered)
  const embedded = asRecord(raw._embedded)
  const featured = Array.isArray(embedded?.['wp:featuredmedia']) ? (embedded['wp:featuredmedia'] as unknown[]) : []
  const cover = text((asRecord(featured[0]) as Record<string, unknown> | null)?.source_url) || firstImage(content)
  const terms = Array.isArray(embedded?.['wp:term']) ? (embedded['wp:term'] as unknown[]) : []
  const categoryNames = asArray(terms[0])
    .map(entry => text((asRecord(entry) as Record<string, unknown> | null)?.name))
    .filter(Boolean)
  return {
    id: text(raw.id),
    kind: section === 'console' ? 'game' : 'game',
    section: section === 'console' ? 'console' : 'pc',
    source: 'gamer520',
    sourceId: text(raw.id),
    title,
    subtitle: '',
    cover,
    coverToken: imgToken(cover),
    category: categoryNames.join('、'),
    sizeText: '',
    meta: [],
    favorite: false,
    installed: false,
  }
}

export function gamer520Source(): SourceAdapter {
  const facets = (_section: string): SourceFacets => ({
    categories: [
      { id: '', label: '全部分类' },
      { id: CAT_PC, label: 'PC PLAY' },
      { id: CAT_SWITCH, label: 'Switch游戏下载' },
    ],
    sorts: [{ id: '', label: '默认' }],
  })

  return {
    kind: 'gamer520',
    label: '数据源2',
    // 该站点对非浏览器请求启用了 Cloudflare 校验，接口目前无法直接访问；如实告知，而不是让用户切过去只看到报错
    hint: '这个数据源的站点目前限制程序访问，可能加载失败；加载不出来请切回数据源1',
    facets,

    async list(query: LibraryQuery): Promise<Page<LibraryItem>> {
      const adapter = getAdapter()
      const search = splitChineseKeywords(query.keyword)
      const cat = query.category || (query.section === 'console' ? CAT_SWITCH : CAT_PC)
      let url = `${BASE}/wp-json/wp/v2/posts?per_page=24&page=${query.page}&_embed=true&categories=${encodeURIComponent(cat)}`
      if (search) url += `&search=${encodeURIComponent(search)}`
      const response = await adapter.request({ url, headers: { accept: 'application/json' }, timeoutMs: 20_000 })
      const bodyText = new TextDecoder('utf-8').decode(response.body)
      assertNotBlocked(response, bodyText)
      if (response.status !== 200) throw new BackendError('SOURCE_ERROR', `数据源2 暂时无法访问（HTTP ${response.status}）`)
      let posts: unknown
      try {
        posts = JSON.parse(bodyText)
      } catch {
        throw new BackendError('SOURCE_ERROR', '数据源2 返回了无法解析的数据')
      }
      const total = Number(response.headers['x-wp-total']) || (Array.isArray(posts) ? posts.length : 0)
      const totalPages = Number(response.headers['x-wp-totalpages']) || 1
      return {
        items: asArray(posts).filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null).map(entry => mapPost(entry, query.section)),
        page: query.page,
        totalPages: Math.max(1, totalPages),
        total,
      }
    },

    async detail(itemId): Promise<DetailData> {
      const adapter = getAdapter()
      const response = await adapter.request({ url: `${BASE}/wp-json/wp/v2/posts/${encodeURIComponent(itemId)}?_embed=true`, headers: { accept: 'application/json' }, timeoutMs: 20_000 })
      const bodyText = new TextDecoder('utf-8').decode(response.body)
      assertNotBlocked(response, bodyText)
      if (response.status !== 200) throw new BackendError('SOURCE_ERROR', `数据源2 暂时无法访问（HTTP ${response.status}）`)
      const raw = JSON.parse(bodyText) as Record<string, unknown>
      const item = mapPost(raw, 'pc')
      const content = text((asRecord(raw.content) as Record<string, unknown> | null)?.rendered)
      const media: MediaRef[] = []
      for (const match of content.matchAll(/<img[^>]+src=(?:"([^"]+)"|'([^']+)')/g)) {
        const url = match[1] ?? match[2] ?? ''
        if (url && !url.startsWith('data:')) media.push({ token: imgToken(url), type: 'image' })
      }
      return {
        item,
        media,
        description: content,
        datetime: text(raw.date),
        sizeText: '',
        installedSizeText: '',
        minConfig: '',
        recommendConfig: '',
        configSpec: { min: [], recommend: [] },
        officialUrl: text(raw.link),
        packages: [],
        trainerOptions: [],
        trainerGuides: [],
      }
    },

    async fileList(): Promise<ResourcePackage[]> {
      // gamer520 没有可解析的文件列表；下载走 downloadPageUrl 的手动下载页。
      return []
    },

    async downloadPageUrl(itemId): Promise<string> {
      const adapter = getAdapter()
      const ajax = await adapter.request({
        url: `${BASE}/wp-admin/admin-ajax.php`,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' },
        body: `action=user_down_ajax&post_id=${encodeURIComponent(itemId)}`,
        timeoutMs: 20_000,
      })
      const ajaxText = new TextDecoder('utf-8').decode(ajax.body)
      assertNotBlocked(ajax, ajaxText)
      const data = JSON.parse(ajaxText) as { status?: unknown; msg?: unknown }
      if (data.status !== '1' || typeof data.msg !== 'string') throw new BackendError('SOURCE_ERROR', '获取下载页地址失败')
      const page = await adapter.request({ url: data.msg, headers: { accept: 'text/html' }, timeoutMs: 20_000 })
      const html = new TextDecoder('utf-8').decode(page.body)
      assertNotBlocked(page, html)
      const redirect = /window\.location='([^']+)'/.exec(html)?.[1] ?? ''
      if (!redirect) throw new BackendError('SOURCE_ERROR', '解析下载页跳转失败')
      return redirect
    },
  }
}
