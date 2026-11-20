/**
 * tvbox MacCMS 采集站客户端（sites type 0=XML / 1=JSON）。
 * 协议（实测 bfzy.tv）：
 *  - home：GET api?ac=list → class 分类树 + 最新列表
 *  - category：GET api?ac=detail|videolist&t=<type_id>&pg=<页>&f=<筛选JSON>（type1；type0 用 at=xml）
 *  - search：GET api?ac=detail&wd=<词>&pg=<页>
 *  - detail：GET api?ac=detail&ids=<id>（旧站 ac=videolist）
 * 选集三级分隔：vod_play_from "线路1$$$线路2"；vod_play_url "名$url#名$url$$$…"。
 */
import { fetchJson, rawFetch, MAX_TEXT_BYTES } from './net'
import { asArray, resolveAgainst } from './shared'
import type { CategoryPage, Episode, FilterGroup, PlayFlag, SiteMeta, TypeItem, VodDetail, VodItem } from './types'

function isMapLike(v: unknown): v is Map<string, unknown> {
  return !!v && typeof v === 'object' && typeof (v as any).entries === 'function' && typeof (v as any).get === 'function' && typeof (v as any).size === 'number'
}

function toVodItem(raw: any, site: SiteMeta): VodItem | null {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.vod_id ?? raw.id
  const name = raw.vod_name ?? raw.name
  if (id === undefined || id === null || !name) return null
  return {
    vod_id: String(id),
    vod_name: String(name),
    vod_pic: raw.vod_pic ? String(raw.vod_pic) : undefined,
    vod_remarks: raw.vod_remarks ? String(raw.vod_remarks) : undefined,
    type_name: raw.type_name ? String(raw.type_name) : undefined,
    vod_year: raw.vod_year ? String(raw.vod_year) : undefined,
    vod_area: raw.vod_area ? String(raw.vod_area) : undefined,
    siteKey: site.key,
  }
}

/** vod_play_from + vod_play_url → [{flag, episodes}]；$$$ 拆线路、# 拆集、$ 拆名与地址 */
export function splitPlayFlags(playFrom: unknown, playUrl: unknown): PlayFlag[] {
  const fromList = String(playFrom ?? '').split('$$$').map(s => s.trim()).filter(Boolean)
  const urlParts = String(playUrl ?? '').split('$$$')
  const flags: PlayFlag[] = []
  fromList.forEach((flag, i) => {
    const part = urlParts[i]
    if (!part) return
    const episodes: Episode[] = []
    for (const seg of part.split('#')) {
      const segTrim = seg.trim()
      if (!segTrim) continue
      const idx = segTrim.indexOf('$')
      if (idx <= 0) {
        episodes.push({ name: String(episodes.length + 1).padStart(2, '0'), url: segTrim })
      } else {
        episodes.push({ name: segTrim.slice(0, idx).trim() || String(episodes.length + 1).padStart(2, '0'), url: segTrim.slice(idx + 1).trim() })
      }
    }
    if (episodes.length) flags.push({ flag, episodes })
  })
  return flags
}

/** type1 标准筛选维度（采集站普遍支持；无 filters 返回时由前端兜底）。
 * 注意：不含「全部」占位项——前端固定渲染自己的「全部」按钮（空值=不筛选）。 */
export function defaultFilters(): Record<string, FilterGroup[]> {
  const mk = (key: string, name: string, values: Array<[string, string]>): FilterGroup =>
    ({ key, name, value: values.map(([n, v]) => ({ n, v })) })
  const plain = (list: string[]): Array<[string, string]> => list.map(v => [v, v])
  return {
    '*': [
      mk('by', '排序', [['按时间', 'time'], ['按人气', 'hits'], ['按评分', 'score']]),
      mk('area', '地区', plain(['大陆', '香港', '台湾', '美国', '韩国', '日本', '法国', '英国', '德国', '泰国', '印度', '其他'])),
      mk('lang', '语言', plain(['国语', '英语', '粤语', '闽南语', '韩语', '日语', '法语', '德语', '其他'])),
      mk('year', '年份', plain(['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014', '2013', '2012', '2011', '2010'])),
    ],
  }
}

/* ---------------- XML（type 0）轻量解析 ---------------- */
interface XmlChunk { attrs: Record<string, string>; text: string }

/** 极简 XML 提取：按标签名收集全部 <tag attr="v">text</tag>（采集 XML 无嵌套同名，够用） */
function xmlFindAll(xml: string, tag: string): XmlChunk[] {
  const out: XmlChunk[] = []
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  const selfRe = new RegExp(`<${tag}(\\s[^>]*)?/>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    out.push({ attrs: xmlAttrs(m[1] ?? ''), text: (m[2] ?? '').replace(/<\!\[CDATA\[|\]\]>/g, '').trim() })
  }
  while ((m = selfRe.exec(xml))) out.push({ attrs: xmlAttrs(m[1] ?? ''), text: '' })
  return out
}
function xmlAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) attrs[m[1]] = decodeXmlEntities(m[3] ?? m[4] ?? '')
  return attrs
}
function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function xmlToPage(xml: string, site: SiteMeta, page: number): CategoryPage {
  const types: TypeItem[] = xmlFindAll(xml, 'ty').map(ty => ({
    type_id: ty.attrs.id ?? ty.text,
    type_name: ty.text,
    parent: ty.attrs.pid || undefined,
  }))
  const list: VodItem[] = []
  for (const v of xmlFindAll(xml, 'video')) {
    const item = toVodItem({
      vod_id: v.attrs.id,
      vod_name: v.text || v.attrs.name,
      vod_pic: v.attrs.pic,
      vod_remarks: v.attrs.note,
      type_name: v.attrs.tname || v.attrs.type,
      vod_year: (v.attrs.year ?? '') || undefined,
    }, site)
    if (item) list.push(item)
  }
  const pageAttr = xmlFindAll(xml, 'list')[0]?.attrs
  return {
    list, types,
    page: Number(pageAttr?.page ?? page),
    pagecount: Number(pageAttr?.pagecount ?? 0),
    total: Number(pageAttr?.total ?? 0),
  }
}
function xmlToDetail(xml: string, site: SiteMeta): VodDetail | null {
  const videos = xmlFindAll(xml, 'video')
  if (!videos.length) return null
  const v = videos[0]
  const dl = xmlFindAll(xml, 'dl')[0]
  const dds = dl ? xmlFindAll(xml, 'dd') : xmlFindAll(xml, 'dd')
  const flags: PlayFlag[] = []
  if (dds.length) {
    // dd 的 flag 属性 = 线路名，内部 text = "名$url#名$url"
    let currentFlag = ''
    const flagMap = new Map<string, string[]>()
    // XML 里 dd 与 video 平级时无法区分归属，退而求其次：全部 dd 视为该影片线路
    for (const dd of dds) {
      const flag = dd.attrs.flag || ''
      if (flag) currentFlag = flag
      const urls = String(dd.text || '').split('#').filter(Boolean)
      if (!urls.length) continue
      const list = flagMap.get(currentFlag) ?? []
      list.push(...urls)
      flagMap.set(currentFlag, list)
    }
    for (const [flag, urlList] of flagMap) {
      const episodes: Episode[] = []
      for (const seg of urlList) {
        const idx = seg.indexOf('$')
        if (idx <= 0) episodes.push({ name: String(episodes.length + 1).padStart(2, '0'), url: seg.trim() })
        else episodes.push({ name: seg.slice(0, idx).trim(), url: seg.slice(idx + 1).trim() })
      }
      if (episodes.length) flags.push({ flag: flag || '默认', episodes })
    }
  }
  const base = toVodItem({
    vod_id: v.attrs.id,
    vod_name: v.text || v.attrs.name,
    vod_pic: v.attrs.pic,
    vod_remarks: v.attrs.note,
    type_name: v.attrs.tname || v.attrs.type,
    vod_year: (v.attrs.year ?? '') || undefined,
  }, site)
  if (!base) return null
  return {
    ...base,
    vod_content: v.attrs.des ? decodeXmlEntities(v.attrs.des) : undefined,
    vod_actor: v.attrs.actor || undefined,
    vod_director: v.attrs.director || undefined,
    vod_lang: v.attrs.lang || undefined,
    vod_area: v.attrs.area || undefined,
    vod_score: v.attrs.score || undefined,
    flags,
  }
}

/** 线路直链打分：全部选集是 m3u8/mp4 直链 = 2，混合 = 1，全非直链 = 0（排序用） */
function directScore(flag: PlayFlag): number {
  if (!flag.episodes.length) return 0
  const direct = flag.episodes.filter(e => /^https?:\/\/[^\s]+\.(m3u8|mp4)(\?|$)/i.test(e.url)).length
  return direct === flag.episodes.length ? 2 : direct > 0 ? 1 : 0
}

/* ---------------- 对外 API ---------------- */
export interface CmsClient {
  home(): Promise<{ types: TypeItem[]; list: VodItem[]; filters?: Record<string, FilterGroup[]> }>
  category(typeId: string, page: number, filters: Record<string, string>): Promise<CategoryPage & { types?: TypeItem[] }>
  search(keyword: string, page: number): Promise<CategoryPage>
  detail(vodId: string): Promise<VodDetail>
}

export function createCmsClient(site: SiteMeta): CmsClient {
  const type = site.type === 0 ? 0 : 1
  const acList = type === 0 ? 'list' : 'list'
  const acDetail = type === 0 ? 'videolist' : 'detail'
  const headers = { ...(site.header ?? {}) }
  const timeoutMs = (site.timeout ?? 15) * 1000

  const apiUrl = (params: Record<string, string | number | undefined>): string => {
    const url = new URL(site.api)
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue
      url.searchParams.set(k, String(v))
    }
    return url.toString()
  }

  /** type0 站在 api 路径上带 at=xml 的，直接请求返回 XML 文本 */
  async function fetchCms(params: Record<string, string | number | undefined>): Promise<{ json: any; xml: string | null }> {
    if (type === 0) {
      const res = await rawFetch(apiUrl({ at: 'xml', ...params }), { headers, timeoutMs, ownerKey: site.key, maxBytes: MAX_TEXT_BYTES })
      if (res.status >= 400) throw new Error(`站点响应 HTTP ${res.status}`)
      return { json: null, xml: res.body }
    }
    const json = await fetchJson(apiUrl(params), { headers, timeoutMs, ownerKey: site.key })
    if (json && typeof json === 'object' && json.msg && Number(json.code) !== 1 && !Array.isArray(json.list)) {
      throw new Error(`站点报错：${String(json.msg).slice(0, 80)}`)
    }
    return { json, xml: null }
  }

  return {
    async home() {
      const { json, xml } = await fetchCms({ ac: acList })
      if (xml !== null) {
        const page = xmlToPage(xml, site, 1)
        return { types: page.types ?? [], list: page.list }
      }
      const types: TypeItem[] = asArray<any>(json?.class).map((c: any) => ({
        type_id: String(c.type_id ?? ''),
        type_name: String(c.type_name ?? ''),
        parent: c.type_pid && Number(c.type_pid) !== 0 ? String(c.type_pid) : undefined,
      })).filter(t => t.type_id)
      const list = asArray<any>(json?.list).map((v: any) => toVodItem(v, site)).filter(Boolean) as VodItem[]
      return { types, list }
    },

    async category(typeId, page, filters) {
      const params: Record<string, string | number> = { ac: acDetail, t: typeId, pg: page }
      // type1 筛选走 f 参数（JSON）；值为空的维度不传
      const active = Object.fromEntries(Object.entries(filters ?? {}).filter(([, v]) => v !== '' && v !== undefined && v !== null))
      if (type === 1 && Object.keys(active).length) params.f = JSON.stringify(active)
      const { json, xml } = await fetchCms(params)
      if (xml !== null) return xmlToPage(xml, site, page)
      const list = asArray<any>(json?.list).map((v: any) => toVodItem(v, site)).filter(Boolean) as VodItem[]
      return {
        list,
        page: Number(json?.page ?? page),
        pagecount: Number(json?.pagecount ?? 0),
        total: Number(json?.total ?? 0),
      }
    },

    async search(keyword, page) {
      const { json, xml } = await fetchCms({ ac: acDetail, wd: keyword, pg: page })
      if (xml !== null) return xmlToPage(xml, site, page)
      const list = asArray<any>(json?.list).map((v: any) => toVodItem(v, site)).filter(Boolean) as VodItem[]
      return { list, page: Number(json?.page ?? page), pagecount: Number(json?.pagecount ?? 0) }
    },

    async detail(vodId) {
      const { json, xml } = await fetchCms({ ac: acDetail, ids: vodId })
      if (xml !== null) {
        const detail = xmlToDetail(xml, site)
        if (!detail) throw new Error('详情解析失败（XML 无 video 节点）')
        return detail
      }
      const v = asArray<any>(json?.list)[0]
      if (!v) throw new Error(`影片不存在：${vodId}`)
      const base = toVodItem(v, site)!
      // 线路排序：直链 m3u8/mp4 优先（如量子资源首个 liangzi 是分享页、lzm3u8 才可播）
      const flags = splitPlayFlags(v.vod_play_from, v.vod_play_url)
        .sort((a, b) => directScore(b) - directScore(a))
      // 站点配置 playUrl 前缀（少数 type0/1 站需要拼解析页地址；直接可播的直链场景少见，保留原样）
      return {
        ...base,
        vod_content: v.vod_content ? String(v.vod_content).replace(/<[^>]+>/g, '').trim() : undefined,
        vod_actor: v.vod_actor ? String(v.vod_actor) : undefined,
        vod_director: v.vod_director ? String(v.vod_director) : undefined,
        vod_lang: v.vod_lang ? String(v.vod_lang) : undefined,
        vod_score: v.vod_score ? String(v.vod_score) : undefined,
        flags,
      }
    },
  }
}
