/**
 * GalleryView — 生成图片画廊：时间序缩略图网格。
 * 动作：放大预览 / 导出（原生保存框）/ 删除 / 放回画布（生成带输入图的编辑节点）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/index.jsx'
import { loadGallery, deleteAsset, getAsset } from '../js/assets.mjs'
import { assetPreviewUrl } from '../js/assets.mjs'

function formatTime(at) {
  if (!at) return ''
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function Tile({ item, onOpen, onDelete, onToCanvas }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    assetPreviewUrl(item.assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [item.assetId])
  return (
    <figure className="ac-gallery-tile">
      <button type="button" className="ac-gallery-img" onClick={() => onOpen(item.assetId)} title="放大预览">
        {url ? <img src={url} alt={item.record?.prompt?.slice(0, 40) ?? item.name} draggable={false} /> : <span className="ac-thumb-loading">…</span>}
      </button>
      <figcaption className="ac-gallery-meta">
        {item.record?.prompt && <div className="ac-gallery-prompt" title={item.record.prompt}>{item.record.prompt}</div>}
        <div className="ac-gallery-sub">
          <span>{item.record?.model ?? ''}</span>
          <span>{formatTime(item.record?.at ?? item.createdAt)}</span>
        </div>
        <div className="ac-gallery-actions">
          <Button size="sm" variant="ghost" onClick={() => onToCanvas(item.assetId)}>入画布</Button>
          <Button size="sm" variant="ghost" onClick={async () => {
            const asset = await getAsset(item.assetId)
            if (!asset) return
            const ext = asset.mime.split('/')[1] ?? 'png'
            await (window.enest || window.zapi).shell.saveFile({ defaultName: `${item.name.replace(/\.[a-z0-9]+$/, '')}.${ext === 'jpeg' ? 'jpg' : ext}`, dataUrl: asset.dataUrl })
          }}>导出</Button>
          <Button size="sm" variant="danger" onClick={() => onDelete(item.assetId)}>删除</Button>
        </div>
      </figcaption>
    </figure>
  )
}

export function GalleryView({ onOpenImage, onToCanvas, onBack }) {
  const [items, setItems] = useState(null)
  const refresh = useCallback(async () => setItems(await loadGallery()), [])
  useEffect(() => { refresh() }, [refresh])

  return (
    <div className="ac-gallery">
      <div className="ac-gallery-head">
        <Button size="sm" variant="ghost" onClick={onBack}>← 返回画布</Button>
        <strong className="ac-gallery-title">画廊</strong>
        <span className="ac-gallery-count">{items ? `${items.length} 张` : ''}</span>
        <div className="ac-gallery-head-flex" />
        <Button size="sm" variant="ghost" onClick={refresh}>刷新</Button>
      </div>
      {items && items.length === 0 && (
        <div className="ac-gallery-empty">
          <div className="ac-gallery-empty-glyph" aria-hidden>✦</div>
          <p>还没有生成图——回画布加一个「文生图」节点跑起来。</p>
        </div>
      )}
      <div className="ac-gallery-grid">
        {(items ?? []).map(item => (
          <Tile key={item.assetId} item={item} onOpen={onOpenImage}
            onDelete={async id => { await deleteAsset(id); refresh() }}
            onToCanvas={aid => { onToCanvas(aid); onBack() }} />
        ))}
      </div>
    </div>
  )
}
