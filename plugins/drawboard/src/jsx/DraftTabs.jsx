/**
 * DraftTabs —— 工具栏下方草稿 Tab 条：点击切换 / 双击重命名 / 中键或 × 关闭 / + 新建
 * 多于 8 个时可横向滚动；与侧栏草稿列表共用同一套草稿操作。
 */
import { useEffect, useRef, useState } from 'react'

export function DraftTabs({ drafts, activeId, onSelect, onCreate, onRename, onDelete }) {
  const [renaming, setRenaming] = useState(null)
  const [name, setName] = useState('')
  const inputRef = useRef(null)
  const stripRef = useRef(null)

  useEffect(() => {
    if (renaming && inputRef.current) { inputRef.current.focus(); inputRef.current.select() }
  }, [renaming])

  // 活跃 Tab 滚入视野
  useEffect(() => {
    const strip = stripRef.current
    const active = strip?.querySelector('.db-tab.active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [activeId, drafts.length])

  const closeTab = (e, id) => {
    e.stopPropagation()
    onDelete(id)
  }

  return (
    <div className="db-tabs" role="tablist" aria-label="草稿页">
      <div className="db-tab-strip" ref={stripRef}>
        {drafts.map((d) => (
          <div
            key={d.id}
            role="tab"
            aria-selected={d.id === activeId}
            className={`db-tab${d.id === activeId ? ' active' : ''}`}
            title={`${d.name}（双击重命名，中键关闭）`}
            onClick={() => onSelect(d.id)}
            onDoubleClick={() => { setRenaming(d.id); setName(d.name) }}
            onAuxClick={(e) => { if (e.button === 1) closeTab(e, d.id) }}
          >
            {renaming === d.id ? (
              <input
                ref={inputRef}
                className="pk-input db-tab-rename"
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
                <span className="db-tab-name">{d.name}</span>
                {drafts.length > 1 && (
                  <button
                    type="button"
                    className="db-tab-close"
                    aria-label={`关闭 ${d.name}`}
                    title="关闭草稿"
                    onClick={(e) => closeTab(e, d.id)}
                  >✕</button>
                )}
              </>
            )}
          </div>
        ))}
        {/* ＋ 紧跟最后一个 Tab，同在滚动容器内；Tab 多时一起横向滚动 */}
        <button type="button" className="db-tab db-tab-new" role="button" aria-label="新建草稿" title="新建草稿" onClick={onCreate}>＋</button>
      </div>
    </div>
  )
}
