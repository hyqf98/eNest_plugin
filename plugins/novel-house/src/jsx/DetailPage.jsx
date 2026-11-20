import { useCallback, useEffect, useState } from 'react'
import { call, loadCover, loadProgress, saveHistoryEntry, isFavorited, toggleFavorite } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { ChapterList, ErrorBox, Loading } from './widgets.jsx'

/** 详情页：封面 + 简介 + 章节 + 缓存整本 */
export function DetailPage({ sourceKey, bookId, title: hintTitle, onBack, onRead }) {
  const [info, setInfo] = useState(null)
  const [cover, setCover] = useState('')
  const [descOpen, setDescOpen] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [chapters, setChapters] = useState([])
  const [tocLoading, setTocLoading] = useState(false)
  const [tocError, setTocError] = useState('')
  const [readingCh, setReadingCh] = useState('')
  const [cacheState, setCacheState] = useState({ cachedChapters: [], busy: false, progress: null })
  const [faved, setFaved] = useState(false)

  useEffect(() => {
    void isFavorited(sourceKey, bookId).then(setFaved).catch(() => {})
  }, [sourceKey, bookId])

  const toggleFav = async () => {
    if (!info) return
    const next = await toggleFavorite({
      sourceKey, bookId,
      title: info.title,
      cover: info.cover,
      author: info.author,
    }).catch(() => null)
    if (next !== null) setFaved(next)
  }

  const reloadInfo = useCallback(async () => {
    setLoading(true); setError(''); setInfo(null); setCover(''); setDescOpen(false)
    try {
      const details = await call('book.info', [sourceKey, bookId])
      setInfo(details)
      setLoading(false)
      // 封面三级回退：coverUrl → 站内固定路径 → 详情页 og:image（后端 cover.load 内部完成）
      try {
        setCover(await loadCover(sourceKey, details?.cover || '', bookId))
      } catch { /* 封面失败不阻塞 */ }
    } catch (e) {
      notifyError(e)
      setError('详情加载失败')
      setLoading(false)
    }
  }, [sourceKey, bookId])

  useEffect(() => {
    let alive = true
    void reloadInfo()
    // 历史留痕 + 进度恢复
    void saveHistoryEntry({ sourceKey, bookId, title: hintTitle ?? '', cover: '', author: '' }).catch(() => {})
    loadProgress().then(
      all => { if (alive) setReadingCh(all[`${sourceKey}::${bookId}`]?.chId ?? '') },
      () => { /* ignore */ }
    )
    call('cache.status', [sourceKey, bookId]).then(
      s => { if (alive) setCacheState(prev => ({ ...prev, cachedChapters: s?.chapters ?? [] })) },
      () => { /* ignore */ }
    )
    return () => { alive = false }
  }, [sourceKey, bookId, reloadInfo, hintTitle])

  // 目录加载（详情就绪后）
  const loadToc = useCallback(async () => {
    if (!info?.tocUrl && !bookId) return
    setTocLoading(true); setTocError('')
    try {
      const r = await call('book.toc', [sourceKey, bookId, info?.tocUrl ?? bookId])
      setChapters(r.chapters)
      setTocLoading(false)
    } catch (e) {
      notifyError(e)
      setTocError('目录加载失败')
      setTocLoading(false)
    }
  }, [sourceKey, bookId, info?.tocUrl])

  useEffect(() => {
    if (info) void loadToc()
  }, [info, loadToc])

  // 缓存进度事件（cache.book / cache.chapter 推送）
  useEffect(() => {
    const enest = window.enest || window.zapi
    const onEvent = ({ event, data }) => {
      if (event !== 'cache.progress') return
      if (data?.sourceKey !== sourceKey || data?.bookId !== bookId) return
      setCacheState(prev => ({ ...prev, busy: data.phase !== 'done', progress: data }))
      if (data.phase === 'done') {
        void call('cache.status', [sourceKey, bookId]).then(
          s => setCacheState(prev => ({ ...prev, cachedChapters: s?.chapters ?? [], busy: false })),
          () => {}
        )
      }
    }
    enest?.on?.('backend.event', onEvent)
    return () => enest?.off?.('backend.event', onEvent)
  }, [sourceKey, bookId])

  const read = async (chId, chTitle) => {
    if (!info) return
    await saveHistoryEntry({
      sourceKey, bookId,
      title: info.title,
      cover: info.cover,
      author: info.author,
      lastChId: chId,
      lastChTitle: chTitle,
    })
    onRead(chId, chTitle, { ...info, chapters })
  }

  const cacheBook = async () => {
    setCacheState(prev => ({ ...prev, busy: true, progress: { phase: 'start' } }))
    try {
      await call('cache.book', [sourceKey, bookId, info?.title, info?.author, info?.cover, info?.tocUrl ?? bookId], { timeoutMs: 3_600_000 })
    } catch (e) {
      setCacheState(prev => ({ ...prev, busy: false, progress: null }))
      notifyError(e)
    }
  }

  const progressText = cacheState.progress
    ? cacheState.progress.phase === 'done'
      ? `已缓存 ${cacheState.progress.doneChapters}/${cacheState.progress.totalChapters} 章`
      : cacheState.progress.phase === 'chapter'
        ? `缓存中 ${cacheState.progress.doneChapters}/${cacheState.progress.totalChapters} 章${cacheState.progress.failedChapters ? `（${cacheState.progress.failedChapters} 失败）` : ''}`
        : '准备缓存…'
    : ''

  return (
    <div className="nh-detail">
      <div className="nh-detail-bar">
        <button className="pk-btn pk-btn-sm" onClick={onBack}>← 返回</button>
        <span className="nh-detail-title">{loading ? '加载中…' : info?.title || hintTitle || ''}</span>
      </div>
      {loading && <Loading label="加载详情中…" />}
      {error && <ErrorBox message={error} onRetry={() => void reloadInfo()} />}
      {!loading && !error && info && (
        <div className="nh-detail-body">
          <div className="nh-detail-hero">
            <div className="nh-detail-cover">
              {cover ? <img src={cover} alt="" /> : <span className="nh-card-fallback" aria-hidden>{(info.title || '书')[0]}</span>}
            </div>
            <div className="nh-detail-meta">
              <h2>{info.title}</h2>
              {info.author && <p className="pk-muted">{info.author}</p>}
              {info.kind && <p className="pk-muted">{info.kind}</p>}
              {info.lastChapter && <p className="pk-muted">最新：{info.lastChapter}</p>}
              {info.intro && (
                <p className={`nh-detail-desc${descOpen ? ' is-open' : ''}`}>{info.intro}</p>
              )}
              {info.intro && info.intro.length > 80 && (
                <button className="nh-desc-toggle" onClick={() => setDescOpen(v => !v)}>
                  {descOpen ? '收起' : '展开全部'}
                </button>
              )}
              <div className="nh-detail-actions">
                <button
                  className={`pk-btn pk-btn-sm ${faved ? 'nh-fav-on' : ''}`}
                  onClick={() => void toggleFav()}
                  title={faved ? '取消收藏' : '收藏到「我的」'}
                >
                  {faved ? '♥ 已收藏' : '♡ 收藏'}
                </button>
                {chapters.length > 0 && (
                  <button className="pk-btn pk-btn-sm" onClick={() => void read(readingCh || chapters[0].id, (chapters.find(c => c.id === readingCh) ?? chapters[0]).title)}>
                    {readingCh ? '继续阅读' : '开始阅读'}
                  </button>
                )}
                <button className="pk-btn pk-btn-sm" disabled={cacheState.busy || !chapters.length} onClick={() => void cacheBook()}>
                  {cacheState.busy ? '缓存中…' : cacheState.cachedChapters.length ? `补缓存（已 ${cacheState.cachedChapters.length} 章）` : '缓存整本'}
                </button>
                {cacheState.cachedChapters.length > 0 && !cacheState.busy && (
                  <button
                    className="pk-btn pk-btn-sm nh-danger"
                    onClick={() => void call('cache.remove', [sourceKey, bookId]).then(() => setCacheState(prev => ({ ...prev, cachedChapters: [] })))}
                  >删除缓存</button>
                )}
              </div>
              {progressText && <p className="pk-muted nh-cache-progress">{progressText}</p>}
            </div>
          </div>
          {tocLoading && <Loading label="加载目录中…" />}
          {tocError && <ErrorBox message={tocError} onRetry={() => void loadToc()} />}
          {!tocLoading && !tocError && (
            chapters.length > 0
              ? (
                <ChapterList
                  chapters={chapters}
                  onRead={(id, title) => void read(id, title)}
                  readingCh={readingCh}
                  cachedChapters={cacheState.cachedChapters}
                />
              )
              : <div className="nh-empty">该书没有章节信息</div>
          )}
        </div>
      )}
    </div>
  )
}
