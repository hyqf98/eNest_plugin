/**
 * Composer — 输入卡：附件 / 文本 / 参数 / 发送 全在一张卡里。
 *
 * 原先参数条浮在卡外上方、模板按钮是 ⭐ 文本字形、发送与参数分属两行，
 * 三者视觉上互不相干。现在收成一张卡：上附件、中文本、下参数与动作，
 * 参数紧贴发送按钮，视线不用在窗口里来回跳。
 *
 * 快捷：Enter 发送 / Shift+Enter 换行 / 空框 ↑ 回溯历史 / ⌘V 粘贴图片 / 整窗拖入。
 */
import { useEffect, useRef, useState } from 'react'
import { SIZE_OPTIONS } from '../js/params.mjs'
import {
  ArrowUpIcon, ChevronDownIcon, MinusIcon, PaperclipIcon, PlusIcon, SettingsIcon, SparklesIcon, SquareIcon, XIcon
} from '../ui/icons.jsx'

const MAX_ATTACHMENTS = 4

export function Composer({
  value, onChange, onSend, busy, onStop,
  attachments, onAttachmentsChange,
  size, onSizeChange, n, onNChange,
  templates, onOpenTemplateSettings,
  onPickFiles, onImageClick, toast, editMode,
  onOpenSettings, hasProvider, historyPrompts = [],
  /* 外部请求聚焦输入框：「带入提示词」等操作后由 App 设置 { token, select?: [start, end] }。
     不在调用处直接 .focus()——那时输入框可能还没挂载（刚从灵感页切回来）；
     也不靠 requestAnimationFrame——窗口未获焦时它会被节流，实测 1.5s 内不触发。
     select：聚焦后顺带选中的区间（带入的提示词里有占位符时选中第一个，直接打字即可替换）。 */
  focusRequest = null
}) {
  const taRef = useRef(null)
  const tplRef = useRef(null)
  const [tplOpen, setTplOpen] = useState(false)
  /* 历史直接由当前会话消息流推导（App 传入），不再在组件里另存一份：
     组件内 ref 一旦重挂载/切会话就清空，↑ 回溯会失效。cursor 只表示"往回翻了几条"。 */
  const cursorRef = useRef(-1)

  /* 输入内容变了（含切换会话）= 退出回溯状态 */
  useEffect(() => { cursorRef.current = -1 }, [historyPrompts.length])

  useEffect(() => {
    const ta = taRef.current
    if (!focusRequest || !ta) return
    ta.focus()
    const range = focusRequest.select
    if (range) ta.setSelectionRange(range[0], range[1])
  }, [focusRequest])

  /* textarea 自动增高（1-6 行） */
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [value])

  /* 模板菜单点外部关闭：原先只能再点一次按钮，容易漏掉 */
  useEffect(() => {
    if (!tplOpen) return
    const onDown = (event) => {
      if (tplRef.current?.contains(event.target)) return
      setTplOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') setTplOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [tplOpen])

  /* 空框 ↑ 回溯本会话已发送的提示词 */
  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
      event.preventDefault()
      onSend()
      return
    }
    const canBrowse = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.isComposing
    if (event.key === 'ArrowUp' && !value && canBrowse && historyPrompts.length) {
      event.preventDefault()
      const next = Math.min(cursorRef.current + 1, historyPrompts.length - 1)
      cursorRef.current = next
      onChange(historyPrompts[historyPrompts.length - 1 - next])
    }
    if (event.key === 'ArrowDown' && !value && canBrowse && cursorRef.current >= 0) {
      event.preventDefault()
      const next = cursorRef.current - 1
      cursorRef.current = next
      onChange(next < 0 ? '' : historyPrompts[historyPrompts.length - 1 - next])
    }
  }

  const send = () => {
    cursorRef.current = -1
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
  const canSend = Boolean(value.trim() || attachments.length)

  return (
    <div className="ig-composer">
      <div className="ig-composer-inner">
        <div className="ig-composer-card">
          {attachments.length > 0 && (
            <div className="ig-composer-atts">
              {attachments.map(att => (
                <div key={att.id} className="ig-att-chip">
                  <button type="button" className="ig-att-open" title={att.name || '附件'} aria-label="预览附件"
                    onClick={() => onImageClick(att.dataUrl)}>
                    <img src={att.dataUrl} alt={att.name || '附件'} />
                  </button>
                  <button type="button" className="ig-att-x" aria-label="移除附件" title="移除"
                    onClick={() => removeAttachment(att.id)}>
                    <XIcon size={10} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={taRef}
            className="ig-composer-textarea"
            rows={1}
            spellCheck={false}
            aria-label={editMode ? '描述要如何修改这张图' : '描述要生成的画面'}
            placeholder={editMode ? '描述要如何修改这张图，Enter 发送' : '描述要生成的画面，Enter 发送'}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />

          <div className="ig-composer-foot">
            <button type="button" className="ig-icon-btn" title="添加图片" aria-label="添加图片" onClick={onPickFiles}>
              <PaperclipIcon size={16} />
            </button>

            <span className="ig-param-group" role="group" aria-label="尺寸">
              {SIZE_OPTIONS.map(o => (
                <button key={o.value} type="button"
                  className={`ig-param-opt ${size === o.value ? 'active' : ''}`}
                  aria-pressed={size === o.value}
                  title={o.value === 'auto' ? '由模型决定尺寸' : o.value}
                  onClick={() => onSizeChange(o.value)}>{o.label}</button>
              ))}
            </span>

            <span className="ig-stepper" role="group" aria-label="生成数量">
              <button type="button" aria-label="减少数量" disabled={n <= 1} onClick={() => onNChange(n - 1)}>
                <MinusIcon size={12} strokeWidth={2} />
              </button>
              <span className="ig-stepper-value" aria-live="polite">{n}</span>
              <button type="button" aria-label="增加数量" disabled={n >= 4} onClick={() => onNChange(n + 1)}>
                <PlusIcon size={12} strokeWidth={2} />
              </button>
            </span>

            <span className="ig-composer-foot-spacer" />

            <span className="ig-tpl-anchor" ref={tplRef}>
              <button type="button" className="ig-icon-btn" title="提示词模板" aria-label="提示词模板"
                data-on={tplOpen ? '' : undefined} aria-expanded={tplOpen}
                onClick={() => setTplOpen(v => !v)}>
                <SparklesIcon size={16} />
              </button>
              {tplOpen && (
                <div className="ig-tpl-menu" role="menu" aria-label="提示词模板">
                  {templates.length === 0 && (
                    <div className="ig-tpl-empty">还没有模板。在设置里存几条常用提示词，这里就能一键追加。</div>
                  )}
                  {templates.map(t => (
                    <button key={t.id} type="button" role="menuitem" className="ig-tpl-item"
                      onClick={() => { onChange(value ? `${value}\n${t.content}` : t.content); setTplOpen(false); taRef.current?.focus() }}>
                      <span className="ig-tpl-item-title">{t.title}</span>
                      <span className="ig-tpl-item-preview">{t.content}</span>
                    </button>
                  ))}
                  <button type="button" className="ig-tpl-manage" onClick={() => { setTplOpen(false); onOpenTemplateSettings() }}>
                    管理模板…
                  </button>
                </div>
              )}
            </span>

            {busy ? (
              <button type="button" className="ig-send-btn" data-busy="" aria-label="停止生成" title="停止生成" onClick={onStop}>
                <SquareIcon size={12} strokeWidth={2.4} />
              </button>
            ) : (
              <button type="button" className="ig-send-btn"
                aria-label={hasProvider ? '发送' : '先配置渠道'}
                title={hasProvider ? '发送' : '先配置渠道'}
                disabled={!canSend}
                onClick={send}>
                <ArrowUpIcon size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>

        {!hasProvider && (
          <button type="button" className="ig-composer-hint" onClick={onOpenSettings}>
            <SettingsIcon size={13} />
            还没有可用渠道，先添加一个才能生成
            <ChevronDownIcon size={12} className="ig-composer-hint-arrow" />
          </button>
        )}
      </div>
    </div>
  )
}
