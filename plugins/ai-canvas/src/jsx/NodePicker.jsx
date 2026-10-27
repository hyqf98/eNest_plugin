/**
 * NodePicker — 节点选择浮层（Dify BlockSelector 同款手感）。
 * 搜索 + 分类分组 + ↑↓/Enter/Esc 键盘导航；由点击端口 / 边中点 / 画布菜单呼出。
 * categories 由调用方给出已过滤的候选（[{category, defs}]）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { PORT_KINDS } from '../js/nodeSchema.mjs'

export function NodePicker({ anchor, groups, title = '添加节点', onPick, onClose }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef(null)
  const searchRef = useRef(null)

  const flat = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const items = []
    for (const group of groups) {
      const defs = group.defs.filter(def =>
        !needle || def.title.toLowerCase().includes(needle) || def.type.toLowerCase().includes(needle) ||
        (def.description ?? '').toLowerCase().includes(needle))
      for (const def of defs) items.push({ group: group.category, def })
    }
    return items
  }, [groups, query])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => {
    const onDocPointer = e => { if (!rootRef.current?.contains(e.target)) onClose() }
    window.addEventListener('pointerdown', onDocPointer, true)
    return () => window.removeEventListener('pointerdown', onDocPointer, true)
  }, [onClose])

  const onKeyDown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, flat.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) onPick(flat[active].def) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }

  const style = {
    position: 'fixed',
    left: Math.min(anchor.x, window.innerWidth - 264),
    top: Math.min(anchor.y, window.innerHeight - 322),
    zIndex: 220
  }
  let renderedIndex = -1
  return (
    <div ref={rootRef} className="ac-picker" style={style} onKeyDown={onKeyDown} role="dialog" aria-label={title}>
      <input ref={searchRef} className="ac-picker-search" placeholder="搜索节点…" value={query}
        onChange={e => setQuery(e.target.value)} />
      <div className="ac-picker-list">
        {flat.length === 0 && <div className="ac-picker-empty">没有匹配的节点</div>}
        {groups.map(group => {
          const items = flat.filter(item => item.group === group.category)
          if (!items.length) return null
          return <div key={group.category} className="ac-picker-group">
            <div className="ac-picker-group-title">{group.category}</div>
            {items.map(({ def }) => {
              renderedIndex += 1
              const index = renderedIndex
              return <button type="button" key={def.type}
                className={`ac-picker-item ${index === active ? 'ac-picker-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => onPick(def)}>
                <span className="ac-glyph" aria-hidden>{def.glyph}</span>
                <span className="ac-picker-item-body">
                  <span className="ac-picker-item-title">{def.title}</span>
                  {def.description && <span className="ac-picker-item-desc">{def.description}</span>}
                </span>
                <span className="ac-picker-item-ports">
                  {def.inputs.length > 0 && <i>入 {def.inputs.map(p => PORT_KINDS[p.kind]?.glyph ?? '?').join('·')}</i>}
                  {def.outputs.length > 0 && <i>出 {def.outputs.map(p => PORT_KINDS[p.kind]?.glyph ?? '?').join('·')}</i>}
                </span>
              </button>
            })}
          </div>
        })}
      </div>
      <div className="ac-picker-hint">↑↓ 选择 · Enter 添加 · Esc 关闭</div>
    </div>
  )
}
