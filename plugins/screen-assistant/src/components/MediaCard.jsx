import { Icon } from './Icon.jsx'
import { LazyThumb } from './Thumb.jsx'
import { formatClock, formatTime } from '../lib/format.js'

export function MediaCard({ item, ensureThumb, onOpen, onEdit, onExport }) {
  return (
    <div
      className="sa-card"
      role="button"
      tabIndex={0}
      aria-label={`打开 ${item.name}`}
      data-kind={item.kind}
      onClick={() => onOpen(item)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item) }
      }}
    >
      <LazyThumb item={item} ensureThumb={ensureThumb} alt={item.name} />
      {item.kind === 'video' ? (
        <span className="sa-play" aria-hidden="true"><span><Icon name="play" size={15} /></span></span>
      ) : null}
      <span className="sa-card-meta">
        <span>{formatTime(item.createdAt)}</span>
        {item.durationMs ? <span className="sa-dur">{formatClock(item.durationMs)}</span> : item.kind === 'gif' ? <span className="sa-dur">GIF</span> : null}
      </span>
      <span className="sa-card-actions">
        {item.kind === 'image' ? (
          <button type="button" title="编辑" aria-label="编辑" onClick={event => { event.stopPropagation(); onEdit(item) }}>
            <Icon name="edit" />
          </button>
        ) : null}
        <button type="button" title="导出" aria-label="导出" onClick={event => { event.stopPropagation(); onExport(item) }}>
          <Icon name="download" />
        </button>
      </span>
    </div>
  )
}
