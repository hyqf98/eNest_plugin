import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterString, pageNumber, requireSourceKey } from './types'

interface UnsplashResponse {
  results?: UnsplashPhoto[]
  total?: number
  total_pages?: number
}

interface UnsplashPhoto {
  id?: string
  description?: string | null
  alt_description?: string | null
  width?: number
  height?: number
  color?: string
  likes?: number
  user?: { name?: string; username?: string; links?: { html?: string } }
  links?: { html?: string; download_location?: string }
  urls?: { raw?: string; full?: string; regular?: string; small?: string; thumb?: string }
}

const limiter = new RateLimiter(45, 60_000)

export const unsplashSource: SourceAdapter = {
  descriptor: {
    id: 'unsplash',
    name: 'Unsplash',
    description: '高质量摄影图库；需要免费 Access Key。下载时会触发 Unsplash 统计端点。',
    homepage: 'https://unsplash.com',
    mediaTypes: ['image'],
    requiresKey: true,
    keyLabel: 'Unsplash Access Key',
    keyUrl: 'https://unsplash.com/developers',
    builtin: true,
    enabledByDefault: false,
    supportsSearch: true,
    supportsPagination: true,
    notices: ['按 Unsplash 要求展示摄影师署名，并在下载时触发统计端点。'],
    facets: {
      items: [
        {
          key: 'orientation',
          label: '方向',
          type: 'select',
          default: 'landscape',
          options: [
            { value: '', label: '不限' },
            { value: 'landscape', label: '横向' },
            { value: 'portrait', label: '纵向' },
            { value: 'squarish', label: '方形' },
          ],
        },
        {
          key: 'color',
          label: '颜色',
          type: 'color',
          default: '',
          values: ['#000000', '#ffffff', '#f5c518', '#f97316', '#ef4444', '#a855f7', '#10b981', '#14b8a6', '#3b82f6'],
        },
        {
          key: 'order_by',
          label: '排序',
          type: 'sort',
          default: 'relevant',
          options: [
            { value: 'relevant', label: '相关度' },
            { value: 'latest', label: '最新' },
          ],
        },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    const key = requireSourceKey(context)
    await limiter.wait(context.signal)
    const page = pageNumber(query)
    const filters = query.filters ?? {}
    const params = new URLSearchParams({
      query: query.query?.trim() || 'wallpaper',
      page: String(page),
      per_page: '24',
      order_by: filterString(filters, 'order_by', 'relevant'),
    })
    const orientation = filterString(filters, 'orientation', 'landscape')
    if (orientation) params.set('orientation', orientation)
    const color = filterString(filters, 'color').replace('#', '')
    if (color) params.set('color', color)
    const payload = await fetchJson<UnsplashResponse>(`https://api.unsplash.com/search/photos?${params.toString()}`, {
      headers: { authorization: `Client-ID ${key}` },
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
    })
    const items = (payload.results ?? []).map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    return {
      items,
      page,
      hasMore: page < (Number(payload.total_pages) || page),
      total: Number(payload.total) || undefined,
    }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    const key = requireSourceKey(context)
    await limiter.wait(context.signal)
    const payload = await fetchJson<UnsplashPhoto>(`https://api.unsplash.com/photos/${encodeURIComponent(remoteId)}`, {
      headers: { authorization: `Client-ID ${key}` },
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
    })
    return toItem(payload)
  },

  async resolve(item: WallpaperItem, context: SourceContext) {
    const key = requireSourceKey(context)
    const downloadLocation = item.meta?.downloadLocation
    if (typeof downloadLocation === 'string' && downloadLocation.startsWith('https://')) {
      await fetchJson<unknown>(downloadLocation, {
        headers: { authorization: `Client-ID ${key}` },
        signal: context.signal,
        maxBytes: 64 * 1024,
      }).catch(() => null)
    }
    return { url: item.fullUrl }
  },
}

function toItem(raw: UnsplashPhoto): WallpaperItem | null {
  const id = raw.id
  const fullUrl = raw.urls?.full || raw.urls?.regular
  if (!id || !fullUrl) return null
  const sourceUrl = raw.links?.html || `https://unsplash.com/photos/${id}`
  const author = raw.user?.name || raw.user?.username || 'Unsplash'
  return {
    sourceId: 'unsplash',
    remoteId: id,
    title: raw.description || raw.alt_description || `Unsplash ${id}`,
    mediaType: 'image',
    thumbUrl: raw.urls?.small || raw.urls?.thumb || raw.urls?.regular || fullUrl,
    previewUrl: raw.urls?.regular || fullUrl,
    fullUrl,
    width: raw.width,
    height: raw.height,
    author,
    authorUrl: raw.user?.links?.html,
    license: 'Unsplash License',
    licenseUrl: 'https://unsplash.com/license',
    sourceUrl,
    attribution: `Photo by ${author} on Unsplash`,
    color: raw.color,
    downloadAllowed: true,
    exportAllowed: true,
    meta: {
      downloadLocation: raw.links?.download_location ?? null,
      likes: raw.likes ?? null,
    },
  }
}
