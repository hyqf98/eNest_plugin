/**
 * contracts — 表情包插件跨模块类型（源适配器 ↔ 视图）。
 * 运行时为纯 JSDoc 语义，类型供开发参考；与宿主契约无涉。
 */

/**
 * MemeItem — 单张表情包。
 * @property {string} id 全局唯一（source:id）
 * @property {string} source 源 id
 * @property {string} label 文字描述（搜索用）
 * @property {string} imageUrl 原图 URL（https 直链）
 * @property {string} [thumbUrl] 缩略图 URL（缺省用原图）
 * @property {number} width 图宽（0=未知，卡片按 1:1 预留）
 * @property {number} height 图高
 * @property {boolean} animated 是否动图
 * @property {string} [category] 所属分类 id
 */
export const ITEM_KINDS = ['image']

/**
 * FilterGroup — 源声明的筛选组（chips 行）。
 * @property {string} key 组键（animated / category）
 * @property {string} name 组名
 * @property {{value: string, name: string}[]} options 选项
 */

/**
 * MemeSource — 数据源适配器契约。
 * list({category, animated, keyword, page, pageSize}) → {items, hasMore}
 * 注意：page 从 1 开始；hasMore=false 表示没有更多页。
 * getFilters() → Promise<FilterGroup[]> 源的筛选元数据（如分类列表）。
 */
export const SOURCES = []
