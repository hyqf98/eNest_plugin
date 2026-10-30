/**
 * dev-env 主界面：左栏环境/包管理器列表 + 右侧详情四页签（依赖/清理/配置/迁移），
 * 包管理器实例进入专属布局（已安装/升级/搜索安装），底部任务条监听 backend.event。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Checkbox, MoreMenu, Segmented, Select, Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/index.jsx'
import { backend, backendReady, isPreviewFixture, onBackendEvent } from '../js/backend.js'
import { formatBytes, platformLabel, totalBytes } from '../js/format.js'
import { EnvList } from './EnvList.jsx'
import { DetailHeader } from './DetailHeader.jsx'
import { DepsPanel } from './DepsPanel.jsx'
import { CleanPanel } from './CleanPanel.jsx'
import { ConfigPanel } from './ConfigPanel.jsx'
import { MigrateDialog } from './MigrateDialog.jsx'
import { PackageManagerPanel } from './PackageManagerPanel.jsx'
import { TaskBar } from './TaskBar.jsx'

const api = () => window.enest || window.zapi
const CUSTOM_KEY = 'customEnvs'
const FAMILY_OPTIONS = [
  { value: 'node', label: 'Node.js' }, { value: 'python', label: 'Python' }, { value: 'uv', label: 'uv' },
  { value: 'conda', label: 'Conda' }, { value: 'java', label: 'Java' }, { value: 'maven', label: 'Maven' },
  { value: 'gradle', label: 'Gradle' }, { value: 'go', label: 'Go' }, { value: 'rust', label: 'Rust' }
]

function newId() { return Math.random().toString(36).slice(2, 10) }

export function App() {
  const kitRef = useRef(null)
  const [customEnvs, setCustomEnvs] = useState([])
  const [snapshot, setSnapshot] = useState(null)
  const [selected, setSelected] = useState(null) // { kind: 'family'|'pm', family?, pm?, id? }
  const [detail, setDetail] = useState(null)
  const [tab, setTab] = useState('deps')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState({ text: isPreviewFixture() ? '演示数据（截图模式）' : '正在探测开发环境…', kind: '' })
  const [tasks, setTasks] = useState([]) // [{ taskId, label, lastLine, lines, running, ok, note }]
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ family: 'node', label: '', rootPath: '' })
  const seqRef = useRef(0)

  const say = (text, kind = '') => setStatus({ text, kind })

  const loadCustom = useCallback(async () => {
    try {
      const list = await api()?.storage?.get?.(CUSTOM_KEY)
      if (Array.isArray(list)) setCustomEnvs(list)
    } catch { /* 首次为空 */ }
  }, [])

  const saveCustom = useCallback(async (list) => {
    setCustomEnvs(list)
    try { await api()?.storage?.set?.(CUSTOM_KEY, list) } catch { /* 存储失败仅本次会话生效 */ }
  }, [])

  const refresh = useCallback(async (silent = false) => {
    const seq = ++seqRef.current
    if (!silent) say('正在探测开发环境…', 'busy')
    try {
      const snap = await backend.snapshot(customEnvs)
      if (seq !== seqRef.current) return
      setSnapshot(snap)
      const installedCount = snap.families.filter(family => family.installed).length
      const pmCount = snap.packageManagers.filter(pm => pm.available).length
      say(`探测完成：${installedCount} 个环境家族 · ${pmCount} 个包管理器`)
      setSelected(prev => {
        if (prev) return prev
        // demo 模式默认选中 node 家族；真实环境选第一个已安装家族
        const demo = isPreviewFixture()
        const first = demo ? snap.families.find(family => family.family === 'node') : snap.families.find(family => family.installed)
        return first ? { kind: 'family', family: first.family, id: first.instances[0]?.id } : null
      })
    } catch (error) {
      if (seq === seqRef.current) say(`探测失败：${error.message}`, 'error')
    }
  }, [customEnvs])

  /* —— 自定义环境路径 —— */
  const addCustom = useCallback(async () => {
    const family = addForm.family
    const label = addForm.label.trim() || (FAMILY_OPTIONS.find(option => option.value === family)?.label ?? family)
    const rootPath = addForm.rootPath.trim()
    if (!rootPath.startsWith('/')) { say('路径必须是绝对路径（以 / 开头）', 'error'); return }
    const entry = { id: newId(), family, label, rootPath }
    await saveCustom([...customEnvs, entry])
    setAddOpen(false)
    setAddForm({ family: 'node', label: '', rootPath: '' })
    say(`已添加自定义环境 ${label}`)
    void refresh(true)
  }, [addForm, customEnvs, refresh, saveCustom])

  const removeCustom = useCallback(async (id) => {
    await saveCustom(customEnvs.filter(entry => entry.id !== id))
    void refresh(true)
  }, [customEnvs, refresh, saveCustom])

  /* —— 任务事件订阅 —— */
  const taskHandlersRef = useRef(null)
  useEffect(() => {
    const handleTask = (message) => {
      if (message?.event !== 'task') return
      const data = message.data ?? {}
      if (data.type === 'task.output') {
        setTasks(prev => prev.map(task => task.taskId === data.taskId
          ? { ...task, lastLine: data.chunk, lines: [...task.lines.slice(-120), data.chunk] }
          : task))
      } else if (data.type === 'task.end') {
        setTasks(prev => prev.map(task => task.taskId === data.taskId
          ? { ...task, running: false, ok: data.ok !== false, note: data.note }
          : task))
        say(data.ok !== false ? (data.note ?? '任务完成') : (data.note ?? '任务失败'), data.ok !== false ? '' : 'error')
        void refresh(true)
      }
    }
    const pushTask = (spec, taskId) => {
      setTasks(prev => [...prev.slice(-4), { taskId, label: spec.__label ?? taskId, lastLine: '', lines: [], running: true, ok: null, note: null }])
    }
    taskHandlersRef.current = { pushTask }
    return onBackendEvent(handleTask)
  }, [refresh])

  const runTask = useCallback(async (spec) => {
    const label = spec.__label ?? spec.kind
    try {
      const result = await backend.taskRun(spec, null)
      if (result?.taskId) taskHandlersRef.current?.pushTask({ ...spec, __label: label }, result.taskId)
      say(`${label} 已开始`, 'busy')
      return result
    } catch (error) {
      say(`${label} 启动失败：${error.message}`, 'error')
      throw error
    }
  }, [])

  const cancelTask = useCallback(async (taskId) => {
    try { await backend.taskCancel(taskId); say(`已请求取消 ${taskId}`) } catch (error) { say(error.message, 'error') }
  }, [])

  /* —— 详情加载 —— */
  const loadDetail = useCallback(async (target) => {
    if (!target) return
    try {
      if (target.kind === 'pm') setDetail(await backend.pmDetail(target.pm))
      else setDetail(await backend.detail(target.family, target.id, customEnvs))
    } catch (error) {
      setDetail(null)
      say(`详情加载失败：${error.message}`, 'error')
    }
  }, [customEnvs])

  useEffect(() => { void loadDetail(selected); setTab('deps') }, [selected, loadDetail])

  /* —— 初始化 —— */
  useEffect(() => {
    const kit = PluginKit.create({ title: '开发环境管理', defaults: {} })
    kitRef.current = kit
    void loadCustom().then(() => {})
    void (async () => { await kit.ready; void refresh() })()
    return () => { seqRef.current++; kit.destroy?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // customEnvs 变化后重新探测（loadCustom 完成时）
  const customLoadedRef = useRef(false)
  useEffect(() => {
    if (!customLoadedRef.current && customEnvs.length > 0) {
      customLoadedRef.current = true
      void refresh(true)
    } else if (!customLoadedRef.current && snapshot) customLoadedRef.current = true
  }, [customEnvs, snapshot, refresh])

  const cap = useMemo(() => {
    if (!selected) return {}
    if (selected.kind === 'pm') {
      const adapterPm = snapshot?.packageManagers.find(pm => pm.id === selected.pm)
      return { deps: true, clean: true, configs: false, migrate: false, label: adapterPm?.label ?? selected.pm }
    }
    const capabilityMap = {
      node: { deps: true, clean: true, configs: true, migrate: true },
      python: { deps: true, clean: true, configs: true, migrate: false },
      uv: { deps: true, clean: true, configs: false, migrate: false },
      conda: { deps: true, clean: true, configs: true, migrate: false },
      java: { deps: false, clean: false, configs: false, migrate: false },
      maven: { deps: false, clean: true, configs: true, migrate: true },
      gradle: { deps: false, clean: true, configs: true, migrate: true },
      go: { deps: true, clean: true, configs: true, migrate: false },
      rust: { deps: true, clean: true, configs: true, migrate: false }
    }
    return capabilityMap[selected.family] ?? {}
  }, [selected, snapshot])

  const selectedFamily = selected?.kind === 'family' ? snapshot?.families.find(family => family.family === selected.family) : null

  return (
    <main className="app">
      <header>
        <div className="head-title">
          <h1>开发环境</h1>
          <span className="muted">{snapshot ? `${platformLabel(snapshot.platform)} · ${snapshot.families.filter(f => f.installed).length} 个家族` : '探测中…'}</span>
        </div>
        {snapshot && <span className="platform-badge">{platformLabel(snapshot.platform)}</span>}
        <div className="head-actions">
          <Input id="search" type="search" placeholder="搜索环境或包名…" aria-label="搜索" value={search}
            onChange={(event) => setSearch(event.target.value)} />
          <Button variant="ghost" size="sm" onClick={() => void refresh()} title="重新探测">刷新</Button>
          <MoreMenu label="⋯" ariaLabel="更多操作" items={[
            { key: 'reprobe', label: '重新探测全部', onSelect: () => void refresh() },
            'sep',
            { key: 'about', label: '说明', onSelect: () => say('dev-env 统一管理本机构建环境与包管理器（macOS / Windows）') }
          ]} />
        </div>
      </header>

      <div className="workspace">
        <EnvList
          snapshot={snapshot} selected={selected} onSelect={setSelected} search={search}
          customEnvs={customEnvs} onRemoveCustom={removeCustom} onAddCustom={() => setAddOpen(true)}
        />
        <section className="detail" role="main">
          {!selected || !snapshot ? (
            <div className="empty">左侧选择一个环境或包管理器查看详情</div>
          ) : selected.kind === 'pm' ? (
            <PackageManagerPanel selected={selected} snapshot={snapshot} search={search} say={say} runTask={runTask} detail={detail} />
          ) : (
            <>
              <DetailHeader detail={detail} family={selectedFamily} selected={selected} />
              <div className="tabs-row">
                <Segmented
                  value={tab}
                  onChange={setTab}
                  ariaLabel="详情页签"
                  options={[
                    { value: 'deps', label: '依赖', disabled: !cap.deps },
                    { value: 'clean', label: '清理', disabled: !cap.clean },
                    { value: 'configs', label: '配置', disabled: !cap.configs },
                    { value: 'migrate', label: '迁移', disabled: !cap.migrate }
                  ]}
                />
                {tab === 'migrate' && cap.migrate && <MigrateDialog selected={selected} say={say} runTask={runTask} />}
              </div>
              <div className="panel">
                {tab === 'deps' && <DepsPanel selected={selected} cap={cap} search={search} say={say} />}
                {tab === 'clean' && <CleanPanel selected={selected} say={say} runTask={runTask} />}
                {tab === 'configs' && <ConfigPanel selected={selected} say={say} />}
                {(tab === 'migrate' || !cap.deps && !cap.clean && !cap.configs) && !cap.migrate && tab !== 'deps' && tab !== 'clean' && tab !== 'configs' ? null : null}
              </div>
            </>
          )}
        </section>
      </div>

      <TaskBar tasks={tasks} onCancel={cancelTask} />

      <footer className="status" role="status" data-kind={status.kind}>{status.text}</footer>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="dev-dialog">
          <DialogTitle>添加自定义环境路径</DialogTitle>
          <DialogDescription>把不在常规位置的开发环境登记进来（只读展示，不修改系统）。</DialogDescription>
          <div className="form">
            <label>家族</label>
            <Select value={addForm.family} onChange={(family) => setAddForm(prev => ({ ...prev, family }))} options={FAMILY_OPTIONS} ariaLabel="家族" />
            <label>名称</label>
            <Input value={addForm.label} placeholder="如 JDK 21（Custom）" onChange={(event) => setAddForm(prev => ({ ...prev, label: event.target.value }))} />
            <label>路径</label>
            <Input className="pk-mono" value={addForm.rootPath} placeholder="/Library/Java/JavaVirtualMachines/jdk-21.jdk" onChange={(event) => setAddForm(prev => ({ ...prev, rootPath: event.target.value }))} />
          </div>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setAddOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void addCustom()}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
