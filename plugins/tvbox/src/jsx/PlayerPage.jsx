import { useCallback, useEffect, useRef, useState } from 'react'
import { call, saveHistoryEntry } from '../js/api.js'
import { createPlayer } from '../js/player.js'

/** 鼠标贴近右缘多少像素内展开选集；移开后多久自动收起 */
const EDGE_PX = 12
const AUTO_HIDE_MS = 1600

/**
 * 全屏播放页（Artplayer）：
 * - 进度拖拽快进/悬浮预览、倍速、音量、设置菜单、画中画、键盘控制（Artplayer 自带）
 * - 业务按钮（返回/上一集/下一集/线路/选集/小窗）合并进 Artplayer 控制栏，与播放器控件同处一条栏，
 *   随控制栏悬停显示、移开隐藏，不单独占一行
 * - 选集抽屉贴右缘悬停展开、移开自动收起，可 pin 常驻
 * - 进度 30s 节流 + 退出/切集保存历史（续播依据）；断流 hls 自动恢复（player.js）
 * - floating：宿主悬浮窗形态（视图已迁入置顶小窗），顶部提供拖动条
 */
export function PlayerPage({ params, onExit, onSwitchEpisode, onSwitchFlag, floating = false }) {
  const { siteKey, siteName, vodId, vodName, flags, flagIndex: initialFlag, episodeIndex, cover, resumeSec } = params
  const containerRef = useRef(null)
  const artRef = useRef(null)
  // 业务按钮容器：React 正常往里渲染，Artplayer 创建时把该节点移进自己的控制栏
  const dockRef = useRef(null)
  const stateRef = useRef({ flagIndex: initialFlag ?? 0, episodeIndex: episodeIndex ?? 0 })
  const [flagIndex, setFlagIndex] = useState(initialFlag ?? 0)
  const [episodeIdx, setEpisodeIdx] = useState(episodeIndex ?? 0)
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState('hls')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerPinned, setDrawerPinned] = useState(false)
  const [resolution, setResolution] = useState('')

  const flag = flags?.[flagIndex]
  const episode = flag?.episodes?.[episodeIdx]
  const epCount = flag?.episodes?.length ?? 0
  const saveProgress = useCallback((positionSec, durationSec, epName) => {
    // 开始播放即入历史（positionSec 可为 0）；quality 为播放中实测分辨率档（剧集源数据无画质词）
    void saveHistoryEntry({
      siteKey, siteName, vodId, vodName, vodPic: cover,
      flag: flags?.[stateRef.current.flagIndex]?.flag ?? '',
      episodeName: epName, episodeIndex: stateRef.current.episodeIndex,
      positionSec: positionSec || 0, durationSec: durationSec || 0,
      quality: resQualityRef.current || undefined,
    }).catch(() => {})
  }, [siteKey, siteName, vodId, vodName, cover, flags])

  /* 播放器就绪即写一次历史（确保「开始播放就进历史」，不依赖 30s 节流） */
  const seededRef = useRef(false)
  const resQualityRef = useRef('')   // 实测画质档（readRes 里更新，saveProgress 带入历史）

  /* 取播放地址（线路/集变化时） */
  useEffect(() => {
    let alive = true
    setError(''); setLoading(true); setUrl('')
    void (async () => {
      try {
        const result = await call('site.play', [siteKey, flag?.flag ?? '', episode?.url ?? ''], { timeoutMs: 60_000 })
        if (!alive) return
        setUrl(result.url)
        setKind(result.kind ?? 'hls')
        setNote(result.note ?? '')
      } catch (e) {
        if (alive) { setError(e?.message || String(e)); setLoading(false) }
      }
    })()
    return () => { alive = false }
  }, [siteKey, flag?.flag, episode?.url])

  const gotoEpisode = useCallback((idx) => {
    const eps = flags?.[stateRef.current.flagIndex]?.episodes ?? []
    if (idx < 0 || idx >= eps.length) return
    // 先保存当前集进度再切
    const art = artRef.current
    if (art && art.currentTime > 5) saveProgress(art.currentTime, art.duration, flag?.episodes?.[stateRef.current.episodeIndex]?.name)
    stateRef.current.episodeIndex = idx
    setEpisodeIdx(idx)
    onSwitchEpisode?.(idx)
  }, [flags, onSwitchEpisode, flag, saveProgress])

  const gotoFlag = useCallback((idx) => {
    if (idx < 0 || idx >= (flags?.length ?? 0)) return
    const art = artRef.current
    if (art && art.currentTime > 5) saveProgress(art.currentTime, art.duration, flag?.episodes?.[stateRef.current.episodeIndex]?.name)
    stateRef.current.flagIndex = idx
    stateRef.current.episodeIndex = 0
    setFlagIndex(idx)
    setEpisodeIdx(0)
    onSwitchFlag?.(idx)
  }, [flags, onSwitchFlag, flag, saveProgress])

  /* 创建 Artplayer（url 变化即重建） */
  useEffect(() => {
    if (!url || !containerRef.current) return
    let lastSaveAt = 0
    let lastPos = 0
    let lastDur = 0
    const art = createPlayer({
      container: containerRef.current,
      url,
      kind,
      title: vodName,
      resumeSec: resumeSec && episodeIdx === (episodeIndex ?? 0) && flagIndex === (initialFlag ?? 0) ? resumeSec : 0,
      speed: params.speed ?? 1,
      dock: dockRef.current,
      onPosition: (pos, dur) => {
        lastPos = pos; lastDur = dur
        const now = Date.now()
        if (now - lastSaveAt > 30_000 && pos > 5) {
          lastSaveAt = now
          saveProgress(pos, dur, flag?.episodes?.[stateRef.current.episodeIndex]?.name)
        }
      },
      onEnded: () => gotoEpisode(stateRef.current.episodeIndex + 1),
      onError: (msg) => setError(msg),
    })
    artRef.current = art
    art.on('video:canplay', () => setLoading(false))
    // 开始播放即入历史一次（「播放过」语义；后续 30s 节流覆盖进度）
    if (!seededRef.current) {
      seededRef.current = true
      saveProgress(0, 0, flag?.episodes?.[stateRef.current.episodeIndex]?.name)
    }
    // 实测分辨率：metadata 就绪后从 video 元素读（真实准确，4K 流即显示 3840×2160）
    // 同时回写历史（历史/继续观看卡片据此显示实测画质角标，剧集源数据无画质词）
    const readRes = () => {
      const v = containerRef.current?.querySelector('video')
      if (v?.videoWidth) {
        setResolution(`${v.videoWidth}×${v.videoHeight}`)
        if (v.videoWidth >= 3800) resQualityRef.current = '4K'
        else if (v.videoWidth >= 2500) resQualityRef.current = '2K'
        else if (v.videoWidth >= 1900) resQualityRef.current = '1080P'
        else if (v.videoWidth > 0) resQualityRef.current = 'HD'
      }
    }
    art.on('ready', readRes)
    art.on('video:loadedmetadata', readRes)
    art.on('resize', readRes)
    setLoading(false)
    return () => {
      // 退出/切集前落一次进度（播放过才写）
      if (lastPos > 5) saveProgress(lastPos, lastDur, flag?.episodes?.[stateRef.current.episodeIndex]?.name)
      art.destroy()
      artRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind])

  /* ---------------- 选集抽屉：贴右缘悬停展开 / 移开自动收起 / pin 常驻 ---------------- */
  const hideTimerRef = useRef(null)
  const drawerStateRef = useRef({ open: false, pinned: false })
  drawerStateRef.current = { open: drawerOpen, pinned: drawerPinned }
  const cancelHide = () => { if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null } }
  const scheduleHide = () => {
    if (drawerStateRef.current.pinned) return
    cancelHide()
    hideTimerRef.current = setTimeout(() => { hideTimerRef.current = null; setDrawerOpen(false) }, AUTO_HIDE_MS)
  }
  // 监听器只绑定一次，状态经 ref 读取（避免每次渲染重绑导致的计时器竞态）
  useEffect(() => {
    const onMove = (e) => {
      const s = drawerStateRef.current
      if (e.clientX >= window.innerWidth - EDGE_PX) { cancelHide(); setDrawerOpen(true) }
      else if (s.open) scheduleHide()
    }
    const onLeave = () => { if (drawerStateRef.current.open) scheduleHide() }
    window.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      cancelHide()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 取消 pin 后若鼠标已不在抽屉上，按普通规则自动收起
  useEffect(() => { if (!drawerPinned && drawerOpen) scheduleHide() }, [drawerPinned]) // eslint-disable-line react-hooks/exhaustive-deps
  // 鼠标在抽屉内不收起
  const onDrawerEnter = cancelHide
  const onDrawerLeave = () => { if (!drawerStateRef.current.pinned) scheduleHide() }

  /* 顶部快捷键：Esc 关抽屉/退出（Artplayer 已处理空格/方向键快进音量） */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { if (drawerOpen) setDrawerOpen(false); else onExit?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, onExit])

  /* 悬浮窗形态下的宿主调用（非宿主环境 / 旧宿主没有该 API 时静默降级） */
  const host = typeof window !== 'undefined' ? window.enest : null
  const enterFloat = () => host?.ui?.enterFloat?.({ width: 480, height: 320, minWidth: 320, minHeight: 200 }).catch(() => {})
  const exitFloat = () => host?.ui?.exitFloat?.().catch(() => {})

  return (
    <div className={`tb-player${floating ? ' is-floating' : ''}`}>
      <div ref={containerRef} className="tb-player-art" />

      {/* 悬浮窗拖动条：仅悬浮形态渲染；无标题栏，靠这条拖动窗口（原生 drag region） */}
      {floating ? (
        <div className="tb-player-drag">
          <button className="tb-player-icon-btn" onClick={exitFloat} title="还原到主窗口">还原</button>
        </div>
      ) : null}

      {/* 业务按钮：由 Artplayer 移入控制栏；不悬浮时隐藏的占位，避免 React 卸载节点 */}
      <div ref={dockRef} className="tb-player-dock">
        <button className="tb-player-icon-btn" onClick={() => (floating ? exitFloat() : onExit?.())} title={floating ? '还原到主窗口' : '返回'}>
          {floating ? '⤢' : '←'}
        </button>
        <span className="tb-player-dock-title">
          {vodName}{episode ? ` · ${episode.name || `第 ${episodeIdx + 1} 集`}` : ''}
        </span>
        {resolution ? <span className="tb-player-res" title="视频实际分辨率">{resolution}</span> : null}
        {epCount > 0 ? <span className="tb-player-dock-note">{episodeIdx + 1}/{epCount}</span> : null}
        {epCount > 1 ? <button className="tb-player-icon-btn" onClick={() => gotoEpisode(episodeIdx - 1)} disabled={episodeIdx === 0} title="上一集">上一集</button> : null}
        {epCount > 1 ? <button className="tb-player-icon-btn" onClick={() => gotoEpisode(episodeIdx + 1)} disabled={episodeIdx >= epCount - 1} title="下一集">下一集</button> : null}
        {flags?.length > 1 ? (
          <button className="tb-player-icon-btn" onClick={() => gotoFlag((flagIndex + 1) % flags.length)} title="切换线路">
            线路（{flag?.flag}）
          </button>
        ) : null}
        <button className="tb-player-icon-btn" onClick={() => { setDrawerPinned(p => !p); setDrawerOpen(true) }} title="选集（固定显示）">
          选集{drawerPinned ? ' ✓' : ''}
        </button>
        {!floating ? <button className="tb-player-icon-btn" onClick={enterFloat} title="缩成悬浮小窗">小窗</button> : null}
      </div>

      {loading ? <div className="tb-player-center"><div className="tb-player-spinner" /></div> : null}
      {error ? (
        <div className="tb-player-center">
          <div style={{ fontSize: 13.5, lineHeight: 1.7, maxWidth: 460, textAlign: 'center' }}>{error}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tb-player-icon-btn" onClick={() => { setError(''); setUrl(''); const u = url; setTimeout(() => setUrl(u), 0) }}>重试</button>
            {flags?.length > 1 ? <button className="tb-player-icon-btn" onClick={() => gotoFlag((flagIndex + 1) % flags.length)}>换线路</button> : null}
            <button className="tb-player-icon-btn" onClick={() => onExit?.()}>返回</button>
          </div>
        </div>
      ) : null}

      {/* 右缘把手：抽屉收起时提示这里有选集 */}
      {!drawerOpen ? <div className="tb-ep-handle" aria-hidden="true" /> : null}
      <div
        className={`tb-ep-drawer${drawerOpen ? ' open' : ''}`}
        onMouseEnter={onDrawerEnter}
        onMouseLeave={onDrawerLeave}
      >
        <header>
          <span>选集 · {flag?.flag ?? ''}（{epCount}）</span>
          <span className="tb-ep-drawer-actions">
            <button
              className={drawerPinned ? 'is-active' : ''}
              onClick={() => setDrawerPinned(p => !p)}
              title={drawerPinned ? '取消固定（移开自动收起）' : '固定显示'}
            >{drawerPinned ? '已固定' : '固定'}</button>
            <button onClick={() => { setDrawerPinned(false); setDrawerOpen(false) }}>✕</button>
          </span>
        </header>
        {flags?.length > 1 ? (
          <div className="tb-ep-drawer-flags">
            {flags.map((f, i) => (
              <button key={f.flag} className={`tb-flag-chip${i === flagIndex ? ' is-active' : ''}`} onClick={() => gotoFlag(i)}>{f.flag}</button>
            ))}
          </div>
        ) : null}
        <div className="list">
          {(flag?.episodes ?? []).map((ep, i) => (
            <button key={`${ep.url}-${i}`} className={`tb-ep-btn${i === episodeIdx ? ' is-current' : ''}`} onClick={() => { gotoEpisode(i); if (!drawerStateRef.current.pinned) setDrawerOpen(false) }}>
              {ep.name || String(i + 1).padStart(2, '0')}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
