/**
 * tvbox 多源聚合层：启用中的全部数据源自动聚合展示（无"当前站点"概念）。
 *
 * 归一策略：
 *  - 分类名归一：各站分类名（电影片/电影/电影解说→电影；连续剧/电视剧/韩剧…→连续剧…）
 *    映射到标准板块；匹配不上的站跳过该板块。
 *  - 同名去重：同名（+年份兜底）合并一张卡，主源取首个返回站；记录 sources[] 供换源。
 *  - 轮询合并：板块内按站点交错（site1,s2,s1,s2…）保证多源均沾。
 *  - 快速失败：每站独立 8s 超时；任一站失败只记错误，不阻断整体。
 *
 * 方法：aggregate.home / aggregate.category / aggregate.searchSuggest
 * 由 index.ts 挂表；站点级 API（site.detail/site.play 等）不变。
 */
import { withTimeout } from './shared'
import type { VodItem } from './types'

/** 标准板块（展示顺序）与各站分类名 → 板块的归一映射 */
export const STANDARD_SECTIONS = [
  { key: 'movie', name: '电影' },
  { key: 'series', name: '连续剧' },
  { key: 'show', name: '综艺' },
  { key: 'anime', name: '动漫' },
] as const

const SECTION_MAP: Record<string, string> = {
  电影片: 'movie', 电影: 'movie', 动作片: 'movie', 喜剧片: 'movie', 爱情片: 'movie', 科幻片: 'movie',
  恐怖片: 'movie', 剧情片: 'movie', 战争片: 'movie', 灾难片: 'movie', 悬疑片: 'movie', 犯罪片: 'movie',
  奇幻片: 'movie', 记录片: 'movie', 纪录片: 'movie', 伦理片: 'movie', 邵氏电影: 'movie', Netflix电影: 'movie',
  连续剧: 'series', 电视剧: 'series', 国产剧: 'series', 香港剧: 'series', 台湾剧: 'series', 韩国剧: 'series',
  韩剧: 'series', 日本剧: 'series', 日剧: 'series', 欧美剧: 'series', 美国剧: 'series', 海外剧: 'series',
  泰剧: 'series', 马泰剧: 'series', 内地剧: 'series', Netflix自制剧: 'series',
  综艺片: 'show', 综艺: 'show', 大陆综艺: 'show', 港台综艺: 'show', 日韩综艺: 'show', 欧美综艺: 'show',
  动漫片: 'anime', 动漫: 'anime', 动画片: 'anime', 国产动漫: 'anime', 日韩动漫: 'anime', 欧美动漫: 'anime',
  港台动漫: 'anime', 海外动漫: 'anime', 中国动漫: 'anime', 日本动漫: 'anime', 有声动漫: 'anime',
}

/** 板块子分类映射（标准板块 → 子分类名列表，供分类页二级 chips） */
export const SECTION_SUBTYPES: Record<string, string[]> = {
  movie: ['动作片', '喜剧片', '爱情片', '科幻片', '恐怖片', '剧情片', '战争片', '悬疑片', '犯罪片', '奇幻片', '灾难片', '纪录片', '伦理片'],
  series: ['国产剧', '香港剧', '台湾剧', '韩国剧', '日本剧', '欧美剧', '海外剧', '泰剧'],
  show: ['大陆综艺', '港台综艺', '日韩综艺', '欧美综艺'],
  anime: ['国产动漫', '日韩动漫', '欧美动漫', '港台动漫', '海外动漫'],
}

export function sectionOf(typeName: string | undefined): string | undefined {
  if (!typeName) return undefined
  return SECTION_MAP[typeName.trim()]
}

/** 同名去重键：名称（去空白+小写）+ 年份（可缺省） */
function dedupeKey(v: VodItem): string {
  const name = (v.vod_name ?? '').replace(/\s|\(|\)|\[|]|【|】/g, '').toLowerCase()
  const year = v.vod_year && /^\d{4}$/.test(v.vod_year) ? v.vod_year : ''
  return `${name}|${year}`
}

export interface AggregateVod extends VodItem {
  /** 命中源列表（换源依据）：{siteKey, siteName, vodId} */
  sources: Array<{ siteKey: string; siteName: string; vodId: string }>
}

/** 多站列表轮询交错合并 + 同名去重（首见者为主源，附 sources） */
export function interleaveMerge(buckets: Array<{ siteKey: string; siteName: string; data: VodItem[] }>, limit: number): AggregateVod[] {
  const byKey = new Map<string, AggregateVod>()
  const order: string[] = []
  const maxLen = Math.max(0, ...buckets.map(b => b.data.length))
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) {
      const item = bucket.data[i]
      if (!item) continue
      const key = dedupeKey(item)
      const existing = byKey.get(key)
      if (existing) {
        if (!existing.sources.some(s => s.siteKey === bucket.siteKey)) {
          existing.sources.push({ siteKey: bucket.siteKey, siteName: bucket.siteName, vodId: item.vod_id })
        }
      } else {
        byKey.set(key, { ...item, sources: [{ siteKey: bucket.siteKey, siteName: bucket.siteName, vodId: item.vod_id }] })
        order.push(key)
      }
    }
  }
  return order.slice(0, limit).map(k => byKey.get(k)!)
}

/** 各站并行拉取（快速失败互不影响）。fetcher 接收站点全量信息（含 type/api 等字段）。 */
export async function gatherFromSites<T, S extends { key: string; name: string }>(
  sites: S[],
  fetcher: (site: S) => Promise<T[]>,
  timeoutMs = 12_000,
): Promise<Array<{ siteKey: string; siteName: string; data: T[] }>> {
  const results = await Promise.allSettled(
    sites.map(async site => ({ siteKey: site.key, siteName: site.name, data: await withTimeout(Promise.resolve(fetcher(site)), timeoutMs, `${site.name} 聚合超时`) })),
  )
  const out: Array<{ siteKey: string; siteName: string; data: T[] }> = []
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value.data)) out.push(r.value)
    else if (r.status === 'rejected') console.warn('[tvbox] aggregate skip site:', r.reason instanceof Error ? r.reason.message : String(r.reason))
  }
  return out
}

/** 分类名匹配：优先精确名，其次包含关系（子分类用） */
export function matchTypeId(types: Array<{ type_id: string; type_name: string }>, wantName: string): string | null {
  if (!types.length || !wantName) return null
  const exact = types.find(t => t.type_name.trim() === wantName)
  if (exact) return exact.type_id
  const partial = types.find(t => t.type_name.includes(wantName) || wantName.includes(t.type_name.trim()))
  return partial?.type_id ?? null
}
