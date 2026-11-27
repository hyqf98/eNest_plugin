import type { ReactNode } from 'react'
import type { MediaType, WallpaperFit, EngineState, DownloadPhase, EngineInstallPhase } from '../shared/contracts'
import { formatBytes } from '../shared/contracts'
import { Button, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle, Tooltip } from '../ui'
import type { I18nKey } from '../i18n'

export type IconName =
  | 'search' | 'download' | 'star' | 'monitor' | 'play' | 'settings' | 'folder'
  | 'chevron-left' | 'chevron-right'
  | 'refresh' | 'external' | 'trash' | 'close' | 'chevron' | 'check' | 'info'
  | 'image' | 'video' | 'gif' | 'web' | 'alert' | 'engine' | 'upload' | 'link' | 'stop' | 'menu'

const paths: Record<IconName, ReactNode> = {
  search: <><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></>,
  download: <><path d="M8 2v8" /><path d="m5 7 3 3 3-3" /><path d="M3 12.5v1.2h10v-1.2" /></>,
  star: <path d="m8 2.4 1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.1l-3.4 1.8.7-3.8L2.5 6.4l3.8-.5Z" />,
  monitor: <><rect x="2" y="3" width="12" height="8" rx="1.2" /><path d="M6 14h4M8 11v3" /></>,
  play: <path d="M5 3.5v9l7-4.5Z" />,
  settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" /></>,
  folder: <path d="M2 4.5h4l1.2 1.5H14v7H2Z" />,
  refresh: <><path d="M13 6.5A5 5 0 1 0 13 10" /><path d="M13 2.5v4H9" /></>,
  external: <><path d="M9 3h4v4" /><path d="m13 3-5 5" /><path d="M12 10.5V13H3V4h2.5" /></>,
  trash: <><path d="M3 4.5h10" /><path d="M6 4.5V3h4v1.5" /><path d="m4.5 4.5.6 9h5.8l.6-9" /></>,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  chevron: <path d="m4 6 4 4 4-4" />,
  'chevron-left': <path d="m10 3-5 5 5 5" />,
  'chevron-right': <path d="m6 3 5 5-5 5" />,
  check: <path d="m3 8 3 3 7-7" />,
  info: <><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 5.2v.2" /></>,
  image: <><rect x="2" y="3" width="12" height="10" rx="1.2" /><path d="m3.5 11 3-3 2.2 2.2 1.8-1.8 2 2" /><circle cx="5.6" cy="6" r=".8" /></>,
  video: <><rect x="2" y="4" width="8" height="8" rx="1.2" /><path d="m10 6.5 4-2v7l-4-2Z" /></>,
  gif: <><rect x="2" y="4" width="12" height="8" rx="1.2" /><path d="M5 8h2M6 7v2M9 9V7h2M9 9h1.5" /></>,
  web: <><circle cx="8" cy="8" r="6" /><path d="M2.5 8h11M8 2c1.8 2 2.6 4 2.6 6S9.8 12 8 14M8 2C6.2 4 5.4 6 5.4 8S6.2 12 8 14" /></>,
  alert: <><path d="M8 2.2 14 13H2Z" /><path d="M8 6v3.2M8 11.2v.2" /></>,
  engine: <><path d="M4 6h8v6H4Z" /><path d="M6 6V3.5h4V6M6 12v2.5M10 12v2.5M12 7.5h2.5M12 10.5h2.5" /></>,
  upload: <><path d="M8 12V3" /><path d="m5 6 3-3 3 3" /><path d="M3 13h10" /></>,
  link: <><path d="M6.5 9.5 9.5 6.5" /><path d="M7.5 4.8 9 3.3a2.4 2.4 0 0 1 3.4 3.4L10.9 8" /><path d="M8.5 11.2 7 12.7a2.4 2.4 0 0 1-3.4-3.4L5.1 8" /></>,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  menu: <><circle cx="3.5" cy="8" r=".8" /><circle cx="8" cy="8" r=".8" /><circle cx="12.5" cy="8" r=".8" /></>,
}

export function Icon({ name, size = 16, className = '', filled = false }: { name: IconName; size?: number; className?: string; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="wh-spinner" role="status" aria-live="polite">
      <span className="wh-spinner-ring" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  )
}

export function EmptyState({ title, body, action, error = false }: { title: string; body?: string; action?: ReactNode; error?: boolean }) {
  return (
    <div className="pk-empty-state" role={error ? 'alert' : action ? undefined : 'status'}>
      <strong className="pk-empty-title">{title}</strong>
      {body ? <p className="pk-empty-hint">{body}</p> : null}
      {action}
    </div>
  )
}

export function ErrorBox({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="wh-error" role="alert">
      <Icon name="alert" size={18} />
      <span>{message}</span>
      {onRetry ? <Button size="sm" onClick={onRetry}>{retryLabel || 'Retry'}</Button> : null}
    </div>
  )
}

export function MediaBadge({ mediaType, label }: { mediaType: MediaType; label?: string }) {
  const icon: IconName = mediaType === 'video' ? 'video' : mediaType === 'gif' ? 'gif' : mediaType === 'web' ? 'web' : 'image'
  return (
    <span className={`wh-media-badge wh-media-${mediaType}`}>
      <Icon name={icon} size={12} />
      {label || mediaType}
    </span>
  )
}

export function StatusDot({ state }: { state: EngineState | 'installed' | 'available' | 'unsupported' | 'error' }) {
  return <span className={`wh-status-dot wh-status-${state}`} aria-hidden="true" />
}

export function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`wh-field${wide ? ' wh-field-wide' : ''}`}>
      <span className="wh-field-label">{label}</span>
      {children}
      {hint ? <span className="wh-field-hint">{hint}</span> : null}
    </label>
  )
}

export function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="wh-section">
      <header className="wh-section-head">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
      <DialogOverlay />
      <DialogContent className="wh-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
        {children}
        <div className="wh-dialog-actions">
          <Button onClick={onClose} disabled={busy}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ProgressBar({ percent, label }: { percent?: number; label?: string }) {
  const value = Math.max(0, Math.min(100, percent ?? 0))
  return (
    <div className="wh-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-label={label}>
      <span style={{ width: `${value}%` }} />
    </div>
  )
}

export function formatResolution(width?: number, height?: number): string {
  return width && height ? `${width} × ${height}` : '—'
}

export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function formatDate(value?: number): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return '—'
  }
}

export function fitOptions(t: (key: I18nKey) => string, fits: WallpaperFit[]) {
  return fits.map(fit => ({ value: fit, label: t(`fit.${fit}` as I18nKey) }))
}

export function mediaLabel(t: (key: I18nKey) => string, mediaType: MediaType): string {
  return t(`media.${mediaType}` as I18nKey)
}

export function phaseLabel(t: (key: I18nKey) => string, phase: DownloadPhase | EngineInstallPhase): string {
  switch (phase) {
    case 'queued': return t('state.queued')
    case 'download': return t('state.loading')
    case 'downloading': return t('action.downloading')
    case 'verify':
    case 'verifying': return t('state.loading')
    case 'extract':
    case 'install': return t('action.install')
    case 'thumbnail': return t('state.loading')
    case 'done': return t('state.done')
    case 'failed': return t('state.failed')
    case 'cancelled': return t('state.cancelled')
    default: return String(phase)
  }
}

export function bytes(value?: number): string {
  return formatBytes(value)
}

export function IconButton({ icon, label, onClick, disabled, variant }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; variant?: string }) {
  return (
    <Tooltip content={label}>
      <Button className="wh-icon-btn" aria-label={label} title={label} onClick={onClick} disabled={disabled} variant={variant}>
        <Icon name={icon} />
      </Button>
    </Tooltip>
  )
}
