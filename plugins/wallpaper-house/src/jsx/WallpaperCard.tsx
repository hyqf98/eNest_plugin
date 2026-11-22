import { memo } from 'react'
import type { LibraryItem, MediaType, WallpaperItem } from '../shared/contracts'
import { formatBytes, resolutionLabel } from '../shared/contracts'
import { useLibraryThumbnail, useThumbnail } from '../js/useThumbnail'
import type { I18nKey } from '../i18n'
import { Button } from '../ui'
import { Icon, MediaBadge, formatDuration } from './common'

export interface GridItem {
  key: string
  item: WallpaperItem
  library?: LibraryItem
}

interface CardProps {
  entry: GridItem
  sourceName?: string
  t: (key: I18nKey) => string
  onOpen: (entry: GridItem) => void
  onSet: (entry: GridItem) => void
  onDownload?: (entry: GridItem) => void
  onFavorite?: (entry: GridItem, favorite: boolean) => void
  onRemove?: (entry: GridItem) => void
  busy?: boolean
}

export const WallpaperCard = memo(function WallpaperCard({ entry, sourceName, t, onOpen, onSet, onDownload, onFavorite, onRemove, busy }: CardProps) {
  const sourceThumb = useThumbnail(entry.library ? undefined : entry.item.thumbUrl, entry.item.thumbHeaders)
  const libraryThumb = useLibraryThumbnail(entry.library?.id ?? '')
  const thumb = entry.library ? libraryThumb : sourceThumb
  const isDynamic = entry.item.mediaType === 'video' || entry.item.mediaType === 'gif' || entry.item.mediaType === 'web'
  const color = entry.item.color || 'var(--wash)'
  return (
    <article className={`wh-card${busy ? ' wh-card-busy' : ''}`} data-media={entry.item.mediaType}>
      <button type="button" className="wh-card-open" onClick={() => onOpen(entry)} aria-label={`${entry.item.title} · ${t('action.openSource')}`}>
        <span className="wh-card-media" style={{ backgroundColor: color }}>
          {thumb.dataUrl ? <img src={thumb.dataUrl} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className={`wh-card-placeholder${thumb.loading ? ' wh-loading' : ''}`}><Icon name={entry.item.mediaType === 'video' ? 'play' : 'image'} size={22} /></span>}
          <span className="wh-card-badges">
            <MediaBadge mediaType={entry.item.mediaType} label={t(`media.${entry.item.mediaType}` as I18nKey)} />
            {isDynamic ? <span className="wh-card-dynamic">{t('media.dynamic')}</span> : null}
          </span>
          {entry.item.durationMs ? <span className="wh-card-duration">{formatDuration(entry.item.durationMs)}</span> : null}
        </span>
        <span className="wh-card-body">
          <strong className="wh-card-title" title={entry.item.title}>{entry.item.title}</strong>
          <span className="wh-card-meta">
            <span>{resolutionLabel(entry.item)}</span>
            <span aria-hidden="true">·</span>
            <span>{entry.library ? formatBytes(entry.library.bytes) : (sourceName || entry.item.sourceId)}</span>
          </span>
          {entry.item.author ? <span className="wh-card-author">{entry.item.author}</span> : null}
        </span>
      </button>
      <div className="wh-card-actions">
        <Button size="sm" variant="primary" onClick={() => onSet(entry)} disabled={busy}>{isDynamic ? t('action.setDynamic') : t('action.setWallpaper')}</Button>
        {entry.library ? (
          <>
            {onFavorite ? <Button size="sm" variant="ghost" aria-label={t('label.favorites')} title={t('label.favorites')} onClick={() => onFavorite(entry, !entry.library?.favorite)}><Icon name="star" filled={entry.library.favorite} /></Button> : null}
            {onRemove ? <Button size="sm" variant="ghost" aria-label={t('action.remove')} title={t('action.remove')} onClick={() => onRemove(entry)}><Icon name="trash" /></Button> : null}
          </>
        ) : onDownload ? (
          <Button size="sm" variant="ghost" aria-label={t('action.download')} title={t('action.download')} onClick={() => onDownload(entry)} disabled={busy}><Icon name="download" /></Button>
        ) : null}
      </div>
    </article>
  )
})

export function mediaIcon(mediaType: MediaType): 'image' | 'video' | 'gif' | 'web' {
  return mediaType === 'video' ? 'video' : mediaType === 'gif' ? 'gif' : mediaType === 'web' ? 'web' : 'image'
}
