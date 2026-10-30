/**
 * 环境变量管理主界面：顶栏（标题/平台徽标/搜索/刷新/MoreMenu）
 * + 左侧范围窄栏 + 右侧变量表（行展开详情、PATH 专用编辑器）
 * + 编辑/新增/设置/备份管理 Dialog。设置经 enest.storage 持久化，
 * 写操作把 settings 附带给后端。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, MoreMenu, Segmented, Switch } from '../ui/index.jsx'
import { backend, demoMode } from '../js/backend.js'
import { formatSize, formatWhen, originLabel, scopeLabel } from '../js/format.js'
import { PathEditor } from './PathEditor.jsx'
import { VarDialog } from './VarDialog.jsx'
import { SettingsDialog } from './SettingsDialog.jsx'
import { BackupsDialog } from './BackupsDialog.jsx'

const api = () => window.enest || window.zapi
const SETTINGS_KEY = 'settings'
const DEFAULT_SETTINGS = { macTarget: 'zshenv', launchctlSync: false }
const MAC_TARGET_PATH = { zshenv: '~/.zshenv', zprofile: '~/.zprofile', zshrc: '~/.zshrc' }
const MAC_TARGETS = [
  { value: 'zshenv', label: '.zshenv' },
  { value: 'zprofile', label: '.zprofile' },
  { value: 'zshrc', label: '.zshrc' }
]

function sameNameConflict(vars) {
  const seen = new Set()
  const conflicted = new Set()
  for (const item of vars) {
    if (seen.has(item.name)) conflicted.add(item.name)
    seen.add(item.name)
  }
  return conflicted
}

export function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState({ text: '正在读取环境变量…', kind: 'busy' })
  const [scope, setScope] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [dialog, setDialog] = useState(null) // {kind:'edit'|'create', item?}
  const [confirmState, setConfirmState] = useState(null) // {kind:'delete'|'restore', target, text, retryElevate}
  const [backups, setBackups] = useState([])
  const [pathParts, setPathParts] = useState(null)
  const busyRef = useRef(false)

  const report = (text, kind = '') => setStatus({ text, kind })
  const isMac = snapshot?.platform === 'darwin'
  const isWin = snapshot?.platform === 'win32'

  // —— 设置持久化：enest.storage（demo fixture 与真实宿主都提供） ——
  const persistSettings = useCallback(async (next) => {
    setSettings(next)
    try {
      await api()?.storage?.set?.(SETTINGS_KEY, next)
    } catch { /* 存储失败保持内存态 */ }
  }, [])

  // —— 首启：读设置 + snapshot ——
  const loadSnapshot = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await backend.snapshot()
      setSnapshot(result)
      setScope(prev => (result.scopes.some(item => item.id === prev) ? prev : defaultScope(result)))
      report(`${scopeLabel(defaultScope(result))}范围 · ${result.vars.length} 个变量`)
    } catch (error) {
      report(`读取失败：${error.message}`, 'error')
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const stored = await api()?.storage?.get?.(SETTINGS_KEY)
        if (alive && stored && typeof stored === 'object') {
          setSettings({
            macTarget: MAC_TARGETS.some(t => t.value === stored.macTarget) ? stored.macTarget : 'zshenv',
            launchctlSync: stored.launchctlSync === true
          })
        }
      } catch { /* 读取失败用默认值 */ }
      if (alive) await loadSnapshot()
    })()
    return () => { alive = false }
  }, [loadSnapshot])

  function defaultScope(result) {
    const isDarwin = result?.platform === 'darwin'
    const preferred = isDarwin ? 'persistent' : 'user'
    return result?.scopes.some(item => item.id === preferred) ? preferred : (result?.scopes[0]?.id ?? '')
  }

  // —— 搜索防抖 120ms ——
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 120)
    return () => clearTimeout(timer)
  }, [query])

  // —— 数据派生 ——
  const conflicted = useMemo(() => (snapshot ? sameNameConflict(snapshot.vars) : new Set()), [snapshot])
  const scopeVars = useMemo(() => {
    if (!snapshot) return []
    return snapshot.vars.filter(item => item.scope === scope)
  }, [snapshot, scope])
  const filteredVars = useMemo(() => {
    if (!debouncedQuery) return scopeVars
    return scopeVars.filter(item =>
      item.name.toLowerCase().includes(debouncedQuery) || String(item.value).toLowerCase().includes(debouncedQuery))
  }, [scopeVars, debouncedQuery])

  const scopeInfo = snapshot?.scopes.find(item => item.id === scope)

  // —— path 范围数据 ——
  useEffect(() => {
    if (scope !== 'path' || pathParts) return
    void backend.pathParts(scope)
      .then(setPathParts)
      .catch(error => report(`读取 PATH 失败：${error.message}`, 'error'))
  }, [scope, pathParts])

  // —— 写操作 ——
  const saveVar = useCallback(async ({ name, value }, retryElevate) => {
    const targetScope = isMac ? 'persistent' : scope
    try {
      const result = await backend.setVar({ name, value, scope: targetScope, settings, elevate: retryElevate === true })
      if (result?.needsElevation) {
        setConfirmState({
          kind: 'elevate', target: { name },
          text: `写入系统变量 ${name} 需要管理员权限，是否现在提权写入？（将弹出系统确认框）`
        })
        return false
      }
      if (result?.ok) {
        report(`${name} 已写入${result.elevated ? '（提权）' : ''}${result.note ? ' · ' + result.note : ''}`)
        setDialog(null)
        await loadSnapshot()
        return true
      }
      report(`写入失败：${result?.note || '未知错误'}`, 'error')
      return false
    } catch (error) {
      report(`写入失败：${error.message}`, 'error')
      return false
    }
  }, [isMac, scope, settings, loadSnapshot])

  const deleteVar = useCallback(async (item, retryElevate) => {
    const targetScope = isMac ? 'persistent' : item.scope
    try {
      const result = await backend.deleteVar({ name: item.name, scope: targetScope, settings, elevate: retryElevate === true })
      if (result?.needsElevation) {
        setConfirmState({
          kind: 'elevate-delete', target: item,
          text: `删除系统变量 ${item.name} 需要管理员权限，是否现在提权删除？（将弹出系统确认框）`
        })
        return
      }
      if (result?.ok) {
        report(`${item.name} 已删除${result.note ? ' · ' + result.note : ''}`)
        await loadSnapshot()
      } else {
        report(`删除失败：${result?.note || '未知错误'}`, 'error')
      }
    } catch (error) {
      report(`删除失败：${error.message}`, 'error')
    }
  }, [isMac, settings, loadSnapshot])

  const savePath = useCallback(async (entries) => {
    await saveVar({ name: 'PATH', value: entries.join(':') })
  }, [saveVar])

  // —— 备份 ——
  const openBackups = useCallback(async () => {
    setDialog({ kind: 'backups' })
    try {
      setBackups(await backend.listBackups())
    } catch (error) {
      report(`读取备份失败：${error.message}`, 'error')
    }
  }, [])

  const restoreBackup = useCallback(async (file) => {
    try {
      await backend.restoreBackup(file)
      report(`已恢复 ${file.replace(/^\/Users\/[^/]+/, '~')}`)
      setConfirmState(null)
      setDialog(null)
      await loadSnapshot()
    } catch (error) {
      report(`恢复失败：${error.message}`, 'error')
    }
  }, [loadSnapshot])

  const openManagedFolder = useCallback(async () => {
    try {
      await backend.openManagedFolder('')
      report('已在 Finder 中打开')
    } catch (error) {
      report(error.message, 'error')
    }
  }, [])

  // —— 确认框回调 ——
  const confirmAction = useCallback(async () => {
    const current = confirmState
    setConfirmState(null)
    if (!current) return
    if (current.kind === 'delete') await deleteVar(current.target)
    else if (current.kind === 'elevate') await saveVar(current.target, true)
    else if (current.kind === 'elevate-delete') await deleteVar(current.target, true)
    else if (current.kind === 'restore') await restoreBackup(current.target)
  }, [confirmState, deleteVar, saveVar, restoreBackup])

  const askDelete = (item) => setConfirmState({
    kind: 'delete', target: item,
    text: `将删除变量 ${item.name}${item.scope === 'machine' ? '（系统变量）' : ''}${isMac ? '，仅移除 eNest 受管块中的定义' : ''}。此操作写入前会自动备份${isMac ? '（macOS）' : ''}。`
  })

  // —— 渲染 ——
  const platformBadge = loading ? '' : isMac ? 'macOS' : isWin ? 'Windows' : String(snapshot?.platform ?? '')
  const canCreate = scope && scope !== 'process' && scope !== 'path'
  const pathVar = snapshot?.vars.find(item => item.name === 'PATH' && item.scope === 'process')
  const expandedItem = expanded !== null ? filteredVars[expanded] : null

  const moreItems = [
    { key: 'settings', label: '设置', onSelect: () => setDialog({ kind: 'settings' }) },
    { key: 'backups', label: '备份管理', onSelect: openBackups, hidden: !isMac },
    'sep',
    { key: 'open-folder', label: '打开受管块所在文件夹', onSelect: openManagedFolder, hidden: !isMac }
  ]

  return (
    <main className="app">
      <header>
        <div className="brand">
          <h1>环境变量</h1>
          <span className="muted">跨平台查看 · 编辑 · 备份</span>
        </div>
        {platformBadge && <span className="pill pill-platform" data-platform={snapshot.platform}>{platformBadge}</span>}
        <div className="header-search">
          <input
            id="query" type="search" placeholder="搜索名称或值…" aria-label="搜索变量"
            data-input-context="editor" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && e.target.value) { e.preventDefault(); setQuery('') } }}
          />
        </div>
        <div className="header-actions">
          <Button variant="ghost" size="sm" onClick={() => void loadSnapshot()} disabled={loading}>刷新</Button>
          <MoreMenu
            label="更多" ariaLabel="插件更多操作" buttonClassName="header-more"
            items={moreItems}
          />
        </div>
      </header>

      <div className="workspace">
        <nav className="scopes" aria-label="变量范围">
          {(snapshot?.scopes ?? []).map((item) => (
            <button
              key={item.id} type="button"
              className={'scope-item' + (scope === item.id ? ' active' : '')}
              onClick={() => { setScope(item.id); setExpanded(null); setPathParts(null) }}
            >
              <span className="scope-label">{item.label}</span>
              {item.id !== 'path' && <span className="scope-count">{item.count}</span>}
            </button>
          ))}
          {loading && <div className="scope-loading">读取中…</div>}
        </nav>

        <section className="table-col">
          {isWin && scope === 'machine' && (
            <div className="scope-hint">写入系统变量需要管理员权限，失败时会请求提权（弹出系统 UAC 确认）。</div>
          )}
          {isMac && (scope === 'persistent' || scope === 'path') && (
            <div className="scope-hint">持久写入落在 eNest 受管块（目标 {MAC_TARGET_PATH[settings.macTarget]}），其余内容一字不动。</div>
          )}

          {scope === 'path' ? (
            <PathEditor
              mac={isMac}
              entries={pathParts?.entries ?? (pathVar ? String(pathVar.value).split(':').filter(Boolean) : [])}
              sources={isMac ? pathParts?.sources : undefined}
              loading={!pathParts && !pathVar}
              onSave={savePath}
              status={status}
            />
          ) : (
            <div className="table-wrap">
              <div className="table-head" role="row">
                <span className="col-name">名称</span>
                <span className="col-value">值</span>
                <span className="col-origin">来源</span>
                <span className="col-actions" aria-hidden="true"></span>
              </div>
              {canCreate && (
                <button type="button" className="row row-ghost" onClick={() => setDialog({ kind: 'create' })}>
                  <span className="ghost-add">+ 新增变量</span>
                </button>
              )}
              <div className="table-body" role="rowgroup">
                {loading && <div className="empty">正在读取环境变量…</div>}
                {!loading && !filteredVars.length && (
                  <div className="empty">{debouncedQuery ? '没有匹配的变量' : '该范围暂无变量'}</div>
                )}
                {filteredVars.map((item, index) => (
                  <div
                    key={`${item.scope}:${item.name}:${item.line ?? 0}:${index}`}
                    className={'row' + (expanded === index ? ' expanded' : '')}
                    style={{ '--i': Math.min(index, 16) }}
                    onClick={() => setExpanded(expanded === index ? null : index)}
                  >
                    <div className="row-line" role="row">
                      <span className="col-name">
                        <span className="var-name">{item.name}</span>
                        {item.managed && <span className="pill pill-managed">managed</span>}
                        {conflicted.has(item.name) && <span className="pill pill-warn">冲突</span>}
                        {item.hasReference && <span className="pill pill-soft">含动态引用</span>}
                      </span>
                      <span className="col-value" title={item.value}>{item.value || <span className="empty-value">（空）</span>}</span>
                      <span className="col-origin" title={item.origin ?? ''}>{originLabel(item)}</span>
                      <span className="col-actions pk-row-actions" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" aria-label={`编辑 ${item.name}`}
                          onClick={() => setDialog({ kind: 'edit', item })}>编辑</Button>
                        <Button variant="ghost" size="sm" className="danger-ghost" aria-label={`删除 ${item.name}`}
                          onClick={() => askDelete(item)}>删除</Button>
                      </span>
                    </div>
                    {expanded === index && (
                      <div className="row-detail" onClick={(e) => e.stopPropagation()}>
                        <dl>
                          <dt>范围</dt><dd>{scopeLabel(item.scope)}</dd>
                          <dt>来源</dt><dd className="mono">{item.origin ? originLabel(item) : '当前进程'}</dd>
                          {item.line !== undefined && <><dt>行号</dt><dd className="mono">{item.line}</dd></>}
                          {item.exported === false && <><dt>export</dt><dd>无 export 前缀</dd></>}
                        </dl>
                        <div className="detail-actions">
                          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'edit', item })}>编辑</Button>
                          {item.name !== 'PATH' && (
                            <Button variant="danger" size="sm" onClick={() => askDelete(item)}>删除</Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="status" role="status" data-kind={status.kind}>{status.text}</div>

      <VarDialog
        dialog={dialog}
        isMac={isMac}
        targetPath={MAC_TARGET_PATH[settings.macTarget] ?? ''}
        existing={snapshot?.vars.map(item => item.name) ?? []}
        onClose={() => setDialog(null)}
        onSave={saveVar}
      />

      <SettingsDialog
        open={dialog?.kind === 'settings'}
        isMac={isMac}
        settings={settings}
        onApply={persistSettings}
        onClose={() => setDialog(null)}
      />

      <BackupsDialog
        open={dialog?.kind === 'backups'}
        backups={backups}
        onRefresh={openBackups}
        onRestore={(file) => setConfirmState({
          kind: 'restore', target: file,
          text: `将用备份 ${file.replace(/^\/Users\/[^/]+/, '~')} 覆盖当前文件（覆盖前会先备份当前版）。继续？`
        })}
        onClose={() => setDialog(null)}
      />

      <Dialog open={Boolean(confirmState)} onOpenChange={(open) => { if (!open) setConfirmState(null) }}>
        <DialogContent aria-describedby="confirm-text">
          <DialogTitle>{confirmState?.kind === 'restore' ? '恢复备份' : confirmState?.kind === 'delete' ? '删除变量' : '请求提权'}</DialogTitle>
          <DialogDescription id="confirm-text">{confirmState?.text}</DialogDescription>
          <div className="dialog-actions">
            <Button onClick={() => setConfirmState(null)}>取消</Button>
            <Button variant="danger" onClick={() => void confirmAction()}>
              {confirmState?.kind === 'elevate' || confirmState?.kind === 'elevate-delete' ? '提权继续' : '确认'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
