/**
 * Lightbox — 全屏预览：时间线前后翻、Esc/遮罩关闭、滚轮锚点缩放（1-4x）、双击复位。
 * 缩放算法与 comic-house ReaderPage.zoomAt 一致：以光标为锚修正滚动偏移。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const MIN_SCALE = 1
const MAX_SCALE = 4

export function Lightbox({ items, index, onIndexChange, onClose, onContinue, onDownload, onDelete, onCopyPrompt }) {
  const wrapRef = useRef(null)
  const [scale, setScale] = useState(1)
  const scaleRef = useRef(1)
  scaleRef.current = scale
  const item = items[index]

  const jump = useCallback(delta => {
    const next = index + delta
    if (next < 0 || next >= items.length) return
    setScale(1)
    onIndexChange(next)
  }, [index, items.length, onIndexChange])

  /* 滚轮：直接缩放（lightbox 语义下滚轮即缩放，非滚动） */
  const zoomAt = useCallback((clientX, clientY, factor) => {
    const el = wrapRef.current
    if (!el) return
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(scaleRef.current * factor).toFixed(3)))
    if (next === scaleRef.current) return
    const rect = el.getBoundingClientRect()
    const offsetX = clientX - rect.left + el.scrollLeft
    const offsetY = clientY - rect.top + el.scrollTop
    const ratio = next / scaleRef.current
    setScale(next)
    requestAnimationFrame(() => {
      el.scrollLeft = offsetX * ratio - (clientX - rect.left)
      el.scrollTop = offsetY * ratio - (clientY - rect.top)
    })
  }, [])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key === 'ArrowLeft') { event.preventDefault(); jump(-1); return }
      if (event.key === 'ArrowRight') { event.preventDefault(); jump(1); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jump, onClose])

  if (!item) return null

  return (
    <div className="ig-lightbox" role="dialog" aria-modal="true" aria-label="图片预览"
      ref={wrapRef}
      tabIndex={-1}
      onWheel={event => {
        event.preventDefault()
        zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 1 / 1.12)
      }}
      onDoubleClick={() => setScale(1)}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <img
        className="ig-lightbox-img"
        src={item.url}
        alt={item.prompt || '生成图'}
        draggable={false}
        style={{ transform: `scale(${scale})` }}
      />
      <div className="ig-lightbox-info" onClick={event => event.stopPropagation()}>
        <span className="ig-lightbox-prompt" title={item.prompt || ''}>{item.prompt || '（无提示词）'}</span>
        <div className="ig-lightbox-acts">
          {onCopyPrompt && item.prompt && <button type="button" className="ig-lb-btn" onClick={() => onCopyPrompt(item)}>复制提示词</button>}
          {onContinue && <button type="button" className="ig-lb-btn" onClick={() => onContinue(item)}>以此图继续</button>}
          {onDownload && <button type="button" className="ig-lb-btn" onClick={() => onDownload(item)}>下载</button>}
          {onDelete && <button type="button" className="ig-lb-btn" onClick={() => onDelete(item)}>删除</button>}
        </div>
      </div>
      <button type="button" className="ig-lightbox-nav" data-side="prev" aria-label="上一张" disabled={index <= 0}
        onClick={event => { event.stopPropagation(); jump(-1) }}>‹</button>
      <button type="button" className="ig-lightbox-nav" data-side="next" aria-label="下一张" disabled={index >= items.length - 1}
        onClick={event => { event.stopPropagation(); jump(1) }}>›</button>
      {items.length > 1 && <span className="ig-lightbox-count">{index + 1} / {items.length}</span>}
      <button type="button" className="ig-lb-btn" aria-label="关闭预览" style={{ position: 'absolute', top: 54, right: 16 }}
        onClick={onClose}>Esc 关闭</button>
    </div>
  )
}
