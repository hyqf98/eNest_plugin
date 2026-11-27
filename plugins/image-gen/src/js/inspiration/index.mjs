/**
 * inspiration — 灵感数据源层（通用接口 + 适配器注册表）。
 *
 * 一个「灵感」= 一张示例图 + 一条可直接用的提示词。来源可以是任意站点或仓库，
 * 只要提供一个适配器把它翻译成统一的条目结构。以后接新数据源只需新增一个适配器，
 * 不必改灵感页。
 *
 * 宿主约束（决定了下面所有取数方式，不要绕开）：
 * - 插件页 CSP 的 img-src 只放行 'self' / data: / blob:，所以示例图不能直接写外链 <img>，
 *   必须经 net.fetch 取回字节再转成 blob: 地址（见 acquireImage）。
 * - net.fetch 非流式响应上限 2MB，并发上限 8（netFetch.mjs 自限 4）。索引文本走非流式；
 *   图片走流式（32MB 上限）并按视口懒加载。
 */

import { downloadBinary } from '../netFetch.mjs'
import { nanoBananaAdapter } from './nanoBananaAdapter.mjs'
import { builtinRecipesAdapter } from './builtinRecipesAdapter.mjs'

/** 适配器必须实现的形状：
 *   {
 *     id: string            // 稳定标识，用于缓存键
 *     label: string         // 展示名
 *     license: string       // 内容许可，灵感页标注来源时展示
 *     homeUrl: string       // 来源主页
 *     models: string[]      // 这批示例适用的生图模型（用于「对应的模型是什么」标注）
 *     async loadIndex(): Promise<Inspiration[]>   // 拉取并解析全部条目（不含图片字节）
 *     imageUrlOf(item): string                    // 条目示例图的原始地址
 *   }
 */
export const adapters = new Map()

export function registerAdapter(adapter) {
  if (!adapter || typeof adapter.loadIndex !== 'function' || typeof adapter.imageUrlOf !== 'function') {
    throw new Error('灵感数据源适配器缺少必要方法')
  }
  adapters.set(adapter.id, adapter)
}

export function getAdapter(id) {
  return adapters.get(id) ?? null
}

/* —— 缓存：索引存进插件 KV（离线也能看文字），图片只放内存 —— */

/* 按适配器分键：多个数据源各有各的缓存，互不覆盖 */
const INDEX_KEY = id => `image-gen.inspiration.index.${id}.v1`
const INDEX_TTL_MS = 12 * 36e5 // 12 小时内不重复拉索引

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

/** 读索引：有新鲜缓存就直接用；否则调适配器拉取并落盘。force 跳过缓存。 */
export async function loadInspirations({ force = false, adapterId = 'nano-banana' } = {}) {
  const adapter = getAdapter(adapterId)
  if (!adapter) throw new Error('没有可用的灵感数据源')
  let cached = null
  if (!force) {
    try { cached = adapter.cached === false ? null : await store().storage.get(INDEX_KEY(adapter.id)) } catch { cached = null }
    if (cached && cached.adapter === adapter.id && Date.now() - (cached.at ?? 0) < INDEX_TTL_MS && Array.isArray(cached.items)) {
      return { items: cached.items, adapter, fromCache: true }
    }
  }
  const items = await adapter.loadIndex({ force })
  if (adapter.cached !== false) {
    try { await store().storage.set(INDEX_KEY(adapter.id), { adapter: adapter.id, at: Date.now(), items }) } catch { /* 缓存写不进去不影响使用 */ }
  }
  return { items, adapter, fromCache: false }
}

const images = new Map()
const idleImages = new Map()
const idleLimit = 8 * 1024 * 1024
let idleBytes = 0

function discard(entry) {
  if (images.get(entry.key) !== entry) return
  images.delete(entry.key)
  if (idleImages.delete(entry.key)) idleBytes -= entry.bytes
  entry.controller.abort()
  if (entry.url) URL.revokeObjectURL(entry.url)
}

export function acquireImage(key) {
  if (!key) return { ready: Promise.resolve(''), release() {} }
  let entry = images.get(key)
  if (!entry) {
    entry = { key, controller: new AbortController(), users: 0, bytes: 0, url: '' }
    images.set(key, entry)
    entry.ready = downloadBinary(key, { signal: entry.controller.signal }).then(bytes => {
      entry.controller.signal.throwIfAborted()
      const type = sniffImageMime(bytes)
      if (type === 'application/octet-stream') throw new Error('无法识别的图片格式')
      entry.bytes = bytes.byteLength
      entry.url = URL.createObjectURL(new Blob([bytes], { type }))
      return entry.url
    }).catch(error => { discard(entry); throw error })
  }
  if (idleImages.delete(key)) idleBytes -= entry.bytes
  entry.users++
  let released = false
  return { ready: entry.ready, release() {
    if (released) return
    released = true
    if (--entry.users || images.get(key) !== entry) return
    if (!entry.url) { discard(entry); return }
    idleImages.set(key, entry)
    idleBytes += entry.bytes
    while (idleImages.size > 24 || idleBytes > idleLimit) discard(idleImages.values().next().value)
  } }
}

function sniffImageMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'image/webp'
  return 'application/octet-stream'
}

/** 释放全部图片缓存（离开灵感页时调用，避免 blob 地址常驻） */
export function releaseImages() {
  for (const entry of images.values()) discard(entry)
}

/* 内置数据源：适配器只依赖 netFetch 与解析器，不依赖本模块，这里注册不会形成循环引用。
   以后接入新的来源，在这里再 registerAdapter 一个适配器即可。 */
registerAdapter(nanoBananaAdapter)
registerAdapter(builtinRecipesAdapter)

/* 缓存键改成按适配器分键之前的旧键，现在没人读了。清掉免得白占一个 KV 键名额；
   由灵感页进入时调用，不在模块加载时做（这个模块也被测试入口引用）。 */
export async function dropLegacyCache() {
  try { await store().storage.remove('image-gen.inspiration.index.v1') } catch { /* 旧宿主/不可用时忽略 */ }
}
