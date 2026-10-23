import { useId } from 'react'
import {
  Button, Input, Dialog, DialogOverlay, DialogContent, DialogTitle, DialogDescription,
} from '@dsh/ui/index.jsx'

export const INSTALL_PHASES = {
  'upgrade-start': '准备升级', backup: '创建备份', 'download-start': '准备下载', download: '下载资产',
  verify: '校验资产', extract: '解包安装', installed: '安装完成', 'health-check': '健康检查',
  activated: '激活完成', 'upgrade-done': '升级完成', rollback: '正在回滚', error: '操作失败',
}
export const INSTALL_STAGES = [
  { label: '备份', phases: ['upgrade-start', 'backup'] },
  { label: '下载与校验', phases: ['download-start', 'download', 'verify'] },
  { label: '安装', phases: ['extract', 'installed'] },
  { label: '检查与激活', phases: ['health-check', 'activated', 'upgrade-done'] },
]

export function InstallProgress({ progress, pending, title }) {
  if (!progress && !pending) return null
  const percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : null
  return (
    <section className="dsh-settings-install-progress" aria-live="polite">
      <div className="dsh-settings-row">
        <strong>{title || (pending ? '操作进度' : '最近一次安装进度')}</strong>
        {percent != null && <span className="dsh-settings-mono">{percent}%</span>}
      </div>
      <ol className="dsh-settings-stages" aria-label="宿主报告的当前阶段">
        {INSTALL_STAGES.map((stage) => <li key={stage.label} aria-current={stage.phases.includes(progress?.phase) ? 'step' : undefined}>{stage.label}</li>)}
      </ol>
      <p>{progress ? INSTALL_PHASES[progress.phase] || progress.phase : pending}{progress?.detail && <span className="dsh-settings-progress-detail">{progress.detail}</span>}</p>
    </section>
  )
}

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
