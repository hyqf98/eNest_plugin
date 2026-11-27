/**
 * ChatView — 会话流视图：顶栏 + 消息列表 + Composer。
 * 用户消息靠右（复制/重新编辑）；AI 消息靠左（running 占位 / 图片网格 / 失败卡）。
 * 自动滚动：新内容贴底，上滚 >120px 暂停并显示「回到最新」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Composer } from './Composer.jsx'
import { usageLabel } from '../js/params.mjs'
import { assetPreviewUrl } from '../js/assets.mjs'
import {
  AlertIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon,
  PencilIcon, RotateIcon, SparklesIcon, SquareIcon, TrashIcon
} from '../ui/icons.jsx'

/** 空态给出的起步提示：真实可用的短提示词，不是占位文案 */
const STARTERS = [
  { key: 'product', label: '商品图', text: '白底棚拍，柔和顶光，居中构图，浅灰渐变背景，高细节，4:5 竖构图' },
  { key: 'scene', label: '场景图', text: '清晨的日式木质小屋厨房，窄窗透入斜射光，浅景深，安静氛围，写实摄影' },
  { key: 'portrait', label: '人像', text: '侧脸半身人像，窗帘柔光，浅灰背景，35mm 镜头质感，自然肤色' }
]

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
        <button type="button" className="ig-act-btn" onClick={() => onCopy(message.prompt)}>
          <CopyIcon size={12} />复制
        </button>
        <button type="button" className="ig-act-btn" onClick={() => onRecall(message)}>
          <PencilIcon size={12} />重新编辑
        </button>
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

function AssistantMessage({ message, prompt, onOpenImage, onImageAction, onRetry, onContinue, onDownloadAll, onStop, onCopyPrompt }) {
  const [revisedOpen, setRevisedOpen] = useState(false)
  const [errorOpen, setErrorOpen] = useState(false)
  /* 「复制提示词」复制实际发给模型的那条：模型改写过（revised）就是改写后的，否则是用户原话 */
  const promptToCopy = message.revised || prompt || ''

  if (message.status === 'running') {
    const kb = Math.max(0, Math.round((message.receivedBytes ?? 0) / 1024))
    return <div className="ig-msg ig-msg-assistant">
      <div className="ig-assistant-block">
        <div className="ig-running">
          <span className="ig-shimmer" aria-hidden="true" />
          <span className="ig-running-info">
            <span className="ig-running-title">正在生成</span>
            <span className="ig-running-sub" aria-live="polite">{kb > 0 ? `${kb} KB` : '等待响应'}</span>
          </span>
          <button type="button" className="ig-stop-btn" onClick={onStop} title="停止生成">
            <SquareIcon size={11} strokeWidth={2.4} />停止
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
          <button type="button" className="ig-act-btn" onClick={onRetry}>
            <RotateIcon size={12} />重试
          </button>
        </div>
      </div>
    </div>
  }

  if (message.status === 'error') {
    return <div className="ig-msg ig-msg-assistant">
      <div className="ig-assistant-block">
        <div className="ig-error-card" data-open={errorOpen ? '' : undefined}>
          <div className="ig-error-head">
            <AlertIcon size={14} />
            <span>生成失败</span>
            <span className="ig-error-acts">
              <button type="button" className="ig-error-toggle" aria-expanded={errorOpen} onClick={() => setErrorOpen(v => !v)}>
                {errorOpen ? '收起' : '详情'}
              </button>
              <button type="button" className="ig-act-btn" onClick={onRetry}>
                <RotateIcon size={12} />重试
              </button>
            </span>
          </div>
          <div className="ig-error-detail">{message.error}</div>
        </div>
      </div>
    </div>
  }

  const images = Array.isArray(message.images) ? message.images : []
  const meta = message.meta ?? {}
  const usage = usageLabel(meta.usage)
  const metaBits = [
    meta.size && meta.size !== 'auto' ? meta.size : '',
    Number.isFinite(meta.ms) ? `${(meta.ms / 1000).toFixed(1)}s` : '',
    usage
  ].filter(Boolean)

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
        {meta.model && <span className="ig-meta-model">{meta.model}</span>}
        {metaBits.map((bit, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span className="ig-meta-sep" aria-hidden="true" />{bit}
          </span>
        ))}
        {message.revised && (
          <button type="button" className="ig-revised-toggle" aria-expanded={revisedOpen}
            onClick={() => setRevisedOpen(v => !v)}>
            <ChevronRightIcon size={11} />优化后提示词
          </button>
        )}
      </div>
      {revisedOpen && message.revised && <div className="ig-revised-body">{message.revised}</div>}
      <div className="ig-result-acts">
        {promptToCopy && (
          <button type="button" className="ig-act-btn" title={message.revised ? '复制模型改写后的提示词' : '复制这条生成用的提示词'}
            onClick={() => onCopyPrompt(promptToCopy)}>
            <CopyIcon size={12} />复制提示词
          </button>
        )}
        {images.length > 0 && (
          <button type="button" className="ig-act-btn" onClick={() => onImageAction('copy', images[0].assetId)}>
            <CopyIcon size={12} />复制图片
          </button>
        )}
        {images.length > 0 && (
          <button type="button" className="ig-act-btn" onClick={() => onImageAction('download', images[0].assetId)}>
            <DownloadIcon size={12} />下载
          </button>
        )}
        <button type="button" className="ig-act-btn" onClick={onRetry}>
          <RotateIcon size={12} />重新生成
        </button>
        {images.length > 0 && (
          <button type="button" className="ig-act-btn" onClick={() => onContinue(images[0])}>
            <PencilIcon size={12} />以此图继续
          </button>
        )}
        {images.length > 1 && (
          <button type="button" className="ig-act-btn" onClick={onDownloadAll}>
            <DownloadIcon size={12} />全部下载
          </button>
        )}
      </div>
    </div>
  </div>
}

/** 图片格 + hover 渐变操作条（以此图继续/下载/删除） */
function ImageCellWrap({ assetId, index, count, onOpen, onImageAction }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    assetPreviewUrl(assetId).then(u => { if (alive) setUrl(u) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [assetId])

  return <div className="ig-cell" data-count={count} onClick={() => url && onOpen(assetId, url)}>
    {url
      ? <img src={url} alt="生成图" draggable={false} onError={() => setFailed(true)} />
      : failed
        ? <span className="ig-cell-failed">图片无法读取</span>
        : <span className="ig-lib-skel" aria-hidden="true" />}
    {url && (
      <span className="ig-cell-bar" onClick={e => e.stopPropagation()}>
        <button type="button" className="ig-cell-act" title="以此图继续" aria-label="以此图继续"
          onClick={() => onImageAction('continue', assetId, url)}><PencilIcon size={14} /></button>
        <button type="button" className="ig-cell-act" title="复制图片" aria-label="复制图片"
          onClick={() => onImageAction('copy', assetId, url)}><CopyIcon size={14} /></button>
        <button type="button" className="ig-cell-act" title="下载" aria-label="下载"
          onClick={() => onImageAction('download', assetId, url)}><DownloadIcon size={14} /></button>
        <button type="button" className="ig-cell-act" data-danger title="删除" aria-label="删除"
          onClick={() => onImageAction('delete', assetId, url)}><TrashIcon size={14} /></button>
      </span>
    )}
  </div>
}

/** 空态：给出三个真实可用的起点，点一下直接进输入框 */
function Welcome({ onUsePrompt, onOpenSettings, hasProvider }) {
  return (
    <div className="ig-welcome">
      <span className="ig-welcome-mark" aria-hidden="true"><SparklesIcon size={22} /></span>
      <h1 className="ig-welcome-title">描述画面，生成图片</h1>
      <p className="ig-welcome-desc">
        写清构图、光线和质感效果最好。<br className="ig-welcome-br" />
        参考图可直接拖进窗口，或用 ⌘V 粘贴剪贴板里的图做图生图。
      </p>
      {hasProvider ? (
        <div className="ig-welcome-list">
          <span className="ig-welcome-list-title">试一条现成的</span>
          {STARTERS.map(item => (
            <button key={item.key} type="button" className="ig-welcome-item" onClick={() => onUsePrompt?.(item.text)}>
              <span className="ig-welcome-item-label">{item.label}</span>
              <span className="ig-welcome-item-text">{item.text}</span>
              <ChevronRightIcon size={14} className="ig-welcome-item-arrow" />
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className="ig-welcome-item" onClick={onOpenSettings}>
          <span className="ig-welcome-item-label" data-tone="warn"><AlertIcon size={12} />尚未配置渠道</span>
          <span className="ig-welcome-item-text">添加接口地址、模型和密钥后即可开始生成。</span>
          <ChevronRightIcon size={14} className="ig-welcome-item-arrow" />
        </button>
      )}
    </div>
  )
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

  /* 图片解码后高度突变：messages 变化那一刻图还是占位块，effect 滚的是占位的高度；
     等图真正加载出来长到几百像素，messages 没再变，没人补滚——图的下沿和元信息就被输入框盖住。
     这里观察内容区的实际尺寸，只要用户还在贴底就跟着滚。 */
  useEffect(() => {
    const el = streamRef.current
    const inner = el?.firstElementChild
    if (!inner || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (stickRef.current) scrollToBottom(false) })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [scrollToBottom])

  /* scroll 事件分不清是用户滚的还是程序滚的。在 scroll 里更新贴底状态会和 ResizeObserver 抢跑：
     多图陆续解码时内容一次次长高，程序刚滚到底、内容又长了一截，距离 >120 就被误判成
     「用户上滚了」→ 之后不再跟随，图留在输入框后面。所以贴底状态只在用户的真实输入上判定。 */
  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    const settle = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 120
    }
    const onWheel = () => { setTimeout(settle, 0) }
    const onTouch = () => { setTimeout(settle, 0) }
    const onKey = (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key) && e.target === el) setTimeout(settle, 0)
    }
    // 拖滚动条：pointerdown 落在滚动容器自身（不是子元素）上
    const onPointer = (e) => { if (e.target === el) setTimeout(settle, 0) }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', onTouch, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('pointerdown', onPointer)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', onTouch)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('pointerdown', onPointer)
    }
  }, [])

  /* 「回到最新」只管按钮显隐，用 scroll 实时算即可（它不参与贴底判定） */
  const onScroll = () => {
    const el = streamRef.current
    if (!el) return
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 120)
  }

  /* 生成中持续贴底（KB 计数更新） */
  useEffect(() => {
    if (running && stickRef.current) {
      const id = requestAnimationFrame(() => scrollToBottom(false))
      return () => cancelAnimationFrame(id)
    }
  }, [running, scrollToBottom])

  /* 每条 AI 消息对应的用户提示词：往前找最近一条用户消息（「复制提示词」在模型没改写时用它） */
  const promptFor = (index) => {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i].prompt || ''
    }
    return ''
  }

  return (
    <div className="ig-stage">
      {topbar}
      <div className="ig-stream-wrap">
        <div className="ig-stream" ref={streamRef} onScroll={onScroll}>
          <div className="ig-stream-inner">
            {messages.length === 0
              ? <Welcome onUsePrompt={composerProps.onUsePrompt} onOpenSettings={composerProps.onOpenSettings}
                  hasProvider={composerProps.hasProvider} />
              : messages.map((m, i) => m.role === 'user'
                ? <UserMessage key={m.id} message={m} onCopy={onCopyPrompt} onRecall={msg => composerProps.onRecall?.(msg)} />
                : <AssistantMessage key={m.id} message={m} prompt={promptFor(i)}
                  onOpenImage={onOpenImage}
                  onImageAction={onImageAction}
                  onRetry={() => onRetry(i)}
                  onContinue={onContinue}
                  onDownloadAll={() => onDownloadAll(m)}
                  onStop={() => composerProps.onStop?.()}
                  onCopyPrompt={onCopyPrompt} />)}
          </div>
        </div>
        {showJump && (
          <button type="button" className="ig-jump-latest" onClick={() => { stickRef.current = true; scrollToBottom() }}>
            <ChevronDownIcon size={13} />回到最新
          </button>
        )}
      </div>
      <Composer {...composerProps} />
    </div>
  )
}
