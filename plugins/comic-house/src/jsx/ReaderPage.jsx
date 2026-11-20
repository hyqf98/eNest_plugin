import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, loadImage, saveHistoryEntry, saveProgress, loadSettings } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { ReaderImage } from './widgets.jsx'

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const EDGE_PX = 36            // 鼠标贴边判定宽度
const AUTO_HIDE_MS = 1600     // 侧栏自动收起延时

/**
 * 沉浸式阅读器：
 * - 整个视口显示漫画，竖向滚动；Ctrl/⌘+滚轮以光标为锚缩放；双击复位
 * - 左缘悬停→章节大纲栏；右缘悬停→功能栏；离开自动收起；可 pin 常驻
 * - Esc 退出；←/→ 切章；+/- 缩放
 */
export function ReaderPage({ params, onExit, kit }) {
  const { sourceKey, comicId } = params
  const info = params.info ?? null
  const chapters = useMemo(() => info?.chapters ?? [], [info])

  const [epId, setEpId] = useState(params.epId)
  const [images, setImages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scale, setScale] = useState(1)
  const [pageNo, setPageNo] = useState(1)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [outlinePinned, setOutlinePinned] = useState(false)
  const [toolsPinned, setToolsPinned] = useState(false)
  const [chapterCached, setChapterCached] = useState(false)
  const [chapterCaching, setChapterCaching] = useState(false)
  const [cachePct, setCachePct] = useState(0)
  const [settings, setSettings] = useState({ readerGap: 4, preloadCount: 3, autoCache: false })

  useEffect(() => { void loadSettings().then(s => setSettings(prev => ({ ...prev, ...s }))).catch(() => {}) }, [])

  const scrollRef = useRef(null)
  const hideTimers = useRef({ outline: null, tools: null })
  const scaleRef = useRef(1)
  scaleRef.current = scale

  const epIndex = chapters.findIndex(c => c.id === epId)
  const prevEp = epIndex > 0 ? chapters[epIndex - 1] : null
  const nextEp = epIndex >= 0 && epIndex < chapters.length - 1 ? chapters[epIndex + 1] : null
  const currentChapterTitle = chapters[epIndex]?.title ?? ''

  /* ---------------- 章节加载 ---------------- */
  /* ---------------- 章节加载（初始 + 重试共用） ---------------- */
  const loadChapter = useCallback(async (targetEp) => {
    setLoading(true); setError(''); setImages([])
    try {
      const result = await call('comic.chapter', [sourceKey, comicId, targetEp])
      setImages(result.images)
      setLoading(false)
      scrollRef.current?.scrollTo({ top: 0 })
    } catch (e) {
      const msg = e?.message || String(e)
      notifyError(e)
      // 保留原始错误：用户需要看到是代理、风控还是源不支持
      setError(msg)
      setLoading(false)
    }
  }, [sourceKey, comicId])

  useEffect(() => { void loadChapter(epId) }, [epId, loadChapter])

  // 加载失败 → 立即收起两侧侧栏（错误提示不应被面板遮挡）
  useEffect(() => {
    if (!error) return
    const s = dockStateRef.current
    if (!s.outlinePinned) setOutlineOpen(false)
    if (!s.toolsPinned) setToolsOpen(false)
  }, [error])

  // 加载完成 → 1s 后若鼠标不贴边且未 pin，收起两侧（加载中不维持展开）
  useEffect(() => {
    if (loading) return
    const t = setTimeout(() => {
      const s = dockStateRef.current
      if (!s.outlinePinned) setOutlineOpen(false)
      if (!s.toolsPinned) setToolsOpen(false)
    }, 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  // 设置开启「自动缓存」时，阅读的章节后台静默离线
  useEffect(() => {
    if (!settings.autoCache || loading || error || !images.length) return
    void call('cache.status', [sourceKey, comicId]).then(s => {
      if (!s?.chapters?.includes(epId)) {
        return call('cache.chapter', [sourceKey, comicId, epId], { timeoutMs: 1_800_000 })
      }
    }).catch(() => { /* 静默 */ })
  }, [settings.autoCache, loading, error, images.length, sourceKey, comicId, epId])

  /* ---------------- 历史与进度 ---------------- */
  const recordHistory = useCallback(async (page) => {
    const chapter = chapters.find(c => c.id === epId)
    try {
      await saveHistoryEntry({
        sourceKey, comicId,
        title: info?.title || comicId,
        cover: '',
        sourceName: '',
        lastEpId: epId,
        lastEpTitle: chapter?.title ?? epId,
        lastPage: page,
      })
      await saveProgress(sourceKey, comicId, { epId, page })
    } catch { /* best effort */ }
  }, [sourceKey, comicId, epId, chapters, info?.title])

  // 滚动位置 → 页码；防抖写历史
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !images.length) return
    let timer = null
    const onScroll = () => {
      const pages = el.querySelectorAll('.ch-reader-page')
      let current = 1
      const viewportMid = el.scrollTop + el.clientHeight * 0.4
      pages.forEach(p => { if (p.offsetTop <= viewportMid) current = Number(p.dataset.index) + 1 })
      setPageNo(current)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void recordHistory(current), 1200)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); if (timer) clearTimeout(timer) }
  }, [images, recordHistory])

  /* ---------------- 缩放：Ctrl/⌘+滚轮以光标为锚 ---------------- */
  const zoomAt = useCallback((clientX, clientY, factor) => {
    const el = scrollRef.current
    if (!el) return
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(scaleRef.current * factor).toFixed(3)))
    if (next === scaleRef.current) return
    const rect = el.getBoundingClientRect()
    const offsetX = clientX - rect.left + el.scrollLeft
    const offsetY = clientY - rect.top + el.scrollTop
    const ratio = next / scaleRef.current
    setScale(next)
    requestAnimationFrame(() => {
      el.scrollLeft = offsetX * ratio - (clientX - rect.left)
      el.scrollTop = offsetY * ratio - (clientY - rect.top)
    })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const setScaleTop = (value) => {
    const el = scrollRef.current
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
    if (!el) { setScale(next); return }
    const rect = el.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + el.clientHeight * 0.3, next / scaleRef.current)
  }

  /* ---------------- 侧栏贴边展开 / 离开自动收起 ---------------- */
  const showOutline = useCallback(() => {
    if (hideTimers.current.outline) { clearTimeout(hideTimers.current.outline); hideTimers.current.outline = null }
    setOutlineOpen(true)
  }, [])
  const showTools = useCallback(() => {
    if (hideTimers.current.tools) { clearTimeout(hideTimers.current.tools); hideTimers.current.tools = null }
    setToolsOpen(true)
  }, [])
  const scheduleHide = (which) => {
    if (which === 'outline' ? outlinePinned : toolsPinned) return
    if (hideTimers.current[which]) clearTimeout(hideTimers.current[which])
    hideTimers.current[which] = setTimeout(() => {
      if (which === 'outline') setOutlineOpen(false); else setToolsOpen(false)
    }, AUTO_HIDE_MS)
  }

  // 最新 open/pinned 状态经 ref 读取，监听器只绑定一次（避免每次渲染重绑导致的计时器竞态）
  const dockStateRef = useRef({ outlineOpen: false, toolsOpen: false, outlinePinned: false, toolsPinned: false })
  dockStateRef.current = { outlineOpen, toolsOpen, outlinePinned, toolsPinned }
  useEffect(() => {
    const onMouseMove = (e) => {
      const w = window.innerWidth
      const s = dockStateRef.current
      if (e.clientX <= EDGE_PX) showOutline(); else if (s.outlineOpen && !s.outlinePinned) scheduleHide('outline')
      if (e.clientX >= w - EDGE_PX) showTools(); else if (s.toolsOpen && !s.toolsPinned) scheduleHide('tools')
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      for (const t of Object.values(hideTimers.current)) if (t) clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // pin 切换时重置计时
  useEffect(() => {
    if (outlinePinned) showOutline()
    else if (outlineOpen) scheduleHide('outline')
  }, [outlinePinned])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (toolsPinned) showTools()
    else if (toolsOpen) scheduleHide('tools')
  }, [toolsPinned])  // eslint-disable-line react-hooks/exhaustive-deps

  // 进入阅读器时侧栏闪现一次，提示左右有浮动面板（收起时读实时 pin 状态）
  useEffect(() => {
    showOutline()
    showTools()
    const t1 = setTimeout(() => { if (!dockStateRef.current.outlinePinned) setOutlineOpen(false) }, 1600)
    const t2 = setTimeout(() => { if (!dockStateRef.current.toolsPinned) setToolsOpen(false) }, 1600)
    return () => { clearTimeout(t1); clearTimeout(t2) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------------- 键盘 ---------------- */
  const goEp = useCallback((target) => {
    if (target) { setEpId(target.id); setPageNo(1) }
  }, [])
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { void recordHistory(pageNo); onExit() }
      else if (e.key === 'ArrowLeft') goEp(prevEp)
      else if (e.key === 'ArrowRight') goEp(nextEp)
      else if (e.key === '+' || e.key === '=') setScaleTop(scaleRef.current * 1.15)
      else if (e.key === '-') setScaleTop(scaleRef.current / 1.15)
      else if (e.key === '0') setScaleTop(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ---------------- 预加载（向后 N 页，设置可调） ---------------- */
  useEffect(() => {
    const count = Math.max(1, Number(settings.preloadCount ?? 3))
    for (let i = 0; i < Math.min(count, images.length); i++) {
      void loadImage(sourceKey, images[i], comicId, epId).catch(() => {})
    }
  }, [images, sourceKey, comicId, epId, settings.preloadCount])

  /* ---------------- 缓存本章（阅读中一键离线） ---------------- */
  useEffect(() => {
    // 章节切换时查缓存态
    setChapterCached(false); setChapterCaching(false); setCachePct(0)
    void call('cache.status', [sourceKey, comicId]).then(
      s => { if (s?.chapters?.includes(epId)) setChapterCached(true) },
      () => {}
    )
  }, [sourceKey, comicId, epId])

  useEffect(() => {
    const enest = window.enest || window.zapi
    const onEvent = ({ event, data }) => {
      if (event !== 'cache.progress' || data?.sourceKey !== sourceKey || data?.comicId !== comicId) return
      if (data.phase === 'image' && data.epId === epId) {
        setChapterCaching(true)
        setCachePct(Math.round((data.doneImages / Math.max(1, data.totalImages)) * 100))
      } else if (data.phase === 'chapter' && data.epId === epId) {
        setChapterCaching(false)
        setChapterCached(true)
      }
    }
    enest?.on?.('backend.event', onEvent)
    return () => enest?.off?.('backend.event', onEvent)
  }, [sourceKey, comicId, epId])

  const cacheThisChapter = useCallback(async () => {
    setChapterCaching(true); setCachePct(0)
    try {
      await call('cache.chapter', [sourceKey, comicId, epId], { timeoutMs: 1_800_000 })
      setChapterCached(true)
    } catch { /* 失败恢复按钮态 */ }
    finally { setChapterCaching(false) }
  }, [sourceKey, comicId, epId])

  return (
    <div className="ch-reader" style={{ '--reader-scale': scale, '--reader-gap': `${settings.readerGap ?? 4}px` }}>
      {/* 阅读视口：整个插件区域 */}
      <div className="ch-reader-scroll" ref={scrollRef} onDoubleClick={() => setScaleTop(1)}>
        {loading && <div className="ch-reader-loading"><span className="ch-reader-spin" /> 正在加载章节…</div>}
        {error && (
          <div className="ch-reader-error">
            <p>章节加载失败</p>
            <p className="ch-reader-error-detail">{error}</p>
            <button className="pk-btn" onClick={() => void loadChapter(epId)}>重试</button>
          </div>
        )}
        {!loading && !error && (
          <div className="ch-reader-strip" style={{ width: `${Math.round(scale * 100)}%`, minWidth: '100%' }}>
            {images.map((url, i) => (
              <ReaderImage
                key={`${epId}:${i}:${url}`}
                sourceKey={sourceKey}
                comicId={comicId}
                epId={epId}
                url={url}
                index={i}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部居中页码指示（章节 + 页码） */}
      <div className="ch-reader-pageno" aria-live="polite">
        {loading ? '…' : (
          <>
            <span className="ch-reader-pageno-ep">{currentChapterTitle}</span>
            <span className="ch-reader-pageno-sep" aria-hidden>·</span>
            <span className="pk-mono">{pageNo} / {images.length || '…'}</span>
          </>
        )}
      </div>

      {/* 左：章节大纲浮动栏 */}
      <aside
        className={`ch-dock ch-dock-left ${outlineOpen ? 'is-open' : ''} ${outlinePinned ? 'is-pinned' : ''}`}
        onMouseEnter={() => showOutline()}
        onMouseLeave={() => scheduleHide('outline')}
        aria-label="章节大纲"
      >
        <div className="ch-dock-head">
          <span>{info?.title || '章节'}</span>
          <button
            className={`ch-pin ${outlinePinned ? 'pk-active' : ''}`}
            onClick={() => setOutlinePinned(v => !v)}
            title={outlinePinned ? '取消固定' : '固定侧栏'}
            aria-pressed={outlinePinned}
          >
            {outlinePinned ? '📌' : '📍'}
          </button>
        </div>
        <ol className="ch-dock-list">
          {[...chapters].reverse().map(ch => (
            <li key={ch.id}>
              <button
                className={ch.id === epId ? 'ch-dock-item pk-active' : 'ch-dock-item'}
                onClick={() => goEp(ch)}
              >
                {ch.title}
              </button>
            </li>
          ))}
        </ol>
      </aside>

      {/* 右：功能浮动栏 */}
      <aside
        className={`ch-dock ch-dock-right ${toolsOpen ? 'is-open' : ''} ${toolsPinned ? 'is-pinned' : ''}`}
        onMouseEnter={() => showTools()}
        onMouseLeave={() => scheduleHide('tools')}
        aria-label="阅读工具"
      >
        <div className="ch-dock-head">
          <span>阅读</span>
          <button
            className={`ch-pin ${toolsPinned ? 'pk-active' : ''}`}
            onClick={() => setToolsPinned(v => !v)}
            title={toolsPinned ? '取消固定' : '固定侧栏'}
            aria-pressed={toolsPinned}
          >
            {toolsPinned ? '📌' : '📍'}
          </button>
        </div>
        <div className="ch-dock-tools">
          <button className="pk-btn pk-btn-sm" onClick={() => void recordHistory(pageNo).then(onExit)}>退出阅读</button>
          <button className="pk-btn pk-btn-sm" disabled={!prevEp} onClick={() => goEp(prevEp)} title="←">上一章</button>
          <button className="pk-btn pk-btn-sm" disabled={!nextEp} onClick={() => goEp(nextEp)} title="→">下一章</button>
          <button
            className="pk-btn pk-btn-sm"
            disabled={chapterCaching || !images.length}
            onClick={() => void cacheThisChapter()}
            title="把当前章节全部图片缓存到本地，离线可读"
          >
            {chapterCaching ? `缓存中 ${cachePct}%` : chapterCached ? '✓ 已缓存' : '缓存本章'}
          </button>
          <div className="ch-zoom">
            <button className="pk-btn pk-btn-sm" onClick={() => setScaleTop(scaleRef.current / 1.15)} title="-">−</button>
            <button className="ch-zoom-value pk-mono" onClick={() => setScaleTop(1)} title="双击复位">
              {Math.round(scale * 100)}%
            </button>
            <button className="pk-btn pk-btn-sm" onClick={() => setScaleTop(scaleRef.current * 1.15)} title="+">＋</button>
          </div>
          <div className="ch-dock-meta pk-muted">
            <div>{pageNo} / {images.length || '…'} 页</div>
            {kit && null}
          </div>
        </div>
      </aside>
    </div>
  )
}
