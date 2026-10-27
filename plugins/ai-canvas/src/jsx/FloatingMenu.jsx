/**
 * FloatingMenu — 固定坐标浮层菜单（画布/节点/边右键共用）。
 * items: [{ label, glyph?, danger?, disabled?, hint?, onClick }]；separator 用 { sep: true }。
 */
import { useEffect, useRef } from 'react'

export function FloatingMenu({ anchor, items, onClose }) {
  const rootRef = useRef(null)

  useEffect(() => {
    const onDocPointer = e => { if (!rootRef.current?.contains(e.target)) onClose() }
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDocPointer, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDocPointer, true); window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const style = {
    position: 'fixed',
    left: Math.min(anchor.x, window.innerWidth - 216),
    top: Math.min(anchor.y, window.innerHeight - items.length * 34 - 24),
    zIndex: 240
  }
  return (
    <div ref={rootRef} className="ac-fmenu" style={style} role="menu">
      {items.map((item, index) => item.sep
        ? <div key={`sep-${index}`} className="ac-fmenu-sep" />
        : <button type="button" key={item.label} role="menuitem"
            className={`ac-fmenu-item ${item.danger ? 'ac-fmenu-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => { onClose(); item.onClick?.() }}>
            <span className="ac-fmenu-glyph" aria-hidden>{item.glyph ?? ''}</span>
            <span className="ac-fmenu-label">{item.label}</span>
            {item.hint && <span className="ac-fmenu-hint">{item.hint}</span>}
          </button>)}
    </div>
  )
}
