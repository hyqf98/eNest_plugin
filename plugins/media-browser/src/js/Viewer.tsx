/**
 * 预览层：图片放大查看，视频播放。
 * ←/→ 切换到上一个/下一个；Delete 直接删除当前文件（不进回收站）；Esc 关闭。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Trash, X } from '@phosphor-icons/react'
import type { MediaItem } from '../shared/contracts'
import { Dialog, DialogContent, DialogTitle } from '../ui/index'
import { getApi } from './api'

export interface ViewerProps {
  /** 当前文件夹里的全部条目（切换顺序以此为准） */
  items: MediaItem[]
  /** 起始条目在 items 里的下标 */
  index: number
  onClose(): void
  /** 用户按了 Delete：调用方负责删文件并刷新；返回 true 表示已删除 */
  onDelete(item: MediaItem): Promise<boolean>
}

export function videoUrlOf(item: MediaItem): string | null {
  // 缩略图与原文件共用同一个 mediaId，只差路由前缀
  return item.thumbUrl ? item.thumbUrl.replace(/\/t\//, '/v/') : null
}

export function imageUrlOf(item: MediaItem): string | null {
  return item.thumbUrl ? item.thumbUrl.replace(/\/t\//, '/o/') : null
}

export function Viewer({ items, index, onClose, onDelete }: ViewerProps) {
  const [position, setPosition] = useState(index)
  const [busy, setBusy] = useState(false)
  const item = items[Math.min(position, items.length - 1)]
  const isVideo = item?.kind === 'video'

  const go = useCallback((delta: number) => {
    setPosition(current => Math.min(items.length - 1, Math.max(0, current + delta)))
  }, [items.length])

  const remove = useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      const removed = await onDelete(item)
      // 父组件删除后会传入更短的 items；位置由下面的 effect 钳制（停在同一位置，即原来的下一张）
      if (!removed) return
      if (items.length <= 1) onClose()
    } finally {
      setBusy(false)
    }
  }, [busy, item, items.length, onClose, onDelete])

  // 条目增减后把位置钳回有效范围：删掉当前后停在同一位置，删到末尾时退到新的末尾
  useEffect(() => {
    setPosition(current => Math.min(current, Math.max(0, items.length - 1)))
  }, [items.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      // 播放视频时方向键归播放器（快退/快进），不切换条目
      if (isVideo) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); return }
      if (event.key === 'ArrowRight') { event.preventDefault(); go(1); return }
      // 只认 Delete：macOS 的 Backspace 是退格键，误触不该永久删文件
      if (event.key === 'Delete') { event.preventDefault(); void remove() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, isVideo, onClose, remove])

  const source = useMemo(() => (item ? (isVideo ? videoUrlOf(item) : imageUrlOf(item)) : null), [item, isVideo])

  // 切到别的插件时暂停播放；回到本插件时继续。只对视频生效。
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (!isVideo) return
    let api: ReturnType<typeof getApi>
    try { api = getApi() } catch { return }
    const pause = () => { videoRef.current?.pause() }
    const resume = () => { void videoRef.current?.play().catch(() => undefined) }
    const offOut = api.onOut(pause)
    const offEnter = api.onEnter(resume)
    return () => { offOut(); offEnter() }
  }, [isVideo])
  if (!item) return null
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="mb-viewer" aria-describedby={undefined}>
        <DialogTitle className="mb-viewer-title">{item.name}</DialogTitle>
        <div className="mb-viewer-stage">
          {source ? (
            isVideo ? (
              <video ref={videoRef} className="mb-viewer-media" src={source} controls autoPlay playsInline />
            ) : (
              <img className="mb-viewer-media" src={source} alt={item.name} draggable={false} />
            )
          ) : (
            <div className="mb-viewer-placeholder">{item.ext.toUpperCase()}</div>
          )}
        </div>
        <div className="mb-viewer-bar">
          <button type="button" className="pk-btn pk-btn-ghost" aria-label="上一个" disabled={position <= 0} onClick={() => go(-1)}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <span className="mb-viewer-position">{position + 1} / {items.length}</span>
          <button type="button" className="pk-btn pk-btn-ghost" aria-label="下一个" disabled={position >= items.length - 1} onClick={() => go(1)}>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <span className="mb-viewer-spacer" />
          <button type="button" className="pk-btn pk-btn-danger" aria-label="删除此文件" disabled={busy} onClick={() => void remove()}>
            <Trash size={16} aria-hidden="true" />
            <span>删除</span>
          </button>
          <button type="button" className="pk-btn pk-btn-ghost" aria-label="关闭" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
