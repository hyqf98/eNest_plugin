import { useMemo } from 'react'
import { Segmented } from '../ui/index.jsx'
import { Icon } from '../components/Icon.jsx'
import { MediaCard } from '../components/MediaCard.jsx'
import { Empty } from '../components/Empty.jsx'
import { formatBytes, groupLabel } from '../lib/format.js'

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '截图' },
  { value: 'record', label: '录屏' }
]

function matchesFilter(item, filter) {
  if (filter === 'image') return item.kind === 'image'
  if (filter === 'record') return item.kind === 'video' || item.kind === 'gif'
  return true
}

export function LibraryView({
  items,
  loading,
  filter,
  onFilter,
  query,
  onQuery,
  onOpen,
  onEdit,
  onExport,
  ensureThumb,
  totalBytes,
  onCapture,
  onClearSearch
}) {
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return items.filter(item => {
      if (!matchesFilter(item, filter)) return false
      if (!text) return true
      const date = new Date(item.createdAt).toLocaleString('zh-CN')
      return `${item.name} ${date}`.toLowerCase().includes(text)
    })
  }, [items, filter, query])

  const groups = useMemo(() => {
    const list = []
    let label = ''
    for (const item of filtered) {
      const next = groupLabel(item.createdAt)
      if (next !== label) { label = next; list.push({ type: 'label', label, key: `label-${label}-${item.id}` }) }
      list.push({ type: 'item', item, key: item.id })
    }
    return list
  }, [filtered])

  return (
    <div className="sa-library">
      <div className="sa-lib-bar">
        <Segmented value={filter} options={FILTERS} onChange={onFilter} ariaLabel="媒体类型" />
        <label className="sa-search">
          <Icon name="search" />
          <input
            value={query}
            onChange={event => onQuery(event.target.value)}
            placeholder="搜索截图或录屏"
            aria-label="搜索截图或录屏"
          />
          {query ? (
            <button type="button" className="sa-icon-btn" style={{ width: 20, height: 20 }} aria-label="清空搜索" onClick={onClearSearch}>
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </label>
        <span className="sa-lib-meta">{filtered.length} 项 · {formatBytes(totalBytes)}</span>
      </div>
      <div className={`sa-lib-scroll${filtered.length ? '' : ' is-empty'}`}>
        {loading ? (
          <div className="sa-empty"><span className="sa-spinner" /> 正在读取媒体库…</div>
        ) : !filtered.length ? (
          <div className="sa-lib-empty">
            <Empty icon="library" text={query ? '没有匹配的记录' : filter === 'record' ? '还没有录屏' : filter === 'image' ? '还没有截图' : '媒体库还是空的'}>
              {!query && filter !== 'record' ? <button type="button" className="pk-btn pk-btn-primary" onClick={onCapture}>区域截图</button> : null}
            </Empty>
          </div>
        ) : (
          <div className="sa-grid">
            {groups.map(entry => entry.type === 'label' ? (
              <div key={entry.key} className="sa-day" style={{ gridColumn: '1 / -1' }}>{entry.label}</div>
            ) : (
              <MediaCard
                key={entry.key}
                item={entry.item}
                ensureThumb={ensureThumb}
                onOpen={onOpen}
                onEdit={onEdit}
                onExport={onExport}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
