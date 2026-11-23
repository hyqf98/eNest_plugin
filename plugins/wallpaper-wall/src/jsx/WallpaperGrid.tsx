import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { I18nKey } from '../i18n'
import type { GridItem } from './WallpaperCard'
import { WallpaperCard } from './WallpaperCard'
import { EmptyState, Spinner } from './common'

interface GridProps {
  items: GridItem[]
  sourceNames: Record<string, string>
  t: (key: I18nKey) => string
  loading: boolean
  error?: string
  hasMore: boolean
  onLoadMore: () => void
  onOpen: (entry: GridItem) => void
  onSet: (entry: GridItem) => void
  onDownload?: (entry: GridItem) => void
  onFavorite?: (entry: GridItem, favorite: boolean) => void
  onRemove?: (entry: GridItem) => void
  busyKey?: string
  emptyTitle: string
  emptyBody?: string
  emptyAction?: ReactNode
  minCardWidth?: number
}

const GAP = 14

export function WallpaperGrid({
  items,
  sourceNames,
  t,
  loading,
  error,
  hasMore,
  onLoadMore,
  onOpen,
  onSet,
  onDownload,
  onFavorite,
  onRemove,
  busyKey,
  emptyTitle,
  emptyBody,
  emptyAction,
  minCardWidth = 220,
}: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(960)
  const [columns, setColumns] = useState(3)

  useLayoutEffect(() => {
    const element = parentRef.current
    if (!element) return
    const update = () => {
      const nextWidth = Math.max(280, element.clientWidth)
      setWidth(nextWidth)
      setColumns(Math.max(1, Math.floor((nextWidth + GAP) / (minCardWidth + GAP))))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [minCardWidth])

  const cardWidth = Math.max(120, (width - GAP * (columns - 1)) / columns)
  const rowHeight = Math.round(cardWidth * 0.625 + 66)
  const rowCount = Math.ceil(items.length / columns)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  })

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [rowHeight, columns, virtualizer])

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    if (hasMore && !loading && element.scrollTop + element.clientHeight > element.scrollHeight - 700) onLoadMore()
  }

  if (!items.length && loading) {
    return (
      <div className="wh-grid-scroll" ref={parentRef}>
        <div className="wh-skeleton-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: columns * 3 }, (_, index) => <div className="wh-skeleton-card" key={index} />)}
        </div>
        <Spinner label={t('state.loading')} />
      </div>
    )
  }

  if (!items.length) {
    return (
      <div className="wh-grid-scroll" ref={parentRef}>
        {error ? <EmptyState title={t('state.error')} body={error} action={emptyAction} /> : <EmptyState title={emptyTitle} body={emptyBody} action={emptyAction} />}
      </div>
    )
  }

  return (
    <div className="wh-grid-scroll" ref={parentRef} onScroll={handleScroll}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(row => {
          const start = row.index * columns
          const rowItems = items.slice(start, start + columns)
          return (
            <div
              key={row.key}
              className="wh-grid-row"
              style={{ transform: `translateY(${row.start}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: GAP }}
            >
              {rowItems.map(entry => (
                <WallpaperCard
                  key={entry.key}
                  entry={entry}
                  sourceName={sourceNames[entry.item.sourceId]}
                  t={t}
                  onOpen={onOpen}
                  onSet={onSet}
                  onDownload={onDownload}
                  onFavorite={onFavorite}
                  onRemove={onRemove}
                  busy={busyKey === entry.key}
                />
              ))}
            </div>
          )
        })}
      </div>
      <div className="wh-grid-tail" aria-live="polite">
        {loading ? <Spinner label={t('state.loading')} /> : !hasMore ? <span>{t('state.noMore')}</span> : null}
        {error ? <span className="wh-grid-error">{error}</span> : null}
      </div>
    </div>
  )
}
