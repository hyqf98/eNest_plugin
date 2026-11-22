/**
 * bqb — ChineseBQB 数据源适配器（主源）。
 * 目录索引：zhaoolee.com/ChineseBQB/catalog/{index,search}.json（GitHub Pages，随 release 自动更新）。
 * 索引字段：id,name,label,src,thumb,width,height,animated,bytes,category,categoryTitle,folder。
 * 图片直链（zhaoolee.com 与 raw.githubusercontent 均无防盗链）；jsDelivr 作加速镜像。
 * index.json 约 300KB / search.json 约 1.2MB，走流式拉取。
 */

import { fetchBytes, fetchText } from '../api.mjs'

const BASE = 'https://zhaoolee.com/ChineseBQB/'
const INDEX_URL = `${BASE}catalog/index.json`
const SEARCH_URL = `${BASE}catalog/search.json`
/** jsDelivr 镜像：同仓库 raw 路径（folder/src），主站失败时降级 */
const MIRROR = 'https://cdn.jsdelivr.net/gh/zhaoolee/ChineseBqb@master/'

let indexPromise = null
let catalog = null // { categories: [{id,title,count}], items: [{...索引字段}] }

async function loadCatalog(force = false) {
  if (catalog && !force) return catalog
  if (!indexPromise || force) {
    indexPromise = (async () => {
      const [indexText, searchText] = await Promise.all([
        fetchText({ url: INDEX_URL, timeoutMs: 30000 }),
        fetchText({ url: SEARCH_URL, timeoutMs: 60000 }),
      ])
      const index = JSON.parse(indexText)
      const search = JSON.parse(searchText)
      // index.json: { categories: [{slug,title,count,...}] }；search.json: 顶层数组（5887 项）
      const categories = (Array.isArray(index) ? index : index.categories ?? []).map(normalizeCategory)
      const items = (Array.isArray(search) ? search : search.items ?? []).map(normalizeItem)
      catalog = { categories, items }
      return catalog
    })()
    indexPromise.catch(() => { indexPromise = null })
  }
  return indexPromise
}

function normalizeCategory(raw) {
  if (typeof raw === 'string') return { id: raw, title: raw, count: 0 }
  return {
    id: String(raw.slug ?? raw.id ?? raw.category ?? raw.name ?? ''),
    title: String(raw.title ?? raw.categoryTitle ?? raw.name ?? ''),
    count: Number(raw.count ?? raw.total ?? 0) || 0,
  }
}

function normalizeItem(raw) {
  const width = Number(raw.width) || 0
  const height = Number(raw.height) || 0
  const category = String(raw.category ?? '')
  return {
    id: `bqb:${raw.id ?? raw.src}`,
    source: 'bqb',
    label: String(raw.label ?? raw.name ?? ''),
    imageUrl: `${BASE}${String(raw.src).replace(/^\/+/, '')}`,
    thumbUrl: raw.thumb ? `${BASE}${String(raw.thumb).replace(/^\/+/, '')}` : undefined,
    width,
    height,
    animated: Boolean(raw.animated ?? String(raw.src).toLowerCase().endsWith('.gif')),
    category,
  }
}

/** 分类浏览 + 关键词搜索 + 动图筛选；内存过滤，分页 slice */
async function list({ category = '', animated = '', keyword = '', page = 1, pageSize = 60 } = {}) {
  const { items } = await loadCatalog()
  const kw = keyword.trim().toLowerCase()
  let filtered = items
  if (category) filtered = filtered.filter(item => item.category === category)
  if (animated === 'yes') filtered = filtered.filter(item => item.animated)
  else if (animated === 'no') filtered = filtered.filter(item => !item.animated)
  if (kw) filtered = filtered.filter(item => item.label.toLowerCase().includes(kw))
  const start = (page - 1) * pageSize
  const slice = filtered.slice(start, start + pageSize)
  return { items: slice, hasMore: start + pageSize < filtered.length }
}

async function getFilters() {
  const { categories, items } = await loadCatalog()
  const counts = new Map()
  for (const item of items) {
    if (item.category) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  }
  const options = categories
    .filter(cat => counts.has(cat.id))
    .map(cat => ({ value: cat.id, name: `${cat.title} ${counts.get(cat.id)}`.trim(), count: counts.get(cat.id) }))
  return [
    { key: 'category', name: '分类', options },
    { key: 'animated', name: '动图', options: [
      { value: 'yes', name: '动图' },
      { value: 'no', name: '静图' },
    ] },
  ]
}

/** 拉单图（原图），支持 jsDelivr 镜像降级 */
async function loadImage(itemUrl, { signal } = {}) {
  const first = await fetchBytes({ url: itemUrl, timeoutMs: 30000, signal })
  return first
}

export const bqbSource = {
  id: 'bqb',
  name: 'ChineseBQB',
  description: '5800+ 张经典中文表情包，115 分类',
  homepage: 'https://github.com/zhaoolee/ChineseBqb',
  list,
  getFilters,
  refresh(force = false) {
    if (force) { indexPromise = null; catalog = null }
    return loadCatalog(true)
  },
  loadImage,
}

export { MIRROR as BQB_MIRROR }
