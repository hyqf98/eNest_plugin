import { useId } from 'react'
import {
  Button, Input, Dialog, DialogOverlay, DialogContent, DialogTitle, DialogDescription,
} from '@dsh/ui/index.jsx'

export function SectionHeading({ title, description, actions }) {
  return (
    <header className="dsh-settings-section-heading">
      <div className="dsh-settings-heading-copy">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="dsh-settings-actions">{actions}</div>}
    </header>
  )
}

export function Panel({ title, description, children, className = '', actions }) {
  return (
    <section className={`dsh-settings-panel ${className}`}>
      {(title || actions) && (
        <header className="dsh-settings-panel-heading">
          <div className="dsh-settings-heading-copy">
            {title && <h3>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="dsh-settings-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Field({ label, hint, htmlFor, children, className = '' }) {
  return (
    <div className={`dsh-settings-field ${className}`}>
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="dsh-settings-label">{label}</span>}
      {children}
      {hint && <p className="dsh-settings-help">{hint}</p>}
    </div>
  )
}

export function InlineMessage({ kind = 'error', children, actions }) {
  if (!children) return null
  return (
    <div className={`dsh-settings-message dsh-settings-message-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div>{children}</div>
      {actions && <div className="dsh-settings-actions">{actions}</div>}
    </div>
  )
}

export function LoadingBlock({ label = '正在读取…' }) {
  return (
    <div className="dsh-settings-loading" role="status" aria-label={label}>
      <span>{label}</span>
      <div className="dsh-settings-skeleton" aria-hidden="true" />
      <div className="dsh-settings-skeleton dsh-settings-skeleton-short" aria-hidden="true" />
    </div>
  )
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="dsh-settings-empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="dsh-settings-actions">{action}</div>}
    </div>
  )
}

export function Facts({ items }) {
  return (
    <dl className="dsh-settings-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value == null || value === '' ? '未提供' : value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ConfirmAction({ confirmation, phrase, setPhrase, pending, error, onClose, onConfirm }) {
  const inputId = useId()
  return (
    <Dialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open && !pending) onClose() }}>
      {confirmation && (
        <>
          <DialogOverlay className="pk-dialog-overlay dsh-settings-dialog-overlay" />
          <DialogContent
            className="dsh-settings-dialog"
            onEscapeKeyDown={(event) => { if (pending) event.preventDefault() }}
            onInteractOutside={(event) => { if (pending) event.preventDefault() }}
          >
            <DialogTitle>{confirmation.title}</DialogTitle>
            <DialogDescription>{confirmation.description}</DialogDescription>
            {confirmation.detail && <div className="dsh-settings-confirm-detail">{confirmation.detail}</div>}
            {confirmation.phrase && (
              <Field label={`输入 ${confirmation.phrase} 确认`} htmlFor={inputId}>
                <Input
                  id={inputId} value={phrase} autoComplete="off" spellCheck={false}
                  disabled={pending} onChange={(event) => setPhrase(event.target.value)}
                />
              </Field>
            )}
            <InlineMessage>{error}</InlineMessage>
            <div className="dsh-settings-dialog-actions">
              <Button disabled={pending} onClick={onClose}>取消</Button>
              <Button
                variant={confirmation.danger ? 'danger' : 'primary'}
                disabled={pending || Boolean(confirmation.phrase && phrase !== confirmation.phrase)}
                onClick={onConfirm}
              >{pending ? '正在处理…' : confirmation.label || '确认'}</Button>
            </div>
          </DialogContent>
        </>
      )}
    </Dialog>
  )
}
