import { useEffect, useState } from 'react'
import { call, loadHistory } from '../js/api.js'
import { Empty, ErrorBox, SkeletonRow } from './widgets.jsx'

/** 一个首页板块：标题 + 横向卡片行 + 「更多」进分类页 */
function Section({ title, list, onMore, onOpen }) {
  if (!list.length) return null
  return (
    <section style={{ marginBottom: 22 }}>
      <div className="tb-section-title">
        {title}
        <span className="tb-more" onClick={onMore}>更多 ›</span>
      </div>
      <div className="tb-row">
        {list.map(v => <Card key={`${v.vod_id}`} item={v} sub={v.vod_remarks} onOpen={() => onOpen(v)} />)}
      </div>
    </section>
  )
}

/**
 * 首页（多源聚合）：继续观看 + 标准板块（电影/连续剧/综艺/动漫），
 * 各板块由全部启用数据源聚合（同名合并、多源标识），「更多」跳分类页。
 */
export function HomePage({ sites, onOpenVod, onGoConfig, onPlayResume, onGoCategory }) {
  const [sections, setSections] = useState([])
  const [sourceCount, setSourceCount] = useState(0)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { void loadHistory().then(setHistory).catch(() => {}) }, [])

  useEffect(() => {
    if (!sites.length) { setSections([]); return }
    let alive = true
    setLoading(true); setError('')
    void (async () => {
      try {
        const board = await call('aggregate.home', [], { timeoutMs: 60_000 })
        if (!alive) return
        setSections(board.sections ?? [])
        setSourceCount(board.sources ?? 0)
      } catch (e) {
        if (alive) setError(e?.message || String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [sites])

  const open = (v) => onOpenVod({ ...v, siteName: v.sources?.length ? `${v.sources[0].siteName}${v.sources.length > 1 ? ` 等${v.sources.length}源` : ''}` : v.siteName })

  if (!sites.length) {
    return (
      <Empty title="暂无影视源" hint="导入配置后，即可浏览和搜索影片。">
        <button className="pk-btn" onClick={onGoConfig}>导入配置地址</button>
      </Empty>
    )
  }

  return (
    <>
      {history.length ? (
        <section style={{ marginBottom: 22 }}>
          <div className="tb-section-title">继续观看</div>
          <div className="tb-row">
            {history.slice(0, 12).map(h => (
              <div key={`${h.siteKey}-${h.vodId}`} className="tb-card" onClick={() => onPlayResume(h)}>
                <div className="tb-card-poster">
                  <Poster pic={h.vodPic} siteKey={h.siteKey} name={h.vodName} />
                  {(() => {
                    // 优先实测画质（播放器回写），否则从片名/remarks 提取
                    const q = h.quality ? { label: h.quality, cls: h.quality === 'HD' ? 'hd' : '' } : extractQuality(h.vodName, h.remarks)
                    return q ? <span className={`tb-card-quality ${q.cls}`}>{q.label}</span> : null
                  })()}
                  {formatWatchBadge(h) ? <span className="tb-card-remark">{formatWatchBadge(h)}</span> : null}
                </div>
                <div className="tb-card-info">
                  <div className="tb-card-name">{h.vodName || h.vod_name}</div>
                  <div className="tb-card-sub" style={{ color: 'var(--accent, #bd542b)' }}>上次看到 {formatWatchPoint(h)}</div>
                  <div className="tb-card-sub">{h.siteName}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <ErrorBox error={error} onRetry={() => setSections([])} />
      {loading && !sections.length ? <SkeletonRow count={6} label="正在聚合各内容源…" /> : null}

      {sections.map(sec => (
        <Section
          key={sec.key ?? sec.typeId}
          title={`${sec.name ?? sec.typeName}${sourceCount > 1 ? ` · ${sourceCount} 源聚合` : ''}`}
          list={sec.list}
          onOpen={open}
          onMore={() => onGoCategory?.(sec.key ?? sec.typeId)}
        />
      ))}
      {!loading && !sections.length && !error ? <Empty title="暂无推荐内容" /> : null}
    </>
  )
}

/** 「上次看到 第X集 12:34」：集名 + mm:ss 进度 */
function formatWatchPoint(h) {
  const ep = h.episodeName || (h.episodeIndex !== undefined ? `第 ${(h.episodeIndex ?? 0) + 1} 集` : '')
  const sec = Math.floor(h.positionSec || 0)
  const mm = Math.floor(sec / 60)
  const ss = String(sec % 60).padStart(2, '0')
  const time = sec > 5 ? ` ${mm}:${ss}` : ''
  return [ep, time].filter(Boolean).join('') || '刚开始'
}
/** 封面角标：集名或进度简写 */
function formatWatchBadge(h) {
  return h.episodeName || (h.positionSec > 10 ? `${Math.floor(h.positionSec / 60)}分` : '')
}

/** 画质角标：从 remarks/片名提取版本词（4K 优先；预告/解说这类内容形态词优先于画质词） */
export function extractQuality(...texts) {
  const all = texts.filter(Boolean).join(' ')
  const up = all.toUpperCase()
  if (/预告|TRAILER/.test(all) && !/HD|1080|720/.test(up)) return { label: '预告', cls: 'sq' }
  if (/电影解说|\[解说\]/.test(all)) return { label: '解说', cls: 'sq' }
  if (/\b(4K|2160P|UHD)\b/.test(up)) return { label: '4K', cls: '' }
  if (/\b(2K|1440P)\b/.test(up)) return { label: '2K', cls: '' }
  if (/\b(1080P?|FHD)|蓝光|BLUERAY|\bBD\b/.test(up)) return { label: '1080P', cls: '' }
  if (/\b(720P?|HD|WEB-?DL)\b|正片|抢先版|\bTC\b/.test(up)) return { label: 'HD', cls: 'hd' }
  return null
}

/** 影片卡片（封面 2:3 + 画质角标 + 多源标识；封面三态：shimmer/图/首字） */
export function Card({ item, sub, onOpen }) {
  const [src, setSrc] = useState(null)   // null=加载中 ''=失败
  useEffect(() => {
    let alive = true
    setSrc(null)
    void import('../js/api.js').then(async ({ loadPoster }) => {
      const url = await loadPoster(item.vod_pic, item.siteKey)
      if (alive) setSrc(url)
    })
    return () => { alive = false }
  }, [item.vod_pic, item.siteKey])
  const quality = extractQuality(item.vod_name, item.vod_remarks, sub)
  const multiSource = item.sources?.length > 1
  return (
    <div className="tb-card" onClick={onOpen} title={item.vod_name}>
      <div className="tb-card-poster">
        {src
          ? <img src={src} alt={item.vod_name} loading="lazy" />
          : src === null
            ? <div className="tb-skeleton" style={{ position: 'absolute', inset: 0 }} />
            : <div className="tb-card-fallback">{(item.vod_name || '·').slice(0, 1)}</div>}
        {quality ? <span className={`tb-card-quality ${quality.cls}`}>{quality.label}</span> : null}
        {multiSource ? <span className="tb-card-multisource">{item.sources.length} 源</span> : null}
        {item.vod_remarks ? <span className="tb-card-remark">{item.vod_remarks}</span> : null}
      </div>
      <div className="tb-card-info">
        <div className="tb-card-name">{item.vod_name}</div>
        <div className="tb-card-sub">{multiSource ? `${item.sources[0].siteName} 等 ${item.sources.length} 源` : (sub || item.sources?.[0]?.siteName)}</div>
      </div>
    </div>
  )
}

function Poster({ pic, siteKey, name }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    if (!pic) return
    void import('../js/api.js').then(async ({ loadPoster }) => setSrc(await loadPoster(pic, siteKey)))
  }, [pic, siteKey])
  if (src) return <img src={src} alt="" />
  return <div className="tb-card-fallback">{(name || '·').slice(0, 1)}</div>
}
