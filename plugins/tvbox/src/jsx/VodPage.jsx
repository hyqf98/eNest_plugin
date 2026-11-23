import { useCallback, useEffect, useRef, useState } from 'react'
import { call } from '../js/api.js'
import { Card } from './HomePage.jsx'
import { ErrorBox, FilterRows, LoadMore, SkeletonRow, useKit } from './widgets.jsx'

/** 标准板块（与后端 STANDARD_SECTIONS 一致） */
const SECTIONS = [
  { key: 'movie', name: '电影' },
  { key: 'series', name: '连续剧' },
  { key: 'show', name: '综艺' },
  { key: 'anime', name: '动漫' },
]

/**
 * 分类浏览页（多源聚合）：标准板块 tab + 子分类 chips + 筛选 + 聚合卡片网格。
 * 各启用数据源按分类名自动匹配，同名合并（N 源标识），触底翻页（各站同页合并）。
 */
export function VodPage({ params, onOpenVod }) {
  const { sectionKey: presetSection } = params ?? {}
  const [activeSection, setActiveSection] = useState(SECTIONS.some(s => s.key === presetSection) ? presetSection : 'movie')
  const [subTypes, setSubTypes] = useState([])
  const [activeSub, setActiveSub] = useState('')
  const [filters] = useState({})
  const [filterValues, setFilterValues] = useState({})
  const [list, setList] = useState([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const reqRef = useRef(0)
  const mainRef = useRef(null)
  const kit = useKit()

  // 板块/子分类/筛选变化 → 重拉第一页
  useEffect(() => {
    const seq = ++reqRef.current
    setLoading(true); setError(''); setList([]); setActiveSub(''); setSubTypes([])
    void (async () => {
      try {
        const result = await call('aggregate.category', [activeSection, '', 1, filterValues], { timeoutMs: 60_000 })
        if (seq !== reqRef.current) return
        setList(result.list ?? [])
        setPage(1)
        setSubTypes(result.subTypes ?? [])
      } catch (e) {
        if (seq === reqRef.current) setError(e?.message || String(e))
      } finally {
        if (seq === reqRef.current) setLoading(false)
      }
    })()
  }, [activeSection, filterValues])

  // 子分类变化 → 重拉（不重置 subTypes）
  useEffect(() => {
    if (!activeSub && activeSub !== '') return
    const seq = ++reqRef.current
    setLoading(true); setError('')
    void (async () => {
      try {
        const result = await call('aggregate.category', [activeSection, activeSub, 1, filterValues], { timeoutMs: 60_000 })
        if (seq !== reqRef.current) return
        setList(result.list ?? [])
        setPage(1)
      } catch (e) {
        if (seq === reqRef.current) setError(e?.message || String(e))
      } finally {
        if (seq === reqRef.current) setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSub])

  const loadMore = useCallback(async () => {
    if (loading) return
    const seq = reqRef.current
    setLoading(true)
    try {
      const next = page + 1
      const result = await call('aggregate.category', [activeSection, activeSub, next, filterValues], { timeoutMs: 60_000 })
      if (seq !== reqRef.current) return
      setList(prev => {
        const seen = new Set(prev.map(v => `${v.vod_name}|${v.vod_year ?? ''}`))
        return [...prev, ...result.list.filter(v => !seen.has(`${v.vod_name}|${v.vod_year ?? ''}`))]
      })
      setPage(next)
    } catch (e) {
      kit?.toast(`加载更多失败：${e?.message || e}`)
    } finally {
      setLoading(false)
    }
  }, [loading, activeSection, activeSub, page, filterValues, kit])

  // 滚动到底自动加载
  const onScroll = useCallback(() => {
    const el = mainRef.current?.parentElement
    if (!el) return
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) void loadMore()
  }, [loadMore])
  useEffect(() => {
    const el = mainRef.current?.parentElement
    el?.addEventListener('scroll', onScroll)
    return () => el?.removeEventListener('scroll', onScroll)
  }, [onScroll])

  return (
    <div ref={mainRef}>
      <div className="tb-section-title" style={{ marginTop: 0 }}>分类 · 多源聚合</div>
      <div className="tb-types">
        {SECTIONS.map(s => (
          <button key={s.key} className={`tb-type-chip${s.key === activeSection ? ' pk-active' : ''}`} onClick={() => setActiveSection(s.key)}>{s.name}</button>
        ))}
      </div>
      {subTypes.length ? (
        <div className="tb-types" style={{ paddingBottom: 6 }}>
          <button className={`tb-type-chip${!activeSub ? ' pk-active' : ''}`} onClick={() => setActiveSub('')}>全部</button>
          {subTypes.map(name => (
            <button key={name} className={`tb-type-chip${activeSub === name ? ' pk-active' : ''}`} onClick={() => setActiveSub(name)}>{name}</button>
          ))}
        </div>
      ) : null}
      <FilterRows filters={filters['*'] ?? []} values={filterValues} onChange={(key, v) => setFilterValues(prev => ({ ...prev, [key]: v }))} />
      <ErrorBox error={error} onRetry={() => setFilterValues({ ...filterValues })} />
      <div className="tb-grid" style={{ marginTop: 8 }}>
        {list.map((v, i) => (
          <Card key={`${v.vod_name}-${v.vod_year ?? ''}-${i}`} item={v} onOpen={() => onOpenVod({ ...v, siteName: v.sources?.[0]?.siteName ?? '' })} />
        ))}
      </div>
      {loading && !list.length ? <SkeletonRow count={8} label="正在加载分类内容…" /> : null}
      {!loading && !list.length && !error ? <div className="tb-empty">这个分类暂时没有内容</div> : null}
      <LoadMore loading={loading} hasMore={list.length > 0 && list.length % 40 === 0} onLoad={loadMore} />
    </div>
  )
}
