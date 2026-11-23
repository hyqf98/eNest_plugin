/**
 * 浏览相关方法：library.facets / library.list / library.detail。
 * 数据源只负责站点协议；这里做三件数据源不知道的事：
 * - 把浏览到的条目登记进条目库，并把收藏 / 已安装状态合并回返回值；
 * - 详情页的正文按白名单净化，图片地址改成 media.load 令牌；
 * - 详情里嵌套的文件夹（资源包里的子目录）用 `条目id#文件夹id` 表示，再调数据源的 fileList。
 */

import type { DetailData, LibraryFacets, LibraryItem, LibraryQuery, Page, ResourcePackage, Section } from '../contracts.ts'
import { sanitizeArticle } from '../imageProxy.ts'
import { ensureItem, mergeUserState, registerAndMerge } from '../library/items.ts'
import { requireString } from '../util.ts'
import { sourceAdapter } from '../sources/registry.ts'

const SECTIONS: readonly Section[] = ['pc', 'console', 'software', 'trainer', 'mod']
const DETAIL_SEPARATOR = '#'

export function libraryFacets(section: string): Promise<LibraryFacets> {
  const safe = SECTIONS.includes(section as Section) ? (section as Section) : 'pc'
  // 这个栏目有哪些可选数据源：按设置里能切换的三个栏目给出，其它栏目只有一个
  const kinds = safe === 'pc' || safe === 'console' || safe === 'software' ? ['ode', 'gamer520'] : [safe]
  const sources = kinds.map(kind => {
    const adapter = sourceAdapter(kind)
    // 可用性不在每次请求时探测（那会让打开页面多一次网络往返）；数据源自己声明的说明原样带给页面
    return { id: adapter.kind as LibraryFacets['sources'][number]['id'], label: adapter.label, hint: adapter.hint ?? '', available: true }
  })
  return Promise.resolve({ ...sourceAdapter(kinds[0]).facets(safe), sources })
}

export async function libraryList(rawQuery: unknown): Promise<Page<LibraryItem>> {
  const query = (rawQuery ?? {}) as Partial<LibraryQuery>
  const section = SECTIONS.includes(query.section as Section) ? (query.section as Section) : 'pc'
  const page = Math.max(1, Math.min(500, Number(query.page) || 1))
  const keyword = String(query.keyword ?? '').slice(0, 200)
  const kind = section === 'trainer' || section === 'mod' ? section : String(query.source || 'ode')
  const result = await sourceAdapter(kind).list({
    section, source: kind === 'ode' || kind === 'gamer520' ? kind : 'ode', page, keyword,
    category: String(query.category ?? ''), sort: String(query.sort ?? ''),
  })
  return { ...result, items: await registerAndMerge(result.items) }
}

/**
 * 条目 id：`数据源:栏目:站点id`；详情里嵌套文件夹时再接 `#文件夹id`。
 * 返回 { itemId, folderPath }，folderPath 为 undefined 表示条目本身。
 */
export function parseDetailId(id: string): { itemId: string; folderPath?: string } {
  const index = id.indexOf(DETAIL_SEPARATOR)
  if (index < 0) return { itemId: id }
  return { itemId: id.slice(0, index), folderPath: id.slice(index + 1) || undefined }
}

/** 条目 id `源:栏目:站点id` 里的栏目；格式不对的 id 一律按 pc 处理（数据源那一步会报错） */
function sectionOf(itemId: string): Section {
  const parts = itemId.split(':')
  if (parts.length >= 3 && SECTIONS.includes(parts[1] as Section)) return parts[1] as Section
  return 'pc'
}

export async function libraryDetail(rawId: unknown): Promise<DetailData> {
  const id = requireString(rawId, '条目 id', 600)
  const { itemId, folderPath } = parseDetailId(id)
  const section = sectionOf(itemId)
  const kind = section === 'trainer' || section === 'mod' ? section : itemId.split(':')[0] || 'ode'
  const adapter = sourceAdapter(kind)

  if (folderPath !== undefined) {
    // 资源包里的子文件夹：只返回文件清单，其余字段留空
    const packages: ResourcePackage[] = await adapter.fileList(itemId, folderPath)
    return { item: { id, kind: 'game', section, source: kind, sourceId: itemId, title: '', subtitle: '', cover: '', coverToken: '', category: '', sizeText: '', meta: [], favorite: false, installed: false }, media: [], description: '', datetime: '', sizeText: '', installedSizeText: '', minConfig: '', recommendConfig: '', officialUrl: '', packages, trainerOptions: [], trainerGuides: [] }
  }

  const detail = await adapter.detail(itemId)
  // 站点正文是不可信 HTML：白名单净化，图片改成经 media.load 的令牌
  const description = detail.description ? sanitizeArticle(detail.description) : ''
  let packages = detail.packages
  if (!packages.length) {
    // 详情接口没带资源清单时再问一次文件列表
    packages = await adapter.fileList(itemId).catch(() => [] as ResourcePackage[])
  }
  const item = await mergeUserState({ ...detail.item, id: itemId, section, favorite: detail.item.favorite, installed: detail.item.installed })
  // 详情页下载要用到站点给的 exe 相对路径：从资源包里带出来登记
  const exeRel = packages.find(pkg => pkg.exePath)?.exePath ?? ''
  const stored = await ensureItem({
    id: itemId, kind: item.kind, section, source: kind, sourceId: detail.item.sourceId || itemId,
    title: item.title, subtitle: item.subtitle, cover: item.cover, category: item.category, sizeText: detail.sizeText || item.sizeText, meta: item.meta,
    ...(exeRel ? { exeRel } : {}),
  })
  // ode 的详情接口不带列表里的封面字段（thumbnail_img）：直接打开详情（或刷新后）侧栏封面就是空的。
  // 浏览列表时封面已登记进条目库，这里用登记过的封面补上。
  if (!item.coverToken && stored.cover) {
    item.cover = stored.cover
    item.coverToken = `img:${Buffer.from(stored.cover, 'utf8').toString('base64url')}`
  }
  return { ...detail, item, description, packages }
}
