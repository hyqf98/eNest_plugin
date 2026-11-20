import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, saveHistoryEntry, saveProgress, loadSettings } from '../js/api.js'
import { notifyError } from '../js/notify.js'

const MIN_FONT = 12
const MAX_FONT = 28
const EDGE_PX = 36            // 鼠标贴边判定宽度
const AUTO_HIDE_MS = 1600     // 侧栏自动收起延时

/**
 * 沉浸式文字阅读器：
 * - 排版：字号/行距/段距/版心宽度/底色（纸张/纯白/护眼/夜间）全部实时生效
 * - ⌘/Ctrl+滚轮调字号；Esc 退出；←/→ 切章
 * - 左缘悬停→目录大纲栏；右缘悬停→功能栏；离开自动收起；可 pin 常驻
 * - 滚动位置持久化为阅读进度
 */
export function ReaderPage({ params, onExit }) {
  const { sourceKey, bookId } = params
  const info = params.info ?? null
  const chapters = useMemo(() => info?.chapters ?? [], [info])

  const [chId, setChId] = useState(params.chId)
  const [chTitle, setChTitle] = useState(params.chTitle ?? '')
  const [paragraphs, setParagraphs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [progressPct, setProgressPct] = useState(0)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [outlinePinned, setOutlinePinned] = useState(false)
  const [toolsPinned, setToolsPinned] = useState(false)
  const [chapterCached, setChapterCached] = useState(false)
  const [chapterCaching, setChapterCaching] = useState(false)
  const [settings, setSettings] = useState({ fontSize: 17, lineHeight: 1.9, paraGap: 14, readerWidth: 720, readerTheme: 'paper', autoCache: false })

  useEffect(() => { void loadSettings().then(s => setSettings(prev => ({ ...prev, ...s }))).catch(() => {}) }, [])

  const scrollRef = useRef(null)
  const hideTimers = useRef({ outline: null, tools: null })
  const fontRef = useRef(settings.fontSize)
  fontRef.current = settings.fontSize

  const chIndex = chapters.findIndex(c => c.id === chId)
  const prevCh = chIndex > 0 ? chapters[chIndex - 1] : null
  const nextCh = chIndex >= 0 && chIndex < chapters.length - 1 ? chapters[chIndex + 1] : null
  const currentChapterTitle = chTitle || chapters[chIndex]?.title || ''

  /* ---------------- 章节加载 ---------------- */
  const loadChapter = useCallback(async (targetCh, title) => {
    setLoading(true); setError(''); setParagraphs([])
    try {
      const result = await call('book.content', [sourceKey, bookId, targetCh, title ?? ''])
      setParagraphs(result.paragraphs)
      setLoading(false)
      scrollRef.current?.scrollTo({ top: 0 })
    } catch (e) {
      notifyError(e)
      setError('章节加载失败，可点击重试')
      setLoading(false)
    }
  }, [sourceKey, bookId])

  useEffect(() => { void loadChapter(chId, chTitle) }, [chId, loadChapter])

  // 设置开启「自动缓存」时，阅读的章节后台静默离线
  useEffect(() => {
    if (!settings.autoCache || loading || error || !paragraphs.length) return
    void call('cache.status', [sourceKey, bookId]).then(s => {
      if (!s?.chapters?.includes(chId)) {
        return call('cache.chapter', [sourceKey, bookId, chId, chTitle], { timeoutMs: 1_800_000 })
      }
    }).catch(() => { /* 静默 */ })
  }, [settings.autoCache, loading, error, paragraphs.length, sourceKey, bookId, chId, chTitle])

  /* ---------------- 历史与进度 ---------------- */
  const recordProgress = useCallback(async (pct) => {
    try {
      await saveHistoryEntry({
        sourceKey, bookId,
        title: info?.title || bookId,
        cover: info?.cover || '',
        author: info?.author || '',
        lastChId: chId,
        lastChTitle: currentChapterTitle,
        lastOffset: pct,
      })
      await saveProgress(sourceKey, bookId, { chId, chTitle: currentChapterTitle, offset: pct })
    } catch { /* best effort */ }
  }, [sourceKey, bookId, chId, currentChapterTitle, info])

  // 滚动位置 → 进度百分比；防抖写历史
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !paragraphs.length) return
    let timer = null
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight
      const pct = max > 0 ? Math.min(100, Math.round(el.scrollTop / max * 100)) : 100
      setProgressPct(pct)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void recordProgress(pct), 1200)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); if (timer) clearTimeout(timer) }
  }, [paragraphs, recordProgress])

  /* ---------------- 字号：⌘/Ctrl+滚轮 ---------------- */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setSettings(prev => {
        const next = Math.min(MAX_FONT, Math.max(MIN_FONT, prev.fontSize + (e.deltaY < 0 ? 1 : -1)))
        if (next !== prev.fontSize) void saveSettings({ fontSize: next }).catch(() => {})
        return { ...prev, fontSize: next }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

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

  useEffect(() => {
    const onMouseMove = (e) => {
      const w = window.innerWidth
      if (e.clientX <= EDGE_PX) showOutline(); else if (outlineOpen && !outlinePinned) scheduleHide('outline')
      if (e.clientX >= w - EDGE_PX) showTools(); else if (toolsOpen && !toolsPinned) scheduleHide('tools')
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      for (const t of Object.values(hideTimers.current)) if (t) clearTimeout(t)
    }
  })
  useEffect(() => {
    if (outlinePinned) showOutline()
    else if (outlineOpen) scheduleHide('outline')
  }, [outlinePinned])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (toolsPinned) showTools()
    else if (toolsOpen) scheduleHide('tools')
  }, [toolsPinned])  // eslint-disable-line react-hooks/exhaustive-deps

  // 进入阅读器时侧栏闪现一次，提示左右有浮动面板
  useEffect(() => {
    showOutline()
    showTools()
    const t1 = setTimeout(() => { if (!outlinePinned) setOutlineOpen(false) }, 1600)
    const t2 = setTimeout(() => { if (!toolsPinned) setToolsOpen(false) }, 1600)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 键盘 ---------------- */
  const goCh = useCallback((target) => {
    if (target) { setChId(target.id); setChTitle(target.title); setProgressPct(0) }
  }, [])
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { void recordProgress(progressPct); onExit() }
      else if (e.key === 'ArrowLeft') goCh(prevCh)
      else if (e.key === 'ArrowRight') goCh(nextCh)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ---------------- 缓存本章 ---------------- */
  useEffect(() => {
    setChapterCached(false); setChapterCaching(false)
    void call('cache.status', [sourceKey, bookId]).then(
      s => { if (s?.chapters?.includes(chId)) setChapterCached(true) },
      () => {}
    )
  }, [sourceKey, bookId, chId])

  useEffect(() => {
    const enest = window.enest || window.zapi
    const onEvent = ({ event, data }) => {
      if (event !== 'cache.progress' || data?.sourceKey !== sourceKey || data?.bookId !== bookId) return
      if (data.phase === 'chapter' && data.chId === chId) {
        setChapterCaching(false)
        setChapterCached(true)
      }
    }
    enest?.on?.('backend.event', onEvent)
    return () => enest?.off?.('backend.event', onEvent)
  }, [sourceKey, bookId, chId])

  const cacheThisChapter = useCallback(async () => {
    setChapterCaching(true)
    try {
      await call('cache.chapter', [sourceKey, bookId, chId, chTitle], { timeoutMs: 1_800_000 })
      setChapterCached(true)
    } catch { /* 失败恢复按钮态 */ }
    finally { setChapterCaching(false) }
  }, [sourceKey, bookId, chId, chTitle])

  const setFont = (delta) => {
    setSettings(prev => {
      const next = Math.min(MAX_FONT, Math.max(MIN_FONT, prev.fontSize + delta))
      void saveSettings({ fontSize: next }).catch(() => {})
      return { ...prev, fontSize: next }
    })
  }

  return (
    <div className={`nh-reader nh-theme-${settings.readerTheme}`} style={{
      '--reader-font': `${settings.fontSize}px`,
      '--reader-line': settings.lineHeight,
      '--reader-para': `${settings.paraGap}px`,
      '--reader-width': `${settings.readerWidth}px`,
    }}>
      {/* 阅读视口 */}
      <div className="nh-reader-scroll" ref={scrollRef}>
        {loading && <div className="nh-reader-loading"><span className="nh-reader-spin" /> 正在加载章节…</div>}
        {error && (
          <div className="nh-reader-error">
            <p>章节加载失败</p>
            <button className="pk-btn" onClick={() => void loadChapter(chId, chTitle)}>重试</button>
          </div>
        )}
        {!loading && !error && (
          <article className="nh-reader-article">
            <h1 className="nh-reader-title">{currentChapterTitle}</h1>
            {paragraphs.map((p, i) => (
              <p className="nh-reader-para" key={i}>{p}</p>
            ))}
            <div className="nh-reader-end">
              {nextCh
                ? <button className="pk-btn" onClick={() => goCh(nextCh)}>下一章：{nextCh.title} →</button>
                : <span className="pk-muted">—— 全书完 ——</span>}
            </div>
          </article>
        )}
      </div>

      {/* 底部居中进度指示（章节名 + 百分比） */}
      <div className="nh-reader-pageno" aria-live="polite">
        {loading ? '…' : (
          <>
            <span className="nh-reader-pageno-ep">{currentChapterTitle}</span>
            <span className="nh-reader-pageno-sep" aria-hidden>·</span>
            <span className="pk-mono">{progressPct}%</span>
          </>
        )}
      </div>

      {/* 左：目录大纲浮动栏 */}
      <aside
        className={`nh-dock nh-dock-left ${outlineOpen ? 'is-open' : ''} ${outlinePinned ? 'is-pinned' : ''}`}
        onMouseEnter={() => showOutline()}
        onMouseLeave={() => scheduleHide('outline')}
        aria-label="目录"
      >
        <div className="nh-dock-head">
          <span>{info?.title || '目录'}</span>
          <button
            className={`nh-pin ${outlinePinned ? 'pk-active' : ''}`}
            onClick={() => setOutlinePinned(v => !v)}
            title={outlinePinned ? '取消固定' : '固定侧栏'}
            aria-pressed={outlinePinned}
          >
            {outlinePinned ? '📌' : '📍'}
          </button>
        </div>
        <ol className="nh-dock-list">
          {[...chapters].reverse().map(ch => (
            <li key={ch.id}>
              <button
                className={ch.id === chId ? 'nh-dock-item pk-active' : 'nh-dock-item'}
                onClick={() => goCh(ch)}
              >
                {ch.title}
              </button>
            </li>
          ))}
          {!chapters.length && <li className="nh-dock-item pk-muted">（无目录信息）</li>}
        </ol>
      </aside>

      {/* 右：功能浮动栏 */}
      <aside
        className={`nh-dock nh-dock-right ${toolsOpen ? 'is-open' : ''} ${toolsPinned ? 'is-pinned' : ''}`}
        onMouseEnter={() => showTools()}
        onMouseLeave={() => scheduleHide('tools')}
        aria-label="阅读工具"
      >
        <div className="nh-dock-head">
          <span>阅读</span>
          <button
            className={`nh-pin ${toolsPinned ? 'pk-active' : ''}`}
            onClick={() => setToolsPinned(v => !v)}
            title={toolsPinned ? '取消固定' : '固定侧栏'}
            aria-pressed={toolsPinned}
          >
            {toolsPinned ? '📌' : '📍'}
          </button>
        </div>
        <div className="nh-dock-tools">
          <button className="pk-btn pk-btn-sm" onClick={() => { void recordProgress(progressPct); onExit() }}>退出阅读</button>
          <button className="pk-btn pk-btn-sm" disabled={!prevCh} onClick={() => goCh(prevCh)} title="←">上一章</button>
          <button className="pk-btn pk-btn-sm" disabled={!nextCh} onClick={() => goCh(nextCh)} title="→">下一章</button>
          <button
            className="pk-btn pk-btn-sm"
            disabled={chapterCaching || !paragraphs.length}
            onClick={() => void cacheThisChapter()}
            title="把当前章节缓存到本地，离线可读"
          >
            {chapterCaching ? '缓存中…' : chapterCached ? '✓ 已缓存' : '缓存本章'}
          </button>
          <div className="nh-zoom">
            <button className="pk-btn pk-btn-sm" onClick={() => setFont(-1)} title="减小字号">A−</button>
            <button className="nh-zoom-value pk-mono" title="字号">{settings.fontSize}px</button>
            <button className="pk-btn pk-btn-sm" onClick={() => setFont(1)} title="增大字号">A＋</button>
          </div>
          <div className="nh-dock-meta pk-muted">
            <div>{chIndex >= 0 ? `${chIndex + 1} / ${chapters.length} 章` : ''}</div>
            <div>{progressPct}%</div>
          </div>
        </div>
      </aside>
    </div>
  )
}
