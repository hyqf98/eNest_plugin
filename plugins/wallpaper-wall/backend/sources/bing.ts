import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterString, stripHtml } from './types'

interface BingImage {
  startdate?: string
  fullstartdate?: string
  enddate?: string
  url?: string
  urlbase?: string
  copyright?: string
  copyrightlink?: string
  title?: string
  quiz?: string
}

interface BingResponse {
  images?: BingImage[]
}

const limiter = new RateLimiter(10, 60_000)

export const bingSource: SourceAdapter = {
  descriptor: {
    id: 'bing-daily',
    name: 'Bing 每日一图',
    description: 'Bing 每日精选图片。仅用于个人桌面壁纸，不提供导出或再分发。',
    homepage: 'https://www.bing.com',
    mediaTypes: ['image'],
    requiresKey: false,
    builtin: true,
    enabledByDefault: true,
    supportsSearch: false,
    supportsPagination: false,
    notices: ['Bing 图片仅限个人桌面使用，不进入可导出本地库。'],
    facets: {
      items: [
        {
          key: 'mkt',
          label: '地区',
          type: 'select',
          default: 'zh-CN',
          options: [
            { value: 'zh-CN', label: '中国' },
            { value: 'en-US', label: '美国' },
            { value: 'ja-JP', label: '日本' },
            { value: 'en-GB', label: '英国' },
            { value: 'de-DE', label: '德国' },
          ],
        },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    await limiter.wait(context.signal)
    const mkt = filterString(query.filters ?? {}, 'mkt', 'zh-CN')
    const payload = await fetchJson<BingResponse>(
      `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=${encodeURIComponent(mkt)}`,
      { signal: context.signal, maxBytes: 2 * 1024 * 1024 },
    )
    const items = (payload.images ?? []).map((image, index) => toItem(image, index, mkt)).filter((item): item is WallpaperItem => Boolean(item))
    return { items, page: 1, hasMore: false, total: items.length }
  },
}

function toItem(raw: BingImage, index: number, mkt: string): WallpaperItem | null {
  if (!raw.urlbase && !raw.url) return null
  const base = raw.urlbase || (raw.url ? raw.url.replace(/_[\d]+x[\d]+\.jpg$/i, '') : '')
  if (!base) return null
  const thumbUrl = `https://www.bing.com${base}_1366x768.jpg`
  const previewUrl = `https://www.bing.com${base}_1920x1080.jpg`
  const fullUrl = `https://www.bing.com${base}_UHD.jpg`
  const copyright = stripHtml(raw.copyright || '')
  const title = copyright.split('©')[0]?.trim() || raw.title || `Bing 每日一图 ${raw.startdate ?? ''}`
  const author = copyright.includes('©') ? copyright.split('©').slice(1).join('©').trim() : copyright || undefined
  return {
    sourceId: 'bing-daily',
    remoteId: `${raw.startdate ?? 'today'}-${index}-${mkt}`,
    title: title || 'Bing 每日一图',
    mediaType: 'image',
    thumbUrl,
    previewUrl,
    fullUrl,
    author,
    license: 'Bing 每日图片（仅个人桌面使用）',
    licenseUrl: 'https://www.bing.com',
    sourceUrl: raw.copyrightlink || 'https://www.bing.com',
    attribution: copyright || 'Bing',
    downloadAllowed: true,
    exportAllowed: false,
    meta: { startdate: raw.startdate ?? null, mkt },
  }
}
