/**
 * 扩展控件：模板 src/ui 之外的、本插件需要的组合件。
 * C、D 两个前端子代理只读这里，不要修改；缺组件在回复里提出。
 */

import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { CaretLeft, CaretRight, FolderOpen } from '@phosphor-icons/react'
import { Button, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle, Tooltip } from '../ui'
import { Glyph } from './Glyph'
import { ErrorBar } from './base'
import { sanitizeHtml } from '../js/markdown'
import { useResolvedHtml } from '../js/articleMedia'
import { enhanceArticleVideos } from '../js/video'

/* ---------------- 确认对话框 ---------------- */

export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel = '取消', danger = false, busy = false, onConfirm, onClose, children }: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
      <DialogOverlay />
      <DialogContent className="gh-dialog" aria-describedby="gh-confirm-desc">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription id="gh-confirm-desc">{body}</DialogDescription>
        {children}
        <div className="gh-dialog-actions">
          <Button onClick={onClose} disabled={busy}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- 路径选择 ---------------- */

export function PathField({ label, value, placeholder, onPick, disabled }: { label: string; value: string; placeholder?: string; onPick: () => void; disabled?: boolean }) {
  return (
    <div className="gh-field">
      <span className="gh-field-label">{label}</span>
      <div className="gh-field-row">
        <input className="pk-input gh-path-input" value={value} placeholder={placeholder ?? '尚未选择'} readOnly aria-label={label} />
        <Tooltip content="选择目录">
          <Button size="sm" onClick={onPick} disabled={disabled} aria-label={`${label}：选择目录`}><Glyph icon={FolderOpen} size={14} /><span>选择</span></Button>
        </Tooltip>
      </div>
    </div>
  )
}

/* ---------------- 分页 ---------------- */

export function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  if (totalPages <= 1) return null
  const pages: Array<number | '…'> = []
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - page) <= 2) pages.push(i)
    else if (pages[pages.length - 1] !== '…') pages.push('…')
  }
  return (
    <nav className="gh-pager" aria-label="分页">
      <Button size="sm" variant="ghost" onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="上一页"><Glyph icon={CaretLeft} size={14} /></Button>
      {pages.map((item, index) => item === '…'
        ? <span key={`gap-${index}`} className="gh-pager-info">…</span>
        : <Button key={item} size="sm" variant={item === page ? 'primary' : 'ghost'} onClick={() => onChange(item)} aria-current={item === page ? 'page' : undefined}>{item}</Button>)}
      <Button size="sm" variant="ghost" onClick={() => onChange(page + 1)} disabled={page >= totalPages} aria-label="下一页"><Glyph icon={CaretRight} size={14} /></Button>
    </nav>
  )
}

/* ---------------- 净化后的 HTML（含媒体令牌解析） ---------------- */

/**
 * 渲染一段后端净化过的富文本。
 * 后端把外站图片 / 视频换成了令牌；这里先把令牌解析成可显示地址，再过一遍前端净化，注入后
 * 给播放列表视频接上 hls.js、隐藏没有地址的视频。解析完成前显示加载态。
 */
export function SanitizedHtml({ html, as: Tag = 'div', className }: { html: string; as?: 'div' | 'article'; className?: string }) {
  const resolved = useResolvedHtml(html)
  const clean = useMemo(() => sanitizeHtml(resolved), [resolved])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root || !clean) return
    return enhanceArticleVideos(root, video => { video.hidden = true })
  }, [clean])
  if (!clean) return <div className="gh-prose gh-prose-loading" aria-busy="true"><span className="gh-spin" aria-label="加载中" /></div>
  // as 只允许 div / article 两种标签，都是普通的块容器
  return Tag === 'article'
    ? <article ref={ref as React.RefObject<HTMLElement>} className={className ?? 'gh-prose'} dangerouslySetInnerHTML={{ __html: clean }} />
    : <div ref={ref} className={className ?? 'gh-prose'} dangerouslySetInnerHTML={{ __html: clean }} />
}

/* ---------------- 带错误边界的区域 ---------------- */

export function ViewBoundary({ children, resetKey }: { children: ReactNode; resetKey?: string }) {
  const [error, setError] = useState('')
  useEffect(() => { setError('') }, [resetKey])
  if (error) return <ErrorBar message={error} onRetry={() => setError('')} />
  return <ErrorCapture onError={setError}>{children}</ErrorCapture>
}

class ErrorCapture extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[game-box] view error', error, info.componentStack)
    this.props.onError(error.message || '页面渲染出错')
  }

  render(): ReactNode {
    if (this.state.failed) return null
    return this.props.children
  }
}
