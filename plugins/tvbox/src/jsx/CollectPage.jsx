import { useEffect, useRef, useState } from 'react'
import { call } from '../js/api.js'
import { Card } from './HomePage.jsx'

/**
 * 聚合搜索：并行搜全部可搜站点；结果 tab 随到达动态追加（FongMi 交互），
 * 首位固定「全部」聚合 tab。
 */
export function CollectPage({ params, onOpenVod, onBack }) {
  const { keyword, sites } = params
  const [results, setResults] = useState([])
  const [activeTab, setActiveTab] = useState('all')
  const [searching, setSearching] = useState(true)
  const abortRef = useRef(false)

  useEffect(() => {
    abortRef.current = false
    setResults([]); setSearching(true); setActiveTab('all')
    const searchable = (sites ?? []).filter(s => !s.disabled && s.searchable !== 0)
    // 站点搜索 + 网盘（OpenList）搜索并行；网盘结果作为独立 tab
    const jobs = searchable.map(async s => {
      const list = await call('site.search', [s.key, keyword, 1], { timeoutMs: 90_000 })
      if (abortRef.current) return
      if (list?.list?.length) setResults(prev => [...prev, { siteKey: s.key, siteName: s.name, list: list.list }])
    })
    const cloudJob = call('openlist.search', [keyword], { timeoutMs: 60_000 })
      .then(items => {
        if (abortRef.current || !items?.length) return
        setResults(prev => [...prev, { siteKey: 'openlist', siteName: '网盘', list: items.map(({ __total, ...v }) => v) }])
      })
      .catch(() => { /* 未配网盘或失败静默 */ })
    void Promise.allSettled([...jobs, cloudJob]).finally(() => { if (!abortRef.current) setSearching(false) })
    return () => { abortRef.current = true }
  }, [keyword, sites])

  const doneCount = results.length
  const activeList = activeTab === 'all'
    ? results.flatMap(r => r.list.map(v => ({ ...v, siteName: r.siteName })))
    : results.find(r => r.siteKey === activeTab)?.list ?? []

  return (
    <div>
      {onBack ? (
        <div className="tb-section-title" style={{ marginTop: 0 }}>
          <button className="pk-btn pk-btn-sm" onClick={onBack}>← 返回</button>
          <span>「{keyword}」搜索结果</span>
          {searching
            ? <span className="tb-more">搜索中…（{doneCount} 站已返回）</span>
            : <span className="tb-more">{doneCount} 站命中 · 共 {activeList.length} 条</span>}
        </div>
      ) : (
        <div className="tb-section-title" style={{ marginTop: 0 }}>
          「{keyword}」
          {searching ? <span className="tb-more">搜索中…（{doneCount} 站已返回）</span> : <span className="tb-more">{doneCount} 站命中 · 共 {activeList.length} 条</span>}
        </div>
      )}
      <div className="tb-collect-tabs">
        <button className={`tb-type-chip${activeTab === 'all' ? ' pk-active' : ''}`} onClick={() => setActiveTab('all')}>全部（{results.flatMap(r => r.list).length}）</button>
        {results.map(r => (
          <button key={r.siteKey} className={`tb-type-chip${activeTab === r.siteKey ? ' pk-active' : ''}`} onClick={() => setActiveTab(r.siteKey)}>
            {r.siteName}（{r.list.length}）
          </button>
        ))}
      </div>
      <div className="tb-grid">
        {activeList.slice(0, 300).map((v, i) => (
          <Card
            key={`${v.siteKey}-${v.vod_id}-${i}`}
            item={v}
            sub={v.siteName}
            onOpen={() => {
              // 网盘条目：vod_id 形如 file:<sign>:<path>，直接取直链播放
              if (v.siteKey?.startsWith('openlist:')) {
                void call('openlist.play', [v.siteKey.slice(9), decodeURIComponent(v.vod_id.replace(/^file:[^:]*:/, ''))], { timeoutMs: 30_000 })
                  .then(play => window.open(play.url, '_blank'))
                  .catch(e => alert(`网盘播放失败：${e?.message || e}`))
                return
              }
              onOpenVod(v)
            }}
          />
        ))}
      </div>
      {!searching && !activeList.length ? <div className="tb-empty">没有找到「{keyword}」相关内容</div> : null}
    </div>
  )
}
