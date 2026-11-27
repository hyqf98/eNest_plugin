import { useEffect, useState } from 'react'

/** kit 降级封装（toast 等） */
export function useKit() {
  const [kit, setKit] = useState(null)
  useEffect(() => {
    const t = setInterval(() => { if (window.PluginKit?.create) { clearInterval(t); setKit(window.PluginKit.create({ plugin: 'tvbox' })) } }, 120)
    return () => clearInterval(t)
  }, [])
  return kit
}


export function ErrorBox({ error, onRetry }) {
  if (!error) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <div className="tb-error">{error}</div>
      {onRetry ? <div><button className="pk-btn pk-btn-sm" onClick={onRetry}>重试</button></div> : null}
    </div>
  )
}

export function Empty({ title, hint, children }) {
  return (
    <div className="pk-empty-state">
      <strong className="pk-empty-title">{title}</strong>
      {hint && <p className="pk-empty-hint">{hint}</p>}
      {children}
    </div>
  )
}

/** 骨架卡片行（+ 顶部转圈提示，避免长时间聚合加载时看不出在进行中） */
export function SkeletonRow({ count = 8, label = '加载中…' }) {
  return (
    <div>
      <div className="tb-skeleton-hint" role="status" aria-live="polite">
        <span className="tb-loading-ring" aria-hidden />
        <span>{label}</span>
      </div>
      <div className="tb-row" aria-hidden>
        {Array.from({ length: count }, (_, i) => (
          <div key={`sk-${i}`} className="tb-card tb-card-skeleton"><div className="tb-card-poster tb-skeleton" /></div>
        ))}
      </div>
    </div>
  )
}

export function LoadMore({ loading, hasMore, onLoad }) {
  if (!hasMore) return null
  return (
    <div className="tb-loadmore">
      <button className="pk-btn pk-btn-sm" disabled={loading} onClick={onLoad}>{loading ? '加载中…' : '加载更多'}</button>
    </div>
  )
}

/** 分类 tab 行 */
export function TypeChips({ types, active, onSelect }) {
  return (
    <div className="tb-types">
      {types.map(t => (
        <button key={t.type_id} className={`tb-type-chip${t.type_id === active ? ' pk-active' : ''}`} onClick={() => onSelect(t.type_id)}>
          {t.type_name}
        </button>
      ))}
    </div>
  )
}

/** 筛选行（by/area/lang/year）：点击即切换，空值代表「全部」 */
export function FilterRows({ filters, values, onChange }) {
  if (!filters?.length) return null
  return (
    <div className="tb-filters">
      {filters.map(group => {
        // 过滤掉空名/空值条目（采集站常把「全部」占位混进 value 数组）
        const opts = (group.value ?? []).filter(v => (v.n && String(v.n).trim()) || (v.v && String(v.v).trim()))
        return (
          <div className="tb-filter-row" key={group.key}>
            <span className="tb-filter-name">{group.name}</span>
            <div className="tb-filter-values">
              <button
                type="button"
                className={`tb-fchip${!values[group.key] ? ' pk-active' : ''}`}
                onClick={() => onChange(group.key, '')}
              >全部</button>
              {opts.map((v, i) => {
                const val = String(v.v ?? '')
                const label = String(v.n || v.v || '')
                return (
                  <button
                    type="button"
                    key={`${group.key}-${val}-${i}`}
                    className={`tb-fchip${values[group.key] === val ? ' pk-active' : ''}`}
                    onClick={() => onChange(group.key, values[group.key] === val ? '' : val)}
                  >{label}</button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
