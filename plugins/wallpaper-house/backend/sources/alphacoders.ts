import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { pageNumber, requireSourceKey } from './types'

interface AlphaResponse {
  success?: boolean
  wallpapers?: AlphaWallpaper[]
  total_match?: number
  error?: string
}

interface AlphaWallpaper {
  id?: number | string
  url_image?: string
  url_thumb?: string
  url_page?: string
  width?: number
  height?: number
  category?: string
  sub_category?: string
  file_size?: number
  file_type?: string
}

const limiter = new RateLimiter(20, 60_000)

export const alphaCodersSource: SourceAdapter = {
  descriptor: {
    id: 'alphacoders',
    name: 'Alpha Coders',
    description: 'Wallpaper Abyss 官方 API；需要 Alpha Coders API Key。内容权利归原上传者。',
    homepage: 'https://wall.alphacoders.com',
    mediaTypes: ['image'],
    requiresKey: true,
    keyLabel: 'Alpha Coders API Key',
    keyUrl: 'https://wall.alphacoders.com/api.php',
    builtin: true,
    enabledByDefault: false,
    supportsSearch: true,
    supportsPagination: true,
    notices: ['使用官方 API；请遵守 Alpha Coders 条款，不批量抓取。'],
    facets: {
      items: [
        {
          key: 'operator',
          label: '关键词匹配',
          type: 'select',
          default: 'and',
          options: [
            { value: 'and', label: '全部词' },
            { value: 'or', label: '任一词' },
          ],
        },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    const key = requireSourceKey(context)
    await limiter.wait(context.signal)
    const page = pageNumber(query)
    const params = new URLSearchParams({
      auth: key,
      method: 'search',
      term: query.query?.trim() || 'landscape',
      page: String(page),
      operator: query.filters?.operator === 'or' ? 'or' : 'and',
    })
    const payload = await fetchJson<AlphaResponse>(`https://wall.alphacoders.com/api2.0/get.php?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
    })
    if (payload.success === false) throw new Error(payload.error || 'Alpha Coders 请求失败')
    const items = (payload.wallpapers ?? []).map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    const total = Number(payload.total_match) || 0
    return { items, page, hasMore: page * 30 < total, total: total || undefined }
  },
}

function toItem(raw: AlphaWallpaper): WallpaperItem | null {
  if (!raw.id || !raw.url_image) return null
  return {
    sourceId: 'alphacoders',
    remoteId: String(raw.id),
    title: `${raw.category || 'Wallpaper'} ${raw.sub_category || raw.id}`.trim(),
    mediaType: 'image',
    thumbUrl: raw.url_thumb || raw.url_image,
    previewUrl: raw.url_thumb || raw.url_image,
    fullUrl: raw.url_image,
    width: raw.width,
    height: raw.height,
    fileSize: raw.file_size,
    mime: raw.file_type ? `image/${raw.file_type.replace(/^\./, '')}` : undefined,
    license: 'Alpha Coders / 原上传者',
    licenseUrl: 'https://wall.alphacoders.com/terms.php',
    sourceUrl: raw.url_page,
    attribution: 'Wallpaper Abyss',
    downloadAllowed: true,
    exportAllowed: false,
    meta: { category: raw.category ?? null, subCategory: raw.sub_category ?? null },
  }
}
