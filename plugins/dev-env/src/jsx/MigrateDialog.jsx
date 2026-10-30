/** 迁移页：目标路径 + plan 预览（steps/configChanges/dataBytes）→ 确认执行（moveData 可选）。 */
import { useCallback, useState } from 'react'
import { Button, Checkbox, Dialog, DialogContent, DialogTitle, DialogDescription, Input } from '../ui/index.jsx'
import { backend } from '../js/backend.js'
import { formatBytes } from '../js/format.js'

export function MigrateDialog({ selected, say, runTask }) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [plan, setPlan] = useState(null)
  const [moveData, setMoveData] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const family = selected.family

  const buildPlan = useCallback(async () => {
    if (!target.trim().startsWith('/')) { say('目标必须是绝对路径', 'error'); return }
    say('正在生成迁移方案…', 'busy')
    try {
      const result = await backend.migratePlan(family, selected.id, target.trim())
      setPlan(result)
      say('迁移方案已生成，请确认后执行')
    } catch (error) { say(`生成方案失败：${error.message}`, 'error') }
  }, [family, say, selected.id, target])

  const execute = useCallback(async () => {
    setConfirming(false)
    setOpen(false)
    say(`正在迁移 ${family} → ${target}…`, 'busy')
    try {
      const spec = { kind: 'migrate.run', family, id: selected.id, target: target.trim(), moveData, __label: `迁移 ${family}` }
      const result = await runTask(spec).catch(async () => backend.migrateRun(family, selected.id, target.trim(), moveData))
      if (result?.taskId) return
      if (result && result.ok !== false) say(result.note ?? '迁移完成')
      else say(result?.note ?? '迁移失败', 'error')
    } catch (error) { say(error.message, 'error') }
  }, [family, moveData, runTask, say, selected.id, target])

  return (
    <div className="migrate-entry">
      <Button variant="primary" size="sm" onClick={() => { setPlan(null); setOpen(true) }}>迁移…</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="dev-dialog wide">
          <DialogTitle>迁移 {family} 数据目录</DialogTitle>
          <DialogDescription>把缓存/仓库等数据目录迁到新位置（如外置盘），配置同步指向新路径。</DialogDescription>
          <div className="form">
            <label>目标路径</label>
            <Input className="pk-mono" value={target} placeholder="/Volumes/Data/npm-cache" onChange={(event) => setTarget(event.target.value)} />
          </div>
          <div className="dialog-actions left">
            <Button variant="ghost" onClick={() => void buildPlan()} disabled={!target.trim()}>生成方案</Button>
          </div>
          {plan && (
            <div className="plan">
              {plan.dataBytes !== undefined && <div className="plan-bytes">待迁移数据：约 {formatBytes(plan.dataBytes)}</div>}
              <div className="plan-title">步骤</div>
              <ol className="plan-steps">{plan.steps.map(step => <li key={step}>{step}</li>)}</ol>
              <div className="plan-title">配置变更</div>
              {plan.configChanges.map(change => (
                <div key={`${change.file}:${change.to}`} className={'plan-change' + (change.manual ? ' manual' : '')}>
                  {change.manual && <span className="badge risk-cautious">需手动</span>}
                  <span className="mono plan-file">{change.file}</span>
                  <span className="plan-arrow">→</span>
                  <span className="mono">{change.to}</span>
                  {!change.manual && <span className="muted">（原：{change.from}）</span>}
                </div>
              ))}
              {plan.configChanges.some(change => change.manual) && (
                <div className="muted manual-note">标有「需手动」的变更本插件不代改（环境变量类设置请用系统或环境变量插件完成），数据搬迁仍会执行。</div>
              )}
              <label className="move-data">
                <Checkbox checked={moveData} onCheckedChange={checked => setMoveData(checked === true)} />
                <span>同时迁移数据（复制 → 校验 → 清理旧目录）；取消勾选只改配置</span>
              </label>
            </div>
          )}
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button variant="danger" disabled={!plan} onClick={() => setConfirming(true)}>执行迁移</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="dev-dialog">
          <DialogTitle>确认迁移</DialogTitle>
          <DialogDescription>
            将{moveData ? '复制数据并' : ''}更新配置指向 <span className="mono">{target}</span>。{moveData ? '迁移期间不要同时使用对应工具，避免数据竞争。' : ''}
          </DialogDescription>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
            <Button variant="danger" onClick={() => void execute()}>开始迁移</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
