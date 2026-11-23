/**
 * 详情页媒体轮播：图片与视频左右切换，下方缩略图条。
 * 媒体地址经 media.load 解析（小图 data URL，大图 / 视频是回环代理地址）。
 * 视频分两种：普通视频直接交给 <video>；HLS 播放列表由 hls.js 播放（见 js/video.ts）。
 * 切换到别的媒体时销毁当前播放器，避免后台继续拉分片、出声。
 */

import { useEffect, useRef, useState } from 'react'
import { CaretLeft, CaretRight, Play } from '@phosphor-icons/react'
import type { MediaRef } from '../../shared/contracts'
import { useMedia } from '../../js/media'
import { loadMedia } from '../../js/articleMedia'
import { useVideoSource } from '../../js/video'
import { Glyph } from '../../components/Glyph'

export function Carousel({ media }: { media: MediaRef[] }) {
  const [index, setIndex] = useState(0)
  useEffect(() => { setIndex(0) }, [media])
  if (!media.length) {
    return (
      <div className="gh-carousel gh-carousel-empty-wrap">
        <span className="gh-carousel-empty">暂无预览</span>
      </div>
    )
  }
  const safeIndex = Math.min(index, media.length - 1)
  const current = media[safeIndex]
  const multiple = media.length > 1
  const go = (delta: number) => setIndex((safeIndex + delta + media.length) % media.length)
  return (
    <div className="gh-detail-media">
      <div className="gh-carousel">
        {/* key 绑定当前项：切换时整个重建，旧播放器随之销毁 */}
        {current.type === 'video'
          ? <CarouselVideo key={`v:${safeIndex}`} item={current} />
          : <CarouselImage key={`i:${safeIndex}`} item={current} alt={`截图 ${safeIndex + 1}`} />}
        {multiple ? (
          <div className="gh-carousel-nav">
            <button type="button" aria-label="上一个" onClick={() => go(-1)}><Glyph icon={CaretLeft} size={16} /></button>
            <button type="button" aria-label="下一个" onClick={() => go(1)}><Glyph icon={CaretRight} size={16} /></button>
          </div>
        ) : null}
        {multiple ? <span className="gh-carousel-index">{safeIndex + 1} / {media.length}</span> : null}
      </div>
      {multiple ? (
        <div className="gh-thumbs" role="tablist" aria-label="媒体缩略图">
          {media.map((item, itemIndex) => (
            <ThumbButton key={`${item.token}:${itemIndex}`} item={item} active={itemIndex === safeIndex} index={itemIndex} onSelect={() => setIndex(itemIndex)} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// 图片不用 loading="lazy"：内嵌 webview 里浏览器的懒加载不触发，可见的图会一直不出来（地址已由后端取回）
// 小图（修改器 / MOD 的封面通常只有两三百像素宽）不铺满 16:9：放大三四倍会糊，按原尺寸居中显示
function CarouselImage({ item, alt }: { item: MediaRef; alt: string }) {
  const url = useMedia(item.token)
  const [small, setSmall] = useState(false)
  if (!url) return <div className="gh-carousel-loading"><span className="gh-spin" aria-label="加载中" /></div>
  return (
    <div className="gh-carousel-stage" data-small={small ? 'true' : 'false'}>
      <img src={url} alt={alt} referrerPolicy="no-referrer" decoding="async" onLoad={event => setSmall(event.currentTarget.naturalWidth < 800)} />
    </div>
  )
}

/**
 * 轮播里的视频：先显示封面和播放按钮；用户点击后才向后端换取地址并播放——
 * 翻截图时不应突然加载视频、出声。地址由 hls.js 或 <video> 接管（见 js/video.ts）。
 */
function CarouselVideo({ item }: { item: MediaRef }) {
  const poster = useMedia(item.poster ?? '')
  const [payload, setPayload] = useState<{ url: string; mime: string }>({ url: '', mime: '' })
  const [failed, setFailed] = useState(false)
  const [started, setStarted] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (!started) return
    let alive = true
    void loadMedia(item.token).then(value => { if (alive) setPayload(value) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [item.token, started])
  // 地址就绪前不接源；源准备好（取回 / hls.js 挂上）后自动播放——用户已经点了播放按钮
  const ready = useVideoSource(videoRef, started ? payload.url : '', payload.mime)
  useEffect(() => { if (ready) void videoRef.current?.play().catch(() => undefined) }, [ready])

  if (failed) return <div className="gh-carousel-loading">视频无法播放</div>
  if (!started) {
    return (
      <button type="button" className="gh-carousel-poster" aria-label="播放视频" onClick={() => setStarted(true)}>
        {poster
          ? <img src={poster} alt="" referrerPolicy="no-referrer" decoding="async" />
          : <span className="gh-carousel-loading"><span className="gh-spin" aria-label="加载中" /></span>}
        <span className="gh-carousel-play" aria-hidden="true"><Play size={28} weight="fill" /></span>
      </button>
    )
  }
  return <video ref={videoRef} poster={poster || undefined} controls autoPlay playsInline onError={() => { if (ready) setFailed(true) }} />
}

function ThumbButton({ item, active, index, onSelect }: { item: MediaRef; active: boolean; index: number; onSelect: () => void }) {
  // 视频项的缩略图用它的封面，图片项用自己
  const url = useMedia(item.type === 'video' ? (item.poster ?? '') : item.token)
  return (
    <button type="button" role="tab" aria-selected={active} data-active={active ? 'true' : 'false'} aria-label={`媒体 ${index + 1}`} onClick={onSelect}>
      {url ? <img src={url} alt="" decoding="async" referrerPolicy="no-referrer" /> : <span className="gh-spin" style={{ margin: 'auto' }} />}
      {item.type === 'video' ? <span className="gh-thumbs-play"><Glyph icon={Play} size={12} /></span> : null}
    </button>
  )
}
