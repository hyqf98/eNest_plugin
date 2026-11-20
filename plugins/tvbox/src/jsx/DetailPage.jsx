import { useEffect, useState } from 'react'
import { call, loadFavorites, loadHistory, toggleFavorite } from '../js/api.js'
import { ErrorBox, useKit } from './widgets.jsx'

/** 详情页：左侧 16:9 可播窗口 + 信息 + 线路 tab + 选集网格 + 换源行 */
export function DetailPage({ params, onBack, onPlay }) {
  const { siteKey, vodId } = params
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [flagIndex, setFlagIndex] = useState(0)
  const [descOpen, setDescOpen] = useState(false)
  const [fav, setFav] = useState(false)
  const [sameList, setSameList] = useState(null)
  const [sameLoading, setSameLoading] = useState(false)
  const [historyEntry, setHistoryEntry] = useState(null)
  const [reverse, setReverse] = useState(false)
  const kit = useKit()

  useEffect(() => {
    let alive = true
    setLoading(true); setError(''); setDetail(null); setFlagIndex(0); setSameList(null); setReverse(false)
    void (async () => {
      try {
        const d = await call('site.detail', [siteKey, vodId])
        if (!alive) return
        setDetail(d)
        // 只读不写：进详情不产生历史（仅播放后才写入，避免「继续观看」被浏览行为污染）
        const all = await loadHistory()
        if (alive) setHistoryEntry(all.find(h => h.siteKey === siteKey && h.vodId === vodId) ?? null)
        const favs = await loadFavorites()
        if (alive) setFav(favs.some(f => f.siteKey === siteKey && f.vodId === vodId))
      } catch (e) {
        if (alive) setError(e?.message || String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [siteKey, vodId, params.siteName])

  const flag = detail?.flags?.[flagIndex]
  const episodes = flag?.episodes ?? []
  const orderedEpisodes = reverse ? [...episodes].map((ep, i) => ({ ...ep, __i: episodes.length - 1 - i })) : episodes.map((ep, i) => ({ ...ep, __i: i }))
  // 集数分组（>40 时按 20 一组）
  const groupSize = 20
  const showGroups = orderedEpisodes.length > 40
  const [groupIndex, setGroupIndex] = useState(0)
  const groups = showGroups ? Array.from({ length: Math.ceil(orderedEpisodes.length / groupSize) }, (_, g) => orderedEpisodes.slice(g * groupSize, (g + 1) * groupSize)) : [orderedEpisodes]

  const findSame = async () => {
    if (!detail?.vod_name || sameLoading) return
    setSameLoading(true)
    try {
      const list = await call('site.findSame', [detail.vod_name, siteKey], { timeoutMs: 60_000 })
      setSameList(list)
    } catch (e) {
      kit?.toast(`换源失败：${e?.message || e}`)
      setSameList([])
    } finally {
      setSameLoading(false)
    }
  }

  const doToggleFav = async () => {
    const { next, exists } = await toggleFavorite({ siteKey, vodId, vodName: detail.vod_name, vodPic: detail.vod_pic, remarks: detail.vod_remarks, siteName: params.siteName })
    setFav(!exists)
    void next
  }

  const resume = historyEntry?.positionSec > 10 ? historyEntry : null

  return (
    <div className="tb-body">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 12px' }}>
        <button className="pk-btn pk-btn-sm" onClick={onBack}>← 返回</button>
        {loading ? <span className="tb-muted">详情加载中…</span> : null}
      </div>
      <ErrorBox error={error} onRetry={() => setDetail(null)} />
      {detail ? (
        <>
          <div className="tb-detail">
            <div className="tb-detail-cover">
              <DetailPoster detail={detail} />
            </div>
            <div className="tb-detail-info">
              <div className="tb-detail-name">{detail.vod_name}</div>
              {detail.vod_remarks ? <div className="tb-meta-line">{detail.vod_remarks}</div> : null}
              <div className="tb-meta-line">
                {[params.siteName, detail.type_name, detail.vod_year, detail.vod_area, detail.vod_lang, detail.vod_score && detail.vod_score !== '0' ? `评分 ${detail.vod_score}` : ''].filter(Boolean).join(' · ')}
              </div>
              {detail.vod_director ? <div className="tb-meta-line">导演：{detail.vod_director}</div> : null}
              {detail.vod_actor ? <div className="tb-meta-line">演员：{detail.vod_actor}</div> : null}
              {detail.vod_content ? (
                <>
                  <div className={descOpen ? 'tb-detail-desc' : 'tb-detail-desc collapsed'}>{detail.vod_content}</div>
                  <button className="tb-detail-desc-toggle" onClick={() => setDescOpen(!descOpen)}>{descOpen ? '收起' : '展开'}</button>
                </>
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {episodes.length ? (
                  <>
                    <button className="pk-btn" onClick={() => onPlay({ siteKey, siteName: params.siteName, vodId, vodName: detail.vod_name, flags: detail.flags, flagIndex, episodeIndex: 0, cover: detail.vod_pic })}>▶ 从第 1 集播放</button>
                    {resume ? (
                      <button className="pk-btn" onClick={() => onPlay({ siteKey, siteName: params.siteName, vodId, vodName: detail.vod_name, flags: detail.flags, flagIndex, episodeIndex: resume.episodeIndex || 0, cover: detail.vod_pic, resumeSec: resume.positionSec })}>
                        续播 · {resume.episodeName || '第 ' + ((resume.episodeIndex ?? 0) + 1) + ' 集'} {Math.floor(resume.positionSec / 60)}分
                      </button>
                    ) : null}
                  </>
                ) : <span className="tb-muted">暂无播放资源</span>}
                <button className="pk-btn" onClick={doToggleFav}>{fav ? '★ 已收藏' : '☆ 收藏'}</button>
                <button className="pk-btn" onClick={findSame} disabled={sameLoading}>{sameLoading ? '查找中…' : '换源'}</button>
              </div>
            </div>
          </div>

          {detail.flags.length ? (
            <>
              <div className="tb-section-title">播放线路</div>
              <div className="tb-flag-row">
                {detail.flags.map((f, i) => (
                  <button key={f.flag} className={i === flagIndex ? 'tb-flag-chip is-active' : 'tb-flag-chip'} onClick={() => setFlagIndex(i)}>
                    {f.flag}<span className="tb-flag-count">{f.episodes.length} 集</span>
                  </button>
                ))}
                {episodes.length > 1 ? <button className="tb-flag-chip" onClick={() => setReverse(!reverse)}>{reverse ? '倒序 ↓' : '正序 ↑'}</button> : null}
              </div>
              {showGroups ? (
                <div className="tb-flag-row" style={{ paddingTop: 0 }}>
                  {groups.map((g, gi) => (
                    <button key={gi} className={gi === groupIndex ? 'tb-flag-chip is-active' : 'tb-flag-chip'} onClick={() => setGroupIndex(gi)}>
                      {(g[0].name || g[0].__i + 1)} - {(g[g.length - 1].name || g[g.length - 1].__i + 1)}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="tb-episodes" style={{ marginTop: 8 }}>
                {(groups[Math.min(groupIndex, groups.length - 1)] ?? []).map(ep => (
                  <button key={ep.url + ep.__i} className="tb-ep-btn" onClick={() => onPlay({ siteKey, siteName: params.siteName, vodId, vodName: detail.vod_name, flags: detail.flags, flagIndex, episodeIndex: ep.__i, cover: detail.vod_pic })}>
                    {ep.name || String(ep.__i + 1).padStart(2, '0')}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {sameList ? (
            <>
              <div className="tb-section-title">换源结果{sameList.length ? "(" + sameList.length + ")" : ""}</div>
              {sameList.length ? (
                <div className="tb-episodes">
                  {sameList.map((v, i) => (
                    <button key={v.siteKey + v.vod_id + i} className="tb-ep-btn" style={{ maxWidth: 260 }} onClick={() => params.onOpenVod?.(v)}>
                      [{v.siteName}] {v.vod_name}
                    </button>
                  ))}
                </div>
              ) : <span className="tb-muted">没有找到同名片源</span>}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function DetailPoster({ detail }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let alive = true
    void import('../js/api.js').then(async ({ loadPoster }) => {
      const url = await loadPoster(detail.vod_pic, detail.siteKey)
      if (alive) setSrc(url)
    })
    return () => { alive = false }
  }, [detail.vod_pic, detail.siteKey])
  return src ? <img src={src} alt={detail.vod_name} /> : <div className="tb-card-fallback">🎬</div>
}
