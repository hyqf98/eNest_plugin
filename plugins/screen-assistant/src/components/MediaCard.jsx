import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.jsx'
import { LazyThumb } from './Thumb.jsx'
import { formatClock, formatTime } from '../lib/format.js'

/** 两次点击才执行：首次点击变红确认，超时或移出卡片后撤销。 */
function useArmedAction(onConfirm) {
  const [armed, setArmed] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const trigger = event => {
    event.stopPropagation()
    if (!armed) {
      setArmed(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setArmed(false), 3200)
      return
    }
    clearTimeout(timer.current)
    setArmed(false)
    onConfirm()
  }
  const disarm = () => { clearTimeout(timer.current); setArmed(false) }
  return { armed, trigger, disarm }
}

export function MediaCard({ item, ensureThumb, onOpen, onEdit, onExport, onDelete, selected, onToggleSelect, selectable }) {
  const remove = useArmedAction(() => { void onDelete([item]) })
  return (
    <div
      className={`sa-card${selected ? ' is-selected' : ''}${selectable ? ' is-selectable' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`打开 ${item.name}`}
      aria-pressed={selectable ? selected : undefined}
      data-kind={item.kind}
      onClick={() => (selectable ? onToggleSelect(item) : onOpen(item))}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); (selectable ? onToggleSelect(item) : onOpen(item)) }
      }}
    >
      <LazyThumb item={item} ensureThumb={ensureThumb} alt={item.name} />
      {item.kind === 'video' ? (
        <span className="sa-play" aria-hidden="true"><span><Icon name="play" size={15} /></span></span>
      ) : null}
      {selectable ? (
        <span className="sa-check" aria-hidden="true"><Icon name="check" size={12} /></span>
      ) : null}
      <span className="sa-card-meta">
        <span>{formatTime(item.createdAt)}</span>
        {item.durationMs ? <span className="sa-dur">{formatClock(item.durationMs)}</span> : item.kind === 'gif' ? <span className="sa-dur">GIF</span> : null}
      </span>
      {selectable ? null : (
        <span className="sa-card-actions">
          {item.kind === 'image' ? (
            <button type="button" title="编辑" aria-label="编辑" onClick={event => { event.stopPropagation(); onEdit(item) }}>
              <Icon name="edit" />
            </button>
          ) : null}
          <button type="button" title="导出" aria-label="导出" onClick={event => { event.stopPropagation(); onExport(item) }}>
            <Icon name="download" />
          </button>
          <button type="button" className={remove.armed ? 'armed' : 'danger'} title={remove.armed ? '再点一次确认删除' : '删除'}
            aria-label={remove.armed ? '确认删除' : '删除'} onClick={remove.trigger}>
            <Icon name="trash" />
          </button>
        </span>
      )}
    </div>
  )
}
