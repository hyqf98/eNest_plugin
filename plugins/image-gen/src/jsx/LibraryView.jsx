/**
 * LibraryView — 预览库：records.v1 时间倒序分组（粘性组头）+ 方格缩略墙。
 * blob LRU 懒加载 + 骨架 shimmer + IntersectionObserver 占位；多选 + 批量条；渠道/模型筛选。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { assetPreviewUrl } from '../js/assets.mjs'

function dayLabel(at) {
  if (!at) return '更早'
  const d = new Date(at)
  const today = new Date()
  const startOf = t => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function timeShort(at) {
  const d = new Date(at ?? 0)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 缩略格：进入视口才取 blob，骨架占位 */
function LibCell({ record, selected, onToggle, onOpen, onAction, onCopy }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState(null)

  useEffect(() => {
    const el = ref.current
    if (!el || visible) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); io.disconnect() }
    }, { rootMargin: '160px' })
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    let alive = true
    assetPreviewUrl(record.assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [visible, record.assetId])

  return (
    <figure className="ig-lib-cell" ref={ref}>
      {url
        ? <img src={url} alt={record.prompt || '生成图'} draggable={false} onClick={() => onOpen(record, url)} />
        : <span className="ig-lib-skel" aria-hidden="true" />}
      <button type="button" className="ig-lib-check" aria-label={selected ? '取消选择' : '选择'}
        data-checked={selected ? 'true' : 'false'} onClick={onToggle}>{selected ? '✓' : ''}</button>
      <span className="ig-lib-acts">
        <button type="button" className="ig-cell-act" title="放大" aria-label="放大"
          onClick={() => url && onOpen(record, url)}>⤢</button>
        <button type="button" className="ig-cell-act" title="下载" aria-label="下载"
          onClick={() => onAction('download', record)}>⤓</button>
        <button type="button" className="ig-cell-act" title="以此图继续" aria-label="以此图继续"
          onClick={() => onAction('continue', record)}>✎</button>
        <button type="button" className="ig-cell-act" title="复制提示词" aria-label="复制提示词"
          onClick={() => onCopy(record)}>⧉</button>
        <button type="button" className="ig-cell-act" title="删除" aria-label="删除"
          onClick={() => onAction('delete', record)}>✕</button>
      </span>
      <figcaption className="ig-lib-veil">
        <span className="ig-lib-prompt" title={record.prompt}>{record.prompt || '（无提示词）'}</span>
        <span className="ig-lib-sub">{[record.model, record.size !== 'auto' ? record.size : '', timeShort(record.at)].filter(Boolean).join(' · ')}</span>
      </figcaption>
    </figure>
  )
}

export function LibraryView({ records, topbar, onOpen, onAction, onCopy, onBulkDownload, onBulkDelete, onGoChat }) {
  const [selected, setSelected] = useState(() => new Set())
  const [providerFilter, setProviderFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')

  const providerOptions = useMemo(() => {
    const names = [...new Set(records.map(r => r.providerName).filter(Boolean))]
    return [{ value: 'all', label: `全部渠道${records.length ? ` (${records.length})` : ''}` },
      ...names.map(n => ({ value: n, label: n }))]
  }, [records])

  const modelOptions = useMemo(() => {
    const source = providerFilter === 'all' ? records : records.filter(r => r.providerName === providerFilter)
    const names = [...new Set(source.map(r => r.model).filter(Boolean))]
    return [{ value: 'all', label: '全部模型' }, ...names.map(n => ({ value: n, label: n }))]
  }, [records, providerFilter])

  const filtered = useMemo(() => records.filter(r =>
    (providerFilter === 'all' || r.providerName === providerFilter)
    && (modelFilter === 'all' || r.model === modelFilter)), [records, providerFilter, modelFilter])

  const groups = useMemo(() => {
    const map = new Map()
    for (const r of filtered) {
      const key = dayLabel(r.at)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(r)
    }
    return Array.from(map.entries())
  }, [filtered])

  const toggle = useCallback(id => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }), [])

  return (
    <div className="ig-stage">
      {topbar}
      <div className="ig-library">
        <div className="ig-library-head">
          <select className="pk-select-trigger" aria-label="按渠道筛选" value={providerFilter}
            onChange={e => { setProviderFilter(e.target.value); setModelFilter('all') }}>
            {providerOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className="pk-select-trigger" aria-label="按模型筛选" value={modelFilter}
            onChange={e => setModelFilter(e.target.value)} disabled={modelOptions.length <= 1}>
            {modelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span className="ig-lib-count">{filtered.length} 张</span>
        </div>
        <div className="ig-lib-inner">
          {filtered.length === 0 ? (
            <div className="ig-lib-empty">
              <span>还没有生成记录</span>
              <button type="button" className="pk-btn pk-btn-primary" onClick={onGoChat}>去发第一张</button>
            </div>
          ) : groups.map(([label, items]) => (
            <section key={label}>
              <div className="ig-lib-group">{label}</div>
              <div className="ig-lib-grid">
                {items.map(r => (
                  <LibCell key={r.id} record={r} selected={selected.has(r.id)}
                    onToggle={() => toggle(r.id)}
                    onOpen={onOpen}
                    onAction={onAction}
                    onCopy={onCopy} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      {selected.size > 0 && (
        <div className="ig-bulk-bar">
          <span>已选 {selected.size}</span>
          <button type="button" className="pk-btn pk-btn-sm" onClick={() => onBulkDownload([...selected])}>下载</button>
          <button type="button" className="pk-btn pk-btn-sm pk-btn-danger" onClick={() => onBulkDelete([...selected])}>删除</button>
          <button type="button" className="pk-btn pk-btn-sm pk-btn-ghost" onClick={() => setSelected(new Set())}>取消</button>
        </div>
      )}
    </div>
  )
}
