import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterNumber, stripHtml } from './types'

interface ApodItem {
  date?: string
  title?: string
  explanation?: string
  url?: string
  hdurl?: string
  media_type?: string
  copyright?: string
  service_version?: string
}

const limiter = new RateLimiter(10, 60_000)

export const nasaApodSource: SourceAdapter = {
  descriptor: {
    id: 'nasa-apod',
    name: 'NASA APOD',
    description: 'NASA 每日天文图，公共领域为主；没有 copyright 字段的图片可自由使用。',
    homepage: 'https://apod.nasa.gov',
    mediaTypes: ['image'],
    requiresKey: false,
    keyLabel: 'NASA API Key（可选，申请后额度更高）',
    keyUrl: 'https://api.nasa.gov',
    builtin: true,
    enabledByDefault: true,
    supportsSearch: false,
    supportsPagination: false,
    facets: {
      items: [
        {
          key: 'count',
          label: '数量',
          type: 'select',
          default: 12,
          options: [
            { value: '12', label: '12 张' },
            { value: '24', label: '24 张' },
            { value: '25', label: '25 张' },
          ],
        },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    await limiter.wait(context.signal)
    const count = Math.min(25, Math.max(1, filterNumber(query.filters ?? {}, 'count', 12)))
    const payload = await fetchJson<ApodItem | ApodItem[]>(
      `https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(context.key || 'DEMO_KEY')}&count=${count}&hd=true`,
      { signal: context.signal, maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 },
    )
    const raw = Array.isArray(payload) ? payload : [payload]
    const items = raw.map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    return { items, page: 1, hasMore: false, total: items.length }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    await limiter.wait(context.signal)
    const payload = await fetchJson<ApodItem>(
      `https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(context.key || 'DEMO_KEY')}&date=${encodeURIComponent(remoteId)}&hd=true`,
      { signal: context.signal, maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 },
    )
    return toItem(payload)
  },
}

function toItem(raw: ApodItem): WallpaperItem | null {
  if (raw.media_type !== 'image' || !raw.url) return null
  const date = raw.date || ''
  const fullUrl = raw.hdurl || raw.url
  const pageDate = date.replace(/-/g, '').slice(2)
  return {
    sourceId: 'nasa-apod',
    remoteId: date || fullUrl,
    title: raw.title || `APOD ${date}`,
    mediaType: 'image',
    thumbUrl: raw.url,
    previewUrl: raw.url,
    fullUrl,
    author: raw.copyright ? stripHtml(raw.copyright) : 'NASA',
    license: raw.copyright ? 'NASA / 版权方' : '公共领域（NASA）',
    licenseUrl: 'https://apod.nasa.gov/apod/lib/about_apod.html',
    sourceUrl: pageDate ? `https://apod.nasa.gov/apod/ap${pageDate}.html` : 'https://apod.nasa.gov',
    attribution: raw.copyright ? `NASA APOD · ${stripHtml(raw.copyright)}` : 'NASA APOD',
    downloadAllowed: true,
    exportAllowed: true,
    meta: { date, explanation: raw.explanation ? stripHtml(raw.explanation).slice(0, 600) : null },
  }
}
