/**
 * ChatView — 会话流视图：顶栏 + 消息列表 + Composer。
 * 用户消息靠右（复制/重新编辑）；AI 消息靠左无框（running shimmer / 图片网格 / 失败卡）。
 * 自动滚动：新内容贴底，上滚 >120px 暂停并显示「回到最新」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Composer } from './Composer.jsx'
import { usageLabel } from '../js/params.mjs'
import { assetPreviewUrl } from '../js/assets.mjs'

function UserMessage({ message, onCopy, onRecall }) {
  const atts = Array.isArray(message.attachments) ? message.attachments : []
  const shown = atts.slice(0, 4)
  const more = atts.length - shown.length
  return (
    <div className="ig-msg ig-msg-user">
      {atts.length > 0 && (
        <div className="ig-user-atts">
          {shown.map((att, i) => (
            <span key={att.assetId ?? i} className="ig-user-att">
              <AttThumb assetId={att.assetId} />
              {i === shown.length - 1 && more > 0 && <span className="ig-user-att-more">+{more}</span>}
            </span>
          ))}
        </div>
      )}
      {message.prompt && <div className="ig-user-bubble">{message.prompt}</div>}
      <div className="ig-user-acts">
        <button type="button" className="ig-act-btn" onClick={() => onCopy(message.prompt)}>复制</button>
        <button type="button" className="ig-act-btn" onClick={() => onRecall(message)}>重新编辑</button>
      </div>
    </div>
  )
}

function AttThumb({ assetId }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    if (!assetId) return
    if (String(assetId).startsWith('data:')) { setUrl(assetId); return }
    assetPreviewUrl(assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [assetId])
  return url ? <img src={url} alt="附件" draggable={false} /> : null
}

function AssistantMessage({ message, onOpenImage, onImageAction, onRetry, onContinue, onDownloadAll, onStop }) {
  const [revisedOpen, setRevisedOpen] = useState(false)
  const [errorOpen, setErrorOpen] = useState(false)

  if (message.status === 'running') {
    const kb = Math.max(0, Math.round((message.receivedBytes ?? 0) / 1024))
    return <div className="ig-msg ig-msg-assistant">
      <div className="ig-assistant-block">
        <div className="ig-running">
          <span className="ig-shimmer" aria-hidden="true" />
          <span className="ig-running-info">
            正在生成…<br />
            <span className="ig-running-kb">{kb > 0 ? `${kb} KB` : '等待响应'}</span>
          </span>
          <button type="button" className="ig-stop-btn" aria-label="停止生成" title="停止生成" onClick={onStop}>
            <span className="ig-stop-square" />
          </button>
        </div>
      </div>
    </div>
  }

  if (message.status === 'cancelled') {
    return <div className="ig-msg ig-msg-assistant">
      <div className="ig-assistant-block">
        <div className="ig-cancelled">
          <span>已取消</span>
          <button type="button" className="pk-btn pk-btn-sm" onClick={onRetry}>重试</button>
        </div>
      </div>
    </div>
  }

  if (message.status === 'error') {
    return <div className="ig-msg ig-msg-assistant">
      <div className="ig-assistant-block">
        <div className="ig-error-card" data-open={errorOpen ? '' : undefined}>
          <div className="ig-error-head">
            <span>生成失败</span>
            <button type="button" className="ig-error-toggle" onClick={() => setErrorOpen(v => !v)}>
              {errorOpen ? '收起' : '展开'}
            </button>
            <button type="button" className="pk-btn pk-btn-sm" onClick={onRetry} style={{ marginLeft: 8 }}>重试</button>
          </div>
          <div className="ig-error-detail">{message.error}</div>
        </div>
      </div>
    </div>
  }

  const images = Array.isArray(message.images) ? message.images : []
  const meta = message.meta ?? {}
  const usage = usageLabel(meta.usage)
  return <div className="ig-msg ig-msg-assistant">
    <div className="ig-assistant-block">
      {images.length > 0 && (
        <div className="ig-grid" data-count={Math.min(images.length, 4)}>
          {images.map((img, i) => (
            <ImageCellWrap key={img.assetId} assetId={img.assetId} index={i} count={images.length}
              onOpen={onOpenImage} onImageAction={onImageAction} />
          ))}
        </div>
      )}
      <div className="ig-meta-row">
        <span className="ig-meta-model">{meta.model}</span>
        {meta.size && meta.size !== 'auto' && <span>{meta.size}</span>}
        <span>{((meta.ms ?? 0) / 1000).toFixed(1)}s</span>
        {usage && <span>{usage}</span>}
        {message.revised && (
          <button type="button" className="ig-revised-toggle" aria-expanded={revisedOpen}
            onClick={() => setRevisedOpen(v => !v)}>优化后提示词 ▸</button>
        )}
      </div>
      {revisedOpen && message.revised && <div className="ig-revised-body">{message.revised}</div>}
      <div className="ig-result-acts">
        <button type="button" className="pk-btn pk-btn-sm" onClick={onRetry}>重新生成</button>
        {images.length > 0 && (
          <button type="button" className="pk-btn pk-btn-sm" onClick={() => onContinue(images[0])}>以此图继续</button>
        )}
        {images.length > 1 && (
          <button type="button" className="pk-btn pk-btn-sm" onClick={onDownloadAll}>全部下载</button>
        )}
      </div>
    </div>
  </div>
}

/** 图片格 + hover 渐变操作条（以此图继续/下载/删除） */
function ImageCellWrap({ assetId, index, count, onOpen, onImageAction }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    assetPreviewUrl(assetId).then(u => { if (alive) setUrl(u) }).catch(() => {})
    return () => { alive = false }
  }, [assetId])
  // 1 图时 hover 放大智能贴边：靠左半屏贴左、靠右半屏贴右
  const onEnter = (event) => {
    const cell = event.currentTarget
    if (count !== 1) return
    const rect = cell.getBoundingClientRect()
    const mid = window.innerWidth / 2
    cell.dataset.origin = rect.left + rect.width / 2 < mid ? 'left' : 'right'
  }
  return <div className="ig-cell ig-cell-zoomable" onMouseEnter={onEnter} onClick={() => url && onOpen(assetId, url)}>
    {url ? <img src={url} alt="生成图" draggable={false} /> : <span className="ig-lib-skel" />}
    {url && <span className="ig-cell-bar" onClick={e => e.stopPropagation()}>
      <button type="button" className="ig-cell-act" title="以此图继续" aria-label="以此图继续"
        onClick={() => onImageAction('continue', assetId, url)}>✎</button>
      <button type="button" className="ig-cell-act" title="下载" aria-label="下载"
        onClick={() => onImageAction('download', assetId, url)}>⤓</button>
      <button type="button" className="ig-cell-act" title="删除" aria-label="删除"
        onClick={() => onImageAction('delete', assetId, url)}>✕</button>
    </span>}
  </div>
}

export function ChatView({
  messages, onOpenImage, onImageAction, onRetry, onContinue, onDownloadAll, onCopyPrompt,
  composerProps, topbar, running
}) {
  const streamRef = useRef(null)
  const [showJump, setShowJump] = useState(false)
  const stickRef = useRef(true)

  const scrollToBottom = useCallback((smooth = true) => {
    const el = streamRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  useEffect(() => {
    if (stickRef.current) scrollToBottom(false)
  }, [messages, scrollToBottom])

  const onScroll = () => {
    const el = streamRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = distance <= 120
    setShowJump(distance > 120)
  }

  /* 生成中持续贴底（KB 计数更新） */
  useEffect(() => {
    if (running && stickRef.current) {
      const id = requestAnimationFrame(() => scrollToBottom(false))
      return () => cancelAnimationFrame(id)
    }
  }, [running, scrollToBottom])

  return (
    <div className="ig-stage">
      {topbar}
      <div className="ig-stream" ref={streamRef} onScroll={onScroll}>
        <div className="ig-stream-inner">
          {messages.length === 0 && (
            <div className="ig-lib-empty">
              <span>描述画面，Enter 发送</span>
            </div>
          )}
          {messages.map((m, i) => m.role === 'user'
            ? <UserMessage key={m.id} message={m} onCopy={onCopyPrompt} onRecall={msg => composerProps.onRecall?.(msg)} />
            : <AssistantMessage key={m.id} message={m}
              onOpenImage={onOpenImage}
              onImageAction={onImageAction}
              onRetry={() => onRetry(i)}
              onContinue={onContinue}
              onDownloadAll={() => onDownloadAll(m)}
              onStop={() => composerProps.onStop?.()} />)}
        </div>
      </div>
      {showJump && (
        <button type="button" className="ig-jump-latest" onClick={() => { stickRef.current = true; scrollToBottom() }}>
          ↓ 回到最新
        </button>
      )}
      <Composer {...composerProps} />
    </div>
  )
}
