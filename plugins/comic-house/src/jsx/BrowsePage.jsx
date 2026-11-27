import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, loadSearchHistory, saveSearchTerm, removeSearchTerm, clearSearchHistory } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { ComicGrid, ComicParts, GridSkeleton, ErrorBox, LoadMore, CoverImage, FavToggle } from './widgets.jsx'

/** 浏览页：顶行（页签 + 搜索框 + 源切换）；内容 = 发现 / 排行 / 搜索结果（内联） */
export function BrowsePage({ sources, activeSource, sourceName, onSourceChange, onOpenSources, onOpenComic }) {
  const [tab, setTab] = useState('explore')          // explore | ranking
  const [searching, setSearching] = useState(null)   // 搜索关键词（非 null 时内容区显示结果）

  if (!sources.filter(s => s.enabled).length) {
    return (
      <div className="pk-empty-state">
        <strong className="pk-empty-title">暂无启用的漫画源</strong>
        <p className="pk-empty-hint">启用数据源后，即可浏览和搜索漫画。</p>
        <button className="pk-btn" onClick={onOpenSources}>管理数据源</button>
      </div>
    )
  }

  const activeTab = searching ? 'search' : tab

  return (
    <div className="ch-browse">
      <div className="ch-browse-tabs">
        <button
          className={activeTab === 'explore' ? 'ch-seg pk-active' : 'ch-seg'}
          onClick={() => { setTab('explore'); setSearching(null) }}
        >发现</button>
        <button
          className={activeTab === 'ranking' ? 'ch-seg pk-active' : 'ch-seg'}
          onClick={() => { setTab('ranking'); setSearching(null) }}
        >排行</button>
        <SearchBox
          sourceKey={activeSource}
          onSearching={setSearching}
          onOpenComic={onOpenComic}
        />
      </div>
      <div className="ch-browse-scroll">
        {searching !== null ? (
          <SearchResults keyword={searching} onOpen={onOpenComic} />
        ) : tab === 'explore' ? (
          <ExplorePane onOpen={onOpenComic} />
        ) : (
          <RankingPane onOpen={onOpenComic} />
        )}
      </div>
    </div>
  )
}

/* ---------------- 顶行搜索框（历史 + 在线建议 + 模糊匹配下拉） ---------------- */
function SearchBox({ sourceKey, onSearching, onOpenComic }) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState([])
  const [online, setOnline] = useState([])   // 在线建议（标题）
  const [onlineLoading, setOnlineLoading] = useState(false)
  const [onlineFailed, setOnlineFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const boxRef = useRef(null)
  const inputRef = useRef(null)
  const onlineReq = useRef(0)
  const composing = useRef(false)   // 输入法组合态：拼音未上屏时不触发查询

  useEffect(() => {
    void loadSearchHistory().then(setHistory).catch(() => {})
  }, [])

  // 点击外部关闭下拉
  useEffect(() => {
    const onDoc = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // 在线建议：输入防抖 400ms 拉源搜索；输入法组合期间（拼音未上屏）不查询
  // 注意：中文字符信息密度高，1 个字即触发查询（英文仍建议 2 字符以上，但由防抖天然节流）
  useEffect(() => {
    const q = value.trim()
    if (!q || composing.current) {
      if (composing.current) return          // 等 compositionend 再查，避免用拼音串去搜
      setOnline([]); setOnlineLoading(false); setOnlineFailed(false); return
    }
    const seq = ++onlineReq.current
    setOnlineLoading(true)
    const timer = setTimeout(() => {
      call('search.load', [sourceKey, q, 1], { timeoutMs: 20_000 }).then(
        result => {
          if (seq !== onlineReq.current) return
          const titles = [...new Set((result?.comics ?? []).slice(0, 6).map(c => c.title))]
          setOnline(titles)
          setOnlineLoading(false)
          setOnlineFailed(false)
        },
        () => {
          // 失败不清空已有建议，避免中文上屏后建议「消失」
          if (seq === onlineReq.current) { setOnlineLoading(false); setOnlineFailed(true) }
        }
      )
    }, 400)
    return () => { clearTimeout(timer); }
  }, [value, sourceKey])

  // 输入法上屏：拿到最终中文再查一次
  const onCompositionEnd = (e) => {
    composing.current = false
    const q = (e.currentTarget.value || '').trim()
    if (!q) return
    const seq = ++onlineReq.current
    setOnlineLoading(true)
    call('search.load', [sourceKey, q, 1], { timeoutMs: 20_000 }).then(
      result => {
        if (seq !== onlineReq.current) return
        const titles = [...new Set((result?.comics ?? []).slice(0, 6).map(c => c.title))]
        setOnline(titles)
        setOnlineLoading(false)
      },
      () => { if (seq === onlineReq.current) setOnlineLoading(false) }
    )
  }

  // 两段建议：历史记录（本地匹配）与最佳匹配（在线搜索）
  const histSuggestions = useMemo(() => {
    const q = value.trim().toLowerCase()
    return q
      ? history.filter(h => h.toLowerCase().includes(q) || fuzzyMatch(h.toLowerCase(), q)).slice(0, 4)
      : history.slice(0, 6)
  }, [value, history])
  const onlineSuggestions = useMemo(() => {
    return online.filter(t => !histSuggestions.some(h => h === t)).slice(0, 6)
  }, [online, histSuggestions])
  const hasAny = histSuggestions.length > 0 || onlineSuggestions.length > 0 || onlineLoading || value.trim().length > 0

  const submit = (term) => {
    const kw = (term ?? value).trim()
    if (!kw) return
    setValue(kw)
    setOpen(false)
    void saveSearchTerm(kw).then(() => void loadSearchHistory().then(setHistory).catch(() => {}))
    onSearching(kw)
  }

  const onKeyDown = (e) => {
    const all = [...histSuggestions, ...onlineSuggestions]
    if (!open || !all.length) {
      if (e.key === 'Enter') submit()
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, all.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, -1)) }
    else if (e.key === 'Enter') { e.preventDefault(); submit(activeIdx >= 0 ? all[activeIdx] : undefined) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div className="ch-searchbox" ref={boxRef}>
      <span className="ch-searchbox-icon" aria-hidden>⌕</span>
      <input
        ref={inputRef}
        type="search"
        placeholder="搜索漫画…"
        value={value}
        aria-label="搜索漫画"
        onChange={e => {
          // 组合输入中（拼音阶段）仍更新文本，但标记组合态以抑制在线查询
          composing.current = e.nativeEvent?.isComposing === true
          setValue(e.target.value)
          setOpen(true)
          setActiveIdx(-1)
        }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={onCompositionEnd}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {value && (
        <button type="button" className="ch-searchbox-clear" aria-label="清空" onClick={() => { setValue(''); inputRef.current?.focus() }}>×</button>
      )}
      {open && hasAny && (
        <div className="ch-searchbox-drop" role="listbox">
          {histSuggestions.length > 0 && (
            <>
              <div className="ch-searchbox-drop-head">
                <span className="pk-muted">历史记录</span>
                {history.length > 0 && (
                  <button type="button" onClick={() => { void clearSearchHistory().then(() => setHistory([])) }}>清空</button>
                )}
              </div>
              {histSuggestions.map((h, i) => (
                <div
                  key={h}
                  className={`ch-searchbox-item${activeIdx === i ? ' is-active' : ''}`}
                  role="option"
                  aria-selected={activeIdx === i}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => submit(h)}
                >
                  <span className="ch-searchbox-item-text">{'\u2315'} {h}</span>
                  <button
                    type="button"
                    className="ch-searchbox-item-del"
                    aria-label={`删除 ${h}`}
                    onClick={e => { e.stopPropagation(); void removeSearchTerm(h).then(() => void loadSearchHistory().then(setHistory).catch(() => {})) }}
                  >×</button>
                </div>
              ))}
            </>
          )}
          {(onlineLoading || onlineSuggestions.length > 0) && (
            <>
              <div className="ch-searchbox-drop-head">
                <span className="pk-muted">最佳匹配</span>
                {onlineLoading && <span className="ch-searchbox-spin" aria-label="搜索建议加载中" />}
              </div>
              {onlineLoading && onlineSuggestions.length === 0 && (
                <div className="ch-searchbox-item ch-searchbox-loading-row">正在从当前数据源获取建议…</div>
              )}
              {onlineSuggestions.map((t, i) => (
                <div
                  key={t}
                  className={`ch-searchbox-item${activeIdx === histSuggestions.length + i ? ' is-active' : ''}`}
                  role="option"
                  aria-selected={activeIdx === histSuggestions.length + i}
                  onMouseEnter={() => setActiveIdx(histSuggestions.length + i)}
                  onClick={() => submit(t)}
                >
                  <span className="ch-searchbox-item-text">{'\u2b50'} {t}</span>
                </div>
              ))}
              {!onlineLoading && onlineSuggestions.length === 0 && value.trim().length >= 1 && (
                <div className="ch-searchbox-item ch-searchbox-loading-row">
                  {onlineFailed ? '未能获取建议，' : '暂无匹配建议，'}按回车搜索「{value.trim()}」
                </div>
              )}
            </>
          )}

        </div>
      )}
    </div>
  )
}
/** 字符序列模糊匹配（q 的字符按顺序出现在 target 中） */
function fuzzyMatch(target, q) {
  let i = 0
  for (const ch of target) { if (ch === q[i]) i++; if (i >= q.length) return true }
  return i >= q.length
}

/* ---------------- 搜索结果（内联内容区） ---------------- */
function SearchResults({ keyword, onOpen }) {
  // 聚合搜索：并行查所有启用源，每源一完成就追加显示（搜一个出一个）
  const [groups, setGroups] = useState([])   // [{sourceKey, sourceName, comics, error}]
  const [progress, setProgress] = useState({ done: 0, total: 0, active: false })
  const streamRef = useRef('')   // 当前流 ID（先于事件到达的限制：started 事件带 streamId）
  const reqRef = useRef(0)

  useEffect(() => {
    const enest = window.enest || window.zapi
    const seq = ++reqRef.current
    streamRef.current = ''
    setGroups([]); setProgress({ done: 0, total: 0, active: true })

    const onEvent = ({ event, data }) => {
      if (event !== 'search.aggregate') return
      if (seq !== reqRef.current) return
      if (!streamRef.current || data?.streamId !== streamRef.current) return
      if (data.finished) { setProgress(p => ({ ...p, active: false })); return }
      setProgress(p => ({ done: data.done ?? p.done, total: data.total ?? p.total, active: true }))
      setGroups(prev => [
        ...prev.filter(g => g.sourceKey !== data.sourceKey),
        { sourceKey: data.sourceKey, sourceName: data.sourceName, comics: data.comics ?? [], error: data.error },
      ])
    }
    enest?.on?.('backend.event', onEvent)

    call('search.aggregate', [keyword, 1]).then(
      r => {
        if (seq !== reqRef.current) return
        streamRef.current = r?.streamId ?? ''
        setProgress({ done: 0, total: r?.total ?? 0, active: true })
      },
      e => { notifyError(e); setProgress({ done: 0, total: 0, active: false }) }
    )
    return () => { enest?.off?.('backend.event', onEvent); reqRef.current++ }
  }, [keyword])

  const withResults = groups.filter(g => g.comics.length > 0)
  const failed = groups.filter(g => g.error)
  const totalComics = withResults.reduce((s, g) => s + g.comics.length, 0)
  const idle = !progress.active && groups.length > 0
  const empty = idle && totalComics === 0

  return (
    <div className={empty ? 'ch-empty-results' : undefined}>
      {progress.active && (
        <div className="ch-agg-status pk-muted">
          <span className="ch-searchbox-spin" aria-hidden /> 并行搜索中 {progress.done}/{progress.total || '?'} 个数据源…
        </div>
      )}
      {progress.active && groups.length === 0 && <GridSkeleton />}
      {withResults.map(g => (
        <section className="ch-part" key={g.sourceKey}>
          <h3 className="ch-part-title">
            {g.sourceName}
            <span className="pk-muted ch-timeline-count">{g.comics.length}</span>
          </h3>
          <ComicGrid comics={g.comics} onOpen={onOpen} />
        </section>
      ))}
      {empty && <div className="pk-empty-state">
        <strong className="pk-empty-title">暂无搜索结果</strong>
        <p className="pk-empty-hint">没有找到「{keyword}」相关漫画，可以换个关键词试试。</p>
      </div>}
      {idle && failed.length > 0 && (
        <div className="ch-agg-failed pk-muted">
          {failed.map(f => `${f.sourceName}: ${f.error}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

/* ---------------- 聚合筛选栏（第一行切源，第二行该源的分类/榜单） ---------------- */
function FilterBar({ onFilter, active }) {
  const [dims, setDims] = useState(null)
  const [picked, setPicked] = useState('')   // '' = 全部源

  useEffect(() => {
    let alive = true
    call('filters.aggregate', [], { timeoutMs: 60_000 }).then(
      list => {
        if (!alive) return
        const items = list ?? []
        setDims(items)
        // 默认保持「全部源」：第二行汇总展示所有源的筛选条件
      },
      () => { if (alive) setDims([]) }
    )
    return () => { alive = false }
  }, [])

  if (!dims || !dims.length) return null
  const current = dims.find(d => d.sourceKey === picked)

  return (
    <div className="ch-filterbar">
      {/* 第一行：数据源切换 */}
      <div className="ch-filter-row ch-filter-sources" role="tablist" aria-label="数据源">
        <button
          className={!picked ? 'ch-seg pk-active' : 'ch-seg'}
          onClick={() => { setPicked(''); onFilter(null) }}
        >全部源</button>
        {dims.map(d => (
          <button
            key={d.sourceKey}
            className={picked === d.sourceKey ? 'ch-seg pk-active' : 'ch-seg'}
            onClick={() => { setPicked(d.sourceKey); onFilter(null) }}
            title={d.sourceName}
          >
            {d.sourceName}{d.adult ? ' ·成人' : ''}
          </button>
        ))}
      </div>

      {/* 第二行：筛选条件（默认折叠，点「更多」展开） */}
      <FilterTermsView
        groups={current ? [current] : dims}
        active={active}
        onFilter={onFilter}
      />
    </div>
  )
}

/** 筛选条件行：每源一行，默认只显示前 6 项，可展开/收起 */
function FilterTermsView({ groups, active, onFilter }) {
  const [expanded, setExpanded] = useState({})   // { sourceKey: bool }
  const usable = groups.filter(d => (d.rankings?.length ?? 0) + (d.categories?.length ?? 0) > 0)
  if (!usable.length) return null
  return (
    <>
      {usable.map(d => {
        const all = [
          ...d.rankings.map(r => ({ kind: 'ranking', label: r, value: r })),
          ...d.categories.map(c => ({ kind: 'category', label: c.label, value: c.param })),
        ]
        const LIMIT = 6
        const open = !!expanded[d.sourceKey]
        const shown = open ? all : all.slice(0, LIMIT)
        const hidden = all.length - shown.length
        return (
          <div className="ch-filter-row ch-filter-terms" key={d.sourceKey}>
            <span className="ch-filter-source pk-muted" title={d.sourceName}>
              {d.sourceName}{d.adult ? '·成人' : ''}
            </span>
            {shown.map(t => (
              <button
                key={`${t.kind}-${t.value}`}
                className={active?.kind === t.kind && active.key === d.sourceKey && active.value === t.value ? 'ch-seg pk-active' : 'ch-seg'}
                onClick={() => onFilter({ kind: t.kind, key: d.sourceKey, name: d.sourceName, value: t.value, label: t.label })}
              >{t.label}</button>
            ))}
            {hidden > 0 && (
              <button className="ch-seg ch-filter-more" onClick={() => setExpanded(prev => ({ ...prev, [d.sourceKey]: true }))}>
                更多 +{hidden}
              </button>
            )}
            {open && all.length > LIMIT && (
              <button className="ch-seg ch-filter-more" onClick={() => setExpanded(prev => ({ ...prev, [d.sourceKey]: false }))}>
                收起
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

/* ---------------- 发现（聚合所有源） ---------------- */
function ExplorePane({ onOpen }) {
  const [filter, setFilter] = useState(null)
  const [agg, setAgg] = useState({ loading: true, items: [] })
  const [filtered, setFiltered] = useState({ loading: false, comics: [], label: '' })

  useEffect(() => {
    let alive = true
    setAgg({ loading: true, items: [] })
    call('home.aggregate', [], { timeoutMs: 180_000 }).then(
      items => { if (alive) setAgg({ loading: false, items: items ?? [] }) },
      e => { if (alive) { notifyError(e); setAgg({ loading: false, items: [] }) } }
    )
    return () => { alive = false }
  }, [])

  // 筛选态：按选中维度加载单个源的内容
  useEffect(() => {
    if (!filter) { setFiltered({ loading: false, comics: [], label: '' }); return }
    let alive = true
    setFiltered({ loading: true, comics: [], label: filter.label })
    call('filters.load', [filter.key, filter.kind, filter.value, 1], { timeoutMs: 120_000 }).then(
      r => { if (alive) setFiltered({ loading: false, comics: r?.comics ?? [], label: filter.label }) },
      e => { if (alive) { notifyError(e); setFiltered({ loading: false, comics: [], label: filter.label }) } }
    )
    return () => { alive = false }
  }, [filter])

  const bar = <FilterBar onFilter={setFilter} active={filter} />

  if (filter) {
    return (
      <div>
        {bar}
        {filtered.loading ? <GridSkeleton /> : (
          <section className="ch-part">
            <h3 className="ch-part-title">{filter.name} · {filtered.label}<span className="pk-muted ch-timeline-count">{filtered.comics.length}</span></h3>
            <ComicGrid comics={filtered.comics} onOpen={onOpen} empty="该分类没有内容" />
          </section>
        )}
      </div>
    )
  }

  if (agg.loading) return <div>{bar}<GridSkeleton /><GridSkeleton count={6} /></div>
  const shown = agg.items.filter(x => x.sections?.length)
  if (!shown.length) return <div className="pk-empty-state">
    <strong className="pk-empty-title">暂无推荐内容</strong>
    <p className="pk-empty-hint">请检查数据源是否可访问。</p>
  </div>
  return (
    <div>
      {bar}
      <div className="ch-parts">
      {shown.map(item => (
        <div key={item.sourceKey}>
          {item.sections.map((sec, si) => (
            <section className="ch-part ch-hot" key={`${item.sourceKey}-${si}`}>
              <h3 className="ch-part-title">
                {sec.title}
                <span className="pk-muted ch-timeline-count">{item.sourceName}{item.adult ? ' · 成人' : ''}</span>
              </h3>
              <div className="ch-grid ch-grid-hot">
                {sec.comics.slice(0, 12).map((c, idx) => (
                  <div className="ch-card-wrap ch-card-hot" key={`${c.sourceKey}:${c.id}`}>
                    <button className="ch-card" onClick={() => onOpen(c)} title={c.title}>
                      <span className="ch-rank-no" aria-hidden>{idx + 1}</span>
                      <div className="ch-card-cover"><CoverImage comic={c} /></div>
                      <div className="ch-card-info"><div className="ch-card-title">{c.title}</div></div>
                    </button>
                    <FavToggle comic={c} size="sm" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ))}
      </div>
    </div>
  )
}

/* ---------------- 排行（聚合所有源） ---------------- */
function RankingPane({ onOpen }) {
  const [agg, setAgg] = useState({ loading: true, items: [] })
  useEffect(() => {
    let alive = true
    setAgg({ loading: true, items: [] })
    call('ranking.aggregate', [1], { timeoutMs: 180_000 }).then(
      items => { if (alive) setAgg({ loading: false, items: items ?? [] }) },
      e => { if (alive) { notifyError(e); setAgg({ loading: false, items: [] }) } }
    )
    return () => { alive = false }
  }, [])
  if (agg.loading) return <div><GridSkeleton /><GridSkeleton count={6} /></div>
  const shown = agg.items.filter(x => x.comics?.length)
  if (!shown.length) return <div className="pk-empty-state">暂无排行数据</div>
  return (
    <div className="ch-parts">
      {shown.map(item => (
        <section className="ch-part" key={item.sourceKey}>
          <h3 className="ch-part-title">
            {item.sourceName}
            <span className="pk-muted ch-timeline-count">{item.option || ''} · {item.comics.length}</span>
          </h3>
          <ComicGrid comics={item.comics} onOpen={onOpen} />
        </section>
      ))}
    </div>
  )
}

