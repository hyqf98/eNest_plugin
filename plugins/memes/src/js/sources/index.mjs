/**
 * sources/index — 数据源注册表。
 * 每个源实现同一契约：list / getFilters / refresh；
 * 视图按当前源渲染对应筛选条件，源之间互不阻塞。
 */

import { bqbSource } from './bqb.mjs'
import { fabiaoqingSource } from './fabiaoqing.mjs'

export const SOURCES = [bqbSource, fabiaoqingSource]

export function getSource(id) {
  return SOURCES.find(source => source.id === id) ?? SOURCES[0]
}
