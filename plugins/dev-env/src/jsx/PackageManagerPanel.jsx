/** 包管理器专属布局：已安装列表（类型/outdated 徽章、行删除确认含 zap/purge 选项）、可升级横条、搜索安装、更新源、清理。 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, DialogContent, DialogTitle, DialogDescription, Input, MoreMenu } from '../ui/index.jsx'
import { backend } from '../js/backend.js'
import { formatBytes, totalBytes } from '../js/format.js'
import { DetailHeader } from './DetailHeader.jsx'

export function PackageManagerPanel({ selected, snapshot, search, say, runTask, detail }) {
  const pm = selected.pm
  const meta = snapshot?.packageManagers.find(entry => entry.id === pm)
  const [items, setItems] = useState(null)
  const [removing, setRemoving] = useState(null) // 目标行
  const [zap, setZap] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [cleanOpen, setCleanOpen] = useState(false)
  const [cleanActions, setCleanActions] = useState(null)
  const [confirmAll, setConfirmAll] = useState(false)

  useEffect(() => {
    let alive = true
    setItems(null)
    backend.pmList(pm)
      .then(result => { if (alive) setItems(result.items ?? []) })
      .catch(error => { if (alive) { setItems([]); say(`${meta?.label ?? pm} 列表加载失败：${error.message}`, 'error') } })
    return () => { alive = false }
  }, [pm, meta?.label, say])

  const doSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setResults(null)
    try { setResults((await backend.pmSearch(pm, q)).items ?? []) }
    catch (error) { setResults([]); say(`搜索失败：${error.message}`, 'error') }
  }, [pm, query, say])

  const install = useCallback(async (item) => {
    say(`正在安装 ${item.name}…`, 'busy')
    try {
      const spec = { kind: 'pm.install', pm, name: item.id ?? item.name, opts: { cask: item.type === 'cask' }, __label: `安装 ${item.name}` }
      const result = await runTask(spec).catch(() => backend.pmInstall(pm, item.id ?? item.name, { cask: item.type === 'cask' }))
      if (result?.taskId) return
      if (result?.ok !== false) { say(`已安装 ${item.name}`); setItems(prev => [...(prev ?? []), { name: item.name, type: item.type }]) }
      else say(result?.note ?? '安装失败', 'error')
    } catch (error) { say(error.message, 'error') }
  }, [pm, runTask, say])

  const uninstall = useCallback(async () => {
    const target = removing
    setRemoving(null)
    if (!target) return
    say(`正在卸载 ${target.name}…`, 'busy')
    try {
      const opts = { cask: target.type === 'cask', zap, purge: zap }
      const spec = { kind: 'pm.uninstall', pm, name: target.id ?? target.name, opts, __label: `卸载 ${target.name}` }
      const result = await runTask(spec).catch(() => backend.pmUninstall(pm, target.id ?? target.name, opts))
      if (result?.taskId) return
      if (result?.ok !== false) { setItems(prev => (prev ?? []).filter(item => item.name !== target.name)); say(result?.note ?? `已卸载 ${target.name}`) }
      else say(result?.note ?? '卸载失败', 'error')
    } catch (error) { say(error.message, 'error') }
    finally { setZap(false) }
  }, [pm, removing, runTask, say, zap])

  const upgradeAll = useCallback(async () => {
    setConfirmAll(false)
    try {
      const spec = { kind: 'pm.upgrade', pm, name: 'all', __label: '升级全部' }
      const result = await runTask(spec).catch(() => backend.pmUpgrade(pm, 'all'))
      if (result?.taskId) return
      say(result?.ok !== false ? (result?.note ?? '升级完成') : (result?.note ?? '升级失败'), result?.ok !== false ? '' : 'error')
    } catch (error) { say(error.message, 'error') }
  }, [pm, runTask, say])

  const openClean = useCallback(async () => {
    setCleanOpen(true)
    setCleanActions(null)
    try { setCleanActions((await backend.pmCleanActions(pm)).actions ?? []) }
    catch (error) { setCleanActions([]); say(`清理项加载失败：${error.message}`, 'error') }
  }, [pm, say])

  const runClean = useCallback(async (action) => {
    setCleanOpen(false)
    try {
      const spec = { kind: 'pm.clean', pm, actionId: action.id, __label: action.label }
      const result = await runTask(spec).catch(() => backend.pmCleanRun(pm, action.id))
      if (result?.taskId) return
      say(result?.ok !== false ? (result?.note ?? '清理完成') : (result?.note ?? '清理失败'), result?.ok !== false ? '' : 'error')
    } catch (error) { say(error.message, 'error') }
  }, [pm, runTask, say])

  if (items === null) return <div className="empty">正在读取已安装列表…</div>

  const query2 = (search ?? '').trim().toLowerCase()
  const visible = query2 ? items.filter(item => item.name.toLowerCase().includes(query2)) : items
  const outdated = items.filter(item => item.outdated)
  const usage = detail?.diskUsage ?? []

  return (
    <>
      <DetailHeader detail={detail} family={null} selected={selected} />
      <div className="tabs-row">
        <div className="pm-toolbar">
          <Button variant="ghost" size="sm" onClick={() => { setSearchOpen(true); setResults(null) }}>搜索安装…</Button>
          <Button variant="ghost" size="sm" onClick={() => void openClean()}>清理…</Button>
          <MoreMenu label="⋯" ariaLabel="包管理器操作" items={[
            { key: 'update-source', label: `更新源（${meta?.label ?? pm} update）`, onSelect: () => { void runTask({ kind: 'pm.updateSource', pm, __label: '更新源' }).catch(() => backend.pmUpdateSource(pm).then(result => say(result.note ?? '源已更新'))) } },
            { key: 'reload', label: '刷新列表', onSelect: () => setItems(null) }
          ]} />
        </div>
      </div>
      <div className="panel">
        {outdated.length > 0 && (
          <div className="outdated-bar">
            <span>可升级 {outdated.length} 项</span>
            <div className="outdated-names mono">{outdated.slice(0, 6).map(item => item.name).join(' · ')}{outdated.length > 6 ? ' …' : ''}</div>
            <Button variant="primary" size="sm" onClick={() => setConfirmAll(true)}>全部升级</Button>
          </div>
        )}
        <div className="table" role="table" aria-label="已安装包">
          <div className="table-head" role="row">
            <span className="col-name">名称</span>
            <span className="col-version">版本</span>
            <span className="col-note">类型</span>
            <span className="col-action" aria-hidden="true" />
          </div>
          {visible.map((item, index) => (
            <div key={item.name} className="table-row" role="row" style={{ '--i': Math.min(index, 16) }}>
              <span className="col-name mono">{item.name}</span>
              <span className="col-version">{item.version ?? '—'}</span>
              <span className="col-note">
                {item.type && <span className="badge type-badge">{item.type}</span>}
                {item.outdated && <span className="badge outdated-badge">可升级</span>}
              </span>
              <span className="col-action row-actions">
                <Button variant="ghost" size="sm" className="danger-text" onClick={() => setRemoving(item)}>删除</Button>
              </span>
            </div>
          ))}
          {visible.length === 0 && <div className="empty">{query2 ? '没有匹配的包' : '没有已安装包'}</div>}
        </div>
        {usage.length > 0 && (
          <div className="pm-usage">
            {usage.map(entry => (
              <div key={entry.path} className="usage-row" title={entry.path}>
                <span className="usage-label">{entry.label}</span>
                <span className="usage-bytes">{formatBytes(entry.bytes)}</span>
              </div>
            ))}
            <div className="usage-row total"><span className="usage-label">合计</span><span className="usage-bytes">{formatBytes(totalBytes(usage))}</span></div>
          </div>
        )}
      </div>

      <Dialog open={Boolean(removing)} onOpenChange={open => { if (!open) { setRemoving(null); setZap(false) } }}>
        <DialogContent className="dev-dialog">
          <DialogTitle>卸载 {removing?.name}</DialogTitle>
          <DialogDescription>
            将从 {meta?.label ?? pm} 卸载 <span className="mono">{removing?.name}</span>{removing?.version ? `（${removing.version}）` : ''}。
            {pm === 'scoop' && '勾选 purge 将同时清除该应用的持久化配置。'}
            {pm === 'brew' && removing?.type === 'cask' && '勾选 zap 将连同应用偏好设置一并删除。'}
          </DialogDescription>
          {pm === 'scoop' ? (
            <label className="move-data"><Checkbox checked={zap} onCheckedChange={checked => setZap(checked === true)} /><span>--purge 同时清除配置数据</span></label>
          ) : pm === 'brew' && removing?.type === 'cask' ? (
            <label className="move-data"><Checkbox checked={zap} onCheckedChange={checked => setZap(checked === true)} /><span>--zap 连偏好设置一起删除</span></label>
          ) : null}
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => { setRemoving(null); setZap(false) }}>取消</Button>
            <Button variant="danger" onClick={() => void uninstall()}>卸载</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="dev-dialog wide">
          <DialogTitle>搜索并安装</DialogTitle>
          <DialogDescription>输入包名搜索 {meta?.label ?? pm}，结果行内直接安装。</DialogDescription>
          <div className="search-install">
            <Input type="search" value={query} placeholder={pm === 'brew' ? '如 ripgrep' : '包名或 ID'}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void doSearch() } }} />
            <Button variant="primary" onClick={() => void doSearch()}>搜索</Button>
          </div>
          <div className="search-results">
            {results === null ? null : results.length === 0 ? <div className="empty">没有匹配结果</div> : results.map(item => (
              <div key={`${item.type ?? ''}${item.name}`} className="search-row">
                <span className="mono">{item.name}</span>
                {item.type && <span className="badge type-badge">{item.type}</span>}
                <span className="muted search-id">{item.id ?? ''}</span>
                <span className="row-actions"><Button variant="ghost" size="sm" onClick={() => void install(item)}>安装</Button></span>
              </div>
            ))}
          </div>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setSearchOpen(false)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cleanOpen} onOpenChange={setCleanOpen}>
        <DialogContent className="dev-dialog">
          <DialogTitle>清理 {meta?.label ?? pm}</DialogTitle>
          <DialogDescription>选择要执行的清理项：</DialogDescription>
          {cleanActions === null ? <div className="empty">正在加载清理项…</div> : cleanActions.length === 0 ? <div className="empty">没有可清理项</div> : (
            <div className="clean-list compact">
              {cleanActions.map(action => (
                <div key={action.id} className="clean-card">
                  <div className="clean-head"><span className="clean-label">{action.label}</span><span className={`badge risk-${action.risk}`}>{action.risk === 'cautious' ? '谨慎' : '安全'}</span></div>
                  <div className="muted clean-desc">{action.description}</div>
                  <div className="clean-actions row-actions"><Button variant="primary" size="sm" onClick={() => void runClean(action)}>执行</Button></div>
                </div>
              ))}
            </div>
          )}
          <div className="dialog-actions"><Button variant="ghost" onClick={() => setCleanOpen(false)}>关闭</Button></div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent className="dev-dialog">
          <DialogTitle>升级全部</DialogTitle>
          <DialogDescription>将升级 {outdated.length} 个包，可能需要较长时间且占用网络；过程中可取消。</DialogDescription>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setConfirmAll(false)}>取消</Button>
            <Button variant="primary" onClick={() => void upgradeAll()}>开始升级</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
