import { useEffect, useMemo, useState } from 'react'
import { Segmented, Button } from '../ui/index.jsx'
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
  onDelete,
  ensureThumb,
  totalBytes,
  onCapture,
  onClearSearch,
  onBack
}) {
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [clearTarget, setClearTarget] = useState(null)

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return items.filter(item => {
      if (!matchesFilter(item, filter)) return false
      if (!text) return true
      const date = new Date(item.createdAt).toLocaleString('zh-CN')
      return `${item.name} ${date}`.toLowerCase().includes(text)
    })
  }, [items, filter, query])
  const armClear = clearTarget === filtered

  // 筛选或搜索变化后，已不在列表里的选中项自动剔除；列表清空则退出多选。
  useEffect(() => {
    const visible = new Set(filtered.map(item => item.id))
    setSelected(current => {
      const next = new Set([...current].filter(id => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [filtered])
  useEffect(() => {
    if (!filtered.length && selecting) { setSelecting(false); setSelected(new Set()) }
  }, [filtered.length, selecting])

  const exitSelecting = () => { setSelecting(false); setSelected(new Set()); setClearTarget(null) }
  const toggleSelect = item => setSelected(current => {
    const next = new Set(current)
    if (next.has(item.id)) next.delete(item.id)
    else next.add(item.id)
    return next
  })
  const selectAll = () => setSelected(new Set(filtered.map(item => item.id)))

  // 批量操作先退出多选，再交给上层等待全部删除完成并汇总提示。
  const removeSelected = () => {
    const list = filtered.filter(item => selected.has(item.id))
    if (!list.length) return
    exitSelecting()
    void onDelete(list)
  }

  // 「清空」同样两次点击确认：范围是当前筛选/搜索的结果，而不是整个媒体库。
  const clearFiltered = () => {
    if (!armClear) { setClearTarget(filtered); return }
    const list = [...filtered]
    exitSelecting()
    void onDelete(list)
  }
  useEffect(() => {
    if (!clearTarget) return undefined
    const timer = setTimeout(() => setClearTarget(null), 3200)
    return () => clearTimeout(timer)
  }, [clearTarget])

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
        {onBack && (
          <Button variant="ghost" size="sm" className="sa-lib-back" onClick={onBack}>
            <Icon name="left" />返回拍摄
          </Button>
        )}
        <Segmented value={filter} options={FILTERS} onChange={onFilter} ariaLabel="媒体类型" />
        {!onBack && (
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
        )}
        <span className="sa-lib-meta">{filtered.length} 项 · {formatBytes(totalBytes)}</span>
        {selecting ? (
          <div className="sa-lib-select" role="toolbar" aria-label="批量操作">
            <Button variant="ghost" size="sm" onClick={selectAll} disabled={!filtered.length}>全选</Button>
            <Button variant="ghost" size="sm" onClick={exitSelecting}>取消</Button>
            <Button variant="danger" size="sm" onClick={removeSelected} disabled={!selected.size}>
              <Icon name="trash" size={14} /> 删除{selected.size ? ` (${selected.size})` : ''}
            </Button>
          </div>
        ) : (
          <div className="sa-lib-select">
            <Button variant="ghost" size="sm" onClick={() => setSelecting(true)} disabled={!filtered.length}>多选</Button>
            <Button variant="ghost" size="sm" className={armClear ? 'sa-btn-armed' : 'sa-btn-danger'} onClick={clearFiltered} disabled={!filtered.length}>
              {armClear ? `确认清空 ${filtered.length} 项` : '清空'}
            </Button>
          </div>
        )}
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
                onDelete={onDelete}
                selectable={selecting}
                selected={selected.has(entry.item.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
