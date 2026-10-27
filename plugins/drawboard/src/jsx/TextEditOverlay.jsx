/**
 * TextEditOverlay —— 文字编辑：画布上定位 textarea，字号×zoom，失焦/⌘Enter 提交
 */
import { useEffect, useRef } from 'react'
import { worldToScreen } from '../js/viewport.mjs'

export function TextEditOverlay({ editing, vp, color, theme, onCommit, onCancel }) {
  const ref = useRef(null)

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.select()
    }
  }, [editing])

  if (!editing) return null
  const p = worldToScreen(vp, editing.world.x, editing.world.y)
  const fontSize = (editing.existing?.size || 24) * vp.zoom
  const value = editing.existing ? editing.existing.text : editing.draftText || ''
  const ink = editing.existing?.color || color || theme.ink

  return (
    <textarea
      ref={ref}
      className="db-textedit"
      style={{
        left: p.x, top: p.y,
        fontSize, lineHeight: 1.3,
        color: ink,
        fontFamily: '"LXGW WenKai Lite", "Kaiti SC", "STKaiti", serif',
      }}
      defaultValue={value}
      placeholder="输入文字…"
      spellCheck={false}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(e.target.value) }
      }}
    />
  )
}
