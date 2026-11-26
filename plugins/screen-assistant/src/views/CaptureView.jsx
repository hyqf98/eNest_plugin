import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon.jsx'
import { LazyThumb } from '../components/Thumb.jsx'
import { Segmented, Select, Switch } from '../ui/index.jsx'
import { formatBytes, formatClock, formatTime } from '../lib/format.js'

export const CAPTURE_ACTIONS = [
  { value: 'annotate', label: '标注' },
  { value: 'preview', label: '预览' },
  { value: 'copy', label: '复制' },
  { value: 'pin', label: '贴图' }
]

const MODE_OPTIONS = [
  { value: 'image', label: <><Icon name="capture" />截图</> },
  { value: 'record', label: <><Icon name="record" />录屏</> }
]

const ACTIONS_BY_MODE = {
  image: [
    { id: 'image', icon: 'frame', label: '区域截图' },
    { id: 'full', icon: 'fullscreen', label: '全屏截图' },
    { id: 'longshot', icon: 'longshot', label: '长截图' }
  ],
  record: [
    { id: 'record', icon: 'record', label: '区域录屏' },
    { id: 'record-full', icon: 'recordFull', label: '全屏录屏' }
  ]
}

function SessionPill({ active, onStop }) {
  const [now, setNow] = useState(Date.now)
  const startedAt = active?.startedAt
  useEffect(() => {
    if (startedAt == null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [startedAt])
  if (!active) return null
  const pending = active.status === 'preparing'
  const paused = active.status === 'paused'
  const saving = active.status === 'saving'
  const label = active.kind === 'longshot' ? '长截图' : '录屏'
  const clock = formatClock(startedAt == null ? active.elapsedMs : now - startedAt)
  return (
    <div className="sa-session-pill" data-idle={pending || paused || saving}>
      <i />
      <span>{pending ? `待开始${label}` : saving ? `正在保存${label}…` : `${paused ? '已暂停' : `${label}中`} · ${clock}`}</span>
      {!saving && <button type="button" onClick={onStop}>{pending ? '取消' : '停止'}</button>}
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
        <LazyThumb item={item} ensureThumb={ensureThumb} />
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
  captureMode = 'image',
  onCaptureModeChange,
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
  const isRecording = captureMode === 'record'
  const actions = ACTIONS_BY_MODE[isRecording ? 'record' : 'image']
  const displayOptions = displays.map((display, index) => ({ value: String(display.id), label: `显示器 ${index + 1}${display.primary ? ' · 主屏' : ''}` }))
  const mediaSummary = `${recent.length} 项 · ${formatBytes(recent.reduce((sum, item) => sum + (item.bytes || 0), 0))}`
  const options = (
    <section className="sa-side-card options" aria-label={isRecording ? '录屏选项' : '截图选项'}>
      {isRecording ? (
        <div className="sa-option-row">
          <span>录制系统声音</span>
          <Switch checked={settings.recordAudio === true} onCheckedChange={onToggleAudio} disabled={disabled} aria-label="录制系统声音" />
        </div>
      ) : (
        <div className="sa-option-row">
          <span>截图后</span>
          <Segmented value={settings.captureAction} options={CAPTURE_ACTIONS} onChange={onCaptureAction} disabled={disabled} ariaLabel="截图后动作" />
        </div>
      )}
      {displays.length > 0 && (
        <div className="sa-option-row sa-display-row">
          <span><Icon name="monitor" />屏幕</span>
          {displays.length > 1 ? (
            <Select
              value={String(displayId)}
              options={displayOptions}
              onChange={value => onDisplayChange(Number(value))}
              disabled={disabled}
              ariaLabel="选择显示器"
            />
          ) : <span className="sa-display-name">{displays[0].primary ? '主显示器' : displayOptions[0].label}</span>}
        </div>
      )}
      {!quick && (
        <div className="sa-side-foot">
          <span>{mediaSummary}</span>
          <button type="button" onClick={onOpenLibrary}>打开媒体库</button>
        </div>
      )}
    </section>
  )
  return (
    <div className="sa-view">
      <div className="sa-capture">
        <section className="sa-stage" aria-label="屏幕拍摄">
          <div className="sa-stage-status">
            <Segmented
              className="sa-mode-segment"
              value={captureMode}
              options={MODE_OPTIONS}
              onChange={onCaptureModeChange}
              disabled={disabled}
              ariaLabel="拍摄模式"
            />
            <SessionPill active={active} onStop={onStop} />
            {busy && !active ? <div className="sa-stage-busy" role="status"><span className="sa-spinner" /> 正在准备…</div> : null}
          </div>
          {!quick && <StageArt />}
          <div className="sa-dock" role="group" aria-label={isRecording ? '开始录屏' : '开始截图'}>
            {actions.map((action, index) => (
              <button
                key={action.id}
                type="button"
                className={`sa-dock-btn${index === 0 ? ' primary' : ''}`}
                disabled={disabled}
                onClick={() => onAction(action.id)}
              >
                <Icon name={action.icon} />
                {action.label}
              </button>
            ))}
          </div>
          {quick && options}
        </section>

        <div className="sa-capture-bottom">
          <section className="sa-side-card recent">
            <div className="sa-side-head">
              <span>{quick ? '最近项目' : '最近'}</span>
              {quick && recent.length > 0 ? <small>{mediaSummary}</small> : null}
              {quick || recent.length > 0 ? (
                <button type="button" onClick={onOpenLibrary}>{quick ? <>媒体库<Icon name="right" /></> : '全部'}</button>
              ) : null}
            </div>
            {recent.length ? (
              <div className="sa-recent-strip">
                {recent.slice(0, 8).map(item => (
                  <RecentItem key={item.id} item={item} ensureThumb={ensureThumb} onOpen={onOpenItem} />
                ))}
              </div>
            ) : (
              <div className="sa-side-empty horizontal">
                <Icon name="image" />
                <span>暂无截图或录屏</span>
                {!quick && <button type="button" className="pk-btn pk-btn-primary pk-btn-sm" disabled={disabled} onClick={() => onAction(actions[0].id)}>{actions[0].label}</button>}
              </div>
            )}
          </section>
          {!quick && options}
        </div>
      </div>
    </div>
  )
}
