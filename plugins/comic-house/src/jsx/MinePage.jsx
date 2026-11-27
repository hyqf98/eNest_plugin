import { useState } from 'react'
import { loadFavorites, removeFavorite, removeHistoryEntry, clearHistory } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { CoverImage } from './widgets.jsx'

/** 我的页：收藏 + 观看历史（时间线），点击续读 */
export function MinePage({ favorites, history, sources, onOpen, onRefreshFavorites, onRefreshHistory }) {
  const [tab, setTab] = useState('favorites')
  const [busy, setBusy] = useState(false)

  const removeFav = async (sourceKey, comicId) => {
    setBusy(true)
    try {
      await removeFavorite(sourceKey, comicId)
      await onRefreshFavorites()
    } catch (e) { notifyError(e) }
    finally { setBusy(false) }
  }
  const removeHist = async (sourceKey, comicId) => {
    setBusy(true)
    try {
      await removeHistoryEntry(sourceKey, comicId)
      await onRefreshHistory()
    } catch (e) { notifyError(e) }
    finally { setBusy(false) }
  }
  const doClearHistory = async () => {
    setBusy(true)
    try {
      await clearHistory()
      await onRefreshHistory()
    } catch (e) { notifyError(e) }
    finally { setBusy(false) }
  }

  const sourceNameOf = (key) => sources.find(s => s.key === key)?.name || key

  return (
    <div className="ch-mine">
      <div className="ch-browse-tabs">
        <button className={tab === 'favorites' ? 'ch-seg pk-active' : 'ch-seg'} onClick={() => setTab('favorites')}>
          收藏{favorites.length ? ` · ${favorites.length}` : ''}
        </button>
        <button className={tab === 'history' ? 'ch-seg pk-active' : 'ch-seg'} onClick={() => setTab('history')}>
          历史{history.length ? ` · ${history.length}` : ''}
        </button>
        {tab === 'history' && history.length > 0 && (
          <button className="pk-btn pk-btn-sm ch-danger ch-mine-clear" onClick={() => { if (confirm('清空全部观看历史？')) void doClearHistory() }}>清空</button>
        )}
      </div>

      {tab === 'favorites' ? (
        favorites.length ? (
          <div className="ch-mine-grid">
            {favorites.map(f => (
              <div className="ch-mine-cell" key={`${f.sourceKey}:${f.comicId}`}>
                <button className="ch-card" onClick={() => onOpen({ sourceKey: f.sourceKey, id: f.comicId, title: f.title })} title={f.title}>
                  <div className="ch-card-cover">
                    {f.cover ? <img src={f.cover} alt="" loading="lazy" /> : <CoverImage comic={{ sourceKey: f.sourceKey, id: f.comicId, title: f.title, cover: '' }} />}
                  </div>
                  <div className="ch-card-info">
                    <div className="ch-card-title">{f.title}</div>
                    <div className="ch-card-sub">{f.sourceName || sourceNameOf(f.sourceKey)}</div>
                  </div>
                </button>
                <button className="ch-mine-remove" disabled={busy} onClick={() => void removeFav(f.sourceKey, f.comicId)} title="取消收藏" aria-label={`取消收藏 ${f.title}`}>×</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="pk-empty-state">
            <strong className="pk-empty-title">暂无收藏</strong>
            <p className="pk-empty-hint">点击漫画卡片或详情页的收藏按钮，即可添加。</p>
          </div>
        )
      ) : (
        history.length ? (
          <HistoryTimeline history={history} sourceNameOf={sourceNameOf} onOpen={onOpen} onRemove={removeHist} busy={busy} />
        ) : (
          <div className="pk-empty-state">
            <strong className="pk-empty-title">暂无阅读历史</strong>
            <p className="pk-empty-hint">阅读漫画后会自动保存进度。</p>
          </div>
        )
      )}
    </div>
  )
}

/** 观看历史时间线：今天/昨天/本周/更早，卡片带源名+章节+页码，点击续读 */
function HistoryTimeline({ history, sourceNameOf, onOpen, onRemove, busy }) {
  const groups = groupByTime(history)
  return (
    <div className="ch-timeline">
      {groups.map(g => (
        <section className="ch-timeline-group" key={g.label}>
          <h3 className="ch-part-title">{g.label}<span className="pk-muted ch-timeline-count">{g.items.length}</span></h3>
          <div className="ch-grid">
            {g.items.map(h => (
              <div className="ch-card-wrap ch-hist-card" key={`${h.sourceKey}:${h.comicId}`}>
                <button
                  className="ch-card"
                  onClick={() => onOpen({ sourceKey: h.sourceKey, id: h.comicId, title: h.title })}
                  title={`${h.title} · 继续阅读`}
                >
                  <div className="ch-card-cover">
                    {h.cover
                      ? <img src={h.cover} alt="" loading="lazy" />
                      : <CoverImage comic={{ sourceKey: h.sourceKey, id: h.comicId, title: h.title, cover: '' }} />}
                  </div>
                  <div className="ch-card-info">
                    <div className="ch-card-title">{h.title}</div>
                    <div className="ch-card-sub">{sourceNameOf(h.sourceKey)}</div>
                    <div className="ch-card-sub ch-hist-progress">
                      {h.lastEpTitle ? `${h.lastEpTitle}` : '未读章节'}
                      {h.lastPage ? ` · P${h.lastPage}` : ''}
                    </div>
                  </div>
                  <span className="ch-hist-time">{formatTime(h.at)}</span>
                  <span className="ch-hist-continue">▶ 继续</span>
                </button>
                <button className="ch-mine-remove" disabled={busy} onClick={() => void onRemove(h.sourceKey, h.comicId)} title="移除这条历史" aria-label={`移除 ${h.title} 的历史`}>×</button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function groupByTime(list) {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const weekAgo = startOfToday - 6 * 86_400_000
  const buckets = [
    { label: '今天', min: startOfToday, items: [] },
    { label: '昨天', min: startOfYesterday, max: startOfToday, items: [] },
    { label: '本周', min: weekAgo, max: startOfYesterday, items: [] },
    { label: '更早', min: 0, max: weekAgo, items: [] },
  ]
  for (const h of list) {
    const t = h.at ?? 0
    const bucket = buckets.find(b => t >= b.min && (b.max === undefined || t < b.max))
    if (bucket) bucket.items.push(h)
  }
  return buckets.filter(b => b.items.length)
}

function formatTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}
