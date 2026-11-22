import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterBoolean, filterNumber, pageNumber, pageSize } from './types'

interface PicsumItem {
  id?: string
  author?: string
  width?: number
  height?: number
  url?: string
  download_url?: string
}

const limiter = new RateLimiter(20, 60_000)

export const picsumSource: SourceAdapter = {
  descriptor: {
    id: 'picsum',
    name: 'Lorem Picsum',
    description: 'Unsplash 来源的演示图库，适合快速测试与占位。',
    homepage: 'https://picsum.photos',
    mediaTypes: ['image'],
    requiresKey: false,
    builtin: true,
    enabledByDefault: true,
    supportsSearch: false,
    supportsPagination: true,
    facets: {
      items: [
        {
          key: 'limit',
          label: '每页',
          type: 'select',
          default: 30,
          options: [
            { value: '20', label: '20 张' },
            { value: '30', label: '30 张' },
            { value: '50', label: '50 张' },
          ],
        },
        { key: 'grayscale', label: '灰度', type: 'toggle', default: false },
        {
          key: 'blur',
          label: '模糊',
          type: 'range',
          default: 0,
          min: 0,
          max: 5,
          step: 1,
        },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    await limiter.wait(context.signal)
    const page = pageNumber(query)
    const limit = Math.min(50, pageSize(query, filterNumber(query.filters ?? {}, 'limit', 30), 50))
    const payload = await fetchJson<PicsumItem[]>(`https://picsum.photos/v2/list?page=${page}&limit=${limit}`, {
      signal: context.signal,
      maxBytes: 2 * 1024 * 1024,
    })
    const grayscale = filterBoolean(query.filters ?? {}, 'grayscale')
    const blur = Math.min(5, Math.max(0, filterNumber(query.filters ?? {}, 'blur', 0)))
    const suffix = `${grayscale ? '?grayscale' : '?'}${blur > 0 ? `${grayscale ? '&' : ''}blur=${blur}` : ''}`
    const items = payload.map(raw => toItem(raw, suffix)).filter((item): item is WallpaperItem => Boolean(item))
    return { items, page, hasMore: payload.length >= limit, total: undefined }
  },
}

function toItem(raw: PicsumItem, suffix: string): WallpaperItem | null {
  if (!raw.id || !raw.download_url) return null
  const id = raw.id
  return {
    sourceId: 'picsum',
    remoteId: id,
    title: `Picsum #${id}`,
    mediaType: 'image',
    thumbUrl: `https://picsum.photos/id/${id}/480/300${suffix}`,
    previewUrl: `https://picsum.photos/id/${id}/1920/1080${suffix}`,
    fullUrl: raw.download_url,
    width: raw.width,
    height: raw.height,
    author: raw.author,
    license: 'Unsplash License',
    licenseUrl: 'https://unsplash.com/license',
    sourceUrl: raw.url || `https://picsum.photos/id/${id}`,
    attribution: raw.author ? `Photo by ${raw.author} on Unsplash` : 'Lorem Picsum',
    downloadAllowed: true,
    exportAllowed: true,
  }
}
