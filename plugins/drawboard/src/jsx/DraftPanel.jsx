/**
 * DraftPanel —— 侧滑草稿列表：新建/重命名/复制/删除
 */
import { useEffect, useRef, useState } from 'react'

export function DraftPanel({ open, drafts, activeId, onSelect, onCreate, onRename, onDuplicate, onDelete, onClose }) {
  const [renaming, setRenaming] = useState(null)
  const [name, setName] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (renaming && inputRef.current) { inputRef.current.focus(); inputRef.current.select() }
  }, [renaming])

  if (!open) return null

  return (
    <div className="db-aside" role="complementary" aria-label="草稿列表">
      <div className="db-aside-head">
        <span>草稿</span>
        <div className="db-aside-actions">
          <button type="button" className="pk-btn pk-btn-sm" onClick={onCreate}>新建</button>
          <button type="button" className="pk-btn pk-btn-sm db-aside-close" aria-label="关闭草稿列表" onClick={onClose}>✕</button>
        </div>
      </div>
      <ul className="db-draft-list">
        {drafts.map((d) => (
          <li
            key={d.id}
            className={`db-draft${d.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(d.id)}
          >
            {renaming === d.id ? (
              <input
                ref={inputRef}
                className="pk-input db-rename"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { onRename(d.id, name.trim() || d.name); setRenaming(null) }
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={() => { onRename(d.id, name.trim() || d.name); setRenaming(null) }}
              />
            ) : (
              <>
                <span className="db-draft-name" title={d.name}>{d.name}</span>
                <span className="db-draft-meta">{d.objects.length} 项</span>
                <span className="db-draft-ops" onClick={(e) => e.stopPropagation()}>
                  <button type="button" aria-label="重命名" title="重命名" onClick={() => { setRenaming(d.id); setName(d.name) }}>✎</button>
                  <button type="button" aria-label="复制草稿" title="复制草稿" onClick={() => onDuplicate(d.id)}>⧉</button>
                  <button type="button" aria-label="删除草稿" title="删除草稿" className="danger" onClick={() => onDelete(d.id)}>🗑</button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
