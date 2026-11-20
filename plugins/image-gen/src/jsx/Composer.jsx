/**
 * Composer — 输入卡片：参数条（尺寸/数量/模板）+ 附件 chip + 自动增高 textarea。
 * Enter 发送 / Shift+Enter 换行 / 空框 ↑ 回溯历史 / ⌘V 粘贴图片 / 📎 选图 / 整窗拖入。
 */
import { useEffect, useRef, useState } from 'react'
import { SIZE_OPTIONS } from '../js/params.mjs'

const MAX_ATTACHMENTS = 4

export function Composer({
  value, onChange, onSend, busy, onStop,
  attachments, onAttachmentsChange,
  size, onSizeChange, n, onNChange,
  templates, onOpenTemplateSettings,
  onPickFiles, onImageClick, toast, editMode
}) {
  const taRef = useRef(null)
  const [tplOpen, setTplOpen] = useState(false)
  const historyRef = useRef({ prompts: [], cursor: -1 })

  /* textarea 自动增高 1-6 行 */
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`
  }, [value])

  /* 空框 ↑ 回溯本会话历史 prompt */
  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
      event.preventDefault()
      onSend()
      return
    }
    if (event.key === 'ArrowUp' && !value && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.isComposing) {
      const prompts = historyRef.current.prompts
      if (!prompts.length) return
      event.preventDefault()
      const cursor = Math.min(historyRef.current.cursor + 1, prompts.length - 1)
      historyRef.current.cursor = cursor
      onChange(prompts[prompts.length - 1 - cursor])
    }
    if (event.key === 'ArrowDown' && !value && historyRef.current.cursor >= 0) {
      event.preventDefault()
      const cursor = historyRef.current.cursor - 1
      historyRef.current.cursor = cursor
      onChange(cursor < 0 ? '' : historyRef.current.prompts[historyRef.current.prompts.length - 1 - cursor])
    }
  }

  /** 外部（回溯 API/以此图继续）推送 prompt 时登记进历史 */
  const pushHistory = (prompt) => {
    const list = historyRef.current.prompts
    if (prompt && list[list.length - 1] !== prompt) {
      list.push(prompt)
      if (list.length > 40) list.shift()
    }
    historyRef.current.cursor = -1
  }

  const send = () => {
    pushHistory(value)
    onSend()
  }

  /* ⌘V 粘贴图片（clipboardData） */
  const onPaste = (event) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
      .map(i => i.getAsFile())
      .filter(Boolean)
    if (!files.length) return
    event.preventDefault()
    addFiles(files)
  }

  const addFiles = (files) => {
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) { toast(`最多 ${MAX_ATTACHMENTS} 张附件`); return }
    const take = files.slice(0, room)
    if (files.length > room) toast(`最多 ${MAX_ATTACHMENTS} 张附件，已忽略 ${files.length - room} 张`)
    let pending = take.length
    const next = [...attachments]
    for (const file of take) {
      const reader = new FileReader()
      reader.onload = () => {
        next.push({ id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, dataUrl: String(reader.result), name: file.name })
        if (--pending === 0) onAttachmentsChange(next)
      }
      reader.readAsDataURL(file)
    }
  }

  const removeAttachment = (id) => onAttachmentsChange(attachments.filter(a => a.id !== id))

  return (
    <div className="ig-composer">
      <div className="ig-composer-inner">
        <div className="ig-param-row">
          <span className="ig-param-group" role="group" aria-label="尺寸">
            {SIZE_OPTIONS.map(o => (
              <button key={o.value} type="button" className={`ig-param-opt ${size === o.value ? 'active' : ''}`}
                onClick={() => onSizeChange(o.value)}>{o.label}</button>
            ))}
          </span>
          <span className="ig-stepper" role="group" aria-label="数量">
            <button type="button" aria-label="减少数量" disabled={n <= 1} onClick={() => onNChange(n - 1)}>−</button>
            <span className="ig-stepper-value">{n}</span>
            <button type="button" aria-label="增加数量" disabled={n >= 4} onClick={() => onNChange(n + 1)}>＋</button>
          </span>
          <span className="ig-param-spacer" />
          <span className="ig-tpl-anchor">
            <button type="button" className="ig-icon-btn" title="提示词模板" aria-label="提示词模板"
              onClick={() => setTplOpen(v => !v)}>⭐</button>
            {tplOpen && (
              <div className="ig-tpl-menu" role="menu" aria-label="提示词模板">
                {templates.length === 0 && <div className="ig-tpl-empty">还没有模板，去设置里添加常用的提示词</div>}
                {templates.map(t => (
                  <button key={t.id} type="button" role="menuitem" className="ig-tpl-item"
                    onClick={() => { onChange(value ? `${value}\n${t.content}` : t.content); setTplOpen(false); taRef.current?.focus() }}>
                    <span className="ig-tpl-item-title">{t.title}</span>
                    <span className="ig-tpl-item-preview">{t.content}</span>
                  </button>
                ))}
                <button type="button" className="ig-tpl-manage" onClick={() => { setTplOpen(false); onOpenTemplateSettings() }}>管理模板…</button>
              </div>
            )}
          </span>
        </div>
        <div className="ig-composer-card">
          {attachments.length > 0 && (
            <div className="ig-composer-atts">
              {attachments.map(att => (
                <button key={att.id} type="button" className="ig-att-chip" title={att.name || '附件'} aria-label="预览附件"
                  onClick={() => onImageClick(att.dataUrl)}>
                  <img src={att.dataUrl} alt={att.name || '附件'} />
                  <span className="ig-att-x" role="button" aria-label="移除附件" tabIndex={0}
                    onClick={e => { e.stopPropagation(); removeAttachment(att.id) }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); removeAttachment(att.id) } }}>✕</span>
                </button>
              ))}
            </div>
          )}
          <div className="ig-composer-row">
            <button type="button" className="ig-icon-btn" title="添加图片" aria-label="添加图片" onClick={onPickFiles}>📎</button>
            <textarea
              ref={taRef}
              className="ig-composer-input"
              rows={1}
              spellCheck={false}
              aria-label={editMode ? '描述要如何修改这张图' : '描述要生成的画面'}
              placeholder={editMode ? '描述要如何修改这张图…' : '描述要生成的画面，Enter 发送'}
              value={value}
              onChange={e => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <button type="button" className="ig-send-btn" aria-label={busy ? '停止生成' : '发送'} title={busy ? '停止生成' : '发送'}
              onClick={() => (busy ? onStop() : send())}>
              {busy ? <span className="ig-send-stop" /> : <span className="ig-send-arrow">↑</span>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
