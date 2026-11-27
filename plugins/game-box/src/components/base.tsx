import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { Image, Warning } from '@phosphor-icons/react'
import { useMedia } from '../js/media'

/** 可点击的卡片外壳：键盘可达（回车打开） */
export function Card({ active = false, onClick, children, className = '', label }: { active?: boolean; onClick?: () => void; children: ReactNode; className?: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={label}
      data-selected={active ? 'true' : undefined}
      className={`gh-card ${className}`.trim()}
      onClick={onClick}
      onKeyDown={event => { if (onClick && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClick() } }}
    >
      {children}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="gh-skeleton-hint" role="status" aria-live="polite">
      <span className="gh-spin" aria-hidden="true" />
      <span>{label || '加载中…'}</span>
    </span>
  )
}

export function Empty({ title, body, action, icon, className = '' }: { title: string; body?: string; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={`pk-empty-state gh-empty ${className}`.trim()}>
      {icon ? <i aria-hidden="true">{icon}</i> : null}
      <strong className="pk-empty-title">{title}</strong>
      {body ? <p className="pk-empty-hint">{body}</p> : null}
      {action}
    </div>
  )
}

export function ErrorBar({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="gh-error" role="alert">
      <Warning size={16} />
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>{message}</span>
      {onRetry ? <button type="button" className="pk-btn pk-btn-sm" onClick={onRetry}>重试</button> : null}
    </div>
  )
}

/** 进度条；value 为 0..100 */
export function Progress({ value, tone }: { value: number; tone?: 'accent' | 'ok' | 'danger' }) {
  const percent = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div className="gh-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} data-tone={tone}>
      <i style={{ width: `${percent}%` }} />
    </div>
  )
}

export function StatusBadge({ tone, children }: { tone?: 'accent' | 'ok' | 'danger' | 'warn'; children: ReactNode }) {
  return <span className="gh-status" data-tone={tone}>{children}</span>
}

/** 骨架卡片墙（配合顶部转圈提示条使用） */
export function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="gh-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="gh-card">
          <div className="gh-cover gh-skeleton" style={{ aspectRatio: '3 / 4' }} />
          <div className="gh-card-body" style={{ gap: 6 }}>
            <div className="gh-skeleton" style={{ height: 12, width: '86%' }} />
            <div className="gh-skeleton" style={{ height: 10, width: '52%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 封面图：加载完成前显示骨架，没有封面或失败时显示占位图标。
 * 基类 gh-cover 只负责填满父容器（width/height 100%），宽高比例由使用方的容器给出。
 * onRatio：图片加载完成后给出它的真实宽高比（宽 / 高）。各数据源的缩略图比例不一样
 * （有的源是 2:1 的横版宣传图），调用方可以据此决定容器比例，而不是把横图硬塞进竖框、裁掉一多半画面。
 * 不用 loading="lazy"：图片本身已由后端取回（media.load 按并发闸逐张给 data URL），
 * 而内嵌 webview 里浏览器的懒加载不触发，会让可见的封面一直是灰块。解码交给浏览器按需处理。
 */
export function Cover({ token, alt, className = '', onRatio }: { token: string; alt: string; className?: string; onRatio?: (ratio: number) => void }) {
  const url = useMedia(token)
  const [loaded, setLoaded] = useState(false)
  const onRatioRef = useRef(onRatio)
  onRatioRef.current = onRatio
  useEffect(() => { setLoaded(false) }, [url])
  const onLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth > 0 && naturalHeight > 0) onRatioRef.current?.(naturalWidth / naturalHeight)
    setLoaded(true)
  }
  return (
    <div className={`gh-cover ${className}`.trim()} data-loaded={loaded ? 'true' : 'false'}>
      <div className="gh-cover-fallback"><Image size={28} /></div>
      {url && !loaded ? <div className="gh-skeleton" style={{ position: 'absolute', inset: 0 }} /> : null}
      {url ? <img src={url} alt={alt} decoding="async" referrerPolicy="no-referrer" onLoad={onLoad} style={{ opacity: loaded ? 1 : 0 }} /> : null}
    </div>
  )
}
