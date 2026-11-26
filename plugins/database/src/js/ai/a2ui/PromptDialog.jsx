/**
 * PromptDialog.jsx — 单行文本输入对话框（命令式侧调用的 React 渲染层）。
 * window.prompt 在 Electron 渲染进程里恒返回 null，重命名这类输入一律走这里。
 * 本插件只引入了 pk-ui.css、没有 Radix 依赖，所以复用 .pk-dialog-* / .pk-prompt-* 类名自己画遮罩与弹层。
 * 用法：const name = await askText({ title, defaultValue })，取消时得到 null。
 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

function PromptForm({ title, defaultValue, onCancel, onSubmit }) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef(null)
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])
  return (
    <div
      className="pk-dialog-overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }}
    >
      <div className="pk-dialog-content" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pk-dialog-title">{title}</div>
        <form
          className="pk-prompt-form"
          onSubmit={(event) => { event.preventDefault(); onSubmit(value.trim()) }}
        >
          <input
            ref={inputRef}
            className="pk-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="pk-prompt-actions">
            <button type="button" className="pk-btn pk-btn-ghost" onClick={onCancel}>取消</button>
            <button type="submit" className="pk-btn pk-btn-primary">确定</button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** 弹出输入框并等待结果；同一时刻只允许一个，重复调用直接返回 null。 */
export function askText({ title, defaultValue = '' }) {
  if (document.querySelector('[data-dbai-prompt]')) return Promise.resolve(null)
  const host = document.createElement('div')
  host.dataset.dbaiPrompt = ''
  document.body.append(host)
  const root = createRoot(host)
  return new Promise((resolve) => {
    const finish = (value) => {
      root.unmount()
      host.remove()
      resolve(value)
    }
    root.render(
      <PromptForm
        title={title}
        defaultValue={defaultValue}
        onCancel={() => finish(null)}
        onSubmit={finish}
      />
    )
  })
}
