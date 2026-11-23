import type { ReactNode } from 'react'
import type { EngineSettings, WallpaperCapabilities } from '../shared/contracts'
import { FPS_LIMITS, VIDEO_QUALITIES } from '../shared/contracts'
import type { I18nKey } from '../i18n'
import { Button, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle, Select, Switch } from '../ui'
import { Icon, StatusDot } from './common'

interface EnginesViewProps {
  capabilities: WallpaperCapabilities | null
  settings: EngineSettings | null
  diagnostics: { engineId: string; lines: string[] } | null
  t: (key: I18nKey) => string
  onStop: () => void
  onDiagnostics: (engineId: string) => void
  onCloseDiagnostics: () => void
  onApplySettings: (patch: Partial<EngineSettings>) => void
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="wh-setting-row">
      <span className="wh-setting-label">{label}</span>
      <div className="wh-setting-control">{children}</div>
    </div>
  )
}

export function EnginesView({
  capabilities,
  settings,
  diagnostics,
  t,
  onStop,
  onDiagnostics,
  onCloseDiagnostics,
  onApplySettings,
}: EnginesViewProps) {
  if (!capabilities) return <div className="wh-view"><p className="wh-muted">{t('state.loading')}</p></div>
  const engine = capabilities.engines[0]
  const status = engine?.status ?? capabilities.engineStatus
  const running = status.state === 'running' || status.state === 'paused'
  const mediaTypes = engine?.capabilities.mediaTypes ?? ['video', 'gif', 'web']

  return (
    <div className="wh-view wh-engines-view">
      <div className="wh-engine-status">
        <StatusDot state={status.state === 'error' ? 'error' : running ? 'installed' : 'available'} />
        <strong>{engine?.descriptor.name ?? t('label.engine')}</strong>
        <span>{running ? t('state.running') : status.state === 'error' ? t('state.failed') : t('state.stopped')}</span>
        {status.message ? <span className="wh-muted">{status.message}</span> : null}
        <div className="wh-engine-status-actions">
          <Button size="sm" variant="ghost" onClick={() => onDiagnostics(capabilities.activeEngineId)}><Icon name="info" />{t('action.diagnostics')}</Button>
          {running ? <Button size="sm" onClick={onStop}><Icon name="stop" />{t('action.stop')}</Button> : null}
        </div>
      </div>

      <section className="wh-settings-section">
        <h2>{t('settings.performance')}</h2>
        <div className="wh-setting-list">
          <Row label={t('label.fps')}>
            <Select
              value={String(settings?.fpsLimit ?? 30)}
              options={FPS_LIMITS.map(value => ({ value: String(value), label: `${value} FPS` }))}
              onChange={value => onApplySettings({ fpsLimit: Number(value) as EngineSettings['fpsLimit'] })}
              ariaLabel={t('label.fps')}
              minWidth={160}
            />
          </Row>
          <Row label={t('label.quality')}>
            <Select
              value={settings?.quality ?? 'high'}
              options={[
                { value: 'low', label: t('quality.low') },
                { value: 'medium', label: t('quality.medium') },
                { value: 'high', label: t('quality.high') },
              ]}
              onChange={value => onApplySettings({ quality: value as EngineSettings['quality'] })}
              ariaLabel={t('label.quality')}
              minWidth={160}
            />
          </Row>
          <Row label={t('label.videoQuality')}>
            <Select
              value={settings?.videoQuality ?? '1080p'}
              options={VIDEO_QUALITIES.map(value => ({ value, label: t(`quality.${value}` as I18nKey) }))}
              onChange={value => onApplySettings({ videoQuality: value as EngineSettings['videoQuality'] })}
              ariaLabel={t('label.videoQuality')}
              minWidth={160}
            />
          </Row>
          <Row label={t('label.mute')}><Switch checked={settings?.mute ?? true} onCheckedChange={value => onApplySettings({ mute: value })} aria-label={t('label.mute')} /></Row>
          <Row label={t('label.pauseFullscreen')}><Switch checked={settings?.pauseOnFullscreen ?? true} onCheckedChange={value => onApplySettings({ pauseOnFullscreen: value })} aria-label={t('label.pauseFullscreen')} /></Row>
          <Row label={t('label.pauseBattery')}><Switch checked={settings?.pauseOnBattery ?? true} onCheckedChange={value => onApplySettings({ pauseOnBattery: value })} aria-label={t('label.pauseBattery')} /></Row>
          <Row label={t('label.pauseLock')}><Switch checked={settings?.pauseOnLock ?? true} onCheckedChange={value => onApplySettings({ pauseOnLock: value })} aria-label={t('label.pauseLock')} /></Row>
          <Row label={t('label.lowPower')}><Switch checked={settings?.lowPower ?? false} onCheckedChange={value => onApplySettings({ lowPower: value })} aria-label={t('label.lowPower')} /></Row>
        </div>
      </section>

      <section className="wh-settings-section">
        <h2>{t('label.capabilities')}</h2>
        <div className="wh-engine-caps">
          {mediaTypes.map(type => <span key={type}>{t(`media.${type}` as I18nKey)}</span>)}
          {engine?.capabilities.multipleMonitors ? <span>{t('label.multiMonitor')}</span> : null}
          {engine?.capabilities.fpsLimit ? <span>FPS</span> : null}
          {engine?.capabilities.pauseOnFullscreen ? <span>{t('label.pause')}</span> : null}
        </div>
      </section>

      <Dialog open={Boolean(diagnostics)} onOpenChange={open => { if (!open) onCloseDiagnostics() }}>
        <DialogOverlay />
        <DialogContent className="wh-dialog wh-dialog-wide">
          <DialogTitle>{t('action.diagnostics')}</DialogTitle>
          <DialogDescription>{diagnostics?.engineId}</DialogDescription>
          <pre className="wh-diagnostics">{diagnostics?.lines.join('\n')}</pre>
          <div className="wh-dialog-actions"><Button onClick={onCloseDiagnostics}>{t('action.close')}</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
