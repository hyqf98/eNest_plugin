/** 依赖页：全局依赖/工具表格，hover 删除 + 确认。 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/index.jsx'
import { backend } from '../js/backend.js'
import { formatBytes } from '../js/format.js'

export function DepsPanel({ selected, cap, search, say }) {
  const [deps, setDeps] = useState(null)
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const family = selected.family

  useEffect(() => {
    let alive = true
    setDeps(null)
    if (!cap.deps) { setDeps([]); return }
    backend.deps(family, selected.id)
      .then(result => { if (alive) setDeps(result.deps ?? []) })
      .catch(error => { if (alive) { setDeps([]); say(`依赖加载失败：${error.message}`, 'error') } })
    return () => { alive = false }
  }, [family, selected.id, cap.deps, say])

  const confirmRemove = useCallback(async () => {
    const target = pending
    setPending(null)
    if (!target) return
    setBusy(true)
    say(`正在卸载 ${target.name}…`, 'busy')
    try {
      const result = await backend.removeDep(family, selected.id, target.name)
      if (result.ok !== false) {
        setDeps(prev => (prev ?? []).filter(dep => dep.name !== target.name))
        say(result.note ?? `已卸载 ${target.name}`)
      } else say(result.note ?? '卸载失败', 'error')
    } catch (error) { say(error.message, 'error') }
    finally { setBusy(false) }
  }, [family, pending, say, selected.id])

  if (!cap.deps) return <div className="empty">该环境不支持全局依赖管理</div>
  if (deps === null) return <div className="empty">正在加载依赖…</div>

  const query = (search ?? '').trim().toLowerCase()
  const visible = query ? deps.filter(dep => dep.name.toLowerCase().includes(query) || (dep.version ?? '').toLowerCase().includes(query)) : deps

  if (visible.length === 0) return <div className="empty">{query ? '没有匹配的依赖' : '没有全局依赖'}</div>

  return (
    <div className="table" role="table" aria-label="全局依赖">
      <div className="table-head" role="row">
        <span className="col-name">名称</span>
        <span className="col-version">版本</span>
        <span className="col-size">大小</span>
        <span className="col-note">备注</span>
        <span className="col-action" aria-hidden="true" />
      </div>
      {visible.map((dep, index) => (
        <div key={dep.name} className="table-row" role="row" style={{ '--i': Math.min(index, 16) }}>
          <span className="col-name mono">{dep.name}</span>
          <span className="col-version">{dep.version ?? '—'}</span>
          <span className="col-size">{formatBytes(dep.size)}</span>
          <span className="col-note muted">{dep.note ?? ''}</span>
          <span className="col-action row-actions">
            <Button variant="ghost" size="sm" className="danger-text" disabled={busy} onClick={() => setPending(dep)}>删除</Button>
          </span>
        </div>
      ))}
      <Dialog open={Boolean(pending)} onOpenChange={open => { if (!open) setPending(null) }}>
        <DialogContent className="dev-dialog">
          <DialogTitle>卸载依赖</DialogTitle>
          <DialogDescription>
            将卸载 <span className="mono">{pending?.name}</span>{pending?.version ? `（${pending.version}）` : ''}。该操作立即生效，重新安装需重新下载。
          </DialogDescription>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setPending(null)}>取消</Button>
            <Button variant="danger" onClick={() => void confirmRemove()}>卸载</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
