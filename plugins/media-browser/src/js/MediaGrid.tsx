/**
 * 右侧网格：图片与视频同一套卡片；视频只在缩略图上叠一个播放按钮。
 * 单击图片放大预览，单击视频播放；Shift 范围选、Ctrl/Cmd 追加选；卡片可拖拽到左侧文件夹。
 */

import { memo, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Play } from '@phosphor-icons/react'
import type { MediaItem } from '../shared/contracts'
import { DRAG_TYPE } from './FolderTree'

export interface GridActions {
  clickGrid(item: MediaItem, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void
  open(item: MediaItem): void
  /** 右键菜单；event 已由调用方 preventDefault */
  contextMenu(item: MediaItem, event: MouseEvent): void
}

interface GridProps {
  items: MediaItem[]
  selected: Set<string>
  thumbFailed: Set<string>
  onThumbError(entryId: string): void
  actions: GridActions
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 进入视口才开始加载的缩略图 */
function LazyThumb({ src, alt, failed, onError }: { src: string | null | undefined; alt: string; failed: boolean; onError(): void }) {
  const ref = useRef<HTMLImageElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '400px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <img
      ref={ref}
      className="mb-card-img"
      src={visible && !failed ? src ?? undefined : undefined}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={onError}
    />
  )
}

const LazyThumbMemo = memo(LazyThumb)

const Card = memo(function Card({ item, selected, selectedIds, failed, onThumbError, actions }: {
  item: MediaItem
  selected: boolean
  /** 当前全部选中的条目，多选拖拽时一并带上 */
  selectedIds: string[]
  failed: boolean
  onThumbError(entryId: string): void
  actions: GridActions
}) {
  const isVideo = item.kind === 'video'
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={item.name}
      draggable
      tabIndex={0}
      data-entry-id={item.entryId}
      className={`mb-card${selected ? ' is-selected' : ''}`}
      title={`${item.name}${item.size ? ` · ${formatSize(item.size)}` : ''}`}
      onClick={(event: MouseEvent) => {
        actions.clickGrid(item, event)
        // 单击（无修饰键）直接打开；Shift/Cmd 只改选择
        if (!(event.shiftKey || event.metaKey || event.ctrlKey)) actions.open(item)
      }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); actions.open(item) } }}
      onContextMenu={event => actions.contextMenu(item, event)}
      onDragStart={event => {
        // 选中多张时拖拽带上全部选中项，否则只拖当前这一张
        const payload = selected && selectedIds.length > 1 ? selectedIds : [item.entryId]
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload))
        event.dataTransfer.effectAllowed = 'move'
      }}
    >
      <div className={`mb-card-frame${isVideo ? ' is-video' : ''}`}>
        <LazyThumbMemo src={item.thumbUrl} alt={item.name} failed={failed} onError={() => onThumbError(item.entryId)} />
        {failed ? <div className="mb-card-placeholder">{item.ext.toUpperCase() || 'FILE'}</div> : null}
        {isVideo ? (
          <span className="mb-card-play" aria-hidden="true">
            <Play size={22} weight="fill" />
          </span>
        ) : null}
      </div>
      <div className="mb-card-name">{item.name}</div>
    </div>
  )
})

export function MediaGrid({ items, selected, thumbFailed, onThumbError, actions }: GridProps) {
  const selectedIds = [...selected]
  return (
    <div className="mb-grid" role="listbox" aria-multiselectable="true">
      {items.map(item => (
        <Card key={item.entryId} item={item} selected={selected.has(item.entryId)} selectedIds={selectedIds} failed={thumbFailed.has(item.entryId)} onThumbError={onThumbError} actions={actions} />
      ))}
    </div>
  )
}
