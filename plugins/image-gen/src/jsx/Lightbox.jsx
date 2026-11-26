/**
 * Lightbox — 全屏预览：时间线前后翻、Esc/遮罩关闭、滚轮锚点缩放（1-4x）、双击复位。
 * 缩放算法与 comic-house ReaderPage.zoomAt 一致：以光标为锚修正滚动偏移。
 * 结构：底部固定操作条（含提示词与动作），顶部只留关闭，不再用内联样式压按钮。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, DownloadIcon, PencilIcon, TrashIcon, XIcon } from '../ui/icons.jsx'

const MIN_SCALE = 1
const MAX_SCALE = 4

export function Lightbox({ items, index, onIndexChange, onClose, onContinue, onCopyImage, onDownload, onDelete, onCopyPrompt }) {
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

  /* 换图时复位缩放与信息条 */
  useEffect(() => { setScale(1) }, [index])

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

      <button type="button" className="ig-lightbox-close" aria-label="关闭预览" title="关闭预览（Esc）" onClick={onClose}>
        <XIcon size={16} />
      </button>

      <img
        className="ig-lightbox-img"
        src={item.url}
        alt={item.prompt || '生成图'}
        draggable={false}
        style={{ transform: `scale(${scale})` }}
      />

      {items.length > 1 && (
        <>
          <button type="button" className="ig-lightbox-nav" data-side="prev" aria-label="上一张" title="上一张（←）"
            disabled={index <= 0} onClick={event => { event.stopPropagation(); jump(-1) }}>
            <ChevronLeftIcon size={18} />
          </button>
          <button type="button" className="ig-lightbox-nav" data-side="next" aria-label="下一张" title="下一张（→）"
            disabled={index >= items.length - 1} onClick={event => { event.stopPropagation(); jump(1) }}>
            <ChevronRightIcon size={18} />
          </button>
        </>
      )}

      <div className="ig-lightbox-bottom" onClick={event => event.stopPropagation()}>
        <div className="ig-lightbox-text">
          <span className="ig-lightbox-prompt" title={item.prompt || ''}>{item.prompt || '（无提示词）'}</span>
          <span className="ig-lightbox-meta">
            {items.length > 1 && <span>{index + 1} / {items.length}</span>}
            {scale !== 1 && <span>{(scale * 100).toFixed(0)}%</span>}
          </span>
        </div>
        <div className="ig-lightbox-acts">
          {onCopyPrompt && item.prompt && (
            <button type="button" className="ig-lb-btn" onClick={() => onCopyPrompt(item)}>
              <CopyIcon size={13} />复制提示词
            </button>
          )}
          {onContinue && (
            <button type="button" className="ig-lb-btn" onClick={() => onContinue(item)}>
              <PencilIcon size={13} />以此图继续
            </button>
          )}
          {onCopyImage && (
            <button type="button" className="ig-lb-btn" onClick={() => onCopyImage(item)}>
              <CopyIcon size={13} />复制图片
            </button>
          )}
          {onDownload && (
            <button type="button" className="ig-lb-btn" onClick={() => onDownload(item)}>
              <DownloadIcon size={13} />下载
            </button>
          )}
          {onDelete && (
            <button type="button" className="ig-lb-btn" onClick={() => onDelete(item)}>
              <TrashIcon size={13} />删除
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
