/**
 * PlanSidebar.jsx —— 左侧计划列表（hover 自动展开）：搜索、切换、右键菜单、新建。
 * 默认收起成 18px 热区竖条，mouseenter 滑出面板、mouseleave 收回；面板浮在
 * 甘特区之上不挤压右侧。用原生事件监听（React 合成 enter/leave 在部分合成
 * 事件链下不触发，原生最稳）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { planStats } from '../js/model.mjs'

export function PlanSidebar({ state, activePlan, api, onExport }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const rootRef = useRef(null)
  /* 收起前留 220ms 缓冲，鼠标斜着穿过间隙不闪跳 */
  const hideTimer = useRef(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const enter = () => { clearTimeout(hideTimer.current); setOpen(true) }
    const leave = () => { clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => setOpen(false), 220) }
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    return () => {
      clearTimeout(hideTimer.current)
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
    }
  }, [])

  const stats = useMemo(
    () => new Map(state.plans.map(p => [p.id, planStats(p)])),
    [state.plans]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return state.plans
    return state.plans.filter(p => p.name.toLowerCase().includes(q))
  }, [state.plans, query])

  const planMenu = (plan, e) => {
    e.preventDefault()
    e.stopPropagation()
    api.openMenu(e, [
      ['rename', '重命名'],
      ['export', '导出 Excel'],
      ['exportHtml', '导出 HTML'],
      'sep',
      ['delete', `删除计划（含 ${plan.tasks.length} 个任务）`, { danger: true, disabled: state.plans.length <= 1 }]
    ], (key) => {
      if (key === 'rename') {
        const name = window.prompt('重命名计划', plan.name)
        if (name && name.trim()) api.renamePlan(plan.id, name.trim())
      } else if (key === 'export') onExport(plan, 'xlsx')
      else if (key === 'exportHtml') onExport(plan, 'html')
      else if (key === 'delete') {
        if (window.confirm(`确定删除计划「${plan.name}」？其 ${plan.tasks.length} 个任务将一并删除。`)) {
          api.deletePlan(plan.id)
        }
      }
    })
  }

  return (
    <aside ref={rootRef} className={`plan-sidebar${pinned || open ? ' is-open' : ''}`}>
      <button type="button" className="plan-side-handle"
        aria-expanded={pinned || open} aria-label="展开计划列表"
        title={pinned ? '收起计划列表' : '展开计划列表（点击固定）'}
        onClick={() => setPinned(p => !p)}>
        <span className="plan-handle-glyph">▤</span>
        <span className="plan-handle-badge">{state.plans.length}</span>
      </button>
      <div className="plan-side-panel gt-panel">
        <div className="plan-list-head">
          <span>计划</span>
          <span className="plan-count">{state.plans.length}</span>
        </div>
        <div className="plan-search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索计划" maxLength={60} />
        </div>
        <div className="plan-list">
          {filtered.map(plan => {
            const s = stats.get(plan.id)
            return (
              <button key={plan.id}
                className={`plan-item${plan.id === activePlan?.id ? ' is-active' : ''}`}
                onClick={() => api.setActivePlan(plan.id)}
                onContextMenu={(e) => planMenu(plan, e)}
                title={`${plan.name} · ${s.leaves} 项 · ${s.progress}%`}>
                <span className="plan-name">{plan.name}</span>
                <span className="plan-count">{s.leaves}项 · {s.progress}%</span>
                <span className="plan-bar" aria-hidden="true">
                  <span style={{ width: `${s.progress}%` }} />
                </span>
                {s.violations.length > 0 && <span className="plan-warn" title={`${s.violations.length} 处依赖冲突`} />}
              </button>
            )
          })}
          {filtered.length === 0 && <div className="plan-empty">没有匹配的计划</div>}
        </div>
        <button className="plan-add" onClick={() => api.createPlan()}>+ 新建计划</button>
      </div>
    </aside>
  )
}
