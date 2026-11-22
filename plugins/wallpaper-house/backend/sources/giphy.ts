import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterString, pageNumber, requireSourceKey } from './types'

interface GiphyResponse {
  data?: GiphyGif[]
  pagination?: { total_count?: number; count?: number; offset?: number }
}

interface GiphyGif {
  id?: string
  title?: string
  url?: string
  rating?: string
  user?: { display_name?: string; username?: string; profile_url?: string }
  images?: Record<string, { url?: string; width?: string; height?: string; mp4?: string; webp?: string } | undefined>
}

const limiter = new RateLimiter(20, 60_000)

export const giphySource: SourceAdapter = {
  descriptor: {
    id: 'giphy',
    name: 'GIPHY',
    description: '动态 GIF 素材；需要 GIPHY API Key。适合轻量动态壁纸与预览。',
    homepage: 'https://giphy.com',
    mediaTypes: ['gif'],
    requiresKey: true,
    keyLabel: 'GIPHY API Key',
    keyUrl: 'https://developers.giphy.com',
    builtin: true,
    enabledByDefault: false,
    supportsSearch: true,
    supportsPagination: true,
    facets: {
      items: [
        {
          key: 'rating',
          label: '分级',
          type: 'select',
          default: 'pg-13',
          options: [
            { value: 'g', label: 'G' },
            { value: 'pg', label: 'PG' },
            { value: 'pg-13', label: 'PG-13' },
            { value: 'r', label: 'R' },
          ],
        },
        {
          key: 'lang',
          label: '语言',
          type: 'select',
          default: 'en',
          options: [
            { value: 'en', label: 'English' },
            { value: 'zh-CN', label: '中文' },
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
      api_key: key,
      q: query.query?.trim() || 'abstract',
      limit: '24',
      offset: String((page - 1) * 24),
      rating: filterString(filters, 'rating', 'pg-13'),
      lang: filterString(filters, 'lang', 'en'),
    })
    const payload = await fetchJson<GiphyResponse>(`https://api.giphy.com/v1/gifs/search?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
    })
    const items = (payload.data ?? []).map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    const total = Number(payload.pagination?.total_count) || 0
    return { items, page, hasMore: page * 24 < total, total: total || undefined }
  },
}

function toItem(raw: GiphyGif): WallpaperItem | null {
  const original = raw.images?.original
  const fixed = raw.images?.fixed_width
  if (!raw.id || !original?.url) return null
  const author = raw.user?.display_name || raw.user?.username
  return {
    sourceId: 'giphy',
    remoteId: raw.id,
    title: raw.title || `GIPHY ${raw.id}`,
    mediaType: 'gif',
    thumbUrl: fixed?.webp || fixed?.url || original.url,
    previewUrl: fixed?.url || original.url,
    fullUrl: original.url,
    width: Number(original.width) || undefined,
    height: Number(original.height) || undefined,
    mime: 'image/gif',
    author,
    authorUrl: raw.user?.profile_url,
    license: 'GIPHY',
    licenseUrl: 'https://giphy.com/terms',
    sourceUrl: raw.url,
    attribution: author ? `GIF by ${author} on GIPHY` : 'GIPHY',
    downloadAllowed: true,
    exportAllowed: false,
    meta: { rating: raw.rating ?? null },
  }
}
