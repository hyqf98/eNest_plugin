/** 清理页：CleanAction 卡片 + dryRun 预览 Dialog + 执行确认。 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/index.jsx'
import { backend } from '../js/backend.js'
import { formatBytes } from '../js/format.js'

const RISK_LABEL = { safe: '安全', cautious: '谨慎' }

export function CleanPanel({ selected, say, runTask }) {
  const [actions, setActions] = useState(null)
  const [preview, setPreview] = useState(null) // { action, lines }
  const [confirmAction, setConfirmAction] = useState(null)
  const family = selected.family

  useEffect(() => {
    let alive = true
    setActions(null)
    if (selected.kind !== 'family') return
    backend.cleanActions(family, selected.id)
      .then(result => { if (alive) setActions(result.actions ?? []) })
      .catch(error => { if (alive) { setActions([]); say(`清理项加载失败：${error.message}`, 'error') } })
    return () => { alive = false }
  }, [family, selected.id, selected.kind, say])

  const openPreview = useCallback(async (action) => {
    setPreview({ action, lines: null })
    try {
      const result = await backend.cleanDryRun(family, selected.id, action.id)
      setPreview({ action, lines: result.lines ?? [] })
    } catch (error) {
      setPreview({ action, lines: ['（该项不支持预览）', String(error.message)] })
    }
  }, [family, selected.id])

  const execute = useCallback(async (action) => {
    setConfirmAction(null)
    say(`正在执行：${action.label}…`, 'busy')
    try {
      // 长任务走 task 通道（流式输出 + 可取消）；同步 fallback 在 task 不可用时直接执行
      const spec = { kind: 'clean.run', family, id: selected.id, actionId: action.id, __label: action.label }
      const result = await runTask(spec).catch(async () => backend.cleanRun(family, selected.id, action.id))
      if (result?.taskId) return // 进度走任务条与 task.end 事件
      if (result && result.ok !== false) say([result.note, result.freedBytes ? `释放 ${formatBytes(result.freedBytes)}` : null].filter(Boolean).join(' · '))
      else say(result?.note ?? '清理失败', 'error')
    } catch (error) { say(error.message, 'error') }
  }, [family, runTask, say, selected.id])

  if (actions === null) return <div className="empty">正在加载清理项…</div>
  if (actions.length === 0) return <div className="empty">该环境没有可清理项</div>

  return (
    <div className="clean-list">
      {actions.map((action, index) => (
        <div key={action.id} className="clean-card" style={{ '--i': Math.min(index, 16) }}>
          <div className="clean-head">
            <span className="clean-label">{action.label}</span>
            <span className={`badge risk-${action.risk}`}>{RISK_LABEL[action.risk] ?? action.risk}</span>
          </div>
          <div className="muted clean-desc">{action.description}</div>
          <div className="clean-actions row-actions">
            <Button variant="ghost" size="sm" onClick={() => void openPreview(action)}>预览</Button>
            <Button variant={action.risk === 'cautious' ? 'danger' : 'primary'} size="sm" onClick={() => setConfirmAction(action)}>执行</Button>
          </div>
        </div>
      ))}

      <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open) setPreview(null) }}>
        <DialogContent className="dev-dialog wide">
          <DialogTitle>预览 · {preview?.action?.label}</DialogTitle>
          <DialogDescription>以下是将要执行/删除的内容（未真正执行）：</DialogDescription>
          <pre className="preview-pre">{preview?.lines === null ? '正在生成预览…' : (preview?.lines ?? []).join('\n')}</pre>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setPreview(null)}>关闭</Button>
            {preview?.action && <Button variant="primary" onClick={() => { const action = preview.action; setPreview(null); setConfirmAction(action) }}>去执行</Button>}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirmAction)} onOpenChange={open => { if (!open) setConfirmAction(null) }}>
        <DialogContent className="dev-dialog">
          <DialogTitle>确认执行清理</DialogTitle>
          <DialogDescription>
            即将执行「{confirmAction?.label}」。{confirmAction?.risk === 'cautious' ? '该项标记为谨慎：可能影响依赖此缓存的其他环境，首次使用时需重建缓存。' : '该项可安全重建。'}
          </DialogDescription>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setConfirmAction(null)}>取消</Button>
            <Button variant={confirmAction?.risk === 'cautious' ? 'danger' : 'primary'} onClick={() => void execute(confirmAction)}>执行</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
