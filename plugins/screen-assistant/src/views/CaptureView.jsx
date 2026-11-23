import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon.jsx'
import { LazyThumb } from '../components/Thumb.jsx'
import { Segmented, Select, Switch } from '../ui/index.jsx'
import { formatBytes, formatClock, formatTime } from '../lib/format.js'

const MODES = [
  { id: 'region', icon: 'capture', label: '区域截图', primary: true },
  { id: 'full', icon: 'fullscreen', label: '全屏截图' },
  { id: 'longshot', icon: 'longshot', label: '长截图' },
  { id: 'record', icon: 'record', label: '区域录屏' },
  { id: 'record-full', icon: 'recordFull', label: '全屏录屏' }
]

function SessionPill({ active, onStop }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  if (!active) return null
  const seconds = Math.max(0, Math.floor((now - active.startedAt) / 1000))
  const text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return (
    <div className="sa-session-pill">
      <i />
      <span>{active.kind === 'longshot' ? '长截图中' : '录制中'} · {text}</span>
      <button type="button" onClick={onStop}>停止</button>
    </div>
  )
}

function StageArt() {
  return (
    <div className="sa-stage-art" aria-hidden="true">
      <div className="sa-mock">
        <span className="sa-mock-bar"><i /><i /><i /></span>
        <span className="sa-mock-body">
          <span className="sa-mock-side" />
          <span className="sa-mock-main"><span /><span /><span /><span /></span>
        </span>
        <span className="sa-mock-sel">
          <b className="nw" /><b className="ne" /><b className="sw" /><b className="se" />
          <em>1280 × 720</em>
        </span>
      </div>
    </div>
  )
}

function RecentItem({ item, ensureThumb, onOpen }) {
  return (
    <button type="button" className="sa-recent-card" title={item.name} onClick={() => onOpen(item)}>
      <span className="sa-recent-thumb">
        <LazyThumb item={item} ensureThumb={ensureThumb} alt={item.name} />
        {item.kind === 'video' ? <span className="sa-recent-play"><Icon name="play" size={14} /></span> : null}
      </span>
      <span className="sa-recent-info">
        <span className="sa-side-name">{item.name}</span>
        <span className="sa-side-meta">
          {item.kind === 'video' ? formatClock(item.durationMs || 0) : item.kind === 'gif' ? 'GIF' : formatTime(item.createdAt)}
        </span>
      </span>
    </button>
  )
}

export function CaptureView({
  displays = [],
  displayId,
  onDisplayChange,
  settings,
  onToggleAudio,
  recent = [],
  ensureThumb,
  busy,
  active,
  onStop,
  onAction,
  onOpenItem,
  onOpenLibrary,
  onCaptureAction,
  quick
}) {
  const disabled = busy || !!active
  const displayOptions = displays.map((display, index) => ({ value: String(display.id), label: `显示器 ${index + 1}` }))
  return (
    <div className="sa-view">
      <div className="sa-capture">
        <section className="sa-stage">
          <SessionPill active={active} onStop={onStop} />
          {busy ? <div className="sa-stage-busy"><span className="sa-spinner" /> 正在准备…</div> : null}
          <StageArt />
          <div className="sa-dock" role="toolbar" aria-label="截图与录屏">
            {MODES.map((mode, index) => (
              <span key={mode.id} style={{ display: 'contents' }}>
                {index === 1 ? <span className="sa-dock-sep" aria-hidden="true" /> : null}
                <button
                  type="button"
                  className={`sa-dock-btn${mode.primary ? ' primary' : ''}`}
                  disabled={disabled}
                  onClick={() => onAction(mode.id)}
                >
                  <Icon name={mode.icon} />
                  {mode.label}
                </button>
              </span>
            ))}
          </div>
        </section>

        <div className="sa-capture-bottom">
          <section className="sa-side-card recent">
            <div className="sa-side-head">
              <span>最近</span>
              {recent.length ? <button type="button" onClick={onOpenLibrary}>全部</button> : null}
            </div>
            {recent.length ? (
              <div className="sa-recent-strip">
                {recent.slice(0, quick ? 3 : 8).map(item => (
                  <RecentItem key={item.id} item={item} ensureThumb={ensureThumb} onOpen={onOpenItem} />
                ))}
              </div>
            ) : (
              <div className="sa-side-empty horizontal">
                <Icon name="image" />
                <span>还没有截图</span>
                <button type="button" className="pk-btn pk-btn-primary pk-btn-sm" disabled={disabled} onClick={() => onAction('region')}>区域截图</button>
              </div>
            )}
          </section>

          <section className="sa-side-card options">
            <div className="sa-option-row">
              <span>截图后</span>
              <Segmented
                value={settings.captureAction}
                options={[{ value: 'preview', label: '预览' }, { value: 'copy', label: '复制' }, { value: 'pin', label: '贴图' }]}
                onChange={onCaptureAction}
                ariaLabel="截图后动作"
              />
            </div>
            <div className="sa-option-row">
              <span>录制系统声音</span>
              <Switch checked={settings.recordAudio} onCheckedChange={onToggleAudio} aria-label="录制系统声音" />
            </div>
            {displays.length > 1 ? (
              <div className="sa-option-row">
                <span>显示器</span>
                <Select
                  value={String(displayId)}
                  options={displayOptions}
                  onChange={value => onDisplayChange(Number(value))}
                  ariaLabel="显示器"
                  minWidth={112}
                />
              </div>
            ) : null}
            <div className="sa-side-foot">
              <span>{recent.length} 项 · {formatBytes(recent.reduce((sum, item) => sum + (item.bytes || 0), 0))}</span>
              <button type="button" onClick={onOpenLibrary}>打开媒体库</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
