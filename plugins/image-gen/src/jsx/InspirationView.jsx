/**
 * InspirationView — 灵感页：示例图瀑布流 + 筛选/搜索 + 一键把提示词带入输入框。
 *
 * 数据来自 inspiration/ 数据源层（内置 Awesome-Nano-Banana-images，可接更多适配器）。
 * 每条灵感 = 示例图 + 提示词 + 适用模型 + 是否需要先上传参考图 + 是否含需替换的占位符。
 * 图片按视口懒加载：进入视口才经 net.fetch 取回并转成 blob:（宿主 CSP 不允许外链 <img>）。
 *
 * 带入输入框时把「需要用户动手」的地方讲清楚，而不是让人复制后直接点生成却得不到效果：
 * - 需参考图的：带入后提示去添加图片；
 * - 含 [方括号] / {花括号} 占位的：带入后提示替换占位符。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { loadInspirations, loadImage, releaseImages } from '../js/inspiration/index.mjs'
import { useMasonry } from '../js/useMasonry.js'
import { Dialog, DialogContent, DialogOverlay, DialogTitle } from '../ui/index.jsx'
import { CheckIcon, CopyIcon, ExternalLinkIcon, LightbulbIcon, SearchIcon, XIcon } from '../ui/icons.jsx'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'ready', label: '直接可用', test: (i) => !i.needsReference && !i.hasPlaceholder },
  { id: 'reference', label: '需参考图', test: (i) => i.needsReference },
  { id: 'placeholder', label: '需替换占位', test: (i) => i.hasPlaceholder },
]

/** 占位符数量（用于提示「替换 N 处占位」）：[方括号] 与 {花括号} 两种写法 */
function countPlaceholders(text) {
  return (String(text ?? '').match(/\[[^\]\n]{1,60}\]|\{[^}\n]{1,60}\}/g) || []).length
}

/** 第一个占位符在文本中的 [起, 止) 区间；没有则返回 null */
function firstPlaceholderRange(text) {
  const m = /\[[^\]\n]{1,60}\]|\{[^}\n]{1,60}\}/.exec(String(text ?? ''))
  return m ? [m.index, m.index + m[0].length] : null
}

export function InspirationView({ topbar, onUsePrompt, onCopyPrompt, toast }) {
  const [items, setItems] = useState([])
  const [adapter, setAdapter] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [model, setModel] = useState('all')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState(null)     // 打开详情的条目
  const [shown, setShown] = useState(48)         // 先渲染前若干张，滚到底再放
  const sentinelRef = useRef(null)

  const load = useCallback(async (force = false) => {
    setLoading(true); setError('')
    try {
      const result = await loadInspirations({ force })
      setItems(result.items); setAdapter(result.adapter)
      setShown(48)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  /* 离开灵感页时释放图片 blob（再次进入会重新按视口加载） */
  useEffect(() => () => releaseImages(), [])

  /* 可选的模型筛选：来自数据源声明的 models */
  const models = useMemo(() => {
    const set = new Set()
    for (const item of items) for (const m of item.models ?? []) set.add(m)
    return [...set]
  }, [items])

  const filtered = useMemo(() => {
    const active = FILTERS.find(f => f.id === filter)
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      if (active?.test && !active.test(item)) return false
      if (model !== 'all' && !(item.models ?? []).includes(model)) return false
      if (q && !`${item.title} ${item.prompt}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, filter, model, query])

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
    const after = []
    if (item.hasPlaceholder) after.push(`替换 ${countPlaceholders(item.prompt)} 处占位符`)
    if (item.needsReference) after.push('添加参考图')
    // 有占位符时把第一个选中：用户不必在几百字里自己找该改哪里，直接打字就替换掉
    onUsePrompt(item.prompt, item.hasPlaceholder ? firstPlaceholderRange(item.prompt) : undefined)
    toast(after.length ? `提示词已带入，记得${after.join('、')}` : '提示词已带入输入框', after.length ? 'info' : 'success')
    setDetail(null)
  }

  const copy = async (item) => { await onCopyPrompt(item.prompt); }

  return (
    <div className="ig-insp">
      {topbar}
      <div className="ig-insp-bar">
        <div className="ig-insp-title">
          <LightbulbIcon size={16} />
          <span>灵感</span>
          {adapter && (
            <a className="ig-insp-source" href={adapter.homeUrl} target="_blank" rel="noreferrer" title={`${adapter.label} · ${adapter.license}`}>
              {adapter.label} · {adapter.license}
            </a>
          )}
        </div>
        <div className="ig-insp-filters" role="group" aria-label="筛选">
          {FILTERS.map(f => (
            <button key={f.id} type="button" className="ig-insp-chip" aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        {models.length > 1 && (
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
        <button type="button" className="ig-act-btn" disabled={loading} onClick={() => void load(true)}>刷新</button>
      </div>

      {error ? (
        <div className="ig-insp-state" role="alert">
          <p>{error}</p>
          <button type="button" className="pk-btn" onClick={() => void load(true)}>重试</button>
        </div>
      ) : loading && !items.length ? (
        <div className="ig-insp-skeleton" aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => <div key={i} className="ig-insp-card"><span className="ig-lib-skel" style={{ height: 120 + (i % 4) * 60 }} /></div>)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="ig-insp-state"><LightbulbIcon size={22} /><p>没有匹配的灵感</p><span>换个筛选条件或搜索词试试</span></div>
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
        <Dialog open onOpenChange={(open) => { if (!open) setDetail(null) }}>
          <DialogOverlay />
          <DialogContent className="ig-insp-detail">
            <DialogTitle>{detail.title}</DialogTitle>
            <div className="ig-insp-detail-body">
              <InspirationImage item={detail} eager large />
              <div className="ig-insp-detail-meta">
                <span className="ig-insp-model">{(detail.models ?? []).join(' / ')}</span>
                {detail.needsReference && <span className="ig-insp-flag" data-kind="ref">需参考图 · {detail.input || '先上传参考图'}</span>}
                {detail.hasPlaceholder && <span className="ig-insp-flag" data-kind="ph">含 {countPlaceholders(detail.prompt)} 处占位符</span>}
                {detail.author && <span className="ig-insp-author">by @{detail.author}</span>}
              </div>
              {detail.note && <p className="ig-insp-note">{detail.note}</p>}
              <pre className="ig-insp-prompt">{detail.prompt}</pre>
            </div>
            <div className="ig-insp-detail-acts">
              {detail.sourceUrl && (
                <a className="ig-act-btn" href={detail.sourceUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon size={13} />原帖</a>
              )}
              <button type="button" className="ig-act-btn" onClick={() => void copy(detail)}><CopyIcon size={13} />复制提示词</button>
              <span className="ig-insp-detail-spacer" />
              <button type="button" className="pk-btn pk-btn-primary" onClick={() => use(detail)}><CheckIcon size={13} />带入输入框</button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
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
  return (
    <article ref={ref} className="ig-insp-card" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
      <InspirationImage item={item} />
      <div className="ig-insp-card-body">
        <h3 className="ig-insp-card-title" title={item.title}>{item.title}</h3>
        <div className="ig-insp-card-meta">
          <span className="ig-insp-model">{(item.models ?? [])[0]}</span>
          {item.needsReference && <span className="ig-insp-flag" data-kind="ref" title={item.input || '需要先上传参考图'}>参考图</span>}
          {item.hasPlaceholder && <span className="ig-insp-flag" data-kind="ph" title="提示词里有需要替换的占位符">占位</span>}
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
    if (eager || !ref.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    let done = false
    const io = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return
      done = true; io.disconnect(); setVisible(true)
    }, { rootMargin: '400px' })
    io.observe(ref.current)
    // 兜底：个别环境下可见性观察器不被调度（实测有嵌入浏览器连 body 上的元素都不回调），
    // 卡片会永远停在骨架屏且没有任何提示。给观察器一个期限，到期仍无回调就按可见处理去加载。
    const fallback = setTimeout(() => { if (!done) { done = true; io.disconnect(); setVisible(true) } }, 1200)
    return () => { done = true; clearTimeout(fallback); io.disconnect() }
  }, [eager])

  useEffect(() => {
    if (!visible || url) return
    let alive = true
    loadImage(item.image)
      .then((u) => { if (alive) setUrl(u) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [visible, item.image, url])

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
