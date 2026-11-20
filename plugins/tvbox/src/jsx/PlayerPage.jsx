import { useCallback, useEffect, useRef, useState } from 'react'
import { call, saveHistoryEntry } from '../js/api.js'
import { createPlayer } from '../js/player.js'

/**
 * 全屏播放页（Artplayer）：
 * - 进度拖拽快进/悬浮预览、倍速、音量、设置菜单、画中画、键盘控制（Artplayer 自带）
 * - 顶部返回+标题、选集抽屉、线路切换、上一集/下一集（自定义控件注入 Artplayer control 栏）
 * - 进度 30s 节流 + 退出/切集保存历史（续播依据）；断流 hls 自动恢复（player.js）
 */
export function PlayerPage({ params, onExit, onSwitchEpisode, onSwitchFlag }) {
  const { siteKey, siteName, vodId, vodName, flags, flagIndex: initialFlag, episodeIndex, cover, resumeSec } = params
  const containerRef = useRef(null)
  const artRef = useRef(null)
  const stateRef = useRef({ flagIndex: initialFlag ?? 0, episodeIndex: episodeIndex ?? 0 })
  const [flagIndex, setFlagIndex] = useState(initialFlag ?? 0)
  const [episodeIdx, setEpisodeIdx] = useState(episodeIndex ?? 0)
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState('hls')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
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
    // 顶栏跟随 Artplayer 控制层显隐（hover 态由 CSS :hover 兜底）
    const root = containerRef.current?.closest('.tb-player')
    const syncState = () => root?.classList.toggle('artstate-hover', !!art.hover)
    art.on('mouseenter', syncState)
    art.on('mouseleave', syncState)
    art.on('mousemove', syncState)
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

  /* 顶部快捷键：Esc 退出（Artplayer 已处理空格/方向键快进音量） */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { if (drawerOpen) setDrawerOpen(false); else onExit?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, onExit])

  /* Artplayer 自带控件之外的顶部栏（返回/标题/线路）+ 选集抽屉 */
  return (
    <div className="tb-player">
      <div ref={containerRef} className="tb-player-art" />
      <div className="tb-player-topbar">
        <button className="tb-player-icon-btn" onClick={() => onExit?.()}>←</button>
        <span className="tb-player-topbar-title">{vodName}{episode ? ` · ${episode.name || `第 ${episodeIdx + 1} 集`}` : ''}</span>
        {resolution ? <span className="tb-player-res" title="视频实际分辨率">{resolution}</span> : null}
        {note ? <span className="tb-player-topbar-note">{note}</span> : null}
        {epCount > 0 ? <span className="tb-player-topbar-note">{episodeIdx + 1}/{epCount}</span> : null}
        <span className="tb-player-topbar-spacer" />
        {epCount > 1 ? <button className="tb-player-icon-btn" onClick={() => gotoEpisode(episodeIdx - 1)} disabled={episodeIdx === 0} title="上一集">上一集</button> : null}
        {epCount > 1 ? <button className="tb-player-icon-btn" onClick={() => gotoEpisode(episodeIdx + 1)} disabled={episodeIdx >= epCount - 1} title="下一集">下一集</button> : null}
        {flags?.length > 1 ? (
          <button className="tb-player-icon-btn" onClick={() => gotoFlag((flagIndex + 1) % flags.length)} title="切换线路">
            线路（{flag?.flag}）
          </button>
        ) : null}
        <button className="tb-player-icon-btn" onClick={() => setDrawerOpen(!drawerOpen)}>选集</button>
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

      <div className={`tb-ep-drawer${drawerOpen ? ' open' : ''}`}>
        <header>
          <span>选集 · {flag?.flag ?? ''}（{epCount}）</span>
          <button onClick={() => setDrawerOpen(false)}>✕</button>
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
            <button key={`${ep.url}-${i}`} className={`tb-ep-btn${i === episodeIdx ? ' is-current' : ''}`} onClick={() => { gotoEpisode(i); setDrawerOpen(false) }}>
              {ep.name || String(i + 1).padStart(2, '0')}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
