import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon.jsx'
import { objectUrlFor } from '../lib/blobs.js'
import { getThumb } from '../lib/assets.js'
import { frameFromVideo } from '../lib/media.js'
import { formatBytes, formatClock, formatDimensions } from '../lib/format.js'
import { convertToGif } from '../lib/gif.js'

function GifSheet({ item, defaults, busy, progress, onCancel, onStart, onClose }) {
  const durationMs = Math.max(1000, item.durationMs || 1000)
  const [startSec, setStartSec] = useState(0)
  const [endSec, setEndSec] = useState(Math.round(durationMs / 100) / 10)
  const [fps, setFps] = useState(defaults.gifFps || 10)
  const [width, setWidth] = useState(defaults.gifWidth || 480)
  const [speed, setSpeed] = useState(1)

  return (
    <div className="sa-sheet-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div className="sa-sheet" role="dialog" aria-modal="true" aria-label="转换为 GIF">
        <div className="sa-sheet-head">
          <Icon name="gif" />
          <strong>转换为 GIF</strong>
        </div>
        <div className="sa-sheet-grid">
          <label className="sa-field">
            <span>开始（秒）</span>
            <input type="number" min={0} max={Math.max(0, endSec - 0.2)} step={0.1} value={startSec} disabled={busy} onChange={event => setStartSec(Number(event.target.value) || 0)} />
          </label>
          <label className="sa-field">
            <span>结束（秒）</span>
            <input type="number" min={startSec + 0.2} max={durationMs / 1000} step={0.1} value={endSec} disabled={busy} onChange={event => setEndSec(Number(event.target.value) || 0)} />
          </label>
          <label className="sa-field">
            <span>帧率</span>
            <select value={fps} disabled={busy} onChange={event => setFps(Number(event.target.value))}>
              {[8, 10, 12, 15].map(value => <option key={value} value={value}>{value} fps</option>)}
            </select>
          </label>
          <label className="sa-field">
            <span>宽度</span>
            <select value={width} disabled={busy} onChange={event => setWidth(Number(event.target.value))}>
              {[360, 480, 640, 720, 960].map(value => <option key={value} value={value}>{value}px</option>)}
            </select>
          </label>
          <label className="sa-field">
            <span>倍速</span>
            <select value={speed} disabled={busy} onChange={event => setSpeed(Number(event.target.value))}>
              {[0.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
            </select>
          </label>
        </div>
        {busy ? (
          <div style={{ marginTop: 12 }}>
            <div className="sa-progress"><i style={{ width: `${Math.round((progress?.ratio || 0) * 100)}%` }} /></div>
            <div className="sa-muted" style={{ fontSize: 10, marginTop: 5 }}>
              {progress?.phase === 'encoding' ? `正在编码 · ${progress.frames || 0} 帧` : '正在解码视频…'}
            </div>
          </div>
        ) : null}
        <div className="sa-sheet-foot">
          <span className="sa-muted" style={{ fontSize: 10 }}>
            {startSec.toFixed(1)}s – {endSec.toFixed(1)}s · {width}px · {fps}fps
          </span>
          <span className="spacer" />
          {busy ? <button type="button" className="pk-btn pk-btn-danger" onClick={onCancel}>取消转换</button> : <button type="button" className="pk-btn" onClick={onClose}>取消</button>}
          <button
            type="button"
            className="pk-btn pk-btn-primary"
            disabled={busy || endSec <= startSec + 0.1}
            onClick={() => onStart({ startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000), fps, width, speed })}
          >生成 GIF</button>
        </div>
      </div>
    </div>
  )
}

export function Lightbox({
  items,
  item,
  index,
  onClose,
  onNavigate,
  onEdit,
  onExport,
  onCopy,
  onPin,
  onDelete,
  onSaveFrame,
  onSaveGif,
  gifDefaults,
  toast
}) {
  const [url, setUrl] = useState('')
  const [thumbOnlyUrl, setThumbOnlyUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [armed, setArmed] = useState(false)
  const [gifOpen, setGifOpen] = useState(false)
  const [gifBusy, setGifBusy] = useState(false)
  const [gifProgress, setGifProgress] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(true)
  const [rate, setRate] = useState(1)
  const videoRef = useRef(null)
  const dragRef = useRef(null)
  const abortRef = useRef(null)
  const armTimer = useRef(0)

  const long = item.kind === 'image' && item.width > 0 && item.height > item.width * 2.2
  const canPrev = index > 0
  const canNext = index < items.length - 1

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setUrl('')
    setThumbOnlyUrl('')
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setArmed(false)
    setGifOpen(false)
    setGifBusy(false)
    setGifProgress(null)
    setPlaying(false)
    setCurrent(0)
    setDuration(item.durationMs || 0)
    if (item.legacyThumbOnly) {
      getThumb(item.thumbId).then(src => { if (alive) { setThumbOnlyUrl(src); setLoading(false) } }).catch(() => { if (alive) { setError('这条记录只有缩略图'); setLoading(false) } })
      return () => { alive = false }
    }
    objectUrlFor(item).then(entry => {
      if (!alive) return
      setUrl(entry.url)
      setLoading(false)
    }).catch(reason => {
      if (!alive) return
      setError(String(reason?.message || reason))
      setLoading(false)
    })
    return () => { alive = false }
  }, [item.id, item.thumbId, item.legacyThumbOnly])

  useEffect(() => {
    const onKey = event => {
      if (event.isComposing) return
      if (event.target.closest?.('input, select, textarea')) return
      if (gifOpen) { if (event.key === 'Escape') setGifOpen(false); return }
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); if (canPrev) onNavigate(-1) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); if (canNext) onNavigate(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gifOpen, canPrev, canNext, onClose, onNavigate])

  useEffect(() => () => { clearTimeout(armTimer.current); abortRef.current?.abort() }, [])

  const media = thumbOnlyUrl || url

  const displaySrc = useMemo(() => media, [media])

  const zoomBy = delta => {
    setScale(value => Math.max(0.25, Math.min(8, Math.round((value + delta) * 100) / 100)))
    if (scale <= 1 && delta > 0) setOffset({ x: 0, y: 0 })
  }

  const onWheel = event => {
    if (event.target.closest?.('.sa-sheet')) return
    event.preventDefault()
    zoomBy(event.deltaY > 0 ? -0.15 : 0.15)
  }

  const onPointerDown = event => {
    if (scale <= 1) return
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = event => {
    if (!dragRef.current) return
    setOffset({ x: dragRef.current.ox + event.clientX - dragRef.current.x, y: dragRef.current.oy + event.clientY - dragRef.current.y })
  }
  const onPointerUp = () => { dragRef.current = null }

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video) return
    try {
      if (video.paused) { await video.play(); setPlaying(true) }
      else { video.pause(); setPlaying(false) }
    } catch (reason) { toast(String(reason?.message || reason), 'error') }
  }

  const syncVideo = () => {
    const video = videoRef.current
    if (!video) return
    setCurrent(video.currentTime)
    if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration * 1000)
  }

  const seek = event => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Number(event.target.value)
    setCurrent(video.currentTime)
  }

  const extractFrame = () => {
    const video = videoRef.current
    if (!video) return
    if (!video.videoWidth) { toast('视频还在加载，请稍后再试', 'info'); return }
    try {
      const { canvas } = frameFromVideo(video)
      onSaveFrame(item, canvas)
    } catch (reason) {
      toast(String(reason?.message || reason), 'error')
    }
  }

  const startGif = async options => {
    if (gifBusy) return
    setGifBusy(true)
    setGifProgress({ phase: 'decoding', ratio: 0 })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const entry = await objectUrlFor(item)
      const result = await convertToGif(entry.blob, { ...options, signal: controller.signal, onProgress: setGifProgress })
      const saved = await onSaveGif(item, result)
      setGifOpen(false)
      toast(`GIF 已保存${saved ? '到媒体库' : ''}`, 'success')
    } catch (reason) {
      if (!reason?.cancelled) toast(String(reason?.message || reason), 'error')
    } finally {
      abortRef.current = null
      setGifBusy(false)
      setGifProgress(null)
    }
  }

  const cancelGif = () => {
    abortRef.current?.abort()
    setGifBusy(false)
    setGifProgress(null)
  }

  const armDelete = () => {
    if (!armed) {
      setArmed(true)
      clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setArmed(false), 3200)
      return
    }
    clearTimeout(armTimer.current)
    setArmed(false)
    onDelete(item)
  }

  const meta = [
    item.name,
    formatDimensions(item.width, item.height),
    item.kind === 'video' ? formatClock(item.durationMs || 0) : '',
    formatBytes(item.bytes)
  ].filter(Boolean).join(' · ')

  return (
    <div className="sa-lightbox" role="dialog" aria-modal="true" aria-label="媒体预览">
      <div className="sa-lb-top">
        <span className="sa-lb-index">{index + 1} / {items.length}</span>
        <div className="sa-lb-actions">
          {item.kind === 'image' && !item.legacyThumbOnly ? (
            <button type="button" onClick={() => onEdit(item)}><Icon name="edit" size={15} /> 编辑</button>
          ) : null}
          {item.kind !== 'video' ? (
            <button type="button" onClick={() => onCopy(item)}><Icon name="copy" size={15} /> 复制</button>
          ) : null}
          {item.kind !== 'video' ? (
            <button type="button" onClick={() => onPin(item)}><Icon name="pin" size={15} /> 贴图</button>
          ) : null}
          <button type="button" onClick={() => onExport(item)}><Icon name="download" size={15} /> 导出</button>
          <button type="button" className={armed ? 'armed' : 'danger'} onClick={armDelete}>
            <Icon name="trash" size={15} /> {armed ? '确认删除' : '删除'}
          </button>
          <button type="button" className="sa-lb-icon" aria-label="关闭" title="关闭（Esc）" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
      </div>

      <div className={`sa-lb-stage${long ? ' long' : ''}`} onWheel={onWheel}>
        <button type="button" className="sa-lb-arrow left" disabled={!canPrev} aria-label="上一项" onClick={() => onNavigate(-1)}><Icon name="left" /></button>
        {loading ? (
          <div className="sa-lb-note"><span className="sa-spinner" /> 正在读取…</div>
        ) : error ? (
          <div className="sa-lb-note">
            <Icon name="image" size={28} />
            <span>{error}</span>
          </div>
        ) : item.kind === 'video' ? (
          <>
            <video
              ref={videoRef}
              className={`sa-lb-media${scale > 1 ? ' zoomed' : ''}`}
              style={{ transform: `scale(${scale}) translate(${offset.x / scale}px, ${offset.y / scale}px)` }}
              src={displaySrc}
              muted={muted}
              playsInline
              onClick={togglePlay}
              onTimeUpdate={syncVideo}
              onLoadedMetadata={syncVideo}
              onEnded={() => setPlaying(false)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
            <div className="sa-video-controls">
              <button type="button" onClick={togglePlay} aria-label={playing ? '暂停' : '播放'}>
                <Icon name={playing ? 'pause' : 'play'} size={15} />
              </button>
              <span className="time">{formatClock(current * 1000)}</span>
              <input type="range" min={0} max={Math.max(0.1, duration / 1000)} step={0.05} value={current} onChange={seek} aria-label="播放进度" />
              <span className="time">{formatClock(duration)}</span>
              <button type="button" onClick={() => setMuted(value => !value)} aria-label={muted ? '取消静音' : '静音'}>
                <Icon name={muted ? 'speaker' : 'mic'} size={15} />
              </button>
              <select value={rate} onChange={event => { const next = Number(event.target.value); setRate(next); if (videoRef.current) videoRef.current.playbackRate = next }} aria-label="播放速度">
                {[0.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
              </select>
              <button type="button" onClick={extractFrame} aria-label="截取当前帧" title="截取当前帧"><Icon name="frame" size={15} /></button>
              <button type="button" onClick={() => setGifOpen(true)} aria-label="转换为 GIF" title="转换为 GIF"><Icon name="gif" size={15} /></button>
            </div>
          </>
        ) : (
          <img
            className={`sa-lb-media${scale > 1 ? ' zoomed' : ''}${long ? ' long' : ''}`}
            style={{
              transform: `scale(${scale}) translate(${offset.x / scale}px, ${offset.y / scale}px)`,
              ...(long ? { maxHeight: 'none', width: 'min(100%, 980px)' } : {})
            }}
            src={displaySrc}
            alt={item.name}
            draggable={false}
            onDoubleClick={() => { setScale(value => (value === 1 ? 2 : 1)); setOffset({ x: 0, y: 0 }) }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        )}
        <button type="button" className="sa-lb-arrow right" disabled={!canNext} aria-label="下一项" onClick={() => onNavigate(1)}><Icon name="right" /></button>
      </div>

      <div className="sa-lb-bottom">
        <span className="sa-lb-meta"><strong>{item.name}</strong>{meta.replace(item.name, '')}</span>
        <div className="sa-lb-zoom">
          <button type="button" className="sa-lb-icon" aria-label="缩小" onClick={() => zoomBy(-0.25)}><Icon name="zoomOut" size={16} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" className="sa-lb-icon" aria-label="放大" onClick={() => zoomBy(0.25)}><Icon name="zoomIn" size={16} /></button>
          <button type="button" className="sa-lb-icon" aria-label="重置缩放" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }) }}><Icon name="refresh" size={15} /></button>
        </div>
      </div>

      {gifOpen ? (
        <GifSheet
          item={item}
          defaults={gifDefaults}
          busy={gifBusy}
          progress={gifProgress}
          onCancel={cancelGif}
          onClose={() => { if (!gifBusy) setGifOpen(false) }}
          onStart={startGif}
        />
      ) : null}
    </div>
  )
}
