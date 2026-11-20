import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, loadSearchHistory, saveSearchTerm, removeSearchTerm, clearSearchHistory } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { BookGrid, GridSkeleton, ErrorBox, LoadMore, FavToggle, CoverImage } from './widgets.jsx'

/** 浏览页：顶行（页签 + 搜索框）；内容 = 聚合发现 / 聚合分类 / 聚合搜索结果（流式） */
export function BrowsePage({ sources, onOpenSources, onOpenBook }) {
  const [tab, setTab] = useState('explore')          // explore | ranking
  const [searching, setSearching] = useState(null)   // 搜索关键词（非 null 时内容区显示结果）

  if (!sources.filter(s => s.enabled).length) {
    return (
      <div className="nh-onboard">
        <div className="nh-onboard-icon" aria-hidden>书</div>
        <button className="pk-btn" onClick={onOpenSources}>去导入书源</button>
      </div>
    )
  }

  const activeTab = searching ? 'search' : tab

  return (
    <div className="nh-browse">
      <div className="nh-browse-tabs">
        <button
          className={activeTab === 'explore' ? 'nh-seg pk-active' : 'nh-seg'}
          onClick={() => { setTab('explore'); setSearching(null) }}
        >发现</button>
        <button
          className={activeTab === 'ranking' ? 'nh-seg pk-active' : 'nh-seg'}
          onClick={() => { setTab('ranking'); setSearching(null) }}
        >分类</button>
        <SearchBox onSearching={setSearching} />
      </div>
      <div className="nh-browse-scroll">
        {searching !== null ? (
          <SearchResults keyword={searching} onOpen={onOpenBook} />
        ) : tab === 'explore' ? (
          <ExplorePane onOpen={onOpenBook} />
        ) : (
          <RankingPane onOpen={onOpenBook} />
        )}
      </div>
    </div>
  )
}

/* ---------------- 顶行搜索框（历史 + 聚合建议 + 模糊匹配下拉） ---------------- */
function SearchBox({ onSearching }) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState([])
  const [online, setOnline] = useState([])   // 在线建议（书名，聚合全部源）
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

  // 在线建议：聚合搜索全部源，收前 6 个去重书名（等待流结束）
  const queryOnline = useCallback((q) => {
    const seq = ++onlineReq.current
    setOnlineLoading(true)
    call('search.aggregate', [q, 1], { timeoutMs: 25_000 }).then(started => {
      if (seq !== onlineReq.current) return
      const streamId = started?.streamId ?? ''
      if (!streamId) { setOnlineLoading(false); return }
      const enest = window.enest || window.zapi
      const titles = []
      let settled = 0
      const total = started.total ?? 0
      const onEvent = ({ event, data }) => {
        if (event !== 'search.aggregate' || data?.streamId !== streamId) return
        for (const b of data.books ?? []) {
          if (titles.length < 8 && !titles.includes(b.title)) titles.push(b.title)
        }
        settled++
        if (settled >= total || data.finished) {
          enest?.off?.('backend.event', onEvent)
          if (seq !== onlineReq.current) return
          setOnline(titles.slice(0, 6))
          setOnlineLoading(false)
          setOnlineFailed(false)
        }
      }
      enest?.on?.('backend.event', onEvent)
    }, () => {
      if (seq === onlineReq.current) { setOnlineLoading(false); setOnlineFailed(true) }
    })
  }, [])

  // 输入防抖 400ms；输入法组合期间（拼音未上屏）不查询
  useEffect(() => {
    const q = value.trim()
    if (!q || composing.current) {
      if (composing.current) return
      setOnline([]); setOnlineLoading(false); setOnlineFailed(false); return
    }
    const timer = setTimeout(() => queryOnline(q), 400)
    return () => { clearTimeout(timer); }
  }, [value, queryOnline])

  // 输入法上屏：拿到最终中文再查一次
  const onCompositionEnd = (e) => {
    composing.current = false
    const q = (e.currentTarget.value || '').trim()
    if (q) queryOnline(q)
  }

  // 两段建议：历史记录（本地匹配）与最佳匹配（聚合搜索）
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
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i, -1)) }
    else if (e.key === 'Enter') { e.preventDefault(); submit(activeIdx >= 0 ? all[activeIdx] : undefined) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div className="nh-searchbox" ref={boxRef}>
      <span className="nh-searchbox-icon" aria-hidden>⌕</span>
      <input
        ref={inputRef}
        type="search"
        placeholder="搜书名或作者…"
        value={value}
        aria-label="搜索小说"
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
        <button type="button" className="nh-searchbox-clear" aria-label="清空" onClick={() => { setValue(''); inputRef.current?.focus() }}>×</button>
      )}
      {open && hasAny && (
        <div className="nh-searchbox-drop" role="listbox">
          {histSuggestions.length > 0 && (
            <>
              <div className="nh-searchbox-drop-head">
                <span className="pk-muted">历史记录</span>
                {history.length > 0 && (
                  <button type="button" onClick={() => { void clearSearchHistory().then(() => setHistory([])) }}>清空</button>
                )}
              </div>
              {histSuggestions.map((h, i) => (
                <div
                  key={h}
                  className={`nh-searchbox-item${activeIdx === i ? ' is-active' : ''}`}
                  role="option"
                  aria-selected={activeIdx === i}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => submit(h)}
                >
                  <span className="nh-searchbox-item-text">{'\u2315'} {h}</span>
                  <button
                    type="button"
                    className="nh-searchbox-item-del"
                    aria-label={`删除 ${h}`}
                    onClick={e => { e.stopPropagation(); void removeSearchTerm(h).then(() => void loadSearchHistory().then(setHistory).catch(() => {})) }}
                  >×</button>
                </div>
              ))}
            </>
          )}
          {(onlineLoading || onlineSuggestions.length > 0) && (
            <>
              <div className="nh-searchbox-drop-head">
                <span className="pk-muted">最佳匹配</span>
                {onlineLoading && <span className="nh-searchbox-spin" aria-label="搜索建议加载中" />}
              </div>
              {onlineLoading && onlineSuggestions.length === 0 && (
                <div className="nh-searchbox-item nh-searchbox-loading-row">正在从全部书源获取建议…</div>
              )}
              {onlineSuggestions.map((t, i) => (
                <div
                  key={t}
                  className={`nh-searchbox-item${activeIdx === histSuggestions.length + i ? ' is-active' : ''}`}
                  role="option"
                  aria-selected={activeIdx === histSuggestions.length + i}
                  onMouseEnter={() => setActiveIdx(histSuggestions.length + i)}
                  onClick={() => submit(t)}
                >
                  <span className="nh-searchbox-item-text">{'\u2b50'} {t}</span>
                </div>
              ))}
              {!onlineLoading && onlineSuggestions.length === 0 && value.trim().length >= 1 && (
                <div className="nh-searchbox-item nh-searchbox-loading-row">
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

/* ---------------- 搜索结果（聚合：并行查所有源，流式逐源显示） ---------------- */
function SearchResults({ keyword, onOpen }) {
  const [groups, setGroups] = useState([])   // [{sourceKey, sourceName, books, error}]
  const [progress, setProgress] = useState({ done: 0, total: 0, active: false })
  const streamRef = useRef('')
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
        { sourceKey: data.sourceKey, sourceName: data.sourceName, books: data.books ?? [], error: data.error },
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

  const withResults = groups.filter(g => g.books.length > 0)
  const failed = groups.filter(g => g.error)
  const totalBooks = withResults.reduce((s, g) => s + g.books.length, 0)
  const idle = !progress.active && groups.length > 0

  return (
    <div>
      {progress.active && (
        <div className="nh-agg-status pk-muted">
          <span className="nh-searchbox-spin" aria-hidden /> 并行搜索中 {progress.done}/{progress.total || '?'} 个书源…
        </div>
      )}
      {progress.active && groups.length === 0 && <GridSkeleton />}
      {withResults.map(g => (
        <section className="nh-part" key={g.sourceKey}>
          <h3 className="nh-part-title">
            {g.sourceName}
            <span className="pk-muted nh-timeline-count">{g.books.length}</span>
          </h3>
          <BookGrid books={g.books} onOpen={onOpen} />
        </section>
      ))}
      {idle && totalBooks === 0 && <div className="nh-empty">「{keyword}」在所有书源中都没有结果</div>}
      {idle && failed.length > 0 && (
        <div className="nh-agg-failed pk-muted">
          {failed.map(f => `${f.sourceName}: ${f.error}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

/* ---------------- 聚合筛选栏（第一行切源，第二行该源/全部源的分类） ---------------- */
function FilterBar({ onFilter, active }) {
  const [dims, setDims] = useState(null)
  const [picked, setPicked] = useState('')   // '' = 全部源

  useEffect(() => {
    let alive = true
    call('filters.aggregate', [], { timeoutMs: 60_000 }).then(
      list => { if (alive) setDims(list ?? []) },
      () => { if (alive) setDims([]) }
    )
    return () => { alive = false }
  }, [])

  if (!dims || !dims.length) return null
  const current = dims.find(d => d.sourceKey === picked)

  return (
    <div className="nh-filterbar">
      {/* 第一行：数据源切换 */}
      <div className="nh-filter-row nh-filter-sources" role="tablist" aria-label="书源">
        <button
          className={!picked ? 'nh-seg pk-active' : 'nh-seg'}
          onClick={() => { setPicked(''); onFilter(null) }}
        >全部源</button>
        {dims.map(d => (
          <button
            key={d.sourceKey}
            className={picked === d.sourceKey ? 'nh-seg pk-active' : 'nh-seg'}
            onClick={() => { setPicked(d.sourceKey); onFilter(null) }}
            title={d.sourceName}
          >
            {d.sourceName}
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
  const [expanded, setExpanded] = useState({})
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
          <div className="nh-filter-row nh-filter-terms" key={d.sourceKey}>
            <span className="nh-filter-source pk-muted" title={d.sourceName}>
              {d.sourceName}
            </span>
            {shown.map(t => (
              <button
                key={`${t.kind}-${t.value}`}
                className={active?.kind === t.kind && active.key === d.sourceKey && active.value === t.value ? 'nh-seg pk-active' : 'nh-seg'}
                onClick={() => onFilter({ kind: t.kind, key: d.sourceKey, name: d.sourceName, value: t.value, label: t.label })}
              >{t.label}</button>
            ))}
            {hidden > 0 && (
              <button className="nh-seg nh-filter-more" onClick={() => setExpanded(prev => ({ ...prev, [d.sourceKey]: true }))}>
                更多 +{hidden}
              </button>
            )}
            {open && all.length > LIMIT && (
              <button className="nh-seg nh-filter-more" onClick={() => setExpanded(prev => ({ ...prev, [d.sourceKey]: false }))}>
                收起
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

/* ---------------- 发现（聚合所有源 + 筛选栏） ---------------- */
function ExplorePane({ onOpen }) {
  const [filter, setFilter] = useState(null)
  const [agg, setAgg] = useState({ loading: true, items: [] })

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
  const [filtered, setFiltered] = useState({ loading: false, books: [], label: '' })
  useEffect(() => {
    if (!filter) { setFiltered({ loading: false, books: [], label: '' }); return }
    let alive = true
    setFiltered({ loading: true, books: [], label: filter.label })
    call('filters.load', [filter.key, filter.kind, filter.value, 1], { timeoutMs: 120_000 }).then(
      r => { if (alive) setFiltered({ loading: false, books: r?.books ?? [], label: filter.label }) },
      e => { if (alive) { notifyError(e); setFiltered({ loading: false, books: [], label: filter.label }) } }
    )
    return () => { alive = false }
  }, [filter])

  const bar = <FilterBar onFilter={setFilter} active={filter} />

  if (filter) {
    return (
      <div>
        {bar}
        {filtered.loading ? <GridSkeleton /> : (
          <section className="nh-part">
            <h3 className="nh-part-title">{filter.name} · {filtered.label}<span className="pk-muted nh-timeline-count">{filtered.books.length}</span></h3>
            <BookGrid books={filtered.books} onOpen={onOpen} empty="该分类没有内容" />
          </section>
        )}
      </div>
    )
  }

  if (agg.loading) return <div>{bar}<GridSkeleton /><GridSkeleton count={6} /></div>
  const shown = agg.items.filter(x => x.sections?.length)
  if (!shown.length) return <div className="nh-empty">暂无内容，请检查书源是否已安装并可访问</div>
  return (
    <div>
      {bar}
      <div className="nh-parts">
      {shown.map(item => (
        <div key={item.sourceKey}>
          {item.sections.map((sec, si) => (
            <section className="nh-part nh-hot" key={`${item.sourceKey}-${si}`}>
              <h3 className="nh-part-title">
                {sec.title}
                <span className="pk-muted nh-timeline-count">{item.sourceName}</span>
              </h3>
              <div className="nh-grid nh-grid-hot">
                {sec.books.slice(0, 12).map((b, idx) => (
                  <div className="nh-card-wrap nh-card-hot" key={`${b.sourceKey}:${b.id}`}>
                    <button className="nh-card" onClick={() => onOpen(b)} title={b.title}>
                      <span className="nh-rank-no" aria-hidden>{idx + 1}</span>
                      <div className="nh-card-cover"><CoverImage book={b} /></div>
                      <div className="nh-card-info"><div className="nh-card-title">{b.title}</div></div>
                    </button>
                    <FavToggle book={b} size="sm" />
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

/* ---------------- 分类（聚合所有源） ---------------- */
function RankingPane({ onOpen }) {
  const [agg, setAgg] = useState({ loading: true, items: [] })
  useEffect(() => {
    let alive = true
    setAgg({ loading: true, items: [] })
    call('explore.aggregate', [1], { timeoutMs: 180_000 }).then(
      items => { if (alive) setAgg({ loading: false, items: items ?? [] }) },
      e => { if (alive) { notifyError(e); setAgg({ loading: false, items: [] }) } }
    )
    return () => { alive = false }
  }, [])
  if (agg.loading) return <div><GridSkeleton /><GridSkeleton count={6} /></div>
  const shown = agg.items.filter(x => x.books?.length)
  if (!shown.length) return <div className="nh-empty">暂无分类内容，请检查书源</div>
  return (
    <div className="nh-parts">
      {shown.map(item => (
        <section className="nh-part" key={item.sourceKey}>
          <h3 className="nh-part-title">
            {item.sourceName}
            <span className="pk-muted nh-timeline-count">{item.option || ''} · {item.books.length}</span>
          </h3>
          <BookGrid books={item.books} onOpen={onOpen} />
        </section>
      ))}
    </div>
  )
}
