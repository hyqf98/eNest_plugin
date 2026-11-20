/**
 * PlanSidebar.jsx —— 左栏计划列表：搜索、切换、右键菜单（重命名/导出/删除）、新建
 */
import { useMemo, useState } from 'react'
import { planStats, fmtDate } from '../js/model.mjs'

export function PlanSidebar({ state, activePlan, api, onExport }) {
  const [query, setQuery] = useState('')

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
    <aside className="plan-sidebar">
      <div className="gt-bezel">
        <div className="gt-bezel-inner">
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
                  onDoubleClick={(e) => planMenu(plan, e)}
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
      </div>
    </aside>
  )
}
