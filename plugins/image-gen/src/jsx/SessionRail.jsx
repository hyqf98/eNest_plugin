/**
 * SessionRail — 左侧会话栏：会话列表 + 新建；折叠态由 App 控制（data-rail-collapsed）。
 */
import { MoreMenu } from '../ui/index.jsx'

function timeLabel(at) {
  if (!at) return ''
  const d = new Date(at)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function SessionRail({ sessions, activeId, onSelect, onNew, onDelete, onRename }) {
  return (
    <aside className="ig-rail" aria-label="会话列表">
      <div className="ig-rail-head">
        <span className="ig-rail-title">会话</span>
        <button type="button" className="ig-icon-btn" title="新建会话" aria-label="新建会话" onClick={onNew}>＋</button>
      </div>
      <div className="ig-rail-list">
        {sessions.length === 0 && <div className="ig-rail-empty">还没有会话<br />发送第一条提示词开始</div>}
        {sessions.map(s => (
          <div key={s.id} className={`ig-rail-item ${s.id === activeId ? 'active' : ''}`}
            role="button" tabIndex={0}
            onClick={() => onSelect(s.id)}
            onKeyDown={e => { if (e.key === 'Enter') onSelect(s.id) }}>
            <span className="ig-rail-item-title" title={s.title}>{s.title}</span>
            <span style={{ color: 'var(--ig-muted)', fontSize: 11, flex: 'none' }}>{timeLabel(s.updatedAt)}</span>
            <MoreMenu
              ariaLabel="会话操作"
              buttonClassName="ig-act-btn"
              label="⋯"
              items={[
                { key: 'rename', label: '重命名', onSelect: () => onRename(s.id) },
                { key: 'delete', label: '删除会话', danger: true, onSelect: () => onDelete(s.id) }
              ]}
            />
          </div>
        ))}
      </div>
    </aside>
  )
}
