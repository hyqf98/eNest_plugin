/** 条目卡片列表：首字母圆标 + 标题/用户名/强度徽章/相对时间；点击进详情。 */
import { Icon } from './icons.jsx'

const STRENGTH_LABEL = { weak: '弱', fair: '中', strong: '强' }

export function relTime(ts) {
  const delta = Date.now() - Number(ts || 0)
  if (!Number.isFinite(delta) || delta < 0) return ''
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

function Avatar({ entry }) {
  const letter = String(entry.title || '?').trim().charAt(0).toUpperCase()
  return (
    <span className="avatar" aria-hidden="true">
      {/[a-z0-9]/i.test(letter) ? letter : <>{Icon.globe(18)}</>}
    </span>
  )
}

export function StrengthBadge({ level }) {
  return <span className={`badge strength-${level || 'weak'}`}>{STRENGTH_LABEL[level] || '弱'}</span>
}

export function EntryList({ entries, activeId, onSelect, onEdit, onDelete }) {
  if (!entries.length) return null
  return (
    <div className="entry-grid" role="list">
      {entries.map((entry, index) => (
        <article
          key={entry.id}
          className={'entry-card' + (entry.id === activeId ? ' active' : '')}
          role="listitem"
          style={{ '--i': Math.min(index, 12) }}
          onClick={() => onSelect(entry)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(entry) } }}
          tabIndex={0}
          aria-label={`条目 ${entry.title}`}
        >
          <div className="entry-head">
            <Avatar entry={entry} />
            <div className="entry-title-wrap">
              <span className="entry-title">{entry.title}</span>
              <span className="entry-site">{entry.site}</span>
            </div>
            <StrengthBadge level={entry.strength} />
          </div>
          <div className="entry-user" title={entry.username}>{entry.username}</div>
          <div className="entry-foot">
            <span className="entry-time">{relTime(entry.updatedAt)}</span>
            <span className="card-actions" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" title="编辑" aria-label={`编辑 ${entry.title}`} onClick={() => onEdit(entry)}>{Icon.edit()}</button>
              <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm danger" title="删除" aria-label={`删除 ${entry.title}`} onClick={() => onDelete(entry)}>{Icon.trash()}</button>
            </span>
          </div>
        </article>
      ))}
    </div>
  )
}
