import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { pageNumber, stripHtml } from './types'

interface NasaSearchResponse {
  collection?: {
    items?: NasaVideoItem[]
    metadata?: { total_hits?: number }
  }
}

interface NasaVideoItem {
  href?: string
  data?: Array<{
    nasa_id?: string
    title?: string
    description?: string
    keywords?: string[]
    date_created?: string
    center?: string
    secondary_creator?: string
    media_type?: string
  }>
  links?: Array<{ href?: string; rel?: string; render?: string }>
}

interface NasaAssetResponse {
  collection?: { items?: Array<{ href?: string }> }
}

const limiter = new RateLimiter(20, 60_000)

export const nasaVideosSource: SourceAdapter = {
  descriptor: {
    id: 'nasa-videos',
    name: 'NASA Videos',
    description: 'NASA 视频库，公共领域为主；视频可直接作为动态壁纸素材。',
    homepage: 'https://images.nasa.gov',
    mediaTypes: ['video'],
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
            { value: '12', label: '12 个' },
            { value: '24', label: '24 个' },
          ],
        },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    await limiter.wait(context.signal)
    const page = pageNumber(query)
    const limit = Math.min(24, Math.max(1, Number(query.filters?.limit) || 12))
    const params = new URLSearchParams({
      q: query.query?.trim() || 'earth',
      media_type: 'video',
      page: String(page),
      page_size: String(limit),
    })
    const payload = await fetchJson<NasaSearchResponse>(`https://images-api.nasa.gov/search?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
    })
    const items = (payload.collection?.items ?? []).map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    const total = Number(payload.collection?.metadata?.total_hits) || 0
    return { items, page, hasMore: total > page * limit, total: total || undefined }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    await limiter.wait(context.signal)
    const payload = await fetchJson<NasaSearchResponse>(`https://images-api.nasa.gov/search?nasa_id=${encodeURIComponent(remoteId)}&media_type=video`, {
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 30_000,
    })
    const item = payload.collection?.items?.[0]
    return item ? toItem(item) : null
  },

  async resolve(item: WallpaperItem, context: SourceContext) {
    await limiter.wait(context.signal)
    const payload = await fetchJson<NasaAssetResponse>(`https://images-api.nasa.gov/asset/${encodeURIComponent(item.remoteId)}`, {
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 30_000,
    })
    const assets = (payload.collection?.items ?? []).map(entry => entry.href).filter((href): href is string => Boolean(href))
    const videos = assets.filter(href => /\.mp4$/i.test(href))
    const preferred = videos.find(href => /~orig\.mp4$/i.test(href))
      || videos.find(href => /~large\.mp4$/i.test(href))
      || videos.find(href => /~preview\.mp4$/i.test(href))
      || videos.at(-1)
    return { url: preferred || item.fullUrl }
  },
}

function toItem(raw: NasaVideoItem): WallpaperItem | null {
  const data = raw.data?.[0]
  const id = data?.nasa_id
  if (!id) return null
  const image = (raw.links ?? []).find(link => link.href && (!link.render || link.render === 'image'))?.href
  if (!image) return null
  return {
    sourceId: 'nasa-videos',
    remoteId: id,
    title: stripHtml(data?.title || `NASA video ${id}`),
    mediaType: 'video',
    thumbUrl: image,
    previewUrl: image,
    fullUrl: `https://images-api.nasa.gov/asset/${encodeURIComponent(id)}`,
    mime: 'video/mp4',
    author: data?.secondary_creator ? stripHtml(data.secondary_creator) : 'NASA',
    license: data?.secondary_creator ? 'NASA / 次级创作者' : '公共领域（NASA）',
    licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(id)}`,
    attribution: data?.secondary_creator ? `NASA · ${stripHtml(data.secondary_creator)}` : 'NASA',
    tags: data?.keywords?.slice(0, 20),
    downloadAllowed: true,
    exportAllowed: true,
    meta: {
      date: data?.date_created ?? null,
      center: data?.center ?? null,
      description: data?.description ? stripHtml(data.description).slice(0, 600) : null,
    },
  }
}
