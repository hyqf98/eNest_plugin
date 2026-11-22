import { useEffect, useMemo, useState } from 'react'
import type { DisplayInfo, MediaPreviewResult, VideoPreviewResult, WallpaperFit } from '../shared/contracts'
import { formatBytes, resolutionLabel } from '../shared/contracts'
import { media } from '../js/api'
import { useThumbnail } from '../js/useThumbnail'
import type { I18nKey } from '../i18n'
import { Button, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle, Select } from '../ui'
import { Icon, MediaBadge, Spinner, fitOptions, formatDuration } from './common'
import type { GridItem } from './WallpaperCard'

interface DetailProps {
  entry: GridItem | null
  sourceName?: string
  t: (key: I18nKey) => string
  displays: DisplayInfo[]
  fits: WallpaperFit[]
  defaultFit: WallpaperFit
  busy: boolean
  onClose: () => void
  onSetStatic: (entry: GridItem, fit: WallpaperFit, displays: string[]) => void
  onSetDynamic: (entry: GridItem) => void
  onDownload?: (entry: GridItem) => void
  onFavorite?: (entry: GridItem, favorite: boolean) => void
  onRemove?: (entry: GridItem) => void
  onOpenSource: (url: string) => void
}

export function DetailSheet({
  entry,
  sourceName,
  t,
  displays,
  fits,
  defaultFit,
  busy,
  onClose,
  onSetStatic,
  onSetDynamic,
  onDownload,
  onFavorite,
  onRemove,
  onOpenSource,
}: DetailProps) {
  const [preview, setPreview] = useState<MediaPreviewResult | null>(null)
  const [video, setVideo] = useState<VideoPreviewResult | null>(null)
  const [videoError, setVideoError] = useState('')
  const [loading, setLoading] = useState(false)
  const [fit, setFit] = useState<WallpaperFit>(defaultFit)
  const [selectedDisplays, setSelectedDisplays] = useState<string[]>([])
  const thumb = useThumbnail(entry?.item.thumbUrl, entry?.item.thumbHeaders)
  const item = entry?.item

  useEffect(() => {
    if (!entry || !item) {
      setPreview(null)
      return
    }
    setFit(defaultFit)
    setSelectedDisplays([])
    if (item.mediaType === 'video') {
      setPreview(null)
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const request = entry.library ? media.libraryPreview(entry.library.id) : media.preview(item)
    void request.then(result => {
      if (!cancelled) setPreview(result)
    }).catch(error => {
      if (!cancelled) setPreview({ dataUrl: null, mediaType: item.mediaType, message: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [entry, item, defaultFit])

  useEffect(() => {
    if (!entry || !item || item.mediaType !== 'video') {
      setVideo(null)
      setVideoError('')
      return
    }
    let cancelled = false
    let token: string | undefined
    setVideo(null)
    setVideoError('')
    const request = entry.library ? media.video({ libraryId: entry.library.id }) : media.video({ item })
    void request.then(result => {
      if (cancelled) {
        void media.releaseVideo(result.token).catch(() => {})
        return
      }
      token = result.token
      setVideo(result)
    }).catch(error => {
      if (!cancelled) setVideoError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
      if (token) void media.releaseVideo(token).catch(() => {})
    }
  }, [entry?.key, entry?.library?.id, item?.mediaType])

  const dynamic = item ? item.mediaType === 'video' || item.mediaType === 'gif' || item.mediaType === 'web' : false
  const meta = useMemo(() => {
    if (!item) return []
    const rows: Array<[string, string]> = []
    rows.push([t('label.source'), sourceName || item.sourceId])
    if (item.author) rows.push([t('label.author'), item.author])
    rows.push([t('label.resolution'), resolutionLabel(item)])
    if (item.fileSize) rows.push([t('label.size'), formatBytes(item.fileSize)])
    if (item.durationMs) rows.push([t('label.duration'), formatDuration(item.durationMs)])
    if (item.license) rows.push([t('label.license'), item.license])
    if (item.attribution) rows.push([t('label.attribution'), item.attribution])
    return rows
  }, [item, sourceName, t])

  const description = typeof item?.meta?.description === 'string' ? item.meta.description : undefined
  const previewSource = preview?.dataUrl || thumb.dataUrl
  const showUnsupportedExport = item && !item.exportAllowed

  return (
    <Dialog open={Boolean(entry)} onOpenChange={value => { if (!value) onClose() }}>
      <DialogOverlay />
      <DialogContent className="wh-detail" aria-describedby="wh-detail-description">
        {!entry || !item ? null : (
          <>
            <header className="wh-detail-head">
              <div>
                <DialogTitle>{item.title}</DialogTitle>
                <DialogDescription id="wh-detail-description">
                  <MediaBadge mediaType={item.mediaType} label={t(`media.${item.mediaType}` as I18nKey)} />
                  {item.sourceUrl ? <button type="button" className="wh-link" onClick={() => onOpenSource(item.sourceUrl as string)}>{t('action.openSource')}<Icon name="external" size={12} /></button> : null}
                </DialogDescription>
              </div>
              <Button className="wh-icon-btn" variant="ghost" aria-label={t('action.close')} onClick={onClose}><Icon name="close" /></Button>
            </header>

            <div className="wh-detail-layout">
              <div className="wh-detail-media" style={{ backgroundColor: item.color || 'var(--wash)' }}>
                {item.mediaType === 'video' ? (
                  video ? (
                    <video className="wh-detail-video" src={video.url} poster={previewSource || undefined} controls autoPlay muted loop playsInline />
                  ) : (
                    <div className="wh-detail-placeholder"><Spinner label={t('state.loading')} />{videoError ? <span>{videoError}</span> : null}</div>
                  )
                ) : loading ? <Spinner label={t('state.loading')} /> : previewSource ? (
                  <img src={previewSource} alt={item.title} decoding="async" />
                ) : (
                  <div className="wh-detail-placeholder"><Icon name={dynamic ? 'play' : 'image'} size={36} /><span>{preview?.message || t('state.empty')}</span></div>
                )}
                {dynamic ? <span className="wh-detail-dynamic"><Icon name="play" size={12} />{t('action.setDynamic')}</span> : null}
              </div>

              <div className="wh-detail-side">
                <dl className="wh-meta">
                  {meta.map(([label, value]) => (
                    <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>
                  ))}
                </dl>
                {description ? <p className="wh-detail-description">{description}</p> : null}
                {item.tags?.length ? <div className="wh-tags">{item.tags.slice(0, 12).map(tag => <span key={tag}>{tag}</span>)}</div> : null}
                {showUnsupportedExport ? <p className="wh-hint"><Icon name="info" size={14} />{t('hint.exportBlocked')}</p> : null}

                <div className="wh-detail-controls">
                  {fits.length > 1 ? (
                    <label className="wh-inline-field">
                      <span>{t('label.fit')}</span>
                      <Select value={fit} options={fitOptions(t, fits)} onChange={value => setFit(value as WallpaperFit)} ariaLabel={t('label.fit')} />
                    </label>
                  ) : null}
                  {displays.length > 1 ? (
                    <div className="wh-display-picker" role="group" aria-label={t('label.displays')}>
                      <button type="button" className={`wh-chip${!selectedDisplays.length ? ' active' : ''}`} onClick={() => setSelectedDisplays([])}>{t('label.all')}</button>
                      {displays.map(display => (
                        <button
                          key={display.id}
                          type="button"
                          className={`wh-chip${selectedDisplays.includes(display.id) ? ' active' : ''}`}
                          onClick={() => setSelectedDisplays(current => current.includes(display.id) ? current.filter(id => id !== display.id) : [...current, display.id])}
                          title={display.name}
                        >
                          {display.name}
                          {display.width ? <small>{display.width}×{display.height}</small> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="wh-detail-actions">
                  {!dynamic ? (
                    <Button variant="primary" onClick={() => onSetStatic(entry, fit, selectedDisplays)} disabled={busy}>
                      <Icon name="monitor" />{t('action.setWallpaper')}
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={() => onSetDynamic(entry)} disabled={busy}>
                      <Icon name="play" />{t('action.setDynamic')}
                    </Button>
                  )}
                  {!entry.library && onDownload ? (
                    <Button onClick={() => onDownload(entry)} disabled={busy}><Icon name="download" />{t('action.download')}</Button>
                  ) : null}
                  {entry.library && onFavorite ? (
                    <Button onClick={() => onFavorite(entry, !entry.library?.favorite)} disabled={busy}>
                      <Icon name="star" filled={entry.library.favorite} />{t('label.favorites')}
                    </Button>
                  ) : null}
                  {entry.library && onRemove ? (
                    <Button variant="danger" onClick={() => onRemove(entry)} disabled={busy}><Icon name="trash" />{t('action.remove')}</Button>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
