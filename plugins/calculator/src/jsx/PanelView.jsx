import { useEffect, useRef, useState } from 'react'
import { observeWidgetSize } from '@enest/plugin-kit/widget'
import { Button } from '../ui/index.jsx'

export function PanelView({ expr, inputRef, result, recent, onChange, onConfirm, onCopy, onOpen }) {
  const rootRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => observeWidgetSize(rootRef.current, setSize), [])
  const showRecent = Boolean(recent && size.height >= 260)

  return (
    <main ref={rootRef} className="pk-widget calculator-widget" aria-label="计算器小组件">
      <div className="pk-widget-heading calculator-widget-heading">
        <h1 className="pk-widget-title">计算器</h1>
        <Button variant="ghost" size="sm" className="calculator-widget-action" onClick={onCopy} disabled={result.value == null} title="复制结果" aria-label="复制结果">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M12 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.5" /></svg>
        </Button>
        <Button variant="ghost" size="sm" className="calculator-widget-action" onClick={onOpen} title="打开完整计算器" aria-label="打开完整计算器">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="M6 14 14 6M6 6h8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </Button>
      </div>
      <form className="calculator-widget-form" onSubmit={(event) => { event.preventDefault(); onConfirm() }}>
        <div className="calculator-widget-body">
          <input ref={inputRef} className="pk-input calculator-widget-input" value={expr} onChange={(event) => onChange(event.target.value)}
            spellCheck="false" autoComplete="off" aria-label="计算表达式，按 Enter 记入历史" title="按 Enter 计算并记入历史" placeholder="输入表达式，如 128 / 4" />
          <output className="calculator-widget-result" data-error={result.error} aria-live="polite" title={result.text}>
            {result.value == null && !result.error ? '即输即算' : result.text}
          </output>
        </div>
        {showRecent && (
          <div className="calculator-widget-recent" title={`${recent.expr} = ${recent.result}`}>
            <span>最近计算</span>
            <p>{recent.expr} = {recent.result}</p>
          </div>
        )}
      </form>
    </main>
  )
}
