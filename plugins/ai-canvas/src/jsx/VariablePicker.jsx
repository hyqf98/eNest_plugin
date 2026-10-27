/**
 * VariablePicker — 变量引用选择浮层（Dify VarReferencePicker 同款）。
 * 按上游节点分组列出已运行出的输出端口，点击插入 {{#nodeId.port#}} 到参数文本。
 * 组顺序按节点 x 倒序（近在上游优先）；搜索框过滤变量名/节点名。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { PORT_KINDS } from '../js/nodeSchema.mjs'
import { listUpstreamVariables } from '../js/variables.mjs'

export function VariablePicker({ anchor, nodes, edges, nodeId, getOutputs, onInsert, onClose }) {
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)
  const searchRef = useRef(null)

  const groups = useMemo(
    () => listUpstreamVariables({ nodeId, nodes, edges, getOutputs }),
    [nodeId, nodes, edges, getOutputs]
  )
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return groups
    return groups
      .map(group => ({ ...group, vars: group.vars.filter(v =>
        v.label.toLowerCase().includes(needle) || group.title.toLowerCase().includes(needle) || v.portKey.toLowerCase().includes(needle)) }))
      .filter(group => group.vars.length)
  }, [groups, query])

  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => {
    const onDocPointer = e => { if (!rootRef.current?.contains(e.target)) onClose() }
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('pointerdown', onDocPointer, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDocPointer, true); window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const style = {
    position: 'fixed',
    left: Math.min(anchor.x, window.innerWidth - 260),
    top: Math.min(anchor.y, window.innerHeight - 320),
    zIndex: 230
  }
  return (
    <div ref={rootRef} className="ac-varpicker" style={style} role="dialog" aria-label="引用上游变量">
      <input ref={searchRef} className="ac-picker-search" placeholder="搜索变量…" value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }} />
      <div className="ac-varpicker-list">
        {filtered.length === 0 && <div className="ac-picker-empty">没有可引用的上游变量<br />（上游节点需先运行出结果）</div>}
        {filtered.map(group => (
          <div key={group.nodeId} className="ac-picker-group">
            <div className="ac-picker-group-title">
              <span className="ac-glyph" aria-hidden>{group.glyph}</span> {group.title}
            </div>
            {group.vars.map(v => (
              <button type="button" key={v.portKey} className="ac-varpicker-item"
                onClick={() => { onInsert(v.selector); onClose() }}>
                <span className={`ac-var-kind ac-var-${v.kind}`}>{PORT_KINDS[v.kind]?.glyph ?? '?'}</span>
                <span className="ac-varpicker-label">{v.label}</span>
                {v.multiple && <span className="ac-var-multi">多值</span>}
                <span className="ac-varpicker-path">{v.selector}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
