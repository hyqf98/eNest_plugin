/**
 * SessionRail — 左侧会话栏：会话列表 + 新建；折叠态由 App 控制（data-rail-collapsed）。
 * 重命名走内联输入框：window.prompt 在 Electron 渲染进程里不可用（直接返回 null），
 * 原先的「重命名」点了没有任何反应。
 */
import { useEffect, useRef, useState } from 'react'
import { MoreMenu } from '../ui/index.jsx'
import { PencilIcon, PlusIcon, TrashIcon } from '../ui/icons.jsx'

function timeLabel(at) {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function RenameInput({ value, onCommit, onCancel }) {
  const ref = useRef(null)
  const [text, setText] = useState(value ?? '')
  const doneRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  const commit = () => {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(text)
  }
  const cancel = () => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }

  return (
    <input
      ref={ref}
      className="ig-rail-rename"
      value={text}
      aria-label="会话名称"
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        else if (e.key === 'Escape') { e.preventDefault(); cancel() }
      }}
    />
  )
}

export function SessionRail({ sessions, activeId, onSelect, onNew, onDelete, onRename }) {
  const [renamingId, setRenamingId] = useState('')

  return (
    <aside className="ig-rail" aria-label="会话列表">
      <div className="ig-rail-head">
        <span className="ig-rail-title">会话</span>
        <button type="button" className="ig-icon-btn" title="新建会话" aria-label="新建会话" onClick={onNew}>
          <PlusIcon size={16} />
        </button>
      </div>
      <div className="ig-rail-list">
        {sessions.length === 0 && (
          <div className="ig-rail-empty">还没有会话。发送第一条提示词就会自动建一个。</div>
        )}
        {sessions.map(s => (
          <div key={s.id} className={`ig-rail-item ${s.id === activeId ? 'active' : ''}`}
            role="button" tabIndex={0}
            onClick={() => { if (renamingId !== s.id) onSelect(s.id) }}
            onKeyDown={e => { if (e.key === 'Enter' && renamingId !== s.id) onSelect(s.id) }}>
            {renamingId === s.id ? (
              <RenameInput value={s.title}
                onCommit={text => { setRenamingId(''); if (text?.trim()) onRename(s.id, text) }}
                onCancel={() => setRenamingId('')} />
            ) : (
              <>
                <span className="ig-rail-item-title" title={s.title}>{s.title}</span>
                <span className="ig-rail-item-time">{timeLabel(s.updatedAt)}</span>
                <span className="ig-rail-more">
                  <MoreMenu
                    ariaLabel="会话操作"
                    buttonClassName="ig-act-btn"
                    items={[
                      { key: 'rename', label: '重命名', onSelect: () => setRenamingId(s.id) },
                      { key: 'delete', label: '删除会话', danger: true, onSelect: () => onDelete(s.id) }
                    ]}
                  />
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
