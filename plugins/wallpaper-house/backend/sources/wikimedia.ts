import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { pageNumber, stripHtml } from './types'

interface CommonsResponse {
  query?: {
    pages?: Record<string, CommonsPage>
  }
  continue?: { gsroffset?: number }
}

interface CommonsPage {
  pageid?: number
  title?: string
  imageinfo?: Array<{
    url?: string
    descriptionurl?: string
    thumburl?: string
    width?: number
    height?: number
    size?: number
    mime?: string
    extmetadata?: Record<string, { value?: string }>
  }>
}

const limiter = new RateLimiter(20, 60_000)

export const wikimediaSource: SourceAdapter = {
  descriptor: {
    id: 'wikimedia',
    name: 'Wikimedia Commons',
    description: '公共领域与 CC 授权图片，适合作为安全、可署名的壁纸来源。',
    homepage: 'https://commons.wikimedia.org',
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
    const term = (query.query || '').trim()
    const search = term ? `${term} filetype:bitmap` : 'filetype:bitmap landscape wallpaper'
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: search,
      gsrnamespace: '6',
      gsrlimit: String(limit),
      gsroffset: String((page - 1) * limit),
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata|mime',
      iiurlwidth: '480',
      iiextmetadatafilter: 'LicenseShortName|Artist|Credit|LicenseUrl|ImageDescription',
    })
    const payload = await fetchJson<CommonsResponse>(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
    })
    const pages = payload.query?.pages ? Object.values(payload.query.pages) : []
    const items = pages.map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    return {
      items,
      page,
      hasMore: Boolean(payload.continue?.gsroffset) || pages.length >= limit,
    }
  },
}

function toItem(page: CommonsPage): WallpaperItem | null {
  const info = page.imageinfo?.[0]
  if (!info?.url || !page.pageid) return null
  const meta = info.extmetadata ?? {}
  const license = stripHtml(meta.LicenseShortName?.value || 'Wikimedia Commons')
  const artist = stripHtml(meta.Artist?.value || meta.Credit?.value || '')
  const description = stripHtml(meta.ImageDescription?.value || '')
  const title = (page.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '') || `Commons ${page.pageid}`
  return {
    sourceId: 'wikimedia',
    remoteId: String(page.pageid),
    title,
    mediaType: 'image',
    thumbUrl: info.thumburl || info.url,
    previewUrl: info.thumburl || info.url,
    fullUrl: info.url,
    width: info.width,
    height: info.height,
    fileSize: info.size,
    mime: info.mime,
    author: artist || undefined,
    license,
    licenseUrl: stripHtml(meta.LicenseUrl?.value || '') || undefined,
    sourceUrl: info.descriptionurl || `https://commons.wikimedia.org/?curid=${page.pageid}`,
    attribution: [artist, license].filter(Boolean).join(' · ') || 'Wikimedia Commons',
    downloadAllowed: true,
    exportAllowed: true,
    meta: { description: description.slice(0, 600) },
  }
}
