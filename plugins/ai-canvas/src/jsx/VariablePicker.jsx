/**
 * VariablePicker — 上游变量引用弹层（portal 到 body）。
 *
 * React Flow 节点在带 transform 的 viewport 内，弹层若用 position:fixed 会被该祖先
 * 变成"局部 fixed"而坐标错乱（选择器跑到角落）。统一 createPortal 到 document.body，
 * 坐标按视口 clientX/clientY 计算即正确。
 *
 * 支持 ↑↓ 导航 + Enter 选中（在 @ 触发的编辑器里按键直接选）；groups 由调用方给出，
 * 回传 { nodeId, portKey, selector, kind, ... } 交给调用方插入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PORT_KINDS } from '../js/nodeSchema.mjs'

const WIDTH = 252

export function VariablePicker({ anchor, groups, emptyHint = '没有可引用的上游变量', onInsert, onClose }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef(null)
  const listRef = useRef(null)
  const searchRef = useRef(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return groups
    return groups
      .map(g => ({ ...g, vars: g.vars.filter(v =>
        v.label.toLowerCase().includes(needle) || g.title.toLowerCase().includes(needle) || v.portKey.toLowerCase().includes(needle)) }))
      .filter(g => g.vars.length)
  }, [groups, query])

  const flat = useMemo(() => {
    const out = []
    for (const g of filtered) for (const v of g.vars) out.push({ ...v, nodeId: g.nodeId, nodeTitle: g.title, glyph: g.glyph })
    return out
  }, [filtered])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => {
    const onDocPointer = e => { if (!rootRef.current?.contains(e.target)) onClose() }
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', onDocPointer, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDocPointer, true); window.removeEventListener('keydown', onKey) }
  }, [onClose])
  // 高亮项滚入可视区
  useEffect(() => {
    const el = listRef.current?.querySelector('.ac-varpicker-active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => flat.length ? (a + 1) % flat.length : 0) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => flat.length ? (a - 1 + flat.length) % flat.length : 0) }
    else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      const item = flat[active]
      if (item) onInsert(item)
    } else if (e.key === 'Escape') { e.stopPropagation(); onClose() }
  }

  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - WIDTH - 8))
  const top = Math.min(anchor.y, window.innerHeight - 330)
  let renderedIndex = -1
  return createPortal(
    <div ref={rootRef} className="ac-varpicker" style={{ position: 'fixed', left, top, zIndex: 500 }}
      role="dialog" aria-label="引用上游变量">
      <input ref={searchRef} className="ac-picker-search" placeholder="搜索变量…（↑↓ 选择 · Enter 引用）" value={query}
        onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} />
      <div ref={listRef} className="ac-varpicker-list" onKeyDown={onKeyDown}>
        {filtered.length === 0 && <div className="ac-picker-empty">{emptyHint}</div>}
        {filtered.map(group => (
          <div key={group.nodeId} className="ac-picker-group">
            <div className="ac-picker-group-title">
              <span className="ac-glyph" aria-hidden>{group.glyph}</span> {group.title}
            </div>
            {group.vars.map(v => {
              renderedIndex += 1
              const index = renderedIndex
              return (
                <button type="button" key={v.portKey}
                  className={`ac-varpicker-item ${index === active ? 'ac-varpicker-active' : ''}`}
                  onMouseDown={e => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onInsert({ ...v, nodeId: group.nodeId, nodeTitle: group.title })}>
                  <span className={`ac-var-kind ac-var-${v.kind}`}>{PORT_KINDS[v.kind]?.glyph ?? '?'}</span>
                  <span className="ac-varpicker-label">{v.label}</span>
                  {v.multiple && <span className="ac-var-multi">多值</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body
  )
}
