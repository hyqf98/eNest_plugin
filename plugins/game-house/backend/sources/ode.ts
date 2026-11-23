/**
 * ode 数据源（uy5.net / kelongwo 镜像）：
 * POST /wodown/resources/，体 { EData: 凯撒+3(参数串) }，头 content-type json + referer。
 * 列表字段 thumbnail_img / Numberofarticlescount / Subtitle / carouselVideoInfo；
 * 详情 GameIntroduction 是正文 HTML；文件列表 coID 是天翼云分享链接或文件夹 id。
 *
 * 条目 id 格式为 `${source}:${section}:${sourceId}`（如 ode:pc:12345），
 * 兼容旧的裸数字 id（按 pc 处理）；fileList 的 folder 包 id 是文件夹 id。
 */

import { getAdapter } from '../adapters/current.ts'
import { BackendError } from '../adapters/types.ts'
import { caesar3 } from '../crypto.ts'
import type { DetailData, LibraryItem, LibraryQuery, MediaRef, Page, ResourcePackage } from '../contracts.ts'
import { asArray, asRecord, formatSize, parseSize, text, textOrNumber } from '../util.ts'
import type { SourceAdapter, SourceFacets } from './registry.ts'

const BASES = ['https://www.uy5.net', 'https://www.kelongwo.cn']
const PATH = '/wodown/resources/'
const SOURCE = 'ode'

/** cat/topicsId：PC=5、Switch=527、软件=538 */
const SECTION_TOPICS: Record<string, string> = { pc: '5', console: '527', software: '538' }

/** 各 section 的站点展示名（兜底错误文案用） */
const SECTION_LABELS: Record<string, string> = { pc: 'PC 游戏站', console: '主机游戏站', software: '软件站' }

const RANKINGS = [
  { id: '', label: '最新' },
  { id: 'views_day', label: '日排行' },
  { id: 'views_week', label: '周排行' },
  { id: 'views_month', label: '月排行' },
  { id: 'views_total', label: '总排行' },
]

/** `ode:pc:123` → { section: 'pc', sourceId: '123' }；裸数字（旧 id）按 pc 处理 */
function parseItemId(itemId: string): { section: string; sourceId: string } {
  const match = /^ode:([^:]+):(.+)$/.exec(itemId)
  if (match && SECTION_TOPICS[match[1]]) return { section: match[1], sourceId: match[2] }
  return { section: 'pc', sourceId: itemId }
}

function sectionLabel(section: string): string {
  return SECTION_LABELS[section] ?? SECTION_LABELS.pc
}

/** odePost 失败的兜底文案按 section 区分站点名 */
async function odePost(params: string, section: string): Promise<Record<string, unknown>> {
  const adapter = getAdapter()
  const label = sectionLabel(section)
  let lastError: unknown = null
  for (const base of BASES) {
    try {
      const response = await adapter.request({
        url: base + PATH,
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: base },
        body: JSON.stringify({ EData: caesar3(params) }),
        timeoutMs: 20_000,
      })
      if (response.status < 200 || response.status >= 300) {
        lastError = new BackendError('SOURCE_ERROR', `${label}接口暂时不可用（HTTP ${response.status}）`)
        continue
      }
      const textBody = new TextDecoder('utf-8').decode(response.body)
      return JSON.parse(textBody) as Record<string, unknown>
    } catch (error) {
      lastError = error
    }
  }
  if (lastError instanceof BackendError) throw lastError
  throw new BackendError('SOURCE_ERROR', `${label}暂时无法访问，请稍后重试`)
}

/**
 * <video> 能播放的地址：mp4 / webm / ogg，以及 HLS 播放列表（.m3u8，由页面用 hls.js 经回环代理播放）。
 * 不带扩展名的直出地址也算；单独的 .ts 分片不算。
 */
function isNativeVideo(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase()
    return !path.endsWith('.ts')
  } catch {
    return false
  }
}

function coverTokenOf(url: string): string {
  return url ? `img:${Buffer.from(url, 'utf8').toString('base64url')}` : ''
}

export function mapListItem(raw: Record<string, unknown>, section: string): LibraryItem {
  const categories = typeof raw.categories === 'string' ? raw.categories : ''
  const sourceId = text(raw.id)
  // cover 存原始 URL；coverToken 存 img: 令牌。thumbnail_img 是真封面，appIco 只是站点图标兜底。
  const cover = text(raw.thumbnail_img) || text(raw.appIco)
  return {
    id: `${SOURCE}:${section}:${sourceId}`,
    kind: section === 'software' ? 'software' : 'game',
    section: section === 'console' ? 'console' : section === 'software' ? 'software' : 'pc',
    source: SOURCE,
    sourceId,
    title: text(raw.post_title),
    subtitle: text(raw.Subtitle),
    cover,
    coverToken: coverTokenOf(cover),
    category: categories,
    sizeText: '',
    meta: [],
    favorite: false,
    installed: false,
  }
}

export function mapFileEntry(raw: Record<string, unknown>): ResourcePackage {
  const coId = text(raw.coID)
  const type = textOrNumber(raw.type, '')
  let state: ResourcePackage['state'] = 'ready'
  let provider = '直链下载'
  if (type === 'warehousing') {
    state = 'warehousing'
    provider = '打包中'
  } else if (type === 'folder') {
    state = 'folder'
    provider = '文件夹'
  } else if (type === 'file') {
    provider = coId.includes('cloud.189.cn') ? '天翼云盘' : '直链下载'
  } else if (!type) {
    // type 缺失：按 coID 是否 http 链接判断 ready/folder
    if (/^https?:\/\//i.test(coId)) {
      provider = coId.includes('cloud.189.cn') ? '天翼云盘' : '直链下载'
    } else {
      state = 'folder'
      provider = '文件夹'
    }
  }
  return {
    // 文件夹行用文件夹 id（fileList 进入子目录时作 path）；文件行用分享链接/直链
    id: state === 'folder' && coId ? coId : coId || text(raw.coName),
    name: text(raw.coName),
    // coSize 可能是 "145.55 GB" 文本，也可能是字节数（软件区实测是 number）
    sizeText: text(raw.coSize) || (typeof raw.coSize === 'number' && Number.isFinite(raw.coSize) && raw.coSize > 0 ? formatSize(raw.coSize) : ''),
    size: parseSize(raw.coSize),
    provider,
    state,
    exePath: text(raw.openPath),
    updatedAt: text(raw.udTime),
    childCount: raw.childCount === undefined ? undefined : Number(raw.childCount) || undefined,
  }
}

/** 从天翼云分享链接提取访问码（?pwd=xxx） */
export function extractCodeFromPkg(pkg: ResourcePackage): string {
  const match = /[?&]pwd=([^&#]+)/.exec(pkg.id)
  return match?.[1] ?? ''
}

function mapDetail(itemId: string, section: string, data: Record<string, unknown>, packages: ResourcePackage[]): DetailData {
  const item = mapListItem(data, section)
  item.id = itemId
  item.sourceId = parseItemId(itemId).sourceId
  const video = asRecord(data.carouselVideoInfo)
  const media: MediaRef[] = []
  const videoUrls = Array.isArray(video?.videoUrl) ? (video.videoUrl as unknown[]) : []
  const videoCovers = Array.isArray(video?.videoCoverUrl) ? (video.videoCoverUrl as unknown[]) : []
  // 图片令牌的前缀是 img（后端 media.load 与前端只认 img:），视频令牌是 video
  const mediaOf = (url: string, type: 'image' | 'video'): MediaRef => ({ token: `${type === 'video' ? 'video' : 'img'}:${Buffer.from(url, 'utf8').toString('base64url')}`, type })
  videoUrls.forEach((url, index) => {
    if (typeof url !== 'string' || !url) return
    const cover = videoCovers[index]
    // 视频项自带封面：缩略图与播放前的占位用它，不再把封面单独当成一项
    if (isNativeVideo(url)) media.push({ ...mediaOf(url, 'video'), ...(typeof cover === 'string' && cover ? { poster: mediaOf(cover, 'image').token } : {}) })
    else if (typeof cover === 'string' && cover) media.push(mediaOf(cover, 'image'))
  })
  for (const shot of asArray(data.carousel)) {
    if (typeof shot === 'string' && shot) media.push(mediaOf(shot, 'image'))
  }
  return {
    item,
    media,
    description: text(data.GameIntroduction),
    datetime: text(data.datetime),
    sizeText: text(data.filesize_z),
    installedSizeText: '',
    minConfig: text(data.MinimumConfiguration),
    recommendConfig: text(data.recommendConfiguration),
    officialUrl: text(data.offcialUrl) || text(data.gfurl),
    packages,
    trainerOptions: [],
    trainerGuides: [],
  }
}

export function odeSource(): SourceAdapter {
  const facets = (section: string): SourceFacets => ({
    categories: [
      { id: '', label: '全部分类' },
      { id: String(SECTION_TOPICS[section] ?? '5'), label: section === 'software' ? '软件' : section === 'console' ? '主机' : 'PC 游戏' },
    ],
    sorts: RANKINGS,
  })

  return {
    kind: 'ode',
    label: 'PC 游戏站',
    facets,

    async list(query: LibraryQuery): Promise<Page<LibraryItem>> {
      const topicsId = SECTION_TOPICS[query.section] ?? ''
      const cat = query.category || topicsId
      const params =
        `action=getAppList&cat=${encodeURIComponent(cat)}&newPage=${query.page}&ranking=${encodeURIComponent(query.sort)}&s=${encodeURIComponent(query.keyword)}&numberposts=24&topicsId=${encodeURIComponent(topicsId)}`
      const data = await odePost(params, query.section)
      const list = asArray(data.list).filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null).map(entry => asRecord(entry) as Record<string, unknown>)
      const total = Number(data.Numberofarticlescount) || 0
      const pageSize = Number(data.pageSize) || 24
      return {
        items: list.map(entry => mapListItem(entry, query.section)),
        page: query.page,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        total,
      }
    },

    async detail(itemId): Promise<DetailData> {
      const { section, sourceId } = parseItemId(itemId)
      const data = await odePost(`action=getPostArticle&id=${encodeURIComponent(sourceId)}`, section)
      // 文章拿到后再拉文件列表，填进 packages
      let packages: ResourcePackage[] = []
      try {
        packages = await listPackages(sourceId, section, undefined)
      } catch {
        // 文件列表失败不阻塞详情展示
        packages = []
      }
      return mapDetail(itemId, section, data, packages)
    },

    async fileList(itemId, path): Promise<ResourcePackage[]> {
      const { section, sourceId } = parseItemId(itemId)
      return listPackages(sourceId, section, path)
    },
  }
}

/**
 * 文件列表。对照原项目 fetch_file_info：
 * - 根目录：`id=<条目id>&path=null`
 * - 子目录：`id=<空>&path=<文件夹id>`
 */
async function listPackages(sourceId: string, section: string, path: string | undefined): Promise<ResourcePackage[]> {
  const params = path === undefined || path === ''
    ? `action=getAppDownList&id=${encodeURIComponent(sourceId)}&path=null&version=1`
    : `action=getAppDownList&id=&path=${encodeURIComponent(path)}&version=1`
  const data = await odePost(params, section)
  const list = asArray(data.list).filter((entry): entry is Record<string, unknown> => asRecord(entry) !== null).map(entry => asRecord(entry) as Record<string, unknown>)
  return list.map(mapFileEntry)
}
