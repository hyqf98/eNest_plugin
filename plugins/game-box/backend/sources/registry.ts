/**
 * 数据源统一接口与分发。
 * SourceAdapter 是结构化接口：各源文件不 import registry，直接导出符合结构的工厂。
 */

import type { DetailData, LibraryItem, LibraryQuery, Page, ResourcePackage } from '../contracts.ts'
import { BackendError } from '../adapters/types.ts'

export type SourceKind = 'ode' | 'gamer520' | 'trainer' | 'mod' | 'pansou'

export interface SourceFacets {
  categories: Array<{ id: string; label: string }>
  sorts: Array<{ id: string; label: string }>
}

export interface SourceAdapter {
  readonly kind: SourceKind
  readonly label: string
  /** 给用户看的现状说明（例如该站点当前不可用）；为空表示没有需要特别说明的 */
  readonly hint?: string
  /** 分类与排序；section 是 'pc' | 'console' | 'software' | 'trainer' | 'mod' */
  facets(section: string): SourceFacets
  list(query: LibraryQuery): Promise<Page<LibraryItem>>
  detail(itemId: string): Promise<DetailData>
  /** 浏览条目下的资源（ode 的分享/文件夹；trainer/mod 的直链包） */
  fileList(itemId: string, path?: string): Promise<ResourcePackage[]>
  /** gamer520 等手动下载源：返回下载页地址；不支持返回 undefined */
  downloadPageUrl?(itemId: string): Promise<string>
}

/** 从 registry 取源适配器；未知源抛 INVALID_ARGUMENT */
export function sourceAdapter(kind: string): SourceAdapter {
  const adapter = registry().get(kind)
  if (!adapter) throw new BackendError('INVALID_ARGUMENT', `未知的数据源：${kind}`)
  return adapter
}

import { gamer520Source } from './gamer520.ts'
import { modSource } from './mod.ts'
import { odeSource } from './ode.ts'
import { pansouSource } from './pansou.ts'
import { trainerSource } from './trainer.ts'

const adapters = new Map<SourceKind, SourceAdapter>()

function registry(): Map<string, SourceAdapter> {
  if (adapters.size === 0) {
    for (const adapter of [odeSource(), gamer520Source(), trainerSource(), modSource(), pansouSource()]) {
      adapters.set(adapter.kind, adapter)
    }
  }
  return adapters
}

export function allSources(): SourceAdapter[] {
  const map = registry()
  return [...map.values()]
}

/**
 * 条目 id 的统一形状：`数据源:栏目:站点id`（例如 `ode:pc:134665`、`trainer:trainer:312`）。
 * 栏目与数据源必须从 id 自己就读得出来，不能依赖"之前浏览过"：重启后直接从"我的游戏"打开
 * 一个修改器时，条目库里未必有它。修改器与 MOD 的站点 id 都是裸数字、两个栏目之间还会撞号，
 * 所以它们也带前缀，由各自的数据源在出口拼、入口剥。
 */
export function itemIdOf(kind: SourceKind, section: string, siteId: string): string {
  return `${kind}:${section}:${siteId}`
}

/** `数据源:栏目:站点id` → 站点id；不带前缀的原样返回 */
export function siteIdOf(itemId: string): string {
  const parts = itemId.split(':')
  return parts.length >= 3 ? parts.slice(2).join(':') : itemId
}

export { BackendError }
