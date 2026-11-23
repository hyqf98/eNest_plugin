import type { SourcePage, WallpaperItem, SourceQuery } from '@backend/contracts'
import { fetchJson, RateLimiter } from '@backend/net'
import { fail } from '@backend/util'
import type { SourceAdapter, SourceContext } from './types'
import { buildUrl, filterList, filterString, pageNumber } from './types'

interface WallhavenResponse {
  data?: WallhavenWallpaper | WallhavenWallpaper[]
  meta?: {
    current_page?: number
    last_page?: number
    total?: number
    seed?: string | null
  }
}

interface WallhavenWallpaper {
  id?: string
  url?: string
  short_url?: string
  uploader?: { username?: string }
  views?: number
  favorites?: number
  source?: string
  purity?: string
  category?: string
  dimension_x?: number
  dimension_y?: number
  resolution?: string
  ratio?: string
  file_size?: number
  file_type?: string
  created_at?: string
  colors?: string[]
  path?: string
  thumbs?: { large?: string; original?: string; small?: string }
  tags?: Array<{ name?: string }>
}

const limiter = new RateLimiter(44, 60_000)
const COLORS = ['#660000', '#004d00', '#003366', '#4d004d', '#4d4d00', '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff']

export const wallhavenSource: SourceAdapter = {
  descriptor: {
    id: 'wallhaven',
    name: 'Wallhaven',
    description: '壁纸垂直站：分类、标签、颜色与分辨率过滤。SFW 免 Key，NSFW 需要 API Key。',
    homepage: 'https://wallhaven.cc',
    mediaTypes: ['image'],
    requiresKey: false,
    builtin: true,
    enabledByDefault: true,
    supportsSearch: true,
    supportsPagination: true,
    facets: {
      items: [
        {
          key: 'categories',
          label: '分类',
          type: 'multi',
          default: ['general', 'anime', 'people'],
          options: [
            { value: 'general', label: '综合' },
            { value: 'anime', label: '动漫' },
            { value: 'people', label: '人物' },
          ],
        },
        {
          key: 'purity',
          label: '纯度',
          type: 'select',
          default: 'sfw',
          options: [
            { value: 'sfw', label: '安全' },
            { value: 'sketchy', label: '略敏感' },
            { value: 'nsfw', label: '全部（需 Key）' },
          ],
        },
        {
          key: 'sorting',
          label: '排序',
          type: 'sort',
          default: 'date_added',
          options: [
            { value: 'date_added', label: '最新' },
            { value: 'relevance', label: '相关度' },
            { value: 'random', label: '随机' },
            { value: 'views', label: '浏览' },
            { value: 'favorites', label: '收藏' },
            { value: 'toplist', label: '排行榜' },
          ],
        },
        {
          key: 'atleast',
          label: '最小分辨率',
          type: 'select',
          default: '',
          options: [
            { value: '', label: '不限' },
            { value: '1920x1080', label: '1920 × 1080' },
            { value: '2560x1440', label: '2560 × 1440' },
            { value: '3840x2160', label: '3840 × 2160' },
          ],
        },
        {
          key: 'ratios',
          label: '比例',
          type: 'select',
          default: '',
          options: [
            { value: '', label: '不限' },
            { value: '16x9', label: '16:9' },
            { value: '16x10', label: '16:10' },
            { value: '21x9', label: '21:9' },
            { value: '9x16', label: '9:16' },
          ],
        },
        { key: 'colors', label: '颜色', type: 'color', values: COLORS, default: '' },
      ],
    },
  },

  async search(query: SourceQuery, context: SourceContext): Promise<SourcePage> {
    await limiter.wait(context.signal)
    const page = pageNumber(query)
    const filters = query.filters ?? {}
    const categories = filterList(filters, 'categories')
    const categoryBits = [
      categories.includes('general') ? '1' : '0',
      categories.includes('anime') ? '1' : '0',
      categories.includes('people') ? '1' : '0',
    ].join('')
    const purityValue = filterString(filters, 'purity', 'sfw')
    if (purityValue !== 'sfw' && !context.key) fail('SOURCE_KEY_REQUIRED', 'Wallhaven 的略敏感/全部内容需要 API Key')
    const purity = purityValue === 'nsfw' ? '111' : purityValue === 'sketchy' ? '110' : '100'
    const sorting = filterString(filters, 'sorting', 'date_added')
    const url = buildUrl('https://wallhaven.cc/api/v1/search', {
      q: query.query?.trim() || undefined,
      categories: categoryBits === '111' ? undefined : categoryBits,
      purity: purity === '100' ? undefined : purity,
      sorting: sorting === 'date_added' ? undefined : sorting,
      atleast: filterString(filters, 'atleast') || undefined,
      ratios: filterString(filters, 'ratios') || undefined,
      colors: filterString(filters, 'colors').replace('#', '') || undefined,
      page,
      apikey: context.key || undefined,
    })
    const payload = await fetchJson<WallhavenResponse>(url, { signal: context.signal, maxBytes: 4 * 1024 * 1024 })
    const rawItems = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : []
    const items = rawItems.map(toItem).filter((item): item is WallpaperItem => Boolean(item))
    const current = Number(payload.meta?.current_page) || page
    const last = Number(payload.meta?.last_page) || current
    return {
      items,
      page: current,
      hasMore: current < last,
      total: Number(payload.meta?.total) || undefined,
    }
  },

  async detail(remoteId: string, context: SourceContext): Promise<WallpaperItem | null> {
    await limiter.wait(context.signal)
    const url = buildUrl(`https://wallhaven.cc/api/v1/w/${encodeURIComponent(remoteId)}`, {
      apikey: context.key || undefined,
    })
    const payload = await fetchJson<WallhavenResponse>(url, { signal: context.signal, maxBytes: 4 * 1024 * 1024 })
    const item = Array.isArray(payload.data) ? payload.data[0] : payload.data
    return item ? toItem(item) : null
  },

  async resolve(item: WallpaperItem, context: SourceContext) {
    if (!context.key) return { url: item.fullUrl }
    const url = new URL(item.fullUrl)
    url.searchParams.set('apikey', context.key)
    return { url: url.toString() }
  },
}

function toItem(raw: WallhavenWallpaper): WallpaperItem | null {
  const id = raw.id
  const fullUrl = raw.path
  if (!id || !fullUrl) return null
  const thumbUrl = raw.thumbs?.large || raw.thumbs?.original || raw.thumbs?.small || fullUrl
  const previewUrl = raw.thumbs?.original || thumbUrl
  return {
    sourceId: 'wallhaven',
    remoteId: id,
    title: `Wallhaven ${id}`,
    mediaType: 'image',
    thumbUrl,
    previewUrl,
    fullUrl,
    width: raw.dimension_x,
    height: raw.dimension_y,
    fileSize: raw.file_size,
    mime: raw.file_type,
    author: raw.uploader?.username,
    license: 'Wallhaven / 原上传者',
    sourceUrl: raw.url || raw.short_url,
    color: raw.colors?.[0],
    tags: raw.tags?.map(tag => tag.name).filter((name): name is string => Boolean(name)).slice(0, 24),
    downloadAllowed: true,
    exportAllowed: true,
    meta: {
      category: raw.category ?? null,
      purity: raw.purity ?? null,
      ratio: raw.ratio ?? null,
      resolution: raw.resolution ?? null,
      views: raw.views ?? null,
      favorites: raw.favorites ?? null,
    },
  }
}
