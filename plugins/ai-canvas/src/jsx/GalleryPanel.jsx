/**
 * GalleryPanel — 图片素材浮层（点击左轨「图片素材」后在画布左上展开）。
 * 按日期分组、可滚动；支持重命名、单张/批量删除、拖到节点引入、点击放大、导出。
 * 拖拽载荷是 assetId（application/x-ai-canvas-asset），节点侧直接接收。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/index.jsx'
import { loadGallery, deleteAsset, getAsset, renameAsset, assetPreviewUrl } from '../js/assets.mjs'

function formatTime(at) {
  if (!at) return ''
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 日期分组键：今天 / 昨天 / YYYY-MM-DD */
function dayKey(at) {
  if (!at) return '更早'
  const d = new Date(at)
  const today = new Date()
  const startOf = t => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function Tile({ item, selected, onToggle, onOpen, onRename, onDelete }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    assetPreviewUrl(item.assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [item.assetId])
  const name = item.record?.name || item.name || item.assetId
  return <figure className={`ac-tile ${selected ? 'ac-tile-selected' : ''}`}>
    <button type="button" className="ac-tile-img" onClick={() => onOpen(item.assetId)} title="点击放大"
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('application/x-ai-canvas-asset', item.assetId)
        e.dataTransfer.effectAllowed = 'copy'
      }}>
      {url ? <img src={url} alt={name} draggable={false} /> : <span className="ac-thumb-loading">…</span>}
    </button>
    <label className="ac-tile-check" title="选择">
      <input type="checkbox" checked={selected} onChange={() => onToggle(item.assetId)} />
    </label>
    <figcaption className="ac-tile-meta">
      <span className="ac-tile-name" title={`${name}（双击重命名）`}
        onDoubleClick={() => {
          const next = window.prompt('重命名图片', name)
          if (next && next.trim() && next.trim() !== name) onRename(item.assetId, next.trim())
        }}>{name}</span>
      <span className="ac-tile-time">{formatTime(item.record?.at ?? item.createdAt)}</span>
    </figcaption>
    <span className="ac-tile-actions">
      <button type="button" className="ac-tile-act" title="删除" onClick={() => onDelete(item.assetId)}>×</button>
    </span>
  </figure>
}

export function GalleryPanel({ onOpenImage, onClose, onChanged }) {
  const [items, setItems] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setItems(await loadGallery()) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const groups = useMemo(() => {
    const sorted = [...items].sort((a, b) => (b.record?.at ?? b.createdAt ?? 0) - (a.record?.at ?? a.createdAt ?? 0))
    const map = new Map()
    for (const item of sorted) {
      const key = dayKey(item.record?.at ?? item.createdAt)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(item)
    }
    return Array.from(map.entries())
  }, [items])

  const toggle = id => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const removeOne = async id => {
    await deleteAsset(id)
    setSelected(prev => { const next = new Set(prev); next.delete(id); return next })
    await refresh(); onChanged?.()
  }

  const removeSelected = async () => {
    if (!selected.size) return
    if (!window.confirm(`删除选中的 ${selected.size} 张图片？此操作不可撤销。`)) return
    for (const id of selected) await deleteAsset(id)
    setSelected(new Set())
    await refresh(); onChanged?.()
  }

  const rename = async (id, name) => {
    await renameAsset(id, name)
    await refresh()
  }

  const exportOne = async item => {
    const asset = await getAsset(item.assetId)
    if (!asset) return
    const ext = (asset.mime?.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
    await (window.enest || window.zapi).shell.saveFile({
      defaultName: `${(item.record?.name || item.name || 'image').replace(/\.[a-z0-9]+$/, '')}.${ext}`,
      dataUrl: asset.dataUrl
    })
  }

  return (
    <aside className="ac-gallerypanel" aria-label="图片素材">
      <header className="ac-gallerypanel-head">
        <span className="ac-gallerypanel-title">图片素材</span>
        <span className="ac-gallerypanel-count">{items.length} 张</span>
        <span className="ac-gallerypanel-flex" />
        {selected.size > 0 && <Button size="sm" variant="danger" onClick={removeSelected}>删除选中 {selected.size}</Button>}
        <button type="button" className="ac-insp-close" onClick={onClose}>收起</button>
      </header>
      <div className="ac-gallerypanel-body">
        {loading && <div className="ac-gallery-empty">加载中…</div>}
        {!loading && items.length === 0 && (
          <div className="ac-gallery-empty"><span className="ac-gallery-empty-glyph">▦</span>还没有生成图片</div>
        )}
        {groups.map(([day, list]) => (
          <section key={day} className="ac-gallery-day">
            <div className="ac-gallery-day-title">{day}<span>{list.length}</span></div>
            <div className="ac-gallery-grid">
              {list.map(item => (
                <Tile key={item.assetId} item={item}
                  selected={selected.has(item.assetId)}
                  onToggle={toggle} onOpen={onOpenImage} onRename={rename}
                  onDelete={removeOne} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <footer className="ac-gallerypanel-foot">
        <span>拖到画布节点即可引入 · 双击名称重命名</span>
      </footer>
    </aside>
  )
}
