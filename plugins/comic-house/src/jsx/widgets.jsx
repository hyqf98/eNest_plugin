import { useEffect, useRef, useState } from 'react'
import { loadImage, isFavorited, toggleFavorite } from '../js/api.js'

/** 漫画封面图（经后端代理转 dataUrl；热门区/卡片复用） */
export function CoverImage({ comic }) {
  const [cover, setCover] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setCover(''); setFailed(false)
    if (!comic?.cover) { setFailed(true); return }
    loadImage(comic.sourceKey, comic.cover).then(
      url => { if (alive) setCover(url) },
      () => { if (alive) setFailed(true) }
    )
    return () => { alive = false }
  }, [comic?.sourceKey, comic?.cover])
  if (cover) return <img src={cover} alt="" loading="lazy" draggable={false} />
  if (failed) return <span className="ch-card-fallback" aria-hidden>漫</span>
  return <span className="ch-card-loading" aria-hidden />
}

/** 卡片右下角爱心收藏角标（独立小按钮，不触发卡片打开；持久化记录 sourceKey 便于迁移） */
export function FavToggle({ comic, size = 'md' }) {
  const [faved, setFaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void isFavorited(comic.sourceKey, comic.id).then(v => { if (alive) setFaved(v) }).catch(() => {})
    return () => { alive = false }
  }, [comic.sourceKey, comic.id])
  const toggle = async (e) => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const next = await toggleFavorite({
        sourceKey: comic.sourceKey,
        comicId: comic.id,
        title: comic.title,
        cover: '',
        sourceName: comic.sourceName || '',
      })
      setFaved(next)
    } catch { /* ignore */ }
    finally { setBusy(false) }
  }
  return (
    <button
      className={`ch-fav-toggle${faved ? ' is-on' : ''}${size === 'sm' ? ' ch-fav-sm' : ''}`}
      onClick={toggle}
      title={faved ? '取消收藏' : '收藏'}
      aria-label={faved ? `取消收藏 ${comic.title}` : `收藏 ${comic.title}`}
      aria-pressed={faved}
    >
      {faved ? '♥' : '♡'}
    </button>
  )
}

/** 漫画卡片（封面经后端代理转 dataUrl；右下角爱心收藏） */
export function ComicCard({ comic, onOpen }) {
  const [cover, setCover] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setCover(''); setFailed(false)
    if (!comic.cover) { setFailed(true); return }
    loadImage(comic.sourceKey, comic.cover).then(
      url => { if (alive) setCover(url) },
      () => { if (alive) setFailed(true) }
    )
    return () => { alive = false }
  }, [comic.sourceKey, comic.cover])

  return (
    <div className="ch-card-wrap">
      <button className="ch-card" onClick={() => onOpen(comic)} title={comic.title}>
        <div className="ch-card-cover">
          {cover
            ? <img src={cover} alt="" loading="lazy" draggable={false} />
            : failed
              ? <span className="ch-card-fallback" aria-hidden>漫</span>
              : <span className="ch-card-loading" aria-hidden />}
        </div>
        <div className="ch-card-info">
          <div className="ch-card-title">{comic.title}</div>
          {comic.subtitle && <div className="ch-card-sub">{comic.subtitle}</div>}
        </div>
      </button>
      <FavToggle comic={comic} />
    </div>
  )
}

/** 响应式漫画卡片墙 */
export function ComicGrid({ comics, onOpen, empty }) {
  if (!comics.length) return <div className="ch-empty">{empty ?? '暂无内容'}</div>
  return (
    <div className="ch-grid">
      {comics.map(c => (
        <ComicCard key={`${c.sourceKey}:${c.id}`} comic={c} onOpen={onOpen} />
      ))}
    </div>
  )
}

/** 探索页多分区（multiPartPage） */
export function ComicParts({ parts, onOpen }) {
  return (
    <div className="ch-parts">
      {parts.map((part, i) => (
        part.comics.length ? (
          <section className="ch-part" key={part.title || i}>
            <h3 className="ch-part-title">{part.title}</h3>
            <ComicGrid comics={part.comics} onOpen={onOpen} />
          </section>
        ) : null
      ))}
    </div>
  )
}

/** 源选择器（下拉，无标签，嵌在浏览页顶行右侧） */
export function SourcePicker({ sources, value, onChange }) {
  const enabled = sources.filter(s => s.enabled)
  if (!enabled.length) return null
  // 注意：不要加 pk-select-native 类 —— 该类被 kit 用于标记「已升级」并 display:none 隐藏，
  // 而 React 异步渲染的 select 不会被 kit 的初始 upgradeSelects 扫描到，会导致彻底不可见。
  // 用 ref + 主动升级保证 kit 接管。
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    // kit 提供 upgradeSelects(scope)；没有则保持原生 select 可用（CSS 已给原生外观）
    try { window.PluginKit?.upgradeSelects?.(ref.current.parentElement ?? document) } catch { /* 原生兜底 */ }
  }, [enabled.length])
  return (
    <select
      ref={ref}
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label="切换数据源"
      title="切换数据源"
    >
      {enabled.map(s => (
        <option key={s.key} value={s.key}>
          {s.name}{s.adult ? ' ·成人' : ''}
        </option>
      ))}
    </select>
  )
}

/** 全局加载态：圆角图标块内旋转圆环 + 下方文字，与空态（ch-onboard）同一视觉语言 */
export function Loading({ label = '加载中…' }) {
  return (
    <div className="ch-loading" role="status" aria-live="polite">
      <span className="ch-loading-badge" aria-hidden>
        <span className="ch-loading-ring" />
      </span>
      <span className="ch-loading-text">{label}</span>
    </div>
  )
}

/** 骨架屏（卡片墙占位） */
export function GridSkeleton({ count = 12 }) {
  return (
    <div className="ch-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="ch-card ch-card-skeleton" key={i}>
          <div className="ch-card-cover" />
        </div>
      ))}
    </div>
  )
}

/** 加载更多 / 分页 */
export function LoadMore({ hasMore, loading, onLoad, hint }) {
  if (!hasMore) return null
  return (
    <div className="ch-loadmore">
      <button className="pk-btn pk-btn-sm" onClick={onLoad} disabled={loading}>
        {loading ? '加载中…' : hint ?? '加载更多'}
      </button>
    </div>
  )
}

/** 错误面板（带重试） */
export function ErrorBox({ message, onRetry }) {
  return (
    <div className="ch-error pk-empty" role="alert">
      <span className="ch-error-text">{message}</span>
      {onRetry && <button className="pk-btn pk-btn-sm" onClick={onRetry}>重试</button>}
    </div>
  )
}

/** 章节列表（详情页用，倒序可切换；cachedChapters 标记离线章节） */
export function ChapterList({ chapters, onRead, readingEp, cachedChapters }) {
  const [desc, setDesc] = useState(true)
  const list = desc ? [...chapters].reverse() : chapters
  const cachedSet = new Set(cachedChapters ?? [])
  return (
    <div className="ch-chapters">
      <div className="ch-chapters-head">
        <span className="pk-muted">章节 · {chapters.length}{cachedSet.size ? `（${cachedSet.size} 章已缓存）` : ''}</span>
        <button className="pk-btn pk-btn-sm" onClick={() => setDesc(d => !d)}>
          {desc ? '倒序 ↓' : '正序 ↑'}
        </button>
      </div>
      <ol className="ch-chapter-list">
        {list.map(ch => (
          <li key={ch.id}>
            <button
              className={ch.id === readingEp ? 'ch-chapter pk-active' : 'ch-chapter'}
              onClick={() => onRead(ch.id)}
            >
              {cachedSet.has(ch.id) && <span className="ch-cached-dot" title="已缓存" aria-label="已缓存">⬇</span>}
              {ch.title}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** 阅读器图片页（懒加载 + 高度占位；失败显示真实原因并可重试） */
export function ReaderImage({ sourceKey, comicId, epId, url, scale, index, onLoaded }) {
  const [src, setSrc] = useState('')
  const [state, setState] = useState('loading') // loading | ready | error
  const [reason, setReason] = useState('')
  const [attempt, setAttempt] = useState(0)
  const imgRef = useRef(null)

  useEffect(() => {
    let alive = true
    setSrc(''); setState('loading'); setReason('')
    loadImage(sourceKey, url, comicId, epId).then(
      dataUrl => { if (alive) setSrc(dataUrl) },
      (e) => { if (alive) { setReason(e?.message || String(e)); setState('error') } }
    )
    return () => { alive = false }
  }, [sourceKey, url, comicId, epId, attempt])

  return (
    <div className="ch-reader-page" data-state={state} data-index={index}>
      {/* 关键：src 为空时不能渲染 img —— 浏览器对空 src 会立即触发 onError，
          导致 dataUrl 还没到达就被误判为「解码失败」 */}
      {state !== 'error' && src && (
        <img
          ref={imgRef}
          src={src}
          alt={`第 ${index + 1} 页`}
          draggable={false}
          onLoad={() => { setState('ready'); onLoaded?.(index) }}
          onError={() => { setReason('图片数据解码失败'); setState('error') }}
          width={undefined}
        />
      )}
      {state === 'loading' && <span className="ch-reader-spin" aria-label="加载中" />}
      {state === 'error' && (
        <span className="ch-reader-page-error">
          <span>第 {index + 1} 页加载失败</span>
          {reason && <span className="ch-reader-page-reason">{reason.slice(0, 160)}</span>}
          <button type="button" className="pk-btn pk-btn-sm" onClick={() => setAttempt(a => a + 1)}>重试</button>
        </span>
      )}
    </div>
  )
}
