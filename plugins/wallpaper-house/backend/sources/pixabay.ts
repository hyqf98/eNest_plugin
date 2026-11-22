import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterString, pageNumber, requireSourceKey } from './types'

interface PixabayPhotoResponse {
  totalHits?: number
  hits?: PixabayPhoto[]
}

interface PixabayPhoto {
  id?: number
  pageURL?: string
  type?: string
  tags?: string
  previewURL?: string
  webformatURL?: string
  largeImageURL?: string
  fullHDURL?: string
  imageURL?: string
  imageWidth?: number
  imageHeight?: number
  user?: string
  views?: number
  downloads?: number
  likes?: number
  colors?: string[]
}

interface PixabayVideoResponse {
  totalHits?: number
  hits?: PixabayVideo[]
}

interface PixabayVideo {
  id?: number
  pageURL?: string
  tags?: string
  duration?: number
  user?: string
  views?: number
  downloads?: number
  likes?: number
  videos?: Record<string, { url?: string; width?: number; height?: number; size?: number; thumbnail?: string } | undefined>
}

const limiter = new RateLimiter(90, 60_000)

export const pixabaySource: SourceAdapter = {
  descriptor: {
    id: 'pixabay',
    name: 'Pixabay',
    description: '免费照片与视频；需要 Pixabay API Key。图片必须本地缓存并标注来源。',
    homepage: 'https://pixabay.com',
    mediaTypes: ['image', 'video'],
    requiresKey: true,
    keyLabel: 'Pixabay API Key',
    keyUrl: 'https://pixabay.com/api/docs/',
    builtin: true,
    enabledByDefault: false,
    supportsSearch: true,
    supportsPagination: true,
    notices: ['Pixabay 要求缓存结果并标注来源；插件不会在页面永久热链。'],
    facets: {
      items: [
        {
          key: 'media',
          label: '类型',
          type: 'select',
          default: 'photo',
          options: [
            { value: 'photo', label: '照片' },
            { value: 'video', label: '视频' },
          ],
        },
        {
          key: 'orientation',
          label: '方向',
          type: 'select',
          default: 'horizontal',
          options: [
            { value: '', label: '不限' },
            { value: 'horizontal', label: '横向' },
            { value: 'vertical', label: '纵向' },
          ],
        },
        {
          key: 'category',
          label: '分类',
          type: 'select',
          default: '',
          options: [
            { value: '', label: '不限' },
            { value: 'nature', label: '自然' },
            { value: 'backgrounds', label: '背景' },
            { value: 'computer', label: '电脑' },
            { value: 'travel', label: '旅行' },
            { value: 'buildings', label: '建筑' },
          ],
        },
        {
          key: 'order',
          label: '排序',
          type: 'sort',
          default: 'popular',
          options: [
            { value: 'popular', label: '热门' },
            { value: 'latest', label: '最新' },
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
    const media = filterString(filters, 'media', 'photo')
    const params = new URLSearchParams({
      key,
      q: query.query?.trim() || 'landscape',
      page: String(page),
      per_page: '24',
      safesearch: 'true',
    })
    const category = filterString(filters, 'category')
    if (category) params.set('category', category)
    const order = filterString(filters, 'order', 'popular')
    if (order) params.set('order', order)
    if (media === 'video') {
      const payload = await fetchJson<PixabayVideoResponse>(`https://pixabay.com/api/videos/?${params.toString()}`, {
        signal: context.signal,
        maxBytes: 8 * 1024 * 1024,
      })
      const items = (payload.hits ?? []).map(toVideo).filter((item): item is WallpaperItem => Boolean(item))
      return { items, page, hasMore: items.length > 0 && page * 24 < (Number(payload.totalHits) || 0), total: Number(payload.totalHits) || undefined }
    }
    const orientation = filterString(filters, 'orientation', 'horizontal')
    if (orientation) params.set('orientation', orientation)
    const payload = await fetchJson<PixabayPhotoResponse>(`https://pixabay.com/api/?${params.toString()}`, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
    })
    const items = (payload.hits ?? []).map(toPhoto).filter((item): item is WallpaperItem => Boolean(item))
    return { items, page, hasMore: items.length > 0 && page * 24 < (Number(payload.totalHits) || 0), total: Number(payload.totalHits) || undefined }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    const key = requireSourceKey(context)
    await limiter.wait(context.signal)
    if (remoteId.startsWith('video-')) {
      const payload = await fetchJson<PixabayVideoResponse>(`https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&id=${encodeURIComponent(remoteId.slice(6))}`, {
        signal: context.signal,
        maxBytes: 4 * 1024 * 1024,
      })
      return payload.hits?.[0] ? toVideo(payload.hits[0]) : null
    }
    const payload = await fetchJson<PixabayPhotoResponse>(`https://pixabay.com/api/?key=${encodeURIComponent(key)}&id=${encodeURIComponent(remoteId.replace(/^photo-/, ''))}`, {
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
    })
    return payload.hits?.[0] ? toPhoto(payload.hits[0]) : null
  },
}

function toPhoto(raw: PixabayPhoto): WallpaperItem | null {
  if (!raw.id) return null
  const fullUrl = raw.fullHDURL || raw.imageURL || raw.largeImageURL
  if (!fullUrl) return null
  return {
    sourceId: 'pixabay',
    remoteId: `photo-${raw.id}`,
    title: raw.tags || `Pixabay photo ${raw.id}`,
    mediaType: 'image',
    thumbUrl: raw.webformatURL || raw.previewURL || fullUrl,
    previewUrl: raw.largeImageURL || raw.webformatURL || fullUrl,
    fullUrl,
    width: raw.imageWidth,
    height: raw.imageHeight,
    author: raw.user,
    license: 'Pixabay Content License',
    licenseUrl: 'https://pixabay.com/service/license-summary/',
    sourceUrl: raw.pageURL,
    attribution: raw.user ? `Image by ${raw.user} from Pixabay` : 'Pixabay',
    tags: raw.tags?.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 24),
    downloadAllowed: true,
    exportAllowed: true,
    meta: {
      views: raw.views ?? null,
      downloads: raw.downloads ?? null,
      likes: raw.likes ?? null,
    },
  }
}

function toVideo(raw: PixabayVideo): WallpaperItem | null {
  if (!raw.id) return null
  const large = raw.videos?.large
  const medium = raw.videos?.medium
  const selected = large?.url ? large : medium?.url ? medium : raw.videos?.small?.url ? raw.videos.small : raw.videos?.tiny
  if (!selected?.url) return null
  const thumb = medium?.thumbnail || raw.videos?.small?.thumbnail || raw.videos?.tiny?.thumbnail
  const variants = ['large', 'medium', 'small', 'tiny'].flatMap(name => {
    const entry = raw.videos?.[name]
    return entry?.url
      ? [{ url: entry.url, width: entry.width, height: entry.height, fileSize: entry.size, label: name }]
      : []
  })
  return {
    sourceId: 'pixabay',
    remoteId: `video-${raw.id}`,
    title: raw.tags || `Pixabay video ${raw.id}`,
    mediaType: 'video',
    thumbUrl: thumb || selected.url,
    previewUrl: thumb || selected.url,
    fullUrl: selected.url,
    width: selected.width,
    height: selected.height,
    fileSize: selected.size,
    mime: 'video/mp4',
    variants,
    durationMs: raw.duration ? raw.duration * 1000 : undefined,
    author: raw.user,
    license: 'Pixabay Content License',
    licenseUrl: 'https://pixabay.com/service/license-summary/',
    sourceUrl: raw.pageURL,
    attribution: raw.user ? `Video by ${raw.user} from Pixabay` : 'Pixabay',
    tags: raw.tags?.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 24),
    downloadAllowed: true,
    exportAllowed: true,
    meta: {
      views: raw.views ?? null,
      downloads: raw.downloads ?? null,
      likes: raw.likes ?? null,
    },
  }
}
