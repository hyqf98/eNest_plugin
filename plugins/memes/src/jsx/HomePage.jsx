import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SOURCES, getSource } from '../js/sources/index.mjs'
import { MemeCard } from './MemeCard.jsx'
import { Lightbox } from './Lightbox.jsx'
import { SkeletonMasonry, LoadingMore, ErrorState, EmptyState, FilterChips } from './widgets.jsx'

/**
 * HomePage — 浏览/搜索主页面。
 * 源 Segmented 切换 → 按源渲染筛选条件（BQB:分类+动图；发表情:热门词）；
 * 搜索回车触发；触底无限加载；点击卡片复制、hover 快捷收藏/放大。
 */
export function HomePage({ showToast, isFavorite, onFavoriteChange, goFavorites }) {
  const [sourceId, setSourceId] = useState(SOURCES[0].id)
  const [filters, setFilters] = useState([]) // FilterGroup[]
  const [filterValues, setFilterValues] = useState({}) // { [key]: value }
  const [keyword, setKeyword] = useState('')
  const [searchWord, setSearchWord] = useState('')
  const [items, setItems] = useState([])
  const [phase, setPhase] = useState('init') // init | loading | ready | error
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [zoom, setZoom] = useState(null) // { item, index }
  const [refreshing, setRefreshing] = useState(false)
  const pageRef = useRef(1)
  const reqRef = useRef(0)
  const scrollRef = useRef(null)

  const source = getSource(sourceId)

  // 拉源筛选元数据
  useEffect(() => {
    let alive = true
    setFilters([])
    setFilterValues({})
    source.getFilters().then(groups => {
      if (alive) setFilters(groups.filter(group => group.options?.length))
    }).catch(() => {})
    return () => { alive = false }
  }, [sourceId])

  const query = useMemo(() => {
    const fbqHotword = sourceId === 'fbq' ? (filterValues.hotword ?? '') : ''
    return {
      keyword: fbqHotword || searchWord,
      category: sourceId === 'bqb' ? (filterValues.category ?? '') : '',
      animated: sourceId === 'bqb' ? (filterValues.animated ?? '') : '',
    }
  }, [sourceId, searchWord, filterValues])

  const loadPage = useCallback(async (page, replace) => {
    const seq = ++reqRef.current
    if (replace) { setPhase('loading'); setItems([]) }
    else setLoadingMore(true)
    try {
      const result = await source.list({ ...query, page, pageSize: 60 })
      if (seq !== reqRef.current) return
      setItems(prev => replace ? result.items : [...prev, ...result.items])
      setHasMore(result.hasMore)
      pageRef.current = page
      setPhase('ready')
    } catch (err) {
      if (seq !== reqRef.current) return
      setError(err.message || String(err))
      if (replace) { setPhase('error'); setItems([]) }
      setHasMore(false)
    } finally {
      if (seq === reqRef.current) setLoadingMore(false)
    }
  }, [source, query])

  // 首载 / 查询条件变化 → 重置第一页
  useEffect(() => { loadPage(1, true) }, [sourceId, loadPage])

  // 触底无限加载
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      if (!hasMore || loadingMore || phase !== 'ready') return
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 320) loadPage(pageRef.current + 1, false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [hasMore, loadingMore, phase, loadPage])

  async function handleRefresh() {
    setRefreshing(true)
    try { await source.refresh?.(true) } catch { /* 刷新失败走列表重载 */ }
    await loadPage(1, true)
    setRefreshing(false)
  }

  function handleSearchSubmit(e) {
    e.preventDefault()
    setSearchWord(keyword.trim())
  }

  const effectiveKeyword = query.keyword

  return createElement('div', { className: 'mm-page' },
    createElement('div', { className: 'mm-top' },
      createElement('div', { className: 'mm-source-tabs' },
        SOURCES.map(src => createElement('button', {
          key: src.id,
          type: 'button',
          className: `mm-tab${sourceId === src.id ? ' is-active' : ''}`,
          title: src.description,
          onClick: () => setSourceId(src.id),
        }, src.name)),
      ),
      createElement('form', { className: 'mm-search', onSubmit: handleSearchSubmit },
        createElement('input', {
          className: 'mm-search-input', type: 'text', value: keyword, placeholder: '搜索表情包，回车确认',
          onChange: e => setKeyword(e.target.value),
        }),
        keyword && createElement('button', { type: 'button', className: 'mm-search-clear', onClick: () => { setKeyword(''); setSearchWord('') }, title: '清除' }, '×'),
        createElement('button', { type: 'submit', className: 'mm-search-go', title: '搜索' }, '🔍'),
      ),
      createElement('button', {
        type: 'button', className: 'mm-icon-btn', title: '刷新数据源', onClick: handleRefresh, disabled: refreshing,
      }, refreshing ? createElement('span', { className: 'mm-spinner' }) : '⟳'),
    ),

    filters.length > 0 && createElement('div', { className: 'mm-filters' },
      filters.map(group => createElement(FilterChips, {
        key: group.key, group, value: filterValues[group.key] ?? '',
        onChange: value => setFilterValues(prev => ({ ...prev, [group.key]: value })),
      })),
    ),

    createElement('div', { className: 'mm-body', ref: scrollRef },
      phase === 'loading' && createElement(SkeletonMasonry, null),
      phase === 'error' && createElement(ErrorState, { message: error, onRetry: () => loadPage(1, true) }),
      phase === 'ready' && items.length === 0 && createElement(EmptyState, {
        text: effectiveKeyword ? `没有找到「${effectiveKeyword}」相关表情包` : '这个筛选条件下没有表情包',
        hint: effectiveKeyword ? '换个关键词试试，或切换数据源' : '试试清除筛选条件',
      }),
      phase === 'ready' && items.length > 0 && createElement('div', { className: 'mm-masonry' },
        items.map((item, index) => createElement(MemeCard, {
          key: item.id, item, isFavorite: isFavorite(item.id), onFavoriteChange, showToast,
          onZoom: () => setZoom({ item, index }),
        })),
      ),
      loadingMore && createElement(LoadingMore, null),
      phase === 'ready' && !hasMore && items.length > 0 && createElement('div', { className: 'mm-end' },
        `已到底 · 共 ${items.length} 张${effectiveKeyword ? `「${effectiveKeyword}」` : ''}`),
    ),

    zoom && createElement(Lightbox, {
      item: zoom.item, isFavorite: isFavorite(zoom.item.id), onFavoriteChange, showToast,
      onClose: () => setZoom(null),
      onNav: dir => setZoom(prev => {
        if (!prev) return prev
        const next = Math.min(Math.max(prev.index + dir, 0), items.length - 1)
        return { item: items[next], index: next }
      }),
    }),
  )
}
