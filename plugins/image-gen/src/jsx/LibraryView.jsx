/**
 * LibraryView — 预览库：records.v1 时间倒序分组（粘性组头）+ 方格缩略墙。
 * blob LRU 懒加载 + 骨架 shimmer + IntersectionObserver 占位；多选 + 批量条；渠道/模型筛选。
 *
 * 筛选用 pk-ui 的 Radix Select：原先给原生 <select> 加 .pk-select-trigger 类，
 * 但那套样式依赖 ::after 折线箭头与 pk-select-rich 结构，原生 select 上不成立。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, Select
} from '../ui/index.jsx'
import {
  CheckIcon, DownloadIcon, ExpandIcon, MoreIcon, TrashIcon, XIcon
} from '../ui/icons.jsx'
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
  const [failed, setFailed] = useState(false)

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
    assetPreviewUrl(record.assetId).then(u => { if (alive) setUrl(u) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [visible, record.assetId])

  const sub = [record.model, record.size !== 'auto' ? record.size : '', timeShort(record.at)].filter(Boolean).join('  ')

  return (
    <figure className="ig-lib-cell" ref={ref} data-selected={selected ? '' : undefined}>
      {url
        ? <img src={url} alt={record.prompt || '生成图'} draggable={false}
            onClick={() => onOpen(record, url)} onError={() => setFailed(true)} />
        : failed
          ? <span className="ig-cell-failed">图片无法读取</span>
          : <span className="ig-lib-skel" aria-hidden="true" />}

      <button type="button" className="ig-lib-check" aria-label={selected ? '取消选择' : '选择'}
        aria-pressed={selected} data-checked={selected ? 'true' : 'false'}
        onClick={event => { event.stopPropagation(); onToggle() }}>
        {selected && <CheckIcon size={12} strokeWidth={2.6} />}
      </button>

      {/* 格子最窄约 150px：5 个 28px 按钮会把最左边挤出 overflow 被裁，
          所以只留 3 个常驻动作，复制提示词与删除收进菜单。 */}
      <span className="ig-lib-acts" onClick={event => event.stopPropagation()}>
        <button type="button" className="ig-cell-act" title="放大" aria-label="放大"
          onClick={() => url && onOpen(record, url)}><ExpandIcon size={13} /></button>
        <button type="button" className="ig-cell-act" title="下载" aria-label="下载"
          onClick={() => onAction('download', record)}><DownloadIcon size={13} /></button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="ig-cell-act" title="更多操作" aria-label="更多操作">
              <MoreIcon size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent aria-label="更多操作" side="bottom" align="end">
            <DropdownMenuItem onSelect={() => onAction('continue', record)}>
              <span className="pk-menu-check" aria-hidden="true" /><span className="pk-menu-label">以此图继续</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCopy(record)}>
              <span className="pk-menu-check" aria-hidden="true" /><span className="pk-menu-label">复制提示词</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('saveRecipe', record)}>
              <span className="pk-menu-check" aria-hidden="true" /><span className="pk-menu-label">存为配方</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onSelect={() => onAction('delete', record)}>
              <span className="pk-menu-check" aria-hidden="true" /><span className="pk-menu-label">删除</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      <figcaption className="ig-lib-veil">
        <span className="ig-lib-prompt" title={record.prompt}>{record.prompt || '（无提示词）'}</span>
        <span className="ig-lib-sub">{sub}</span>
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
    return [{ value: 'all', label: `全部渠道 · ${records.length} 张` },
      ...names.map(n => ({ value: n, label: n }))]
  }, [records])

  const modelOptions = useMemo(() => {
    const source = providerFilter === 'all' ? records : records.filter(r => r.providerName === providerFilter)
    const names = [...new Set(source.map(r => r.model).filter(Boolean))]
    return [{ value: 'all', label: '全部模型' }, ...names.map(n => ({ value: n, label: n }))]
  }, [records, providerFilter])

  /* 筛选变了之后，已选中的条目可能已不在列表里；直接清空避免"删了看不见的东西" */
  useEffect(() => { setSelected(new Set()) }, [providerFilter, modelFilter])

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
          <Select value={providerFilter} options={providerOptions} onChange={v => { setProviderFilter(v); setModelFilter('all') }}
            ariaLabel="按渠道筛选" minWidth={168} />
          <Select value={modelFilter} options={modelOptions} onChange={setModelFilter}
            ariaLabel="按模型筛选" minWidth={148} disabled={modelOptions.length <= 1} />
          <span className="ig-lib-count">{filtered.length} 张</span>
        </div>
        <div className="ig-lib-inner">
          {filtered.length === 0 ? (
            <div className="pk-empty-state" role="status">
              <strong className="pk-empty-title">{records.length ? '没有匹配的图片' : '暂无图片'}</strong>
              <p className="pk-empty-hint">
                {records.length
                  ? '换一个渠道或模型试试。'
                  : '生成后的图片会自动保存到预览库。'}
              </p>
              {!records.length && (
                <button type="button" className="pk-btn pk-btn-primary" onClick={onGoChat}>去生成第一张</button>
              )}
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
          <span className="ig-bulk-count">已选 {selected.size} 张</span>
          <button type="button" className="pk-btn pk-btn-sm" onClick={() => onBulkDownload([...selected])}>
            <DownloadIcon size={13} />下载
          </button>
          <button type="button" className="pk-btn pk-btn-sm pk-btn-danger" onClick={() => onBulkDelete([...selected])}>
            <TrashIcon size={13} />删除
          </button>
          <button type="button" className="ig-icon-btn" title="取消选择" aria-label="取消选择"
            onClick={() => setSelected(new Set())}>
            <XIcon size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
