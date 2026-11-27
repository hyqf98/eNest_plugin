import { useState } from 'react'
import { loadFavorites, removeFavorite, removeHistoryEntry, clearHistory } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { CoverImage } from './widgets.jsx'

/** 我的页：书架（收藏）+ 阅读历史（时间线），点击续读 */
export function MinePage({ favorites, history, sources, onOpen, onRefreshFavorites, onRefreshHistory }) {
  const [tab, setTab] = useState('favorites')
  const [busy, setBusy] = useState(false)

  const removeFav = async (sourceKey, bookId) => {
    setBusy(true)
    try {
      await removeFavorite(sourceKey, bookId)
      await onRefreshFavorites()
    } catch (e) { notifyError(e) }
    finally { setBusy(false) }
  }
  const removeHist = async (sourceKey, bookId) => {
    setBusy(true)
    try {
      await removeHistoryEntry(sourceKey, bookId)
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
    <div className="nh-mine">
      <div className="nh-browse-tabs">
        <button className={tab === 'favorites' ? 'nh-seg pk-active' : 'nh-seg'} onClick={() => setTab('favorites')}>
          书架{favorites.length ? ` · ${favorites.length}` : ''}
        </button>
        <button className={tab === 'history' ? 'nh-seg pk-active' : 'nh-seg'} onClick={() => setTab('history')}>
          历史{history.length ? ` · ${history.length}` : ''}
        </button>
        {tab === 'history' && history.length > 0 && (
          <button className="pk-btn pk-btn-sm nh-danger nh-mine-clear" onClick={() => { if (confirm('清空全部阅读历史？')) void doClearHistory() }}>清空</button>
        )}
      </div>

      {tab === 'favorites' ? (
        favorites.length ? (
          <div className="nh-mine-grid">
            {favorites.map(f => (
              <div className="nh-mine-cell" key={`${f.sourceKey}:${f.bookId}`}>
                <button className="nh-card" onClick={() => onOpen({ sourceKey: f.sourceKey, id: f.bookId, title: f.title })} title={f.title}>
                  <div className="nh-card-cover">
                    {f.cover
                      ? <img src={f.cover} alt="" loading="lazy" />
                      : <CoverImage book={{ sourceKey: f.sourceKey, cover: f.cover || '', title: f.title, bookId: f.bookId }} />}
                  </div>
                  <div className="nh-card-info">
                    <div className="nh-card-title">{f.title}</div>
                    <div className="nh-card-sub">{f.author || f.sourceName || sourceNameOf(f.sourceKey)}</div>
                  </div>
                </button>
                <button className="nh-mine-remove" disabled={busy} onClick={() => void removeFav(f.sourceKey, f.bookId)} title="移出书架" aria-label={`移出书架 ${f.title}`}>×</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="pk-empty-state">
            <strong className="pk-empty-title">书架暂无收藏</strong>
            <p className="pk-empty-hint">点击书籍卡片或详情页的收藏按钮，即可添加。</p>
          </div>
        )
      ) : (
        history.length ? (
          <HistoryTimeline history={history} sourceNameOf={sourceNameOf} onOpen={onOpen} onRemove={removeHist} busy={busy} />
        ) : (
          <div className="pk-empty-state">
            <strong className="pk-empty-title">暂无阅读历史</strong>
            <p className="pk-empty-hint">阅读小说后会自动保存进度。</p>
          </div>
        )
      )}
    </div>
  )
}

/** 阅读历史时间线：今天/昨天/本周/更早，卡片带源名+章节，点击续读 */
function HistoryTimeline({ history, sourceNameOf, onOpen, onRemove, busy }) {
  const groups = groupByTime(history)
  return (
    <div className="nh-timeline">
      {groups.map(g => (
        <section className="nh-timeline-group" key={g.label}>
          <h3 className="nh-part-title">{g.label}<span className="pk-muted nh-timeline-count">{g.items.length}</span></h3>
          <div className="nh-grid">
            {g.items.map(h => (
              <div className="nh-card-wrap nh-hist-card" key={`${h.sourceKey}:${h.bookId}`}>
                <button
                  className="nh-card"
                  onClick={() => onOpen({ sourceKey: h.sourceKey, id: h.bookId, title: h.title })}
                  title={`${h.title} · 继续阅读`}
                >
                  <div className="nh-card-cover">
                    {h.cover
                      ? <img src={h.cover} alt="" loading="lazy" />
                      : <CoverImage book={{ sourceKey: h.sourceKey, cover: h.cover || '', title: h.title, bookId: h.bookId }} />}
                  </div>
                  <div className="nh-card-info">
                    <div className="nh-card-title">{h.title}</div>
                    <div className="nh-card-sub">{sourceNameOf(h.sourceKey)}</div>
                    <div className="nh-card-sub nh-hist-progress">
                      {h.lastChTitle ? `${h.lastChTitle}` : '未读章节'}
                    </div>
                  </div>
                  <span className="nh-hist-time">{formatTime(h.at)}</span>
                  <span className="nh-hist-continue">▶ 继续</span>
                </button>
                <button className="nh-mine-remove" disabled={busy} onClick={() => void onRemove(h.sourceKey, h.bookId)} title="移除这条历史" aria-label={`移除 ${h.title} 的历史`}>×</button>
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
