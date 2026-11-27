/**
 * InspirationView — 灵感页：示例图瀑布流 + 筛选/搜索 + 一键把提示词带入输入框。
 *
 * 数据来自 inspiration/ 数据源层，三个数据源：
 * - 案例集（Nano Banana）：示例图 + 提示词，按适用模型分组，联网拉取；
 * - 社区配方：按需下载并缓存提示词模板、槽位默认值、尺寸参数、分类与署名；
 * - 我的：用户在预览库「存为配方」攒下来的。
 * 每条灵感 = 示例图 + 提示词 + 适用模型 + 是否需要先上传参考图 + 是否含需替换的占位符。
 * 图片按视口懒加载：进入视口才取回并转成 blob:（宿主 CSP 不允许外链 <img>）。
 *
 * 带入输入框时把「需要用户动手」的地方讲清楚，而不是让人复制后直接点生成却得不到效果：
 * - 需参考图的：带入后提示去添加图片；
 * - 含 [方括号] / {花括号} 占位的：带入后提示替换占位符。
 * - 配方：详情里先把槽位填好（每格有默认值），带入的是填完的完整提示词，不再让用户在几百字里找占位符。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { loadInspirations, acquireImage, releaseImages, dropLegacyCache } from '../js/inspiration/index.mjs'
import { observeCover } from '../js/inspiration/viewport.mjs'
import { CATEGORY_LABELS, CATEGORIES, pick, renderPrompt } from '../js/recipes.mjs'
import { assetPreviewUrl } from '../js/assets.mjs'
import { useMasonry } from '../js/useMasonry.js'
import { Dialog, DialogContent, DialogOverlay, DialogTitle } from '../ui/index.jsx'
import { CheckIcon, CopyIcon, ExternalLinkIcon, LightbulbIcon, SearchIcon, TrashIcon, XIcon } from '../ui/icons.jsx'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'ready', label: '直接可用', test: (i) => !i.needsReference && !i.hasPlaceholder },
  { id: 'reference', label: '需参考图', test: (i) => i.needsReference },
  { id: 'placeholder', label: '需替换占位', test: (i) => i.hasPlaceholder }
]

/* 数据源：id 对应 inspiration/index.mjs 里注册的适配器；mine 不是适配器，数据由 App 从 KV 读出传入 */
const SOURCES = [
  { id: 'nano-banana', label: '案例集' },
  { id: 'builtin-recipes', label: '配方' },
  { id: 'mine', label: '我的' }
]
const MINE = 'mine'

/** 「我的」配方（recipes.mjs 的存储形状）→ 灵感条目，与内置配方同构 */
function mineItem(recipe) {
  return {
    kind: 'recipe', id: `mine-${recipe.id}`, title: pick(recipe.title, 'zh'), prompt: recipe.prompt,
    coverAssetId: recipe.coverAssetId ?? '', image: '',
    needsReference: recipe.inputs.length > 0, input: recipe.inputs.length ? `需先添加 ${recipe.inputs.length} 张参考图` : '',
    hasPlaceholder: recipe.slots.length > 0, note: pick(recipe.summary, 'zh'),
    models: [], author: '', sourceUrl: '', recipe
  }
}

/** 按内容自动增高的单行起步文本域（最多 maxRows 行，超出滚动）。
    配方空位的默认值经常是几十字的长句，单行 <input> 会裁掉，用户看不清自己要改的是什么。 */
function AutoTextarea({ value, onChange, rows = 1, maxRows = 4, className = '', ...rest }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxRows * parseFloat(getComputedStyle(el).lineHeight) + 2)}px`
  }, [value, maxRows])
  return (
    <textarea ref={ref} className={`ig-recipe-ta ${className}`} rows={rows} value={value}
      onChange={(e) => onChange(e.target.value)} {...rest} />
  )
}

/** 占位符数量（用于提示「替换 N 处占位」）：[方括号] 与 {花括号} 两种写法 */
function countPlaceholders(text) {
  return (String(text ?? '').match(/\[[^\]\n]{1,60}\]|\{[^}\n]{1,60}\}/g) || []).length
}

/** 第一个占位符在文本中的 [起, 止) 区间；没有则返回 null */
function firstPlaceholderRange(text) {
  const m = /\[[^\]\n]{1,60}\]|\{[^}\n]{1,60}\}/.exec(String(text ?? ''))
  return m ? [m.index, m.index + m[0].length] : null
}

/**
 * 配方的可搜索文本。界面是中文的，所以除了上游的英文标签，还要把中文分类名、中文槽位标签一并纳入，
 * 否则搜「信息图」「海报」什么都搜不到。
 */
function recipeSearchText(item) {
  const r = item.recipe
  const slotLabels = (r.slots ?? []).map((s) => `${pick(s.label, 'zh')} ${pick(s.label, 'en')}`).join(' ')
  return [
    `${r.title?.zh ?? ''} ${r.title?.en ?? ''}`,
    `${(r.tags ?? []).join(' ')} ${r.category} ${CATEGORY_LABELS[r.category] ?? ''} ${slotLabels}`,
    `${r.summary?.zh ?? ''} ${r.summary?.en ?? ''}`,
    r.prompt ?? ''
  ]
}

/** 按数据源与查询过滤。配方走带权重的 recipeSearchText，案例集保持原来的标题/提示词匹配。 */
function filterItems(items, source, query, category) {
  const q = query.trim().toLowerCase()
  const isRecipe = source !== 'nano-banana'
  if (isRecipe && category !== 'all') items = items.filter((i) => i.recipe?.category === category)
  if (!q) return items
  if (!isRecipe) return items.filter((i) => `${i.title} ${i.prompt}`.toLowerCase().includes(q))
  const terms = q.split(/\s+/).filter(Boolean)
  const weights = [6, 4, 2, 1]
  const scored = []
  for (const item of items) {
    const fields = recipeSearchText(item)
    let score = 0
    let all = true
    for (const term of terms) {
      let best = 0
      fields.forEach((text, i) => { if (text.toLowerCase().includes(term)) best = Math.max(best, weights[i]) })
      if (best === 0) { all = false; break }
      score += best
    }
    if (all) scored.push({ item, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item)
}

export function InspirationView({ topbar, onUsePrompt, onUseRecipe, onCopyPrompt, mine = [], onDeleteMine, toast }) {
  const [source, setSource] = useState('nano-banana')
  const [items, setItems] = useState([])
  const [adapter, setAdapter] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [model, setModel] = useState('all')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState(null)     // 打开详情的条目
  const [shown, setShown] = useState(48)         // 先渲染前若干张，滚到底再放
  const sentinelRef = useRef(null)
  const loadEpoch = useRef(0)

  const load = useCallback(async (force = false) => {
    const epoch = ++loadEpoch.current
    setLoading(true); setError('')
    try {
      if (source === MINE) {
        setItems(mine.map(mineItem)); setAdapter({ id: MINE, label: '我的配方', license: '', homeUrl: '' })
      } else {
        const result = await loadInspirations({ force, adapterId: source })
        if (loadEpoch.current !== epoch) return
        setItems(result.items); setAdapter(result.adapter)
      }
      setShown(48)
    } catch (err) {
      if (loadEpoch.current === epoch) setError(err instanceof Error ? err.message : String(err))
    } finally { if (loadEpoch.current === epoch) setLoading(false) }
  }, [source, mine])

  useEffect(() => { void dropLegacyCache() }, [])
  useEffect(() => { void load(); return () => { loadEpoch.current++ } }, [load])
  /* 离开灵感页时释放图片 blob（再次进入会重新按视口加载） */
  useEffect(() => () => releaseImages(), [])

  /* 可选的模型筛选：来自数据源声明的 models（配方与我的没有这一维，不显示） */
  const models = useMemo(() => {
    const set = new Set()
    for (const item of items) for (const m of item.models ?? []) set.add(m)
    return [...set]
  }, [items])

  const isRecipeSource = source !== 'nano-banana'

  /* 当前数据源里实际出现过的分类：只列这些，不把九个分类全摆出来让人点到空分组 */
  const categories = useMemo(() => {
    const present = new Set(items.map((i) => i.recipe?.category).filter(Boolean))
    return CATEGORIES.filter((c) => present.has(c)).map((c) => ({ id: c, label: CATEGORY_LABELS[c] ?? c }))
  }, [items])

  const filtered = useMemo(() => {
    const active = FILTERS.find(f => f.id === filter)
    let list = filterItems(items, source, query, category)
    if (active?.test) list = list.filter((item) => active.test(item))
    if (model !== 'all' && !isRecipeSource) list = list.filter((item) => (item.models ?? []).includes(model))
    return list
  }, [items, source, filter, model, query, category, isRecipeSource])

  /* 真正的瀑布流：先渲染前 shown 条，卡片量出高度后由「最短列优先」重新分配 */
  const visible = useMemo(() => filtered.slice(0, shown), [filtered, shown])
  const masonry = useMasonry(visible, { minColumnWidth: 220, gap: 14 })

  /* 滚到底部哨兵 → 多显示一批。以瀑布流容器为观察根（判断「滚到底」更准）。
     这里故意不加「超时兜底」：哨兵的兜底如果也当成可见，会一次性把全部卡片渲染出来，
     失去分批的意义；观察器不工作时最多只显示前一批，是更安全的失败方式。 */
  const scrollerRef = useRef(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || shown >= filtered.length) return
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) setShown(n => Math.min(filtered.length, n + 48))
    }, { root: scrollerRef.current, rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [shown, filtered.length])

  const use = (item) => {
    /* 配方：卡片上的快速带入不走详情，直接用各槽位的默认值渲染（想改空位就点卡片进详情）。
       这里不能把带 {{槽位}} 的原始模板塞进输入框——那不是能直接画的提示词。 */
    if (item.recipe) {
      onUseRecipe(item, { values: {}, extra: '' })
      toast(item.needsReference ? '配方已带入，记得添加参考图' : '配方已带入输入框', item.needsReference ? 'info' : 'success')
      setDetail(null)
      return
    }
    const after = []
    if (item.hasPlaceholder) after.push(`替换 ${countPlaceholders(item.prompt)} 处占位符`)
    if (item.needsReference) after.push('添加参考图')
    // 有占位符时把第一个选中：用户不必在几百字里自己找该改哪里，直接打字就替换掉
    onUsePrompt(item.prompt, item.hasPlaceholder ? firstPlaceholderRange(item.prompt) : undefined)
    toast(after.length ? `提示词已带入，记得${after.join('、')}` : '提示词已带入输入框', after.length ? 'info' : 'success')
    setDetail(null)
  }

  const copy = async (item) => { await onCopyPrompt(item.prompt) }

  /* 切数据源时把该源不适用的筛选归位（模型筛选只对案例集有意义，分类只对配方有意义） */
  const switchSource = (id) => {
    if (id === source) return
    loadEpoch.current++
    setItems([]); setDetail(null); setAdapter(null)
    setSource(id)
    setModel('all'); setCategory('all'); setQuery(''); setFilter('all')
  }

  return (
    <div className="ig-insp">
      {topbar}
      <div className="ig-insp-bar">
        <div className="ig-insp-title">
          <LightbulbIcon size={16} />
          <span>灵感</span>
          {adapter && (
            <a className="ig-insp-source" href={adapter.homeUrl || undefined} target="_blank" rel="noreferrer"
              title={adapter.homeUrl ? `${adapter.label} · 许可：${adapter.license}` : adapter.label}>
              {/* 屏幕上只留来源名，许可证收进 hover 提示：四种许可全列出来要 299px，
                  占了工具条三分之一宽，会把搜索框挤到第二行。逐条署名在配方详情里仍有 */}
              {adapter.label}
            </a>
          )}
        </div>
        <div className="ig-insp-filters" role="group" aria-label="数据源">
          {SOURCES.map(s => (
            <button key={s.id} type="button" className="ig-insp-chip" aria-pressed={source === s.id}
              onClick={() => switchSource(s.id)}>{s.label}</button>
          ))}
        </div>
        <div className="ig-insp-filters" role="group" aria-label="筛选">
          {FILTERS.map(f => (
            <button key={f.id} type="button" className="ig-insp-chip" aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        {!isRecipeSource && models.length > 1 && (
          <div className="ig-insp-filters" role="group" aria-label="适用模型">
            <button type="button" className="ig-insp-chip" aria-pressed={model === 'all'} onClick={() => setModel('all')}>全部模型</button>
            {models.map(m => (
              <button key={m} type="button" className="ig-insp-chip" aria-pressed={model === m} onClick={() => setModel(m)}>{m}</button>
            ))}
          </div>
        )}
        <label className="ig-insp-search">
          <SearchIcon size={14} />
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索灵感或提示词" aria-label="搜索灵感" spellCheck={false} />
          {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><XIcon size={12} /></button>}
        </label>
        <span className="ig-insp-count">{loading ? '加载中…' : `${filtered.length} 条`}</span>
        {source !== MINE && (
          <button type="button" className="ig-act-btn" disabled={loading} onClick={() => void load(true)}>刷新</button>
        )}
      </div>

      {/* 分类行：只对配方/我的显示；一行放不下时横向滚动 */}
      {isRecipeSource && categories.length > 1 && (
        <div className="ig-insp-bar ig-insp-bar-sub" role="group" aria-label="配方分类">
          <button type="button" className="ig-insp-chip" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>全部分类</button>
          {categories.map(c => (
            <button key={c.id} type="button" className="ig-insp-chip" aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}>{c.label}</button>
          ))}
        </div>
      )}

      {error ? (
        <div className="pk-empty-state" role="alert">
          <strong className="pk-empty-title">无法加载灵感</strong>
          <p className="pk-empty-hint">{error}</p>
          <button type="button" className="pk-btn" onClick={() => void load(true)}>重试</button>
        </div>
      ) : loading && !items.length ? (
        <div className="ig-insp-skeleton" aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => <div key={i} className="ig-insp-card"><span className="ig-lib-skel" style={{ height: 120 + (i % 4) * 60 }} /></div>)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="pk-empty-state" role="status">
          <strong className="pk-empty-title">{items.length ? '没有匹配的灵感' : source === MINE ? '还没有自己的配方' : '暂无灵感'}</strong>
          <p className="pk-empty-hint">{items.length ? '换个筛选条件或搜索词试试。' : source === MINE ? '在「预览库」里对满意的图点「存为配方」，它就会出现在这里。' : '可以刷新列表后再查看。'}</p>
          {!items.length && source !== MINE && (
            <button type="button" className="pk-btn" onClick={() => void load(true)}>刷新</button>
          )}
        </div>
      ) : (
        <div className="ig-insp-masonry" ref={scrollerRef}>
          <div className="ig-insp-columns" ref={masonry.containerRef} style={{ gap: masonry.gap }}>
            {masonry.columns.map((column) => (
              <div key={column[0]?.id ?? 'empty'} className="ig-insp-column" style={{ gap: masonry.gap }}>
                {column.map((item, index) => (
                  <InspirationCard key={item.id} item={item} onHeight={masonry.onItemHeight}
                    onOpen={() => setDetail(item)} onUse={() => use(item)} onCopy={() => void copy(item)} />
                ))}
              </div>
            ))}
          </div>
          <div ref={sentinelRef} className="ig-insp-sentinel" aria-hidden="true" />
        </div>
      )}

      {detail && (
        <DetailDialog key={detail.id} detail={detail} isRecipe={isRecipeSource}
          onClose={() => setDetail(null)} onUse={use}
          onUseRecipe={(values, extra) => {
            onUseRecipe(detail, { values, extra })
            setDetail(null)
          }}
          onCopy={() => void copy(detail)}
          onDelete={source === MINE ? () => { onDeleteMine(detail); setDetail(null) } : null} />
      )}
    </div>
  )
}

/** 详情弹层。案例集条目：大图 + 元信息 + 完整提示词 + 带入；
    配方条目：另外渲染槽位表单（每格预填默认值），带入的是填好的提示词。 */
function DetailDialog({ detail, isRecipe, onClose, onUse, onUseRecipe, onCopy, onDelete }) {
  const slots = isRecipe ? detail.recipe.slots : []
  const [values, setValues] = useState(() => Object.fromEntries(slots.map((s) => [s.name, s.default ?? ''])))
  const [extra, setExtra] = useState('')
  const setSlot = (name, value) => setValues((prev) => ({ ...prev, [name]: value }))

  const submit = () => {
    if (!isRecipe) { onUse(detail); return }
    onUseRecipe(values, extra)
  }

  const r = isRecipe ? detail.recipe : null
  const source = r?.source
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogOverlay />
      <DialogContent className={`ig-insp-detail${isRecipe ? ' ig-recipe-detail' : ''}`}>
        <DialogTitle>{detail.title}</DialogTitle>
        <div className="ig-insp-detail-body">
          <InspirationImage item={detail} eager large />
          <div className="ig-insp-detail-meta">
            {isRecipe ? (
              <>
                <span className="ig-insp-model">{CATEGORY_LABELS[r.category] ?? r.category}</span>
                {(detail.models ?? []).map((m) => <span key={m} className="ig-insp-flag" title="在这些模型上验证过">{m}</span>)}
                {r.params.size && r.params.size !== 'auto' && <span className="ig-insp-flag">{r.params.size}</span>}
                {detail.needsReference && <span className="ig-insp-flag" data-kind="ref">需参考图 · {detail.input}</span>}
                {detail.author && <span className="ig-insp-author">by {detail.author}</span>}
              </>
            ) : (
              <>
                <span className="ig-insp-model">{(detail.models ?? []).join(' / ')}</span>
                {detail.needsReference && <span className="ig-insp-flag" data-kind="ref">需参考图 · {detail.input || '先上传参考图'}</span>}
                {detail.hasPlaceholder && <span className="ig-insp-flag" data-kind="ph">含 {countPlaceholders(detail.prompt)} 处占位符</span>}
                {detail.author && <span className="ig-insp-author">by @{detail.author}</span>}
              </>
            )}
          </div>
          {isRecipe && detail.note && <p className="ig-insp-note ig-recipe-summary">{detail.note}</p>}
          {detail.note && !isRecipe && <p className="ig-insp-note">{detail.note}</p>}
          {isRecipe && (
            <>
              {slots.length > 0 ? (
                <div className="ig-recipe-slots" role="group" aria-label="填写空位">
                  <div className="ig-recipe-slots-head">填写空位 <span>留空用默认值</span></div>
                  {slots.map((s) => (
                    <label key={s.name} className="ig-recipe-slot">
                      <span className="ig-recipe-slot-label">{pick(s.label, 'zh') || s.name.replace(/_/g, ' ')}</span>
                      <AutoTextarea className="pk-input" rows={1} value={values[s.name] ?? ''} aria-label={pick(s.label, 'zh') || s.name}
                        onChange={(value) => setSlot(s.name, value)} />
                    </label>
                  ))}
                </div>
              ) : <p className="ig-form-note">这条配方没有要填的空位，可以直接带入。</p>}
              <label className="ig-recipe-slot ig-recipe-extra">
                <span className="ig-recipe-slot-label">补充要求 <span>可选，追加在配方后面</span></span>
                <AutoTextarea className="pk-input" rows={1} value={extra} aria-label="补充要求"
                  placeholder="比如：换成暖色调、留出顶部标题位置" onChange={setExtra} />
              </label>
              {source && (
                <p className="ig-recipe-credit">
                  <span className="ig-recipe-credit-label">来源</span>
                  {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.repo || source.author || '原帖'}</a> : <span>{source.repo || source.author}</span>}
                  {source.author && source.repo ? <span> · {source.author}</span> : null}
                  {source.license ? <span> · {source.license}</span> : null}
                </p>
              )}
            </>
          )}
          <pre className="ig-insp-prompt">{isRecipe ? renderPrompt(r, values, extra) : detail.prompt}</pre>
        </div>
        <div className="ig-insp-detail-acts">
          {onDelete && (
            <button type="button" className="ig-act-btn ig-act-danger" onClick={onDelete}><TrashIcon size={13} />删除</button>
          )}
          {detail.sourceUrl && !isRecipe && (
            <a className="ig-act-btn" href={detail.sourceUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon size={13} />原帖</a>
          )}
          <button type="button" className="ig-act-btn" onClick={onCopy}><CopyIcon size={13} />复制提示词</button>
          <span className="ig-insp-detail-spacer" />
          <button type="button" className="pk-btn pk-btn-primary" onClick={submit}>
            <CheckIcon size={13} />带入输入框
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 单张卡片：图 + 标题 + 模型标签；hover 出「带入」「复制」。图进入视口才加载。
    渲染后把自身高度报给瀑布流（图片解码、标题换行导致高度变化时也会重新上报）。 */
function InspirationCard({ item, onOpen, onUse, onCopy, onHeight }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => onHeight(item, Math.round(el.getBoundingClientRect().height))
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [item, onHeight])
  const recipe = item.recipe
  return (
    <article ref={ref} className="ig-insp-card" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
      <InspirationImage item={item} />
      <div className="ig-insp-card-body">
        <h3 className="ig-insp-card-title" title={item.title}>{item.title}</h3>
        <div className="ig-insp-card-meta">
          {recipe ? (
            <>
              <span className="ig-insp-model">{CATEGORY_LABELS[recipe.category] ?? recipe.category}</span>
              {recipe.slots.length > 0 && <span className="ig-insp-flag" data-kind="ph" title="有要填的空位">{recipe.slots.length} 个空位</span>}
              {item.needsReference && <span className="ig-insp-flag" data-kind="ref" title={item.input}>参考图</span>}
            </>
          ) : (
            <>
              <span className="ig-insp-model">{(item.models ?? [])[0]}</span>
              {item.needsReference && <span className="ig-insp-flag" data-kind="ref" title={item.input || '需要先上传参考图'}>参考图</span>}
              {item.hasPlaceholder && <span className="ig-insp-flag" data-kind="ph" title="提示词里有需要替换的占位符">占位</span>}
            </>
          )}
        </div>
      </div>
      <div className="ig-insp-card-acts" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="ig-act-btn" onClick={onUse}><CheckIcon size={13} />带入</button>
        <button type="button" className="ig-act-btn" onClick={onCopy} aria-label="复制提示词" title="复制提示词"><CopyIcon size={13} /></button>
      </div>
    </article>
  )
}

/** 示例图：进入视口才经数据源层取回（blob:），取不到时给出占位而不是破图。 */
function InspirationImage({ item, eager = false, large = false }) {
  const ref = useRef(null)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(eager)

  useEffect(() => {
    const element = ref.current
    if (!element || eager) return
    return observeCover(element, setVisible)
  }, [eager])

  useEffect(() => {
    setUrl(''); setFailed(false)
    if (!visible) return
    let alive = true
    const lease = item.coverAssetId ? null : acquireImage(item.image)
    const pending = lease ? lease.ready : assetPreviewUrl(item.coverAssetId)
    pending
      // 资产已被删除时 assetPreviewUrl 返回 null：按「加载失败」处理，否则会永远停在骨架屏
      .then((u) => { if (alive) { if (u) setUrl(u); else setFailed(true) } })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false; lease?.release() }
  }, [visible, item.image, item.coverAssetId])

  return (
    <div ref={ref} className={`ig-insp-fig${large ? ' is-large' : ''}`} data-state={url ? 'ready' : failed ? 'failed' : 'loading'}>
      {/* 不加 loading="lazy"：取图已经由上面的可见性观察器按视口触发，这里再懒加载就是双重懒加载，
          多一层对浏览器调度的依赖（个别环境里原生 lazy 不触发，图会一直不解码）。 */}
      {url ? <img src={url} alt={item.title} draggable={false} />
        : failed ? <span className="ig-insp-fig-failed">图片加载失败</span>
        : <span className="ig-lib-skel" aria-hidden="true" />}
    </div>
  )
}
