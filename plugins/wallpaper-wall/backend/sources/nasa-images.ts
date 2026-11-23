import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { pageNumber, stripHtml } from './types'

interface NasaSearchResponse {
  collection?: {
    items?: NasaItem[]
    metadata?: { total_hits?: number }
    links?: Array<{ href?: string; rel?: string }>
  }
}

interface NasaItem {
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

export const nasaImagesSource: SourceAdapter = {
  descriptor: {
    id: 'nasa-images',
    name: 'NASA Image Library',
    description: 'NASA 图像库，公共领域为主，适合搜索航天、地球与深空主题。',
    homepage: 'https://images.nasa.gov',
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
          default: 24,
          options: [
            { value: '24', label: '24 张' },
            { value: '48', label: '48 张' },
          ],
        },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    await limiter.wait(context.signal)
    const page = pageNumber(query)
    const limit = Math.min(48, Math.max(1, Number(query.filters?.limit) || 24))
    const params = new URLSearchParams({
      q: query.query?.trim() || 'earth',
      media_type: 'image',
      page: String(page),
      page_size: String(limit),
    })
    const payload = await fetchJson<NasaSearchResponse>(`https://images-api.nasa.gov/search?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
    })
    const items = (payload.collection?.items ?? []).map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    const total = Number(payload.collection?.metadata?.total_hits) || 0
    return { items, page, hasMore: total > page * limit, total: total || undefined }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    await limiter.wait(context.signal)
    const payload = await fetchJson<NasaSearchResponse>(`https://images-api.nasa.gov/search?nasa_id=${encodeURIComponent(remoteId)}&media_type=image`, {
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
    })
    const item = payload.collection?.items?.[0]
    return item ? toItem(item) : null
  },

  async resolve(item: WallpaperItem, context: SourceContext) {
    await limiter.wait(context.signal)
    const payload = await fetchJson<NasaAssetResponse>(`https://images-api.nasa.gov/asset/${encodeURIComponent(item.remoteId)}`, {
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
    })
    const assets = (payload.collection?.items ?? []).map(entry => entry.href).filter((href): href is string => Boolean(href))
    const images = assets.filter(href => /\.(jpe?g|png)$/i.test(href))
    const preferred = images.find(href => /~orig\.(jpe?g|png)$/i.test(href))
      || images.find(href => /~large\.(jpe?g|png)$/i.test(href))
      || images.at(-1)
    return { url: preferred || item.fullUrl }
  },
}

function toItem(raw: NasaItem): WallpaperItem | null {
  const data = raw.data?.[0]
  const id = data?.nasa_id
  if (!id) return null
  const imageLinks = (raw.links ?? []).filter(link => link.href && (!link.render || link.render === 'image'))
  const thumb = imageLinks[0]?.href
  if (!thumb) return null
  const title = stripHtml(data?.title || `NASA ${id}`)
  return {
    sourceId: 'nasa-images',
    remoteId: id,
    title,
    mediaType: 'image',
    thumbUrl: thumb,
    previewUrl: thumb,
    fullUrl: `https://images-api.nasa.gov/asset/${encodeURIComponent(id)}`,
    author: data?.secondary_creator ? stripHtml(data.secondary_creator) : 'NASA',
    license: data?.secondary_creator ? 'NASA / 次级创作者' : '公共领域（NASA）',
    licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(id)}`,
    attribution: data?.secondary_creator ? `NASA · ${stripHtml(data.secondary_creator)}` : 'NASA',
    tags: data?.keywords?.slice(0, 24),
    downloadAllowed: true,
    exportAllowed: true,
    meta: {
      date: data?.date_created ?? null,
      center: data?.center ?? null,
      description: data?.description ? stripHtml(data.description).slice(0, 600) : null,
    },
  }
}
