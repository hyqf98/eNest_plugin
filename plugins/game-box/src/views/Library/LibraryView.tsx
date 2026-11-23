/**
 * 浏览视图（游戏库）：工具行（搜索、分类、排序、数据源）+ 封面网格 + 分页。
 * 数据来自 library.list，条目与任务状态从 useApp() 读取；
 * 请求带递增序号，快速切换分类/搜索时丢弃过期响应，不闪回旧结果。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle, Heart, Info, MagnifyingGlass, X,
} from '@phosphor-icons/react'
import * as api from '../../js/api'
import type { LibraryFacets, LibraryItem, Page, Section, SourceId } from '../../shared/contracts'
import { ACTIVE_STATES } from '../../shared/contracts'
import { useApp } from '../../js/state'
import { Cover, Empty, ErrorBar, SkeletonGrid, Spinner } from '../../components/base'
import { Pager } from '../../components/ext'
import { Glyph } from '../../components/Glyph'
import { Select, Segmented } from '../../ui'

/** trainer/mod 的后端本地分页大小未知，交给 totalPages 即可 */
const ALL_SECTIONS: readonly Section[] = ['pc', 'console', 'software', 'trainer', 'mod']

interface ListState {
  loading: boolean
  error: string
  page: Page<LibraryItem>
}

const IDLE_PAGE: Page<LibraryItem> = { items: [], page: 1, totalPages: 1, total: 0 }

/** 该栏目是否允许选择数据源（pc/console/software 有 source* 设置） */
function sourceSettingKey(section: Section): 'sourcePc' | 'sourceConsole' | 'sourceSoftware' | null {
  if (section === 'pc') return 'sourcePc'
  if (section === 'console') return 'sourceConsole'
  if (section === 'software') return 'sourceSoftware'
  return null
}

export function LibraryView({ section }: { section: Section }) {
  const app = useApp()
  const settings = app.settings

  const [facets, setFacets] = useState<LibraryFacets | null>(null)
  const [keyword, setKeyword] = useState('')
  const [keywordDraft, setKeywordDraft] = useState('')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState('')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<ListState>({ loading: true, error: '', page: IDLE_PAGE })
  const [favBusyId, setFavBusyId] = useState('')
  // 递增请求序号：只有最后一次发出的响应允许落地
  const requestSeq = useRef(0)

  const sectionKey = ALL_SECTIONS.includes(section) ? section : 'pc'
  const settingKey = sourceSettingKey(sectionKey)
  const source: SourceId = (settingKey && settings ? settings[settingKey] : 'ode') || 'ode'
  const sources = facets?.sources ?? []
  const sorts = facets?.sorts ?? []

  // 切栏目重置筛选
  useEffect(() => {
    setKeyword('')
    setKeywordDraft('')
    setCategory('')
    setSort('')
    setPage(1)
    setFacets(null)
  }, [sectionKey])

  const facetsErrorRef = useRef('')
  useEffect(() => {
    let alive = true
    const seq = ++requestSeq.current
    facetsErrorRef.current = ''
    setState(current => ({ ...current, loading: true, error: '' }))
    api.library.facets(sectionKey)
      .then(result => {
        if (!alive || seq !== requestSeq.current) return
        setFacets(result)
      })
      .catch(error => {
        if (!alive || seq !== requestSeq.current) return
        setState({ loading: false, error: errorMessage(error), page: IDLE_PAGE })
      })
    return () => { alive = false }
  }, [sectionKey])

  const loadList = useCallback((options?: { keepLoading?: boolean }) => {
    const seq = ++requestSeq.current
    if (!options?.keepLoading) setState(current => ({ ...current, loading: true, error: '' }))
    else setState(current => ({ ...current, loading: true, error: '' }))
    api.library.list({ section: sectionKey, source, page, keyword, category, sort })
      .then(result => {
        if (seq !== requestSeq.current) return
        setState({ loading: false, error: '', page: result })
      })
      .catch(error => {
        if (seq !== requestSeq.current) return
        setState({ loading: false, error: errorMessage(error), page: IDLE_PAGE })
      })
  }, [sectionKey, source, page, keyword, category, sort])

  // 列表依赖的任一条件变化就重新加载
  const loadKey = `${sectionKey}|${source}|${page}|${keyword}|${category}|${sort}`
  const lastLoaded = useRef('')
  useEffect(() => {
    if (!facets) return
    if (lastLoaded.current === loadKey) return
    lastLoaded.current = loadKey
    loadList()
  }, [loadKey, facets, loadList])

  const hasActiveSource = sources.length > 1 && settingKey !== null
  // 数据源给了多个排序就显示下拉：修改器（综合/最新/最热/推荐）、MOD（默认/最新/最热）也有排序；
  // gamer520 不给排序，切到它时下拉自然消失
  const showSort = sorts.length > 1

  const taskByItem = useMemo(() => {
    const map = new Map<string, { percent: number }>()
    for (const task of app.taskList) {
      if (!ACTIVE_STATES.includes(task.state) || task.totalBytes <= 0) continue
      if (!map.has(task.itemId)) map.set(task.itemId, { percent: Math.min(100, (task.completedBytes / task.totalBytes) * 100) })
    }
    return map
  }, [app.taskList])

  const onSearchSubmit = () => {
    const next = keywordDraft.trim()
    if (next === keyword) return
    setKeyword(next)
    setPage(1)
  }

  const onFavorite = async (item: LibraryItem) => {
    if (favBusyId) return
    setFavBusyId(item.id)
    try {
      await api.library.favorite(item.id, !item.favorite)
      await app.refreshEntries()
      loadList({ keepLoading: true })
    } catch (error) {
      void app.notify(errorMessage(error), 'error')
    } finally {
      setFavBusyId('')
    }
  }

  const sourceOptions = sources.map(item => ({ value: item.id, label: item.label }))
  // 当前数据源自己的现状说明（可空），非空时显示在工具行下方
  const sourceHint = sources.find(item => item.id === source)?.hint?.trim() ?? ''

  return (
    <div className="gh-lib">
      <div className="gh-toolbar">
        <div className="gh-search">
          <i><Glyph icon={MagnifyingGlass} size={15} /></i>
          <input
            value={keywordDraft}
            placeholder="搜索你想玩的游戏…"
            aria-label="搜索"
            onChange={event => setKeywordDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') onSearchSubmit() }}
            onBlur={onSearchSubmit}
          />
          {keywordDraft ? (
            <button type="button" className="gh-search-clear" aria-label="清空搜索" onClick={() => { setKeywordDraft(''); if (keyword) { setKeyword(''); setPage(1) } }}>
              <Glyph icon={X} size={12} />
            </button>
          ) : null}
        </div>
        {facets && facets.categories.length > 1 ? (
          <Select
            value={category}
            ariaLabel="分类"
            minWidth={120}
            options={facets.categories.map(item => ({ value: item.id, label: item.label }))}
            onChange={value => { setCategory(value); setPage(1) }}
          />
        ) : null}
        {showSort ? (
          <Select
            value={sort}
            ariaLabel="排序"
            minWidth={110}
            options={sorts.map(item => ({ value: item.id, label: item.label }))}
            onChange={value => { setSort(value); setPage(1) }}
          />
        ) : null}
        {hasActiveSource ? (
          <Segmented
            value={source}
            ariaLabel="数据源"
            options={sourceOptions}
            onChange={value => {
              if (!settingKey || !settings) return
              void app.updateSettings({ [settingKey]: value as SourceId })
              setPage(1)
            }}
          />
        ) : null}
      </div>

      {sourceHint ? (
        <p className="gh-lib-source-hint" role="note">
          <Glyph icon={Info} size={13} />
          <span>{sourceHint}</span>
        </p>
      ) : null}

      {state.loading ? <Spinner label={sectionKey === 'trainer' ? '正在加载修改器列表…' : '正在加载分类内容…'} /> : null}

      {state.error ? (
        <ErrorBar message={state.error} onRetry={() => { setFacets(null); lastLoaded.current = ''; requestSeq.current++; setFacets(f => f); loadList() }} />
      ) : state.loading && !state.page.items.length ? (
        <SkeletonGrid count={12} />
      ) : !state.loading && !state.page.items.length ? (
        <Empty title="暂无数据" body={keyword ? `没有找到与「${keyword}」相关的内容，换个关键词试试` : '这个分类下暂时没有内容'} />
      ) : (
        <>
          <div className="gh-grid">
            {state.page.items.map(item => (
              <GameCardView
                key={item.id}
                item={item}
                progress={taskByItem.get(item.id)?.percent ?? 0}
                favoriteBusy={favBusyId === item.id}
                onOpen={() => app.openDetail(item.id)}
                onFavorite={() => void onFavorite(item)}
              />
            ))}
          </div>
          <Pager page={state.page.page} totalPages={state.page.totalPages} onChange={next => setPage(next)} />
        </>
      )}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ---------------- 卡片 ---------------- */

/* 封面比例的占位值与夹取范围（宽 / 高）。加载前按竖版 3:4 占位；
   加载后跟随图片本身，但夹在 5:4 与 4:3 之间——更宽的横幅图只放到 4:3 为止，
   再宽就把同一行的卡片压得又扁又参差，这时宁可裁掉左右少量边缘。 */
const COVER_RATIO_PLACEHOLDER = 3 / 4
const COVER_RATIO_MIN = 5 / 4
const COVER_RATIO_MAX = 4 / 3

function coverRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return COVER_RATIO_PLACEHOLDER
  return Math.min(COVER_RATIO_MAX, Math.max(COVER_RATIO_MIN, ratio))
}

function GameCardView({ item, progress, favoriteBusy, onOpen, onFavorite }: {
  item: LibraryItem
  progress: number
  favoriteBusy: boolean
  onOpen: () => void
  onFavorite: () => void
}) {
  const meta = item.sizeText || item.subtitle || item.category || '未知大小'
  const [ratio, setRatio] = useState(COVER_RATIO_PLACEHOLDER)
  return (
    <div className="gh-card gh-lib-card" role="button" tabIndex={0} aria-label={item.title}
      onClick={onOpen}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }}
    >
      <div className="gh-lib-cover" style={{ aspectRatio: ratio }}>
        <Cover token={item.coverToken} alt={item.title} onRatio={value => setRatio(coverRatio(value))} />
        <div className="gh-card-badges">
          {item.category ? <span>{item.category}</span> : null}
        </div>
        {item.installed ? (
          <span className="gh-lib-installed" title="已安装"><Glyph icon={CheckCircle} size={16} /></span>
        ) : null}
        <button
          type="button"
          className="gh-card-fav"
          data-favorite={item.favorite ? 'true' : 'false'}
          aria-label={item.favorite ? '取消收藏' : '收藏'}
          aria-pressed={item.favorite}
          disabled={favoriteBusy}
          onClick={event => { event.stopPropagation(); onFavorite() }}
        >
          <Heart size={14} weight={item.favorite ? 'fill' : 'regular'} />
        </button>
        {progress > 0 ? (
          <div className="gh-lib-card-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
        ) : null}
      </div>
      <div className="gh-card-body">
        <h3 className="gh-card-title" title={item.title}>{item.title}</h3>
        <div className="gh-card-meta"><span>{meta}</span></div>
      </div>
    </div>
  )
}
