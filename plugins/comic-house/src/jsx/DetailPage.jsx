import { useCallback, useEffect, useState } from 'react'
import { call, loadImage, loadProgress, saveHistoryEntry, isFavorited, toggleFavorite } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { ChapterList, ErrorBox, Loading } from './widgets.jsx'

/** 详情页：封面 + 简介 + 标签 + 章节列表 + 缓存整部 */
export function DetailPage({ sourceKey, comicId, onBack, onRead }) {
  const [info, setInfo] = useState(null)
  const [cover, setCover] = useState('')
  const [coverBig, setCoverBig] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [readingEp, setReadingEp] = useState('')
  const [cacheState, setCacheState] = useState({ cachedChapters: [], busy: false, progress: null })
  const [faved, setFaved] = useState(false)

  useEffect(() => {
    void isFavorited(sourceKey, comicId).then(setFaved).catch(() => {})
  }, [sourceKey, comicId])

  const toggleFav = async () => {
    if (!info) return
    const next = await toggleFavorite({
      sourceKey, comicId,
      title: info.title,
      cover,
      sourceName: '',
    }).catch(() => null)
    if (next !== null) setFaved(next)
  }

  const reloadInfo = useCallback(async () => {
    setLoading(true); setError(''); setInfo(null); setCover(''); setDescOpen(false)
    try {
      const details = await call('comic.info', [sourceKey, comicId])
      setInfo(details)
      setLoading(false)
      if (details?.cover) {
        try { setCover(await loadImage(sourceKey, details.cover, comicId)) } catch { /* 封面失败不阻塞 */ }
      }
    } catch (e) {
      notifyError(e)
      setError('详情加载失败')
      setLoading(false)
    }
  }, [sourceKey, comicId])

  useEffect(() => {
    let alive = true
    void reloadInfo()
    // 历史留痕 + 进度恢复
    void saveHistoryEntry({
      sourceKey,
      comicId,
      title: '',
      cover: '',
      sourceName: '',
    }).catch(() => {})
    loadProgress().then(
      all => { if (alive) setReadingEp(all[`${sourceKey}::${comicId}`]?.epId ?? '') },
      () => { /* ignore */ }
    )
    call('cache.status', [sourceKey, comicId]).then(
      s => { if (alive) setCacheState(prev => ({ ...prev, cachedChapters: s?.chapters ?? [] })) },
      () => { /* ignore */ }
    )
    return () => { alive = false }
  }, [sourceKey, comicId, reloadInfo])

  // 缓存进度事件（cache.comic / cache.chapter 推送）
  useEffect(() => {
    const enest = window.enest || window.zapi
    const onEvent = ({ event, data }) => {
      if (event !== 'cache.progress') return
      if (data?.sourceKey !== sourceKey || data?.comicId !== comicId) return
      setCacheState(prev => ({ ...prev, busy: data.phase !== 'done', progress: data }))
      if (data.phase === 'done') {
        void call('cache.status', [sourceKey, comicId]).then(
          s => setCacheState(prev => ({ ...prev, cachedChapters: s?.chapters ?? [], busy: false })),
          () => {}
        )
      }
    }
    enest?.on?.('backend.event', onEvent)
    return () => enest?.off?.('backend.event', onEvent)
  }, [sourceKey, comicId])

  const read = async (epId) => {
    if (!info) return
    const chapter = info.chapters.find(c => c.id === epId)
    await saveHistoryEntry({
      sourceKey,
      comicId,
      title: info.title,
      cover,
      sourceName: '',
      lastEpId: epId,
      lastEpTitle: chapter?.title ?? epId,
    })
    onRead(epId, info)
  }

  const cacheComic = async () => {
    setCacheState(prev => ({ ...prev, busy: true, progress: { phase: 'start' } }))
    try {
      await call('cache.comic', [sourceKey, comicId], { timeoutMs: 3_600_000 })
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
        : cacheState.progress.phase === 'image'
          ? `下载图片 ${cacheState.progress.doneImages}/${cacheState.progress.totalImages}`
          : '准备缓存…'
    : ''

  return (
    <div className="ch-detail">
      <div className="ch-detail-bar">
        <button className="pk-btn pk-btn-sm" onClick={onBack}>← 返回</button>
        <span className="ch-detail-title">{loading ? '' : info?.title || ''}</span>
      </div>
      {loading && <Loading label="加载详情中…" />}
      {error && <ErrorBox message={error} onRetry={() => void reloadInfo()} />}
      {!loading && !error && info && (
        <div className="ch-detail-body">
          <div className="ch-detail-hero">
            <button className="ch-detail-cover" onClick={() => setCoverBig(true)} title="查看大图">
              {cover ? <img src={cover} alt="" /> : <span className="ch-card-fallback" aria-hidden>漫</span>}
            </button>
            <div className="ch-detail-meta">
              <h2>{info.title}</h2>
              {info.subtitle && <p className="pk-muted">{info.subtitle}</p>}
              {info.updateTime && <p className="pk-muted">更新：{info.updateTime}</p>}
              {info.tags.length > 0 && (
                <div className="ch-tags">
                  {info.tags.slice(0, 12).map(t => (
                    <span className="pk-badge" key={`${t.namespace}:${t.tag}`}>
                      {t.namespace ? `${t.namespace}:` : ''}{t.tag}
                    </span>
                  ))}
                </div>
              )}
              {info.description && (
                <p className={`ch-detail-desc${descOpen ? ' is-open' : ''}`}>{info.description}</p>
              )}
              {info.description && info.description.length > 80 && (
                <button className="ch-desc-toggle" onClick={() => setDescOpen(v => !v)}>
                  {descOpen ? '收起' : '展开全部'}
                </button>
              )}
              <div className="ch-detail-actions">
                <button
                  className={`pk-btn pk-btn-sm ${faved ? 'ch-fav-on' : ''}`}
                  onClick={() => void toggleFav()}
                  title={faved ? '取消收藏' : '收藏到「我的」'}
                >
                  {faved ? '♥ 已收藏' : '♡ 收藏'}
                </button>
                {info.chapters.length > 0 && (
                  <button className="pk-btn pk-btn-sm" onClick={() => void read(readingEp || info.chapters[0].id)}>
                    {readingEp ? '继续阅读' : '开始阅读'}
                  </button>
                )}
                <button className="pk-btn pk-btn-sm" disabled={cacheState.busy || !info.chapters.length} onClick={() => void cacheComic()}>
                  {cacheState.busy ? '缓存中…' : cacheState.cachedChapters.length ? `补缓存（已 ${cacheState.cachedChapters.length} 章）` : '缓存整部'}
                </button>
                {cacheState.cachedChapters.length > 0 && !cacheState.busy && (
                  <button
                    className="pk-btn pk-btn-sm ch-danger"
                    onClick={() => void call('cache.remove', [sourceKey, comicId]).then(() => setCacheState(prev => ({ ...prev, cachedChapters: [] })))}
                  >删除缓存</button>
                )}
              </div>
              {progressText && <p className="pk-muted ch-cache-progress">{progressText}</p>}
            </div>
          </div>
          {info.chapters.length > 0
            ? (
              <ChapterList
                chapters={info.chapters}
                onRead={id => void read(id)}
                readingEp={readingEp}
                cachedChapters={cacheState.cachedChapters}
              />
            )
            : <div className="ch-empty">该漫画没有章节信息</div>}
        </div>
      )}
      {/* 封面大图查看器 */}
      {coverBig && cover && (
        <div className="ch-cover-viewer" onClick={() => setCoverBig(false)} role="dialog" aria-label="封面大图">
          <img src={cover} alt="" />
          <span className="ch-cover-hint pk-muted">点击任意处关闭</span>
        </div>
      )}
    </div>
  )
}
