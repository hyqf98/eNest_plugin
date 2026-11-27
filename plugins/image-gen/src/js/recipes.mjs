/**
 * recipes — 配方：一条经过测试的提示词模板 + `{{槽位}}` 默认值 + 画它时用的参数 + 署名。
 *
 * 校验、归一化、槽位填充与搜索移植自 @kadaliao/dsh-images 的 lib/recipes.mjs（MIT），
 * 去掉了其中依赖 node:zlib / Buffer 的部分（分享码 dshimg1.、PNG 文本块）——那些是第二期的内容，
 * 而且不能原样进页面。函数逻辑与报错文案保持与上游一致，便于以后对照升级。
 * 源码：https://github.com/kadaliao/dsh-images  版权与许可全文见 src/data/recipes/LICENSE-dsh-images.txt
 *
 * 「我的配方」存插件私有 KV `image-gen.recipes.mine.v1`，用 commit 显式提交。
 */

export const RECIPE_FORMAT = 1
export const CATEGORIES = ['photo', 'handdrawn', 'editorial', 'infographic', '3d', 'sticker', 'illustration', 'product', 'comic']

/** 分类 ID → 中文名。界面只显示中文，搜索时也拿中文名参与匹配。
    sticker 在上游含 GIF 循环配方，但那部分本期不展示（见 builtinRecipesAdapter），所以这里只叫「贴纸」。 */
export const CATEGORY_LABELS = {
  photo: '摄影', handdrawn: '手绘', editorial: '杂志海报', infographic: '信息图',
  '3d': '3D', sticker: '贴纸', illustration: '插画', product: '产品', comic: '漫画'
}

const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto']
const FRAMES = [4, 6, 9, 16]
const QUALITIES = ['low', 'medium', 'high']
const LIMITS = { id: 48, title: 60, summary: 240, prompt: 8000, label: 60, value: 400, tag: 24, tags: 6, slots: 8, inputs: 6, url: 600, author: 80, license: 40, repo: 120 }

/** 模板里的一个 `{{name}}` 空位 */
const SLOT_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/

const str = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v).slice(0, max) : '')

/** 一段 `{zh?, en?}` 双语文本。纯字符串按书写语言归档。 */
export function localized(v, max) {
  if (typeof v === 'string') {
    const s = str(v, max)
    return s === '' ? {} : CJK_RE.test(s) ? { zh: s } : { en: s }
  }
  const out = {}
  if (v && typeof v === 'object') {
    for (const lang of ['zh', 'en']) {
      const s = str(v[lang], max)
      if (s !== '') out[lang] = s
    }
  }
  return out
}

/** 取 `lang` 的文本，没有就退到另一种语言。界面是中文的，默认取 zh。 */
export function pick(text, lang = 'zh') {
  if (typeof text === 'string') return text
  if (!text || typeof text !== 'object') return ''
  const want = String(lang).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return text[want] ?? text[want === 'zh' ? 'en' : 'zh'] ?? ''
}

/** 模板里出现的空位名，按首次出现顺序 */
export function slotsOf(prompt) {
  const names = []
  for (const m of String(prompt ?? '').matchAll(SLOT_RE)) if (!names.includes(m[1])) names.push(m[1])
  return names
}

/** 任意文本 → kebab-case ID；没有可用字符时返回 '' */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** https 地址，否则 '' */
function httpsUrl(v) {
  const s = str(v, LIMITS.url)
  if (!/^https:\/\//i.test(s)) return ''
  try {
    return new URL(s).href
  } catch {
    return ''
  }
}

/** 封面引用：https 地址，或来源内部的普通相对路径 */
function coverRef(v) {
  const s = str(v, LIMITS.url)
  if (s === '') return ''
  if (/^https:\/\//i.test(s)) return httpsUrl(s)
  if (/^[A-Za-z0-9._/-]+$/.test(s) && !s.split('/').includes('..') && !s.startsWith('/')) return s
  return ''
}

/**
 * 校验一条配方并整理成存储形状。出错时抛出说明原因的 Error，未知字段丢弃。
 * @param {unknown} raw
 */
export function normalizeRecipe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a recipe must be an object')
  const prompt = str(raw.prompt, LIMITS.prompt)
  if (prompt === '') throw new Error('the recipe has no prompt')
  const title = localized(raw.title, LIMITS.title)
  if (!title.zh && !title.en) throw new Error('the recipe has no title')
  const givenId = str(raw.id, LIMITS.id).toLowerCase()
  const id = ID_RE.test(givenId) ? givenId : slugify(givenId) || slugify(title.en) || ''

  // 空位以模板里实际用到的为准，slots 只负责给它们贴标签
  const meta = new Map()
  for (const s of Array.isArray(raw.slots) ? raw.slots : []) {
    const name = str(s?.name, 32)
    if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) && !meta.has(name)) meta.set(name, s)
  }
  const names = slotsOf(prompt)
  if (names.length > LIMITS.slots) throw new Error(`a recipe may have at most ${LIMITS.slots} blanks; this one has ${names.length}`)
  const slots = names.map((name) => {
    const s = meta.get(name) ?? {}
    const label = localized(s.label, LIMITS.label)
    return { name, label: label.zh || label.en ? label : { en: name.replace(/_/g, ' ') }, default: str(s.default, LIMITS.value) }
  })

  const inputs = (Array.isArray(raw.inputs) ? raw.inputs : []).slice(0, LIMITS.inputs).map((input, i) => {
    const label = localized(typeof input === 'string' ? input : input?.label, LIMITS.label)
    const name = str(input?.name, 32)
    return { name: /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ? name : `image${i + 1}`, label: label.zh || label.en ? label : { en: `Image ${i + 1}`, zh: `图 ${i + 1}` } }
  })

  const p = raw.params && typeof raw.params === 'object' ? raw.params : {}
  const params = {}
  if (SIZES.includes(str(p.size, 16))) params.size = str(p.size, 16)
  if (FRAMES.includes(Number(p.frames))) params.frames = Number(p.frames)
  if (params.frames && Number.isFinite(Number(p.frameMs))) params.frameMs = Math.min(1000, Math.max(40, Math.round(Number(p.frameMs))))
  if (QUALITIES.includes(str(p.quality, 8))) params.quality = str(p.quality, 8)

  const category = CATEGORIES.includes(str(raw.category, 16)) ? str(raw.category, 16) : params.frames ? 'sticker' : inputs.length > 0 ? 'photo' : 'illustration'
  const tags = [...new Set((Array.isArray(raw.tags) ? raw.tags : []).map((t) => str(t, LIMITS.tag).toLowerCase()).filter(Boolean))].slice(0, LIMITS.tags)

  const out = { id, title, summary: localized(raw.summary, LIMITS.summary), category, tags, inputs, slots, prompt, params }

  const src = raw.source && typeof raw.source === 'object' ? raw.source : undefined
  if (src) {
    const source = {}
    const repo = str(src.repo, LIMITS.repo)
    const url = httpsUrl(src.url)
    const license = str(src.license, LIMITS.license)
    const author = str(src.author, LIMITS.author)
    if (repo) source.repo = repo
    if (url) source.url = url
    if (license) source.license = license
    if (author) source.author = author
    if (Object.keys(source).length > 0) out.source = source
  }
  const author = str(raw.author, LIMITS.author)
  if (author) out.author = author
  const cover = coverRef(raw.cover)
  if (cover) out.cover = cover
  if (Array.isArray(raw.tested)) {
    const tested = raw.tested.map((t) => str(t, 60)).filter(Boolean).slice(0, 6)
    if (tested.length > 0) out.tested = tested
  }
  for (const key of ['createdAt', 'updatedAt']) if (Number.isFinite(raw[key]) && raw[key] > 0) out[key] = raw[key]
  return out
}

/**
 * 配方最终画图用的提示词：每个空位依次用「调用方给的值 → 该空位的默认值 → 空位名」填上，最后追加补充说明。
 * @param {{prompt: string, slots: {name: string, default: string}[]}} recipe
 * @param {Record<string, unknown>} [values]
 * @param {string} [extra]
 */
export function renderPrompt(recipe, values = {}, extra = '') {
  const given = values && typeof values === 'object' ? values : {}
  const byName = new Map((recipe.slots ?? []).map((s) => [s.name, s]))
  const filled = String(recipe.prompt).replace(SLOT_RE, (_, name) => str(given[name], LIMITS.value) || byName.get(name)?.default || name.replace(/_/g, ' '))
  const more = str(extra, LIMITS.prompt)
  return more === '' ? filled : `${filled}\n\nAdditional direction: ${more}`
}

/** 一段提示词开头的短句当标题 */
export function titleFrom(prompt) {
  const s = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  const clause = s.split(/[，。,.:：;；!?！？\n]/)[0] || s
  // 按开头字符判断中日文：一条点名中国城市的英文提示词仍然是英文
  if (CJK_RE.test(clause.replace(/^[\s"'“‘(（【\[]+/, '').charAt(0))) return clause.slice(0, 16)
  const words = clause.split(' ').slice(0, 6).join(' ')
  return words.length > 40 ? `${words.slice(0, 39)}…` : words
}

/**
 * 一张预览库的图对应的配方：提示词原样、画它时用的尺寸。
 * 提示词里已有的 `{{` 拆成 `{ {`，否则会被当成模板空位。
 * 封面单独放 coverAssetId（normalizeRecipe 的 cover 只放行 https 与相对路径，assetId 走不通），
 * 显示时经 assetPreviewUrl 取图。预览库记录里没有参考图数量与画质，这两项不带。
 * @param {object} record - 预览库记录 { prompt, size, assetId }
 */
export function recipeFromRecord(record) {
  const prompt = String(record?.prompt ?? '').replace(SLOT_RE, (m) => m.replace(/\{\{|\}\}/g, (b) => (b === '{{' ? '{ {' : '} }')))
  const recipe = normalizeRecipe({
    id: `mine-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: titleFrom(prompt) || '我的配方',
    category: 'illustration',
    prompt,
    params: SIZES.includes(record?.size) ? { size: record.size } : {}
  })
  if (record?.assetId) recipe.coverAssetId = record.assetId
  return recipe
}

/**
 * 匹配查询的配方，最好的排前面。每个词都必须出现；标题权重最高，其次是标签和分类，再到摘要，最后是提示词。
 * @param {object[]} recipes
 * @param {string} query
 */
export function searchRecipes(recipes, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return recipes.slice()
  const scored = []
  for (const r of recipes) {
    const fields = [
      [`${r.title?.zh ?? ''} ${r.title?.en ?? ''}`.toLowerCase(), 6],
      [`${(r.tags ?? []).join(' ')} ${r.category}`.toLowerCase(), 4],
      [`${r.summary?.zh ?? ''} ${r.summary?.en ?? ''}`.toLowerCase(), 2],
      [String(r.prompt ?? '').toLowerCase(), 1]
    ]
    let score = 0
    let all = true
    for (const term of terms) {
      const best = fields.reduce((acc, [text, weight]) => (text.includes(term) ? Math.max(acc, weight) : acc), 0)
      if (best === 0) {
        all = false
        break
      }
      score += best
    }
    if (all) scored.push({ r, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.r)
}

/* —— 我的配方（插件私有 KV，显式提交） —— */

const MINE_KEY = 'image-gen.recipes.mine.v1'
let mineTail = Promise.resolve()

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

async function readMine(storage) {
  const saved = await storage.get(MINE_KEY)
  if (saved === undefined || saved === null) return []
  // 读失败不能当成空表：否则一次写回就把用户的配方清光
  if (!Array.isArray(saved)) throw new Error('我的配方数据格式无效，未覆盖已有数据')
  return saved
}

function updateMine(change) {
  const task = mineTail.then(async () => {
    const storage = store().storage
    const list = await readMine(storage)
    change(list)
    if (storage.commit) await storage.commit([{ op: 'set', key: MINE_KEY, value: list }])
    else {
      await storage.set(MINE_KEY, list)
      if (storage.flush) await storage.flush()
    }
    return list
  })
  mineTail = task.then(() => undefined, () => undefined)
  return task
}

/** 读取我的配方。读失败时展示为空，但不影响后续写入（写入走严格读取）。 */
export async function loadMine() {
  try {
    return await readMine(store().storage)
  } catch { /* 展示可以没有；写入用上面的严格读取 */ }
  return []
}

/** 新增一条我的配方，返回保存后的完整列表 */
export async function addMine(recipe) {
  return updateMine(list => { list.unshift(recipe) })
}

/** 按 id 删除一条我的配方，返回保存后的完整列表 */
export async function removeMine(id) {
  return updateMine(list => {
    const index = list.findIndex(r => r.id === id)
    if (index >= 0) list.splice(index, 1)
  })
}
