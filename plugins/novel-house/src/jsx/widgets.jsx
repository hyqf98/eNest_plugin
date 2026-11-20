import { useEffect, useState } from 'react'
import { loadCover, isFavorited, toggleFavorite } from '../js/api.js'

/** 书籍封面（三级回退：列表 coverUrl → 笔趣阁固定路径（后端按 bookId 推导）→ 详情页 og:image） */
export function CoverImage({ book, glyph = '书' }) {
  const [cover, setCover] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setCover(''); setFailed(false)
    if (!book?.cover && !book?.bookId && !book?.id) { setFailed(true); return }
    loadCover(book.sourceKey, book.cover || '', book.bookId ?? book.id ?? '').then(
      url => { if (alive) setCover(url) },
      () => { if (alive) setFailed(true) }
    )
    return () => { alive = false }
  }, [book?.sourceKey, book?.cover, book?.bookId, book?.id])
  if (cover) return <img src={cover} alt="" loading="lazy" draggable={false} />
  if (failed) return <span className="nh-card-fallback" aria-hidden>{book?.title?.[0] || glyph}</span>
  return <span className="nh-card-loading" aria-hidden />
}

/** 卡片右下角爱心收藏角标（独立小按钮，不触发卡片打开） */
export function FavToggle({ book, size = 'md' }) {
  const [faved, setFaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void isFavorited(book.sourceKey, book.bookId ?? book.id).then(v => { if (alive) setFaved(v) }).catch(() => {})
    return () => { alive = false }
  }, [book.sourceKey, book.bookId, book.id])
  const toggle = async (e) => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const next = await toggleFavorite({
        sourceKey: book.sourceKey,
        bookId: book.bookId ?? book.id,
        title: book.title,
        cover: book.cover || '',
        author: book.author || '',
      })
      setFaved(next)
    } catch { /* ignore */ }
    finally { setBusy(false) }
  }
  return (
    <button
      className={`nh-fav-toggle${faved ? ' is-on' : ''}${size === 'sm' ? ' nh-fav-sm' : ''}`}
      onClick={toggle}
      title={faved ? '取消收藏' : '收藏'}
      aria-label={faved ? `取消收藏 ${book.title}` : `收藏 ${book.title}`}
      aria-pressed={faved}
    >
      {faved ? '♥' : '♡'}
    </button>
  )
}

/** 书籍卡片（封面 + 书名 + 作者） */
export function BookCard({ book, onOpen }) {
  return (
    <div className="nh-card-wrap">
      <button className="nh-card" onClick={() => onOpen(book)} title={book.title}>
        <div className="nh-card-cover">
          <CoverImage book={book} />
        </div>        <div className="nh-card-info">
          <div className="nh-card-title">{book.title}</div>
          {book.author ? <div className="nh-card-sub">{book.author}</div>
            : book.lastChapter ? <div className="nh-card-sub">{book.lastChapter}</div> : null}
        </div>
      </button>
      <FavToggle book={book} />
    </div>
  )
}

/** 响应式书籍卡片墙 */
export function BookGrid({ books, onOpen, empty }) {
  if (!books?.length) return <div className="nh-empty">{empty ?? '暂无内容'}</div>
  return (
    <div className="nh-grid">
      {books.map(b => (
        <BookCard key={`${b.sourceKey}:${b.id}`} book={b} onOpen={onOpen} />
      ))}
    </div>
  )
}

/** 源选择器（下拉，嵌在浏览页顶行右侧） */
export function SourcePicker({ sources, value, onChange }) {
  const enabled = sources.filter(s => s.enabled)
  if (!enabled.length) return null
  return (
    <select
      className="pk-select-native"
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label="切换书源"
      title="切换书源"
    >
      {enabled.map(s => (
        <option key={s.key} value={s.key}>
          {s.name}{s.group ? `（${s.group}）` : ''}
        </option>
      ))}
    </select>
  )
}

/** 居中加载态（与漫画屋同款：圆角徽标底 + 圆环 + 文案） */
export function Loading({ label = '加载中…' }) {
  return (
    <div className="nh-loading" role="status" aria-live="polite">
      <span className="nh-loading-badge" aria-hidden>
        <span className="nh-loading-ring" />
      </span>
      <span className="nh-loading-text">{label}</span>
    </div>
  )
}

/** 骨架屏（卡片墙占位） */
export function GridSkeleton({ count = 12 }) {
  return (
    <div className="nh-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="nh-card nh-card-skeleton" key={i}>
          <div className="nh-card-cover" />
        </div>
      ))}
    </div>
  )
}

/** 加载更多 */
export function LoadMore({ hasMore, loading, onLoad, hint }) {
  if (!hasMore) return null
  return (
    <div className="nh-loadmore">
      <button className="pk-btn pk-btn-sm" onClick={onLoad} disabled={loading}>
        {loading ? '加载中…' : hint ?? '加载更多'}
      </button>
    </div>
  )
}

/** 错误面板（带重试） */
export function ErrorBox({ message, onRetry }) {
  return (
    <div className="nh-error pk-empty" role="alert">
      <span className="nh-error-text">{message}</span>
      {onRetry && <button className="pk-btn pk-btn-sm" onClick={onRetry}>重试</button>}
    </div>
  )
}

/** 章节列表（详情页用，倒序可切换；cachedChapters 标记离线章节） */
export function ChapterList({ chapters, onRead, readingCh, cachedChapters }) {
  const [desc, setDesc] = useState(true)
  const list = desc ? [...chapters].reverse() : chapters
  const cachedSet = new Set(cachedChapters ?? [])
  return (
    <div className="nh-chapters">
      <div className="nh-chapters-head">
        <span className="pk-muted">章节 · {chapters.length}{cachedSet.size ? `（${cachedSet.size} 章已缓存）` : ''}</span>
        <button className="pk-btn pk-btn-sm" onClick={() => setDesc(d => !d)}>
          {desc ? '倒序 ↓' : '正序 ↑'}
        </button>
      </div>
      <ol className="nh-chapter-list">
        {list.map(ch => (
          <li key={ch.id}>
            <button
              className={ch.id === readingCh ? 'nh-chapter pk-active' : 'nh-chapter'}
              onClick={() => onRead(ch.id, ch.title)}
            >
              {cachedSet.has(ch.id) && <span className="nh-cached-dot" title="已缓存" aria-label="已缓存">⬇</span>}
              {ch.title}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
