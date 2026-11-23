import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import type { SourceAdapter, SourceContext } from './types'
import { filterString, pageNumber, requireSourceKey } from './types'

interface PexelsPhotoResponse {
  photos?: PexelsPhoto[]
  total_results?: number
  next_page?: string | null
}

interface PexelsPhoto {
  id?: number
  width?: number
  height?: number
  url?: string
  photographer?: string
  photographer_url?: string
  avg_color?: string
  alt?: string
  src?: { original?: string; large2x?: string; large?: string; medium?: string; small?: string; tiny?: string }
}

interface PexelsVideoResponse {
  videos?: PexelsVideo[]
  total_results?: number
  next_page?: string | null
}

interface PexelsVideo {
  id?: number
  width?: number
  height?: number
  url?: string
  image?: string
  duration?: number
  user?: { name?: string; url?: string }
  video_files?: Array<{ id?: number; quality?: string; file_type?: string; width?: number; height?: number; link?: string }>
}

const limiter = new RateLimiter(40, 60_000)

export const pexelsSource: SourceAdapter = {
  descriptor: {
    id: 'pexels',
    name: 'Pexels',
    description: '免费照片与视频；需要 Pexels API Key。视频可直接作为动态壁纸素材。',
    homepage: 'https://www.pexels.com',
    mediaTypes: ['image', 'video'],
    requiresKey: true,
    keyLabel: 'Pexels API Key',
    keyUrl: 'https://www.pexels.com/api/',
    builtin: true,
    enabledByDefault: false,
    supportsSearch: true,
    supportsPagination: true,
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
          default: 'landscape',
          options: [
            { value: '', label: '不限' },
            { value: 'landscape', label: '横向' },
            { value: 'portrait', label: '纵向' },
            { value: 'square', label: '方形' },
          ],
        },
        {
          key: 'size',
          label: '尺寸',
          type: 'select',
          default: 'large',
          options: [
            { value: '', label: '不限' },
            { value: 'large', label: '大图' },
            { value: 'medium', label: '中图' },
            { value: 'small', label: '小图' },
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
      query: query.query?.trim() || 'nature wallpaper',
      page: String(page),
      per_page: '24',
    })
    const orientation = filterString(filters, 'orientation', 'landscape')
    if (orientation) params.set('orientation', orientation)
    const size = filterString(filters, 'size', 'large')
    if (size) params.set('size', size)
    if (media === 'video') {
      const payload = await fetchJson<PexelsVideoResponse>(`https://api.pexels.com/videos/search?${params.toString()}`, {
        headers: { authorization: key },
        signal: context.signal,
        maxBytes: 8 * 1024 * 1024,
      })
      const items = (payload.videos ?? []).map(toVideo).filter((item): item is WallpaperItem => Boolean(item))
      return {
        items,
        page,
        hasMore: Boolean(payload.next_page) && items.length > 0,
        total: Number(payload.total_results) || undefined,
      }
    }
    const payload = await fetchJson<PexelsPhotoResponse>(`https://api.pexels.com/v1/search?${params.toString()}`, {
      headers: { authorization: key },
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
    })
    const items = (payload.photos ?? []).map(toPhoto).filter((item): item is WallpaperItem => Boolean(item))
    return {
      items,
      page,
      hasMore: Boolean(payload.next_page) && items.length > 0,
      total: Number(payload.total_results) || undefined,
    }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    const key = requireSourceKey(context)
    await limiter.wait(context.signal)
    if (remoteId.startsWith('video-')) {
      const payload = await fetchJson<PexelsVideo>(`https://api.pexels.com/videos/videos/${encodeURIComponent(remoteId.slice(6))}`, {
        headers: { authorization: key },
        signal: context.signal,
        maxBytes: 4 * 1024 * 1024,
      })
      return toVideo(payload)
    }
    const payload = await fetchJson<PexelsPhoto>(`https://api.pexels.com/v1/photos/${encodeURIComponent(remoteId.replace(/^photo-/, ''))}`, {
      headers: { authorization: key },
      signal: context.signal,
      maxBytes: 4 * 1024 * 1024,
    })
    return toPhoto(payload)
  },
}

function toPhoto(raw: PexelsPhoto): WallpaperItem | null {
  if (!raw.id) return null
  const fullUrl = raw.src?.original || raw.src?.large2x
  if (!fullUrl) return null
  return {
    sourceId: 'pexels',
    remoteId: `photo-${raw.id}`,
    title: raw.alt || `Pexels photo ${raw.id}`,
    mediaType: 'image',
    thumbUrl: raw.src?.medium || raw.src?.small || fullUrl,
    previewUrl: raw.src?.large2x || raw.src?.large || fullUrl,
    fullUrl,
    width: raw.width,
    height: raw.height,
    author: raw.photographer,
    authorUrl: raw.photographer_url,
    license: 'Pexels License',
    licenseUrl: 'https://www.pexels.com/license/',
    sourceUrl: raw.url || `https://www.pexels.com/photo/${raw.id}/`,
    attribution: raw.photographer ? `Photo by ${raw.photographer} on Pexels` : 'Pexels',
    color: raw.avg_color,
    downloadAllowed: true,
    exportAllowed: true,
  }
}

function toVideo(raw: PexelsVideo): WallpaperItem | null {
  if (!raw.id) return null
  const files = (raw.video_files ?? []).filter(file => file.link && file.file_type === 'video/mp4')
  const sorted = files.sort((a, b) => {
    const aWidth = a.width ?? 0
    const bWidth = b.width ?? 0
    const aScore = aWidth <= 1920 ? aWidth : 1920 - aWidth
    const bScore = bWidth <= 1920 ? bWidth : 1920 - bWidth
    return bScore - aScore
  })
  const selected = sorted[0]
  if (!selected?.link) return null
  const poster = raw.image
  const variants = (raw.video_files ?? [])
    .filter(file => file.link && file.file_type === 'video/mp4')
    .map(file => ({ url: file.link as string, width: file.width, height: file.height, label: file.quality }))
  return {
    sourceId: 'pexels',
    remoteId: `video-${raw.id}`,
    title: `Pexels video ${raw.id}`,
    mediaType: 'video',
    thumbUrl: poster ? `${poster}?auto=compress&cs=tinysrgb&w=480` : selected.link,
    previewUrl: poster || selected.link,
    fullUrl: selected.link,
    width: selected.width ?? raw.width,
    height: selected.height ?? raw.height,
    mime: 'video/mp4',
    variants,
    durationMs: raw.duration ? raw.duration * 1000 : undefined,
    author: raw.user?.name,
    authorUrl: raw.user?.url,
    license: 'Pexels License',
    licenseUrl: 'https://www.pexels.com/license/',
    sourceUrl: raw.url || `https://www.pexels.com/video/${raw.id}/`,
    attribution: raw.user?.name ? `Video by ${raw.user.name} on Pexels` : 'Pexels',
    downloadAllowed: true,
    exportAllowed: true,
  }
}
