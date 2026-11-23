import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterString, pageNumber } from './types'

interface OpenverseResponse {
  result_count?: number
  page_count?: number
  results?: OpenverseImage[]
}

interface OpenverseImage {
  id?: string
  title?: string
  creator?: string
  creator_url?: string
  url?: string
  thumbnail?: string
  foreign_landing_url?: string
  license?: string
  license_version?: string
  license_url?: string
  source?: string
  width?: number
  height?: number
  filesize?: number
  filetype?: string
  attribution?: string
}

const limiter = new RateLimiter(20, 60_000)

export const openverseSource: SourceAdapter = {
  descriptor: {
    id: 'openverse',
    name: 'Openverse',
    description: '跨站 CC 图片搜索（Flickr、Wikimedia 等），可按许可、尺寸与比例过滤。',
    homepage: 'https://openverse.org',
    mediaTypes: ['image'],
    requiresKey: false,
    builtin: true,
    enabledByDefault: true,
    supportsSearch: true,
    supportsPagination: true,
    facets: {
      items: [
        {
          key: 'license_type',
          label: '许可',
          type: 'select',
          default: 'all-cc',
          options: [
            { value: 'all-cc', label: '全部 CC' },
            { value: 'commercial', label: '允许商用' },
            { value: 'modification', label: '允许修改' },
          ],
        },
        {
          key: 'size',
          label: '尺寸',
          type: 'select',
          default: '',
          options: [
            { value: '', label: '不限' },
            { value: 'large', label: '大图' },
            { value: 'medium', label: '中图' },
          ],
        },
        {
          key: 'aspect_ratio',
          label: '比例',
          type: 'select',
          default: 'wide',
          options: [
            { value: '', label: '不限' },
            { value: 'wide', label: '横向' },
            { value: 'tall', label: '纵向' },
            { value: 'square', label: '方形' },
          ],
        },
        {
          key: 'extension',
          label: '格式',
          type: 'select',
          default: 'jpg',
          options: [
            { value: '', label: '不限' },
            { value: 'jpg', label: 'JPG' },
            { value: 'png', label: 'PNG' },
            { value: 'webp', label: 'WebP' },
          ],
        },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    await limiter.wait(context.signal)
    const page = pageNumber(query)
    const filters = query.filters ?? {}
    const params = new URLSearchParams({
      q: query.query?.trim() || 'landscape wallpaper',
      page: String(page),
      page_size: '20',
      license_type: filterString(filters, 'license_type', 'all-cc'),
      mature: 'false',
    })
    for (const key of ['size', 'aspect_ratio', 'extension'] as const) {
      const value = filterString(filters, key)
      if (value) params.set(key, value)
    }
    const payload = await fetchJson<OpenverseResponse>(`https://api.openverse.org/v1/images/?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
    })
    const items = (payload.results ?? []).map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    const pageCount = Number(payload.page_count) || page
    return {
      items,
      page,
      hasMore: page < pageCount,
      total: Number(payload.result_count) || undefined,
    }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    await limiter.wait(context.signal)
    const payload = await fetchJson<OpenverseImage>(`https://api.openverse.org/v1/images/${encodeURIComponent(remoteId)}/`, {
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 30_000,
    })
    return toItem(payload)
  },
}

function toItem(raw: OpenverseImage): WallpaperItem | null {
  if (!raw.id || !raw.url) return null
  const license = [raw.license?.toUpperCase(), raw.license_version].filter(Boolean).join(' ')
  return {
    sourceId: 'openverse',
    remoteId: raw.id,
    title: raw.title || `Openverse ${raw.id}`,
    mediaType: 'image',
    thumbUrl: raw.thumbnail || raw.url,
    previewUrl: raw.thumbnail || raw.url,
    fullUrl: raw.url,
    width: raw.width,
    height: raw.height,
    fileSize: raw.filesize,
    mime: raw.filetype ? `image/${raw.filetype}` : undefined,
    author: raw.creator,
    authorUrl: raw.creator_url,
    license: license || 'CC',
    licenseUrl: raw.license_url,
    sourceUrl: raw.foreign_landing_url,
    attribution: raw.attribution || [raw.creator, license].filter(Boolean).join(' · '),
    downloadAllowed: true,
    exportAllowed: true,
    meta: { source: raw.source ?? null },
  }
}
