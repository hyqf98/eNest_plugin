import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterString, pageNumber, stripHtml } from './types'

interface MetSearch {
  total?: number
  objectIDs?: number[] | null
}

interface MetObject {
  objectID?: number
  title?: string
  artistDisplayName?: string
  objectURL?: string
  primaryImage?: string
  primaryImageSmall?: string
  isPublicDomain?: boolean
  objectDate?: string
  department?: string
  medium?: string
}

const limiter = new RateLimiter(20, 60_000)
const DEPARTMENTS = [
  { value: '', label: '全部部门' },
  { value: '11', label: '欧洲绘画' },
  { value: '21', label: '现代艺术' },
  { value: '9', label: '素描与版画' },
  { value: '6', label: '亚洲艺术' },
  { value: '1', label: '美国装饰艺术' },
]

export const metSource: SourceAdapter = {
  descriptor: {
    id: 'met',
    name: '大都会艺术博物馆',
    description: 'The Met 公共领域艺术藏品；详情请求较多，单页数量限制在 24。',
    homepage: 'https://www.metmuseum.org',
    mediaTypes: ['image'],
    requiresKey: false,
    builtin: true,
    enabledByDefault: true,
    supportsSearch: true,
    supportsPagination: true,
    facets: {
      items: [
        {
          key: 'limit',
          label: '每页',
          type: 'select',
          default: 12,
          options: [
            { value: '12', label: '12 张' },
            { value: '24', label: '24 张' },
          ],
        },
        { key: 'departmentId', label: '部门', type: 'select', default: '', options: DEPARTMENTS },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    await limiter.wait(context.signal)
    const page = pageNumber(query)
    const limit = Math.min(24, Math.max(1, Number(query.filters?.limit) || 12))
    const params = new URLSearchParams({
      hasImages: 'true',
      q: query.query?.trim() || 'landscape',
      limit: String(limit),
      offset: String((page - 1) * limit),
    })
    const departmentId = filterString(query.filters ?? {}, 'departmentId')
    if (departmentId) params.set('departmentId', departmentId)
    const search = await fetchJson<MetSearch>(`https://collectionapi.metmuseum.org/public/collection/v1.1/search?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
    })
    const ids = (search.objectIDs ?? []).slice(0, limit)
    const settled = await Promise.allSettled(ids.map(async id => {
      const detail = await fetchJson<MetObject>(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, {
        signal: context.signal,
        maxBytes: 2 * 1024 * 1024,
      })
      return toItem(detail)
    }))
    const items = settled
      .map(result => result.status === 'fulfilled' ? result.value : null)
      .filter((item): item is WallpaperItem => Boolean(item))
    return {
      items,
      page,
      hasMore: (Number(search.total) || 0) > page * limit,
      total: search.total,
    }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    await limiter.wait(context.signal)
    const payload = await fetchJson<MetObject>(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${encodeURIComponent(remoteId)}`, {
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
    })
    return toItem(payload)
  },
}

function toItem(raw: MetObject): WallpaperItem | null {
  const fullUrl = raw.primaryImage
  if (!raw.objectID || !fullUrl) return null
  const thumb = raw.primaryImageSmall || fullUrl
  return {
    sourceId: 'met',
    remoteId: String(raw.objectID),
    title: stripHtml(raw.title || `Met ${raw.objectID}`),
    mediaType: 'image',
    thumbUrl: thumb,
    previewUrl: thumb,
    fullUrl,
    author: stripHtml(raw.artistDisplayName || ''),
    license: raw.isPublicDomain ? '公共领域（CC0）' : 'The Metropolitan Museum of Art',
    licenseUrl: 'https://www.metmuseum.org/about-the-met/policies-and-documents/open-access',
    sourceUrl: raw.objectURL,
    attribution: [stripHtml(raw.artistDisplayName || ''), raw.isPublicDomain ? '公共领域' : 'The Met'].filter(Boolean).join(' · '),
    downloadAllowed: true,
    exportAllowed: Boolean(raw.isPublicDomain),
    meta: {
      date: stripHtml(raw.objectDate || ''),
      department: raw.department ?? null,
      medium: stripHtml(raw.medium || ''),
      publicDomain: Boolean(raw.isPublicDomain),
    },
  }
}
