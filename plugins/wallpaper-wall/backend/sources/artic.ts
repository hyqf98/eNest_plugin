import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { pageNumber, stripHtml } from './types'

interface ArticResponse {
  data?: ArticArtwork[]
  pagination?: { total?: number; current_page?: number; total_pages?: number }
}

interface ArticArtwork {
  id?: number
  title?: string
  image_id?: string | null
  artist_display?: string
  date_display?: string
  is_public_domain?: boolean
  classification_title?: string
  color?: { h?: number; s?: number; l?: number; population?: number }
}

const limiter = new RateLimiter(20, 60_000)

export const articSource: SourceAdapter = {
  descriptor: {
    id: 'artic',
    name: '芝加哥艺术博物馆',
    description: 'Art Institute of Chicago 公共领域艺术作品，适合作为艺术类壁纸。',
    homepage: 'https://www.artic.edu',
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
      q: query.query?.trim() || 'landscape',
      page: String(page),
      limit: String(limit),
      fields: 'id,title,image_id,artist_display,date_display,is_public_domain,classification_title,color',
    })
    const payload = await fetchJson<ArticResponse>(`https://api.artic.edu/api/v1/artworks/search?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
    })
    const items = (payload.data ?? []).map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    const totalPages = Number(payload.pagination?.total_pages) || page
    return {
      items,
      page,
      hasMore: page < totalPages,
      total: Number(payload.pagination?.total) || undefined,
    }
  },
}

function toItem(raw: ArticArtwork): WallpaperItem | null {
  if (!raw.id || !raw.image_id) return null
  const iiif = `https://www.artic.edu/iiif/2/${raw.image_id}`
  return {
    sourceId: 'artic',
    remoteId: String(raw.id),
    title: stripHtml(raw.title || `Artwork ${raw.id}`),
    mediaType: 'image',
    thumbUrl: `${iiif}/full/400,/0/default.jpg`,
    previewUrl: `${iiif}/full/1686,/0/default.jpg`,
    fullUrl: `${iiif}/full/1686,/0/default.jpg`,
    author: stripHtml(raw.artist_display || ''),
    license: raw.is_public_domain ? '公共领域（CC0）' : 'Art Institute of Chicago',
    licenseUrl: 'https://www.artic.edu/open-access',
    sourceUrl: `https://www.artic.edu/artworks/${raw.id}`,
    attribution: [stripHtml(raw.artist_display || ''), raw.is_public_domain ? '公共领域' : 'Art Institute of Chicago'].filter(Boolean).join(' · '),
    downloadAllowed: true,
    exportAllowed: Boolean(raw.is_public_domain),
    meta: {
      date: stripHtml(raw.date_display || ''),
      classification: raw.classification_title ?? null,
      publicDomain: Boolean(raw.is_public_domain),
    },
  }
}
