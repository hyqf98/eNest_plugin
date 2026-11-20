import { useEffect, useRef, useState } from 'react'
import { call, loadPoster, loadSearchHistory, removeSearchKeyword } from '../js/api.js'

/**
 * 搜索框（漫画屋 ch-searchbox 同款交互）：
 * - 聚焦/输入时弹出下拉：历史搜索记录（可单条删除）+ 当前站点最佳匹配（防抖 350ms）
 * - 方向键在历史与匹配间导航，回车执行；点击历史词直接搜索；点击匹配影片直接进详情
 */
export function SearchBox({ keyword, setKeyword, onSearch, onOpenVod }) {
  const [focused, setFocused] = useState(false)
  const [history, setHistory] = useState([])
  const [suggest, setSuggest] = useState([])
  const [suggesting, setSuggesting] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const boxRef = useRef(null)
  const timerRef = useRef(0)
  const seqRef = useRef(0)

  // 聚焦时拉历史
  useEffect(() => {
    if (!focused) return
    void loadSearchHistory().then(setHistory).catch(() => {})
  }, [focused])

  // 点击外部关闭
  useEffect(() => {
    if (!focused) return
    const onDoc = e => { if (!boxRef.current?.contains(e.target)) setFocused(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [focused])

  // 输入防抖 → 多站聚合最佳匹配（先返回先出，取前 6 条）
  useEffect(() => {
    clearTimeout(timerRef.current)
    const kw = keyword.trim()
    if (!kw) { setSuggest([]); setSuggesting(false); return }
    setSuggesting(true)
    const seq = ++seqRef.current
    timerRef.current = setTimeout(() => {
      void call('aggregate.suggest', [kw], { timeoutMs: 20_000 })
        .then(r => { if (seq === seqRef.current) setSuggest((r ?? []).slice(0, 6)) })
        .catch(() => { if (seq === seqRef.current) setSuggest([]) })
        .finally(() => { if (seq === seqRef.current) setSuggesting(false) })
    }, 350)
    return () => clearTimeout(timerRef.current)
  }, [keyword])

  const filteredHistory = keyword.trim()
    ? history.filter(w => w.includes(keyword.trim())).slice(0, 5)
    : history.slice(0, 8)
  const open = focused && (filteredHistory.length > 0 || suggest.length > 0)
  const flatItems = [
    ...filteredHistory.map(w => ({ kind: 'history', word: w })),
    ...suggest.map(v => ({ kind: 'suggest', item: v })),
  ]

  const doGo = (item) => {
    setFocused(false)
    if (item.kind === 'history') { setKeyword(item.word); onSearch(item.word) }
    else onOpenVod?.(item.item)
  }

  const onKeyDown = (e) => {
    if (!open || !flatItems.length) { if (e.key === 'Enter') onSearch(keyword); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, flatItems.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, -1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex >= 0) doGo(flatItems[activeIndex])
      else onSearch(keyword)
    } else if (e.key === 'Escape') setFocused(false)
  }

  return (
    <div className="tb-searchbox" ref={boxRef}>
      <span className="tb-searchbox-icon">🔍</span>
      <input
        placeholder="搜索影片，聚合全部站点…"
        value={keyword}
        onFocus={() => setFocused(true)}
        onChange={e => { setKeyword(e.target.value); setActiveIndex(-1) }}
        onKeyDown={onKeyDown}
      />
      {suggesting ? <span className="tb-searchbox-hint">匹配中…</span> : null}
      {keyword ? <button className="tb-searchbox-clear" onClick={() => { setKeyword(''); setSuggest([]) }}>✕</button> : null}
      {open ? (
        <div className="tb-searchbox-drop" onMouseDown={e => e.preventDefault()}>
          {filteredHistory.length ? (
            <>
              <div className="tb-searchbox-drop-head">
                <span>搜索历史</span>
                <span className="tb-muted">{filteredHistory.length} 条</span>
              </div>
              {filteredHistory.map((w, i) => (
                <div
                  key={`h-${w}`}
                  className={`tb-searchbox-item${activeIndex === i ? ' is-active' : ''}`}
                  onClick={() => doGo({ kind: 'history', word: w })}
                >
                  <span className="tb-searchbox-item-icon">🕘</span>
                  <span className="tb-searchbox-item-text">{w}</span>
                  <button
                    className="tb-searchbox-item-del"
                    title="删除该记录"
                    onClick={async e => {
                      e.stopPropagation()
                      await removeSearchKeyword(w)
                      setHistory(prev => prev.filter(x => x !== w))
                    }}
                  >✕</button>
                </div>
              ))}
            </>
          ) : null}
          {suggest.length ? (
            <>
              <div className="tb-searchbox-drop-head">
                <span>最佳匹配</span>
                {suggesting ? <span className="tb-muted">匹配中…</span> : null}
              </div>
              {suggest.map((v, i) => {
                const idx = filteredHistory.length + i
                return (
                  <div
                    key={`s-${v.vod_id}-${i}`}
                    className={`tb-searchbox-item${activeIndex === idx ? ' is-active' : ''}`}
                    onClick={() => doGo({ kind: 'suggest', item: v })}
                  >
                    <SuggestThumb item={v} />
                    <span className="tb-searchbox-item-text">{v.vod_name}</span>
                    <span className="tb-muted" style={{ fontSize: 11, flex: 'none' }}>{v.vod_remarks || v.type_name || ''}</span>
                  </div>
                )
              })}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SuggestThumb({ item }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let alive = true
    void loadPoster(item.vod_pic, item.siteKey).then(u => { if (alive) setSrc(u) }).catch(() => {})
    return () => { alive = false }
  }, [item.vod_pic, item.siteKey])
  return (
    <span className="tb-searchbox-thumb">
      {src ? <img src={src} alt="" /> : <span>🎬</span>}
    </span>
  )
}
