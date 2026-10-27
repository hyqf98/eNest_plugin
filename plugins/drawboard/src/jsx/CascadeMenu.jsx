/**
 * CascadeMenu —— 画板右键多级菜单（替代 plugin-kit openMenu 的单层限制）
 * - 任意层级：item.children 存在时 hover 展开右侧子菜单
 * - 自动定位：屏幕内翻转/收贴；子菜单超右边则向左展开
 * - 视觉沿用 pk-menu token，滚动条走主题胶囊样式
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

let cascadeSeq = 0

export function openCascadeMenu(x, y, items, onPick) {
  const host = document.createElement('div')
  host.id = `db-cascade-${++cascadeSeq}`
  host.className = 'db-cascade-host'
  document.body.append(host)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    host.remove()
    document.removeEventListener('pointerdown', onDocDown, true)
    window.removeEventListener('resize', close)
  }
  const onDocDown = (e) => {
    if (!host.contains(e.target)) close()
  }
  document.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('resize', close)

  const root = createRootSafe(host)
  root.render(
    <CascadeLevel
      items={items}
      x={x}
      y={y}
      onPick={(key) => { close(); onPick?.(key) }}
      onCloseRequest={close}
    />,
  )
  return { close }
}

/* React 18 createRoot（本插件直接依赖 react-dom） */
import { createRoot } from 'react-dom/client'
function createRootSafe(host) { return createRoot(host) }

function CascadeLevel({ items, x, y, onPick, onCloseRequest, depth = 0 }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [openSub, setOpenSub] = useState(null) // item.key
  const hoverTimer = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + r.width > innerWidth - 8) left = depth > 0 ? x - r.width - 6 : innerWidth - r.width - 8
    if (left < 8) left = 8
    if (top + r.height > innerHeight - 8) top = Math.max(8, innerHeight - r.height - 8)
    if (top < 8) top = 8
    setPos({ left, top })
  }, [x, y, depth])

  const scheduleOpen = useCallback((key, hasChildren) => {
    clearTimeout(hoverTimer.current)
    if (!hasChildren) { hoverTimer.current = setTimeout(() => setOpenSub(null), 120); return }
    hoverTimer.current = setTimeout(() => setOpenSub(key), 120)
  }, [])

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const subItem = items.find((it) => it.sep !== true && it.key === openSub && it.children?.length)
  const rowEl = ref.current?.querySelector(`button[data-k="${CSS.escape(String(openSub))}"]`)

  return (
    <div ref={ref} className="pk-menu db-cascade" style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((item, i) => {
        if (item === 'sep' || item.sep) return <div key={`sep${i}`} className="pk-menu-sep" role="separator" />
        // 内嵌控件项：widget 组件占一行；hover 不改变子菜单开合（保持父级展开，避免拖动中被重挂）
        if (item.widget) {
          const Widget = item.widget
          return (
            <div key={item.key || `w${i}`} className="db-menu-widget">
              <Widget />
            </div>
          )
        }
        const hasChildren = !!item.children?.length
        return (
          <button
            key={item.key}
            type="button"
            className={`pk-menu-item${item.danger ? ' danger' : ''}`}
            role="menuitem"
            data-k={String(item.key)}
            aria-haspopup={hasChildren ? 'menu' : undefined}
            aria-expanded={hasChildren ? String(openSub === item.key) : undefined}
            disabled={item.disabled}
            data-highlighted={openSub === item.key ? '' : undefined}
            onClick={(e) => {
              e.stopPropagation()
              if (hasChildren) { setOpenSub(openSub === item.key ? null : item.key); return }
              onPick(String(item.key))
            }}
            onPointerEnter={() => scheduleOpen(item.key, hasChildren)}
          >
            {item.icon ? <span className="db-menu-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: item.icon }} /> : null}
            <span className="pk-menu-label">{item.label}</span>
            {item.hint && <span className="pk-menu-hint pk-mono">{item.hint}</span>}
            {hasChildren && (
              <span className="db-cascade-arrow" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg>
              </span>
            )}
          </button>
        )
      })}
      {subItem && rowEl && (
        <CascadeLevel
          items={subItem.children}
          x={pos.left + ref.current.offsetWidth + 6}
          y={rowEl.getBoundingClientRect().top}
          onPick={onPick}
          onCloseRequest={onCloseRequest}
          depth={depth + 1}
        />
      )}
    </div>
  )
}
