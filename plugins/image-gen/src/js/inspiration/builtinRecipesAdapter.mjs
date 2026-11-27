/**
 * 配方来自固定版本的 @kadaliao/dsh-images，文本索引首次打开时下载并缓存在插件 KV，封面按视口获取。
 *
 * 与 Nano Banana 灵感条目的区别：配方有 slots（{{槽位}} 及默认值）、params（尺寸/帧数）、category，
 * 视图层按 kind === 'recipe' 分支渲染；两者共用的字段（id/title/prompt/image/needsReference）保持一致。
 *
 * 带 frames 的是 GIF 循环配方：需要「精灵图切帧 + GIF 编码」，第一期不做。它们不能当成普通配方展示，
 * 否则用户照着生成只会得到一张九宫格精灵图——所以这里直接滤掉（共 10 条，全是 sticker 分类）。
 */

import { normalizeRecipe, pick } from '../recipes.mjs'
import { requestJson } from '../netFetch.mjs'

const base = 'https://cdn.jsdelivr.net/npm/@kadaliao/dsh-images@0.8.1/recipes/'
const catalogHash = '14104ffc15ef49f6be712aa7ca5c9aef02c3d978198de8c95a793244005b7d54'
const cacheKey = 'image-gen.inspiration.dsh-recipes.catalog'
const homeUrl = 'https://github.com/kadaliao/dsh-images'

async function verifiedCatalog(value) {
  if (value?.format !== 1 || !Array.isArray(value.recipes)) return false
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') === catalogHash
}

async function loadCatalog(force) {
  const storage = (window.enest || window.zapi)?.storage
  let saved
  try { saved = await storage?.get(cacheKey) } catch { /* cache is optional */ }
  const usable = await verifiedCatalog(saved)
  if (usable && !force) return saved
  try {
    const catalog = await requestJson({ url: `${base}builtin.json` })
    if (!await verifiedCatalog(catalog)) throw new Error('配方索引内容与固定版本不符')
    try { await storage?.commit([{ op: 'set', key: cacheKey, value: catalog }]) } catch { /* quota or read-only storage */ }
    return catalog
  } catch (error) {
    if (usable) return saved
    throw new Error(`首次使用配方需要联网：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 配方 → 灵感条目。只用 zh（界面是中文的），en 留在 recipe 里备查。 */
function toItem(recipe) {
  return {
    kind: 'recipe',
    id: `recipe-${recipe.id}`,
    title: pick(recipe.title, 'zh'),
    prompt: recipe.prompt,
    image: `${base}covers/${encodeURIComponent(recipe.id)}.webp`,
    /* 参考图位：inputs 声明了几张就需要几张；文字槽位由 slots 表单填，不靠用户自己找占位符 */
    needsReference: recipe.inputs.length > 0,
    input: recipe.inputs.length ? `需先添加 ${recipe.inputs.length} 张参考图` : '',
    hasPlaceholder: recipe.slots.length > 0,
    note: pick(recipe.summary, 'zh'),
    /* 上游 191 条全部只在 gpt-image-2.6 上验证过（tested 字段）；换别的模型照画不保证效果，详情里如实显示 */
    models: recipe.tested?.length ? recipe.tested : [],
    author: recipe.source?.author ?? '',
    sourceUrl: recipe.source?.url ?? '',
    recipe
  }
}

export const builtinRecipesAdapter = {
  id: 'builtin-recipes',
  label: '社区配方',
  license: 'MIT · CC BY 4.0 · Apache-2.0 · CC0',
  homeUrl,
  cached: false,

  async loadIndex({ force = false } = {}) {
    const builtin = await loadCatalog(force)
    const items = []
    for (const raw of builtin.recipes) {
      try {
        const recipe = normalizeRecipe(raw)
        if (recipe.params.frames) continue
        items.push(toItem(recipe))
      } catch {
        // 单条坏数据跳过，不让整页失败
      }
    }
    return items
  },

  imageUrlOf(item) {
    return item.image ?? ''
  }
}
