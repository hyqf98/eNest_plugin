import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AppSettings,
  DiagnosticsReport,
  LibraryFolderResult,
  RotationSettings,
  SourceListEntry,
  SourceScriptInfo,
  WallpaperCapabilities,
  WallpaperFit,
} from '../shared/contracts'
import { DEFAULT_ENGINE_SETTINGS, FPS_LIMITS, VIDEO_QUALITIES } from '../shared/contracts'
import type { I18nKey } from '../i18n'
import { Button, Input, Select, Switch } from '../ui'
import { Icon, StatusDot, fitOptions, formatDate } from './common'

interface SettingsViewProps {
  settings: AppSettings | null
  folder: LibraryFolderResult | null
  sources: SourceListEntry[]
  rotation: RotationSettings | null
  capabilities: WallpaperCapabilities | null
  scripts: SourceScriptInfo[]
  diagnostics: DiagnosticsReport | null
  busy: boolean
  t: (key: I18nKey) => string
  onUpdate: (patch: Partial<AppSettings>) => void
  onPickFolder: () => void
  onUseDefaultFolder: () => void
  onSaveKey: (sourceId: string, key: string) => void
  onRemoveKey: (sourceId: string) => void
  onToggleSource: (sourceId: string, enabled: boolean) => void
  onToggleBackground: (enabled: boolean) => void
  onUpdateRotation: (patch: Partial<RotationSettings>) => void
  onNextRotation: () => void
  onInstallScriptFile: () => void
  onInstallScriptUrl: (url: string) => void
  onToggleScript: (id: string, enabled: boolean) => void
  onRemoveScript: (id: string) => void
  onRefreshDiagnostics: () => void
  onOpenExternal: (url: string) => void
}

function Row({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`wh-setting-row${wide ? ' wide' : ''}`}>
      <span className="wh-setting-label">{label}</span>
      <div className="wh-setting-control">{children}</div>
    </div>
  )
}

export function SettingsView({
  settings,
  folder,
  sources,
  rotation,
  capabilities,
  scripts,
  diagnostics,
  busy,
  t,
  onUpdate,
  onPickFolder,
  onUseDefaultFolder,
  onSaveKey,
  onRemoveKey,
  onToggleSource,
  onToggleBackground,
  onUpdateRotation,
  onNextRotation,
  onInstallScriptFile,
  onInstallScriptUrl,
  onToggleScript,
  onRemoveScript,
  onRefreshDiagnostics,
  onOpenExternal,
}: SettingsViewProps) {
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [scriptUrl, setScriptUrl] = useState('')
  const fits = capabilities?.static.fits ?? ['fill', 'fit', 'stretch', 'center', 'tile', 'span']
  const engineSettings = settings?.engineSettings ?? DEFAULT_ENGINE_SETTINGS

  return (
    <div className="wh-view wh-settings-view">
      <section className="wh-settings-section">
        <h2>{t('settings.general')}</h2>
        <div className="wh-setting-list">
          <Row label={t('label.background')}>
            <Switch checked={settings?.backgroundEnabled ?? false} onCheckedChange={onToggleBackground} disabled={busy} aria-label={t('label.background')} />
          </Row>
          <Row label={t('label.fit')}>
            <Select
              value={settings?.defaultFit ?? 'fill'}
              options={fitOptions(t, fits as WallpaperFit[])}
              onChange={value => onUpdate({ defaultFit: value as WallpaperFit })}
              ariaLabel={t('label.fit')}
              minWidth={180}
            />
          </Row>
        </div>
      </section>

      <section className="wh-settings-section">
        <h2>{t('settings.library')}</h2>
        <div className="wh-setting-list">
          <Row label={t('label.directory')} wide>
            <code className="wh-path">{settings?.libraryPath || t('state.notConfigured')}</code>
            <Button size="sm" onClick={onPickFolder} disabled={busy}><Icon name="folder" />{t('action.chooseFolder')}</Button>
            <Button size="sm" variant="ghost" onClick={onUseDefaultFolder} disabled={busy}>{t('action.useDefaultFolder')}</Button>
          </Row>
          {folder?.path && folder.writable === false ? (
            <Row label={t('label.status')} wide>
              <span className="wh-setting-error"><Icon name="alert" size={14} />{folder.message || t('error.libraryNotWritable')}</span>
            </Row>
          ) : null}
        </div>
      </section>

      <section className="wh-settings-section">
        <h2>{t('settings.sources')}</h2>
        <div className="wh-source-settings">
          {sources.map(source => (
            <article key={source.id} className="wh-source-setting">
              <header>
                <div className="wh-source-title">
                  <strong>{source.name}</strong>
                  <span>{source.mediaTypes.map(type => t(`media.${type}` as I18nKey)).join(' · ')}</span>
                  {source.requiresKey ? <span className={`wh-key-state${source.hasKey ? ' saved' : ''}`}>{source.hasKey ? t('label.stored') : t('label.notStored')}</span> : null}
                </div>
                <Switch checked={source.enabled} onCheckedChange={value => onToggleSource(source.id, value)} disabled={busy} aria-label={`${source.name} ${source.enabled ? t('source.enabled') : t('source.disabled')}`} />
              </header>
              {source.requiresKey ? (
                <div className="wh-key-row">
                  <Input
                    type="password"
                    value={keyDrafts[source.id] ?? ''}
                    placeholder={t('placeholder.apiKey')}
                    onChange={event => setKeyDrafts(current => ({ ...current, [source.id]: event.target.value }))}
                    aria-label={`${source.name} ${t('label.apiKey')}`}
                  />
                  <Button size="sm" onClick={() => { onSaveKey(source.id, keyDrafts[source.id] ?? ''); setKeyDrafts(current => ({ ...current, [source.id]: '' })) }} disabled={busy || !(keyDrafts[source.id] ?? '').trim()}>{t('action.save')}</Button>
                  {source.hasKey ? <Button size="sm" variant="ghost" onClick={() => onRemoveKey(source.id)} disabled={busy}>{t('action.removeKey')}</Button> : null}
                  {source.keyUrl ? <Button size="sm" variant="ghost" onClick={() => onOpenExternal(source.keyUrl as string)}><Icon name="external" />{t('action.openSource')}</Button> : null}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="wh-settings-section">
        <div className="wh-section-bar">
          <h2>{t('settings.rotation')}</h2>
          <Button size="sm" onClick={onNextRotation} disabled={busy || !rotation?.enabled}>{t('action.next')}</Button>
        </div>
        {rotation ? (
          <div className="wh-setting-list">
            <Row label={t('label.enableRotation')}><Switch checked={rotation.enabled} onCheckedChange={value => onUpdateRotation({ enabled: value })} aria-label={t('settings.rotation')} /></Row>
            <Row label={t('label.interval')}>
              <Select
                value={String(rotation.intervalMinutes)}
                options={[15, 30, 60, 180, 360, 720, 1440].map(value => ({ value: String(value), label: value < 60 ? `${value} ${t('unit.minutes')}` : `${Math.round(value / 60)} ${t('unit.hours')}` }))}
                onChange={value => onUpdateRotation({ intervalMinutes: Number(value) })}
                ariaLabel={t('label.interval')}
                minWidth={160}
              />
            </Row>
            <Row label={t('label.rotationSource')}>
              <Select value={rotation.source} options={[{ value: 'library', label: t('library.title') }, { value: 'favorites', label: t('favorites.title') }]} onChange={value => onUpdateRotation({ source: value as RotationSettings['source'] })} ariaLabel={t('settings.rotation')} minWidth={160} />
            </Row>
            <Row label={t('label.order')}>
              <Select value={rotation.order} options={[{ value: 'sequential', label: t('order.sequential') }, { value: 'random', label: t('order.random') }]} onChange={value => onUpdateRotation({ order: value as RotationSettings['order'] })} ariaLabel={t('label.order')} minWidth={160} />
            </Row>
            <Row label={t('label.fit')}>
              <Select value={rotation.fit} options={fitOptions(t, fits as WallpaperFit[])} onChange={value => onUpdateRotation({ fit: value as WallpaperFit })} ariaLabel={t('label.fit')} minWidth={160} />
            </Row>
            <Row label={t('label.includeDynamic')}><Switch checked={rotation.includeDynamic} onCheckedChange={value => onUpdateRotation({ includeDynamic: value })} aria-label={t('label.includeDynamic')} /></Row>
          </div>
        ) : null}
      </section>

      <section className="wh-settings-section">
        <h2>{t('settings.performance')}</h2>
        <div className="wh-setting-list">
          <Row label={t('label.fps')}>
            <Select
              value={String(engineSettings.fpsLimit)}
              options={FPS_LIMITS.map(value => ({ value: String(value), label: `${value} FPS` }))}
              onChange={value => onUpdate({ engineSettings: { ...engineSettings, fpsLimit: Number(value) as 24 | 30 | 60 } })}
              ariaLabel={t('label.fps')}
              minWidth={160}
            />
          </Row>
          <Row label={t('label.quality')}>
            <Select value={engineSettings.quality} options={[{ value: 'low', label: t('quality.low') }, { value: 'medium', label: t('quality.medium') }, { value: 'high', label: t('quality.high') }]} onChange={value => onUpdate({ engineSettings: { ...engineSettings, quality: value as typeof engineSettings.quality } })} ariaLabel={t('label.quality')} minWidth={160} />
          </Row>
          <Row label={t('label.videoQuality')}>
            <Select
              value={engineSettings.videoQuality}
              options={VIDEO_QUALITIES.map(value => ({ value, label: t(`quality.${value}` as I18nKey) }))}
              onChange={value => onUpdate({ engineSettings: { ...engineSettings, videoQuality: value as typeof engineSettings.videoQuality } })}
              ariaLabel={t('label.videoQuality')}
              minWidth={160}
            />
          </Row>
          <Row label={t('label.mute')}><Switch checked={engineSettings.mute} onCheckedChange={value => onUpdate({ engineSettings: { ...engineSettings, mute: value } })} aria-label={t('label.mute')} /></Row>
          <Row label={t('label.pauseFullscreen')}><Switch checked={engineSettings.pauseOnFullscreen} onCheckedChange={value => onUpdate({ engineSettings: { ...engineSettings, pauseOnFullscreen: value } })} aria-label={t('label.pauseFullscreen')} /></Row>
          <Row label={t('label.pauseBattery')}><Switch checked={engineSettings.pauseOnBattery} onCheckedChange={value => onUpdate({ engineSettings: { ...engineSettings, pauseOnBattery: value } })} aria-label={t('label.pauseBattery')} /></Row>
          <Row label={t('label.pauseLock')}><Switch checked={engineSettings.pauseOnLock} onCheckedChange={value => onUpdate({ engineSettings: { ...engineSettings, pauseOnLock: value } })} aria-label={t('label.pauseLock')} /></Row>
          <Row label={t('label.lowPower')}><Switch checked={engineSettings.lowPower} onCheckedChange={value => onUpdate({ engineSettings: { ...engineSettings, lowPower: value } })} aria-label={t('label.lowPower')} /></Row>
        </div>
      </section>

      <section className="wh-settings-section">
        <div className="wh-section-bar">
          <h2>{t('settings.scripts')}</h2>
          <Button size="sm" onClick={onInstallScriptFile} disabled={busy}><Icon name="upload" />{t('action.installScript')}</Button>
        </div>
        <div className="wh-script-url">
          <Input value={scriptUrl} onChange={event => setScriptUrl(event.target.value)} placeholder={t('placeholder.scriptUrl')} aria-label={t('placeholder.scriptUrl')} />
          <Button size="sm" onClick={() => { onInstallScriptUrl(scriptUrl.trim()); setScriptUrl('') }} disabled={busy || !scriptUrl.trim()}>{t('action.installFromUrl')}</Button>
        </div>
        <div className="wh-script-list">
          {scripts.length ? scripts.map(script => (
            <div key={script.id} className="wh-script-row">
              <div>
                <strong>{script.name}</strong>
                <span>{script.id} · v{script.version} · {formatDate(script.installedAt)}</span>
              </div>
              <Switch checked={script.enabled} onCheckedChange={value => onToggleScript(script.id, value)} disabled={busy} aria-label={script.name} />
              <Button size="sm" variant="ghost" onClick={() => onRemoveScript(script.id)} disabled={busy}><Icon name="trash" /></Button>
            </div>
          )) : <p className="wh-muted">{t('state.empty')}</p>}
        </div>
      </section>

      <section className="wh-settings-section">
        <div className="wh-section-bar">
          <h2>{t('settings.diagnostics')}</h2>
          <Button size="sm" onClick={onRefreshDiagnostics} disabled={busy}><Icon name="refresh" />{t('action.refresh')}</Button>
        </div>
        {diagnostics ? (
          <div className="wh-setting-list">
            <Row label="Platform"><span>{diagnostics.platform}-{diagnostics.arch}</span></Row>
            <Row label={t('label.engine')}><span className="wh-inline-status"><StatusDot state={diagnostics.helperInstalled ? 'installed' : 'unsupported'} />{diagnostics.helperTarget} · {diagnostics.helperInstalled ? t('state.installed') : t('state.notInstalled')}</span></Row>
            <Row label={t('library.title')}><span>{diagnostics.libraryCount} {t('unit.items')}</span></Row>
          </div>
        ) : <p className="wh-muted">{t('state.notConfigured')}</p>}
      </section>
    </div>
  )
}
