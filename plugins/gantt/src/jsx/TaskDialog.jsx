/**
 * TaskDialog.jsx —— 新建/编辑任务弹窗（Radix Dialog）
 * 名称/开始-结束（原生 date 双输入，仓内惯例）/进度 Slider/颜色色板/里程碑 Switch/
 * 父任务 Select/前置任务多选/备注。编辑时校验：end >= start、里程碑单日、
 * 父任务不能选自己或自己的后代、依赖不能成环。
 */
import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, Input, Switch, Slider, Select } from '../ui/index.jsx'
import { PALETTE_SIZE, cmpDate, fmtDate, wouldCycle, addDays, todayStr } from '../js/model.mjs'
import { paletteVar } from './GanttChart.jsx'

export function TaskDialog({ open, onOpenChange, plan, editing, api }) {
  // editing: null=新建 | task 对象 | { task, defaults } 混合（右键新建带日期/父任务）
  const task = editing?.task || editing
  const isEdit = Boolean(task?.id)
  const defaults = editing?.defaults || {}

  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [progress, setProgress] = useState(0)
  const [colorIndex, setColorIndex] = useState(0)
  const [milestone, setMilestone] = useState(false)
  const [parentId, setParentId] = useState(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const [deps, setDeps] = useState([])

  useEffect(() => {
    if (!open) return
    setError('')
    if (isEdit) {
      setName(task.name)
      setStart(task.start)
      setEnd(task.milestone ? task.start : task.end)
      setProgress(task.progress)
      setColorIndex(task.colorIndex)
      setMilestone(task.milestone)
      setParentId(task.parentId)
      setNote(task.note || '')
      setDeps(task.deps || [])
    } else {
      const s = defaults.start || todayStr()
      setName('')
      setStart(s)
      setEnd(defaults.end || s)
      setProgress(0)
      setColorIndex(defaults.colorIndex ?? (plan.tasks.length % PALETTE_SIZE))
      setMilestone(Boolean(defaults.milestone))
      setParentId(defaults.parentId ?? null)
      setNote('')
      setDeps(defaults.deps || [])
    }
  }, [open, editing]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 可作父任务的候选：排除自己与自己的后代 */
  const parentCandidates = useMemo(() => {
    if (!isEdit) return plan.tasks
    const descendants = new Set([task.id])
    let changed = true
    while (changed) {
      changed = false
      for (const t of plan.tasks) {
        if (t.parentId && descendants.has(t.parentId) && !descendants.has(t.id)) {
          descendants.add(t.id)
          changed = true
        }
      }
    }
    return plan.tasks.filter(t => !descendants.has(t.id))
  }, [plan.tasks, isEdit, task])

  /** 可作前置的任务：排除自己；选择后不能成环 */
  const depCandidates = useMemo(
    () => (isEdit ? plan.tasks.filter(t => t.id !== task.id) : plan.tasks),
    [plan.tasks, isEdit, task]
  )

  const toggleDep = (id) => {
    setDeps(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      // fromId=id(前置) -> toId=当前任务；wouldCycle(tasks, fromId, toId)
      const target = isEdit ? task.id : '__new__'
      if (isEdit && wouldCycle(plan.tasks, id, task.id)) {
        setError(`不能依赖「${plan.tasks.find(t => t.id === id)?.name}」：会形成循环依赖`)
        return prev
      }
      return [...prev, id]
    })
    setError('')
  }

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('请输入任务名称'); return }
    if (!start) { setError('请选择开始日期'); return }
    let e2 = end || start
    if (milestone) e2 = start
    else if (cmpDate(e2, start) < 0) { setError('结束日期不能早于开始日期'); return }
    if (isEdit) {
      api.patchTask(plan.id, task.id, { name: trimmed, start, end: e2, progress, colorIndex, milestone, parentId, deps, note })
    } else {
      api.createTask(plan.id, { name: trimmed, start, end: e2, progress, colorIndex, milestone, parentId, deps, note })
    }
    onOpenChange(false)
  }

  const shift = (days) => {
    const s = addDays(start, days)
    const len = cmpDate(end, start) >= 0 ? Math.max(0, (new Date(end) - new Date(start)) / 86400000) : 0
    setStart(s)
    setEnd(addDays(s, len))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gt-dialog" aria-describedby={undefined}>
        <DialogTitle>{isEdit ? '编辑任务' : '新建任务'}</DialogTitle>
        <div className="gt-form">
          <label className="gt-field">
            <span className="gt-field-label">名称</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：接口联调" maxLength={200}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }} autoFocus />
          </label>

          <div className="gt-field-row">
            <label className="gt-field">
              <span className="gt-field-label">{milestone ? '日期' : '开始'}</span>
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            {!milestone && (
              <label className="gt-field">
                <span className="gt-field-label">结束</span>
                <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} min={start} />
              </label>
            )}
            <div className="gt-field gt-field-auto">
              <span className="gt-field-label">前后调整</span>
              <div className="gt-inline-btns">
                <button type="button" className="pk-btn pk-btn-sm" onClick={() => shift(-7)}>前 7 天</button>
                <button type="button" className="pk-btn pk-btn-sm" onClick={() => shift(-1)}>前一天</button>
                <button type="button" className="pk-btn pk-btn-sm" onClick={() => shift(1)}>后一天</button>
                <button type="button" className="pk-btn pk-btn-sm" onClick={() => shift(7)}>后 7 天</button>
              </div>
            </div>
          </div>

          {!milestone && (
            <label className="gt-field">
              <span className="gt-field-label">进度 {progress}%</span>
              <Slider value={[progress]} onValueChange={([v]) => setProgress(Math.round(v))} min={0} max={100} step={5} />
            </label>
          )}

          <div className="gt-field-row">
            <div className="gt-field">
              <span className="gt-field-label">颜色</span>
              <div className="gt-swatches">
                {Array.from({ length: PALETTE_SIZE }, (_, i) => (
                  <button key={i} type="button" className={`gt-swatch${colorIndex === i ? ' is-active' : ''}`}
                    style={{ background: paletteVar(i) }} onClick={() => setColorIndex(i)}
                    aria-label={`颜色 ${i + 1}`} />
                ))}
              </div>
            </div>
            <label className="gt-field gt-field-auto">
              <span className="gt-field-label">里程碑</span>
              <Switch checked={milestone} onCheckedChange={setMilestone} />
            </label>
          </div>

          <div className="gt-field-row">
            <label className="gt-field">
              <span className="gt-field-label">父任务</span>
              <Select value={parentId || '__none__'} onChange={(v) => setParentId(v === '__none__' ? null : v)}
                options={[{ value: '__none__', label: '无（顶层任务）' }, ...parentCandidates.map(t => ({
                  value: t.id, label: t.name
                }))]} />
            </label>
          </div>

          <div className="gt-field">
            <span className="gt-field-label">前置任务（完成-开始）</span>
            <div className="gt-deps">
              {depCandidates.length === 0 && <span className="gt-hint">当前计划暂无其他任务</span>}
              {depCandidates.map(t => (
                <label key={t.id} className="gt-dep-chip">
                  <input type="checkbox" checked={deps.includes(t.id)} onChange={() => toggleDep(t.id)} />
                  <span className="gt-dep-dot" style={{ background: paletteVar(t.colorIndex) }} />
                  {t.name}
                </label>
              ))}
            </div>
          </div>

          <label className="gt-field">
            <span className="gt-field-label">备注</span>
            <textarea className="gt-textarea" value={note} onChange={(e) => setNote(e.target.value)}
              rows={2} maxLength={2000} placeholder="补充说明（可选）" />
          </label>

          {error && <div className="gt-form-error">{error}</div>}

          <div className="gt-form-actions">
            {isEdit && (
              <button type="button" className="pk-btn pk-btn-danger" onClick={() => { api.deleteTask(plan.id, task.id); onOpenChange(false) }}>
                删除
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button type="button" className="pk-btn" onClick={() => onOpenChange(false)}>取消</button>
            <button type="button" className="pk-btn pk-btn-primary" onClick={submit}>{isEdit ? '保存' : '创建'}</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
