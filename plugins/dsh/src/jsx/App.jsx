/**
 * DSH 驾驶舱主界面 —— React 版（原 src/js/{main,views,settings}.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原版完全一致，样式零改变；
 * 业务核心 api.js（宿主薄封装）/ state.js（订阅式状态层）原样复用（未改动）。
 * 路由（main: quick|cockpit / shell / settings）转为 React state；
 * iframe 完全体与 runtime 一律不涉及（iframe src 仍由 state.status.web.readyUrl 驱动）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import '../js/api.js'
import '../js/state.js'
import {
  IconGear, IconExternal, IconRestart, IconPlus, IconBack,
  IconStack, IconPower, IconUp, IconArchive, IconPulse,
} from './icons.jsx'

const api = window.enest || window.zapi
const { esc } = window.DshApi

/* —— 事件投影：durable session event → 展示行（原 views.js renderEvent 等价） —— */
function pickText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(pickText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (value.content) return pickText(value.content)
    if (typeof value.summary === 'string') return value.summary
  }
  return ''
}

function renderEvent(ev, index) {
  if (!ev || typeof ev !== 'object') return null
  const type = String(ev.type ?? ev.kind ?? '')
  const ts = ev.timestamp || ev.ts || ev.time
  const meta = ts ? new Date(Number(ts) || ts).toTimeString().slice(0, 8) : type
  let body = null
  let cls = 'evt'
  if (type === 'user/message') {
    cls += ' evt-user'
    body = esc(pickText(ev.message ?? ev).slice(0, 600))
  } else if (type === 'assistant/message') {
    body = esc(pickText(ev.message ?? ev).slice(0, 1200))
  } else if (type === 'tool/call') {
    const name = ev.name || ev.tool || ev.toolName || 'tool'
    body = <span className="tool-line">tool {esc(String(name))}</span>
  } else if (type === 'tool/result') {
    const name = ev.name || ev.tool || ev.toolName || 'tool'
    const ok = ev.ok !== false && ev.error == null
    body = <span className="tool-line">tool {esc(String(name))} {ok ? '✓' : '✗'}</span>
  } else if (type === 'turn/start') {
    body = <span className="tool-line">turn 开始</span>
  } else if (type === 'turn/end') {
    body = <span className="tool-line">turn 结束</span>
  } else if (type === 'step/start' || type === 'step/end') {
    return null // 噪音行折叠
  } else if (type) {
    body = <span className="tool-line">{esc(type)}</span>
  } else {
    return null
  }
  return (
    <div key={index} className={`${cls} dsh-enter`} style={{ '--index': index }}>
      <span className="evt-meta">{esc(meta)}</span>
      <div className="evt-body">{body || <span className="tool-line">…</span>}</div>
    </div>
  )
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

/* —— 设置台分区面板（原 settings.js RENDERERS 等价；sectionData 由 SettingsView 加载） —— */

function ProfilesSection({ data, onAction }) {
  const list = data.profiles || []
  const backups = (data.backups || []).filter((b) => b.scope === 'profile')
  return (
    <>
      <h2 className="settings-title">Profile 管家</h2>
      <p className="settings-desc">$DSH_HOME/profiles 下的组合层可视化：bundles 栈、用户补丁、out-of-tree 插件。删除前自动快照。</p>
      <div className="sect">
        <div className="sect-row">
          <input className="field" id="profile-name" placeholder="新 profile 名（如 work）" style={{ width: 200 }} />
          <select className="field" id="profile-template" defaultValue="web">
            {['web', 'headless', 'sdk', 'sdk-minimal', 'acp'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="btn" id="profile-create" onClick={onAction('profile-create')}>新增</button>
        </div>
      </div>
      {list.length === 0
        ? <p className="evt-empty">尚无 profile — 启动一次完全体后会自动初始化 web 模板。</p>
        : list.map((p, i) => (
          <div key={p.name} className="card dsh-enter" style={{ '--index': i }}>
            <div className="card-head">
              <span className="card-title mono">{esc(p.name)}</span>
              {p.builtin ? <span className="tag">内置</span> : <span className="tag">自定义</span>}
              {p.reserved ? <span className="tag tag-err">保留</span> : null}
            </div>
            <div className="card-body">
              bundles 有序栈（{p.bundles.length} 层）：
              <div className="stack-list">
                {p.bundles.map((b, idx) => (
                  <div key={idx} className="stack-item"><span className="ord">{idx + 1}</span><span>{esc(b)}</span></div>
                ))}
                {p.bundles.length === 0 && <div className="stack-item">（空）</div>}
              </div>
              {p.patchLines ? <div style={{ marginTop: 6 }}>cordis.patch.yml {p.patchLines} 行</div> : null}
              {p.plugins?.length
                ? <div style={{ marginTop: 4 }}>out-of-tree 插件：<span className="mono">{esc(p.plugins.join(', '))}</span></div>
                : null}
            </div>
            <div className="card-actions">
              <button className="btn-ghost" onClick={onAction('profile-backup', p.name)}>备份</button>
              {!p.reserved && <button className="btn-ghost btn-danger" onClick={onAction('profile-delete', p.name)}>删除（先备份）</button>}
            </div>
          </div>
        ))}
      {backups.length > 0 && (
        <div className="sect">
          <div className="card-title" style={{ marginBottom: 6 }}>Profile 备份</div>
          {backups.map((b) => (
            <div key={b.backupId} className="sect-row" style={{ padding: '6px 0' }}>
              <span className="sect-value" style={{ flex: 1 }}>{esc(b.backupId)}{b.target ? ` → ${esc(b.target)}` : ''} · {fmtBytes(b.sizeBytes)} · {fmtTime(b.createdAt)}</span>
              <button className="btn-ghost" onClick={onAction('backup-restore', b.backupId)}>恢复</button>
              <button className="btn-ghost btn-danger" onClick={onAction('backup-delete', b.backupId)}>删除</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function RuntimeSection({ state, onAction, onPolicyChange, onPolicySave }) {
  const st = state.status
  const web = st?.web
  const sdk = st?.sdk
  const prefs = state.prefs
  const procCard = (kind, info, runningLabel) => (
    <div key={kind} className="card">
      <div className="card-head">
        <span className={`dot${info?.running ? ' dot-ok' : ''}`}></span>
        <span className="card-title">{kind === 'web' ? 'Web 完全体进程' : 'SDK 快速对话进程'}</span>
        <span className="sect-value">{runningLabel}</span>
      </div>
      <div className="card-actions">
        <button className="btn-ghost" onClick={onAction('proc-start', kind)}>{info?.running ? '已在运行' : '启动'}</button>
        <button className="btn-ghost" onClick={onAction('proc-stop', kind)}>停止</button>
        {kind === 'web' && <button className="btn-ghost" onClick={onAction('proc-restart', kind)}>重启</button>}
      </div>
    </div>
  )
  const webLabel = web?.running
    ? `${web.port ? `127.0.0.1:${web.port}` : ''}${web.profile && web.profile !== 'web' ? ` · ${web.profile}` : ''}${web.portRetries ? ` · 换口重试 ${web.portRetries} 次` : ''}`
    : '未运行'
  const sdkLabel = sdk?.running ? (sdk.initialized ? `pid ${sdk.pid ?? ''}` : '初始化中…') : '未运行'
  return (
    <>
      <h2 className="settings-title">运行时与端口</h2>
      <p className="settings-desc">端口冲突时自动换空闲口重启并通知；插件关闭时进程与端口自动回收。</p>
      {procCard('web', web, webLabel)}
      {procCard('sdk', sdk, sdkLabel)}
      <div className="sect">
        <div className="sect-row">
          <span className="sect-label">端口策略</span>
          <select
            className="field" id="port-policy" style={{ width: 120 }}
            value={prefs.webPortPolicy !== 'fixed' ? 'auto' : 'fixed'}
            onChange={(e) => onPolicyChange(e.target.value)}
          >
            <option value="auto">自动分配</option>
            <option value="fixed">固定端口</option>
          </select>
          <input
            className="field" id="port-fixed" type="number"
            value={prefs.webPort ?? 3080} style={{ width: 100 }}
            disabled={prefs.webPortPolicy !== 'fixed'}
            onChange={(e) => onPolicyChange(null, e.target.value)}
          />
          <button className="btn" id="port-save" onClick={onPolicySave}>保存</button>
        </div>
      </div>
      {web?.lastError && <div className="sect"><div className="guide-log">{esc(web.lastError)}</div></div>}
    </>
  )
}

function VersionsSection({ data, state, onAction, onRefresh }) {
  const installed = data.installed || []
  const remote = data.remote || []
  const progress = state.upgrading
  return (
    <>
      <h2 className="settings-title">版本与升级</h2>
      <p className="settings-desc">dsh 迭代快：一键升级 = 停进程 → 全量备份 → 下载 → 激活 → 健康检查，失败自动回滚；切换旧版本即回退。</p>
      <div className="sect">
        <div className="card-title" style={{ marginBottom: 4 }}>本地版本</div>
        {installed.length === 0
          ? <p className="evt-empty">无</p>
          : installed.map((v) => (
            <div key={v.version} className="sect-row" style={{ padding: '6px 0' }}>
              <span className={`dot${v.active ? ' dot-run' : ''}`}></span>
              <span className="sect-value" style={{ flex: 1 }}>v{esc(v.version)} · {v.channel === 'bundled' ? '插件捆绑' : '热更新'}{v.active ? ' · 使用中' : ''}</span>
              {v.channel === 'data' && !v.active && (
                <>
                  <button className="btn-ghost" onClick={onAction('ver-activate', v.version)}>切换</button>
                  <button className="btn-ghost btn-danger" onClick={onAction('ver-remove', v.version)}>移除</button>
                </>
              )}
            </div>
          ))}
      </div>
      <div className="sect">
        <div className="sect-row" style={{ justifyContent: 'space-between' }}>
          <div className="card-title">可用版本</div>
          <button className="btn-ghost" onClick={onRefresh}>刷新</button>
        </div>
        <div id="remote-rows" className="dsh-enter">
          {remote.length === 0
            ? <p className="evt-empty">点击刷新获取</p>
            : remote.slice(0, 12).map((v) => (
              <div key={v.version} className="sect-row" style={{ padding: '6px 0' }}>
                <span className="sect-value" style={{ flex: 1 }}>v{esc(v.version)}{v.distTag ? ` · ${esc(v.distTag)}` : ''}{v.date ? ` · ${esc(v.date.slice(0, 10))}` : ''}{v.assetUrl ? '' : ' · 无预编译资产'}</span>
                {installed.some((i) => i.version === v.version)
                  ? <span className="tag tag-ok">已装</span>
                  : v.assetUrl ? <button className="btn-ghost" onClick={onAction('ver-download', v.version)}>下载</button> : null}
                {v.assetUrl && !installed.some((i) => i.version === v.version)
                  ? <button className="btn" onClick={onAction('ver-upgrade', v.version)}>一键升级</button> : null}
              </div>
            ))}
        </div>
        {progress && (
          <>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${Number(progress.percent ?? 0)}%` }}></div></div>
            <div className="progress-line">{esc(progress.phase)}{progress.detail ? ` · ${esc(progress.detail)}` : ''}{progress.percent != null ? ` · ${progress.percent}%` : ''}</div>
          </>
        )}
      </div>
    </>
  )
}

function BackupsSection({ data, onAction }) {
  const backups = (data.backups || []).filter((b) => b.scope === 'home')
  return (
    <>
      <h2 className="settings-title">备份</h2>
      <p className="settings-desc">$DSH_HOME 全量快照（profiles 配置 / 凭据 / 会话；排除 node_modules）。含 API 凭据，仅保存在本机。</p>
      <div className="sect">
        <button className="btn" id="backup-create" onClick={onAction('backup-create')}>立即备份</button>
        {backups.length === 0
          ? <p className="evt-empty">暂无备份</p>
          : backups.map((b) => (
            <div key={b.backupId} className="sect-row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span className="sect-value" style={{ flex: 1 }}>{esc(b.name || b.backupId)} · {fmtBytes(b.sizeBytes)} · {fmtTime(b.createdAt)}</span>
              <button className="btn-ghost" onClick={onAction('backup-restore', b.backupId)}>恢复</button>
              <button className="btn-ghost btn-danger" onClick={onAction('backup-delete', b.backupId)}>删除</button>
            </div>
          ))}
      </div>
    </>
  )
}

function DiagnosticsSection({ data, state, onAction }) {
  const r = state.runtime || {}
  const tree = (data.home || []).map((l, i) => <div key={i}>{esc(l)}</div>)
  const logs = (data.logs || []).map((l, i) => <div key={i}>{esc(l)}</div>)
  return (
    <>
      <h2 className="settings-title">诊断</h2>
      <div className="sect">
        <div className="sect-row"><span className="sect-label">运行时</span><span className="sect-value">{esc(r.source ?? '')} {r.version ? `v${esc(r.version)}` : ''} · {esc(r.engine ?? '')}</span></div>
        <div className="sect-row"><span className="sect-label">runtime 路径</span><span className="sect-value">{esc(r.root ?? '')}</span></div>
        <div className="sect-row"><span className="sect-label">DSH_HOME</span><span className="sect-value">{esc(r.dshHome ?? '')}</span></div>
      </div>
      <div className="sect"><div className="card-title" style={{ marginBottom: 6 }}>DSH_HOME 布局</div><div className="guide-log">{tree.length ? tree : '（空）'}</div></div>
      <div className="sect">
        <div className="sect-row" style={{ justifyContent: 'space-between' }}>
          <div className="card-title">进程日志尾</div>
          <span>
            <button className="btn-ghost" onClick={onAction('logs', 'web')}>web</button>{' '}
            <button className="btn-ghost" onClick={onAction('logs', 'sdk')}>sdk</button>
          </span>
        </div>
        <div className="guide-log">{logs.length ? logs : '（无输出）'}</div>
      </div>
    </>
  )
}

/* —— 设置台（原 settings.js 等价） —— */
const NAV = [
  { id: 'profiles', label: 'Profile 管家', icon: IconStack },
  { id: 'runtime', label: '运行时与端口', icon: IconPower },
  { id: 'versions', label: '版本与升级', icon: IconUp },
  { id: 'backups', label: '备份', icon: IconArchive },
  { id: 'diagnostics', label: '诊断', icon: IconPulse },
]

function SettingsView({ state, onBack }) {
  const [section, setSection] = useState('profiles')
  const [sectionData, setSectionData] = useState({})
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const { call, notice } = window.DshApi

  const guard = useCallback(async (promise, okText) => {
    try {
      const r = await promise
      if (okText) notice(okText)
      return r
    } catch (error) {
      notice(String(error.message || error), 'error')
      throw error
    }
  }, [notice])

  const loadSection = useCallback(async (which) => {
    const target = which ?? section
    let next = {}
    try {
      if (target === 'profiles') {
        const [profiles, backups] = await Promise.all([
          call('profiles.list', {}).catch(() => []),
          call('backup.list', {}).catch(() => []),
        ])
        next = { profiles, backups }
      } else if (target === 'versions') {
        const [installed, remote] = await Promise.all([
          call('runtime.versions.list', {}).catch(() => []),
          call('runtime.versions.available', { limit: 15 }).catch(() => []),
        ])
        next = { installed, remote }
      } else if (target === 'backups') {
        next = { backups: await call('backup.list', {}).catch(() => []) }
      } else if (target === 'diagnostics') {
        const logs = await call('logs.tail', { kind: 'web', lines: 40 }).catch(() => [])
        const r = state.runtime || {}
        const home = [r.dshHome ?? '', r.dshHome ? '  profiles/' : '', r.dshHome ? '  storages/' : '']
        next = { logs, home }
      }
    } finally {
      if (aliveRef.current) setSectionData(next)
    }
  }, [call, section, state.runtime])

  useEffect(() => { void loadSection(section) }, [section]) // eslint-disable-line react-hooks/exhaustive-deps

  const onAction = useCallback((kind, value) => {
    return async () => {
      try {
        if (kind === 'profile-create') {
          const name = document.getElementById('profile-name')?.value.trim()
          const template = document.getElementById('profile-template')?.value
          if (!name) return
          await guard(call('profiles.create', { name, template }), `已创建 ${name}`)
        } else if (kind === 'profile-backup') {
          await guard(call('profiles.backup', { name: value }), '已备份')
        } else if (kind === 'profile-delete') {
          if (!window.confirm(`删除 profile "${value}"？（会先自动备份）`)) return
          await guard(call('profiles.delete', { name: value }), '已删除（备份保留）')
        } else if (kind === 'backup-restore') {
          if (!window.confirm('恢复此备份？当前数据将被覆盖（进程会停止）。')) return
          await guard(call('backup.restore', { backupId: value }), '已恢复')
        } else if (kind === 'backup-delete') {
          await guard(call('backup.delete', { backupId: value }), '已删除')
        } else if (kind === 'backup-create') {
          await guard(call('backup.create', { label: `手动快照 ${new Date().toLocaleString()}` }), '备份完成')
        } else if (kind === 'proc-start') {
          if (value === 'web') await guard(window.DshState.ensureWeb(), null)
          else await guard(window.DshState.ensureSdk(), null)
          await window.DshState.refreshStatus()
        } else if (kind === 'proc-stop') {
          await guard(call(value === 'web' ? 'web.stop' : 'sdk.stop', {}), '已停止')
          await window.DshState.refreshStatus()
        } else if (kind === 'proc-restart') {
          await guard(call('web.restart', {}), '重启中')
          await window.DshState.refreshStatus()
        } else if (kind === 'ver-activate') {
          await guard(call('runtime.activate', { version: value }), '已切换')
        } else if (kind === 'ver-remove') {
          await guard(call('runtime.remove', { version: value }), '已移除')
        } else if (kind === 'ver-download') {
          notice('开始下载…')
          await guard(call('runtime.download', { version: value }), '下载完成')
        } else if (kind === 'ver-upgrade') {
          if (!window.confirm(`一键升级到 ${value}？将停止进程并做全量备份，失败自动回滚。`)) return
          await guard(call('upgrade.oneClick', { version: value }), '升级完成')
          await window.DshState.detect()
        } else if (kind === 'logs') {
          const logs = await call('logs.tail', { kind: value, lines: 60 })
          setSectionData((prev) => ({ ...prev, logs }))
          return
        }
      } catch { /* guard 已 toast，维持原「失败不刷新」语义 */ }
      if (kind !== 'proc-restart') void loadSection()
    }
  }, [call, guard, loadSection, notice])

  const onPolicyChange = useCallback((policy, port) => {
    if (policy != null) state.prefs.webPortPolicy = policy
    if (port != null) state.prefs.webPort = Number(port) || 3080
  }, [state.prefs])

  const onPolicySave = useCallback(async () => {
    state.prefs.webPortPolicy = document.getElementById('port-policy').value
    state.prefs.webPort = Number(document.getElementById('port-fixed').value) || 3080
    await window.DshApi.setPref('webPortPolicy', state.prefs.webPortPolicy)
    await window.DshApi.setPref('webPort', state.prefs.webPort)
    notice('端口策略已保存（重启 web 进程后生效）')
  }, [notice, state.prefs])

  return (
    <div className="settings dsh-enter">
      <nav className="settings-nav">
        {NAV.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              className={`settings-nav-item${item.id === section ? ' active' : ''}`}
              data-nav={item.id}
              onClick={() => setSection(item.id)}
            >
              <Icon /><span>{item.label}</span>
            </button>
          )
        })}
        <span style={{ flex: 1 }}></span>
        <button className="settings-nav-item" data-nav="__back" onClick={onBack}>
          <IconBack /><span>返回</span>
        </button>
      </nav>
      <div className="settings-main" id="settings-main">
        {section === 'profiles' && <ProfilesSection data={sectionData} onAction={onAction} />}
        {section === 'runtime' && (
          <RuntimeSection
            state={state}
            onAction={onAction}
            onPolicyChange={onPolicyChange}
            onPolicySave={onPolicySave}
          />
        )}
        {section === 'versions' && <VersionsSection data={sectionData} state={state} onAction={onAction} onRefresh={() => void loadSection()} />}
        {section === 'backups' && <BackupsSection data={sectionData} onAction={onAction} />}
        {section === 'diagnostics' && <DiagnosticsSection data={sectionData} state={state} onAction={onAction} />}
      </div>
    </div>
  )
}

/* —— 小窗驾驶舱（原 views.js renderCockpit 等价） —— */
function CockpitView({ state, onGoSettings, onGoShell, onNewSession, onPickSession, onSend }) {
  const running = Object.entries(state.liveStatus).filter(([, v]) => v === 'running').map(([k]) => k)
  const inputRef = useRef(null)
  const activityRef = useRef(null)

  useEffect(() => {
    const activity = activityRef.current
    if (activity) activity.scrollTop = activity.scrollHeight
  }, [state.events, state.sdkError])

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend(inputRef.current)
    }
  }
  const onInput = () => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(120, input.scrollHeight)}px`
  }

  return (
    <div className="cockpit dsh-enter">
      <div className="cockpit-head">
        <span className={`dot${running.length ? ' dot-run' : state.runtime?.available ? ' dot-ok' : ' dot-err'}`}></span>
        <span className="cockpit-title">DSH 驾驶舱</span>
        <span className="cockpit-sub">{running.length ? `${running.length} 个会话运行中` : state.runtime?.version ? `v${esc(state.runtime.version)}` : ''}</span>
        <span style={{ flex: 1 }}></span>
        <button className="icon-btn" data-act="new-session" title="新快速会话" onClick={onNewSession}><IconPlus /></button>
        <button className="icon-btn" data-act="settings" title="设置" onClick={onGoSettings}><IconGear /></button>
      </div>
      <div className="sessions">
        {state.sessions.length > 0
          ? state.sessions.map((item) => {
              const live = state.liveStatus[item.sessionId] === 'running'
              const active = item.sessionId === state.currentSessionId
              return (
                <button
                  key={item.sessionId}
                  className={`session-chip${active ? ' active' : ''}`}
                  data-session={esc(item.sessionId)}
                  onClick={() => onPickSession(item.sessionId)}
                >
                  <span className={`dot${live ? ' dot-run' : ''}`} style={{ width: 5, height: 5 }}></span>
                  <span className="chip-title">{esc(item.title || item.sessionId)}</span>
                </button>
              )
            })
          : <span className="evt-empty">暂无会话 — 在下方开始快速对话，或在完全体里跑任务</span>}
      </div>
      <div className="activity" id="activity" ref={activityRef}>
        {state.events.length > 0
          ? state.events.map((ev, i) => renderEvent(ev, i))
          : <div className="evt-empty">选择上方会话查看进度，或直接在下方发起快速对话。</div>}
        {state.sdkError && (
          <div className="evt">
            <span className="evt-meta">sdk</span>
            <div className="evt-body">
              <span className="tool-line" style={{ color: 'var(--danger)' }}>{esc(state.sdkError)}</span>
              <button className="btn-ghost" data-act="open-full" style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }} onClick={onGoShell}>去完全体配置模型</button>
            </div>
          </div>
        )}
      </div>
      <div className="composer">
        <div className="composer-row">
          <textarea
            id="composer-input" ref={inputRef}
            placeholder="快速对话… Enter 发送，Shift+Enter 换行" rows={1}
            onKeyDown={onKeyDown} onInput={onInput}
          ></textarea>
          <button className="btn" id="composer-send" onClick={() => onSend(inputRef.current)}>发送</button>
        </div>
        <div className="composer-hint">{esc(state.prefs.provider)} · {esc(state.prefs.model)}</div>
      </div>
    </div>
  )
}

/* —— 大桌面（完全体，原 views.js renderShell / renderShellBoot / renderGuide 等价） —— */
function ShellView({ state, onGoSettings, onRestart, onBrowser }) {
  const web = state.status?.web
  const ready = web?.running && web?.readyUrl
  const runtime = state.runtime
  const readyRef = useRef(ready)
  readyRef.current = ready
  // 原 renderShell 尾部「非 ready 即 ensureWeb」的副作用等价（ready 变化不重复触发）
  useEffect(() => {
    if (!readyRef.current) void window.DshState.ensureWeb()
  }, [])
  if (runtime && !runtime.available) return <GuideView runtime={runtime} />
  const port = web?.port ? `127.0.0.1:${web.port}` : state.webBooting ? '启动中…' : '未运行'
  return (
    <div className="dsh-enter" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="shellbar">
        <span className={`dot${ready ? ' dot-ok' : state.webBooting ? ' dot-run' : web?.lastError ? ' dot-err' : ''}`}></span>
        <span>DSH 完全体</span>
        <span className="port">{esc(String(port))}{web?.profile && web.profile !== 'web' ? ` · ${esc(web.profile)}` : ''}</span>
        <span className="sep"></span>
        <button className="icon-btn" data-act="restart" title="重启服务" onClick={onRestart}><IconRestart /></button>
        <button className="icon-btn" data-act="browser" title="在浏览器打开" onClick={onBrowser}><IconExternal /></button>
        <button className="icon-btn" data-act="settings" title="设置" onClick={onGoSettings}><IconGear /></button>
      </div>
      {ready
        ? <iframe className="web-frame" id="web-frame" src={esc(web.readyUrl)} allow="clipboard-read; clipboard-write"></iframe>
        : <ShellBootView state={state} />}
    </div>
  )
}

function ShellBootView({ state }) {
  const err = state.status?.web?.lastError || state.webTail || ''
  return (
    <div className="guide">
      <div className="guide-card">
        <h2 className="guide-title">{state.webBooting ? '正在启动 DSH 完全体' : 'DSH Web 服务未运行'}</h2>
        <p className="guide-text">{state.webBooting ? '首次启动需要初始化 profile，通常 5–15 秒。' : '点击下方按钮启动本地 Web UI（随机空闲端口，token 自动注入）。'}</p>
        {err ? <div className="guide-log">{esc(err.slice(-1200))}</div> : null}
        <div className="guide-actions">
          <button className="btn" data-boot onClick={() => void window.DshState.ensureWeb()}>启动服务</button>
          <button
            className="btn-ghost" data-retry
            onClick={async () => { await window.DshState.refreshStatus(); window.DshRouter.rerender() }}
          >刷新状态</button>
        </div>
      </div>
    </div>
  )
}

function GuideView({ runtime }) {
  return (
    <div className="guide dsh-enter">
      <div className="guide-card">
        <h2 className="guide-title">未找到 DSH 运行时</h2>
        <p className="guide-text">本插件自带运行时（安装包即用）；若为开发加载或运行时被移除，可从插件仓库 Release 下载对应平台资产，或安装系统 dsh：<code>npm i -g @deepseek-ai/dsh</code></p>
        {runtime?.error ? <div className="guide-log">{esc(runtime.error)}</div> : null}
        <div className="guide-actions">
          <button className="btn" data-open-repo onClick={() => void window.DshApi.openExternal('https://github.com/hyqf98/eNest_plugin/releases')}>获取运行时</button>
          <button
            className="btn-ghost" data-retry
            onClick={async () => { await window.DshState.detect(); window.DshRouter.rerender() }}
          >重新检测</button>
        </div>
      </div>
    </div>
  )
}

/* —— 应用根：路由 + kit 装配（原 main.js 等价） —— */
export function App() {
  const { state, subscribe, boot, startPolling } = window.DshState
  const [route, setRoute] = useState('main') // main | settings
  const [tick, setTick] = useState(0)
  const kitRef = useRef(null)
  const routeRef = useRef(route)
  routeRef.current = route

  const currentMode = useCallback(() => {
    try {
      return kitRef.current?.mode || api.getLaunchMode?.() || 'shell'
    } catch {
      return 'shell'
    }
  }, [])

  const sendComposer = useCallback(async (input) => {
    const text = (input?.value ?? document.getElementById('composer-input')?.value ?? '').trim()
    if (!text) return
    if (input) {
      input.value = ''
      input.style.height = 'auto'
    }
    await window.DshState.ensureSdk()
    try {
      await window.DshState.sendPrompt(text)
    } catch (error) {
      window.DshApi.notice(`发送失败：${String(error.message || error)}`, 'error')
    }
  }, [])

  const rerenderRef = useRef(() => {})
  rerenderRef.current = () => setTick((n) => n + 1)

  useEffect(() => {
    const kit = window.PluginKit.create({
      title: 'DSH 驾驶舱',
      quickPlaceholder: '快速对话 / 查会话进度 · Enter 发送',
      height: 560,
      onQuery: (value) => {
        const input = document.getElementById('composer-input')
        if (input && value) {
          input.value = String(value).slice(0, 4000)
          input.focus()
        }
      },
      onAction: (action) => {
        if (action === 'submit') {
          void sendComposer(document.getElementById('composer-send'))
        }
      },
    })
    kitRef.current = kit

    // 模式迁移（quick ↔ shell 固定）不重载页面：重渲染
    try {
      api.onModeChange?.((mode) => {
        window.DshState.state.mode = mode
        rerenderRef.current()
      })
    } catch {
      /* 旧宿主无 onModeChange */
    }

    // Escape 从设置台返回主视图
    const onKey = (e) => {
      if (e.key === 'Escape' && routeRef.current === 'settings') setRoute('main')
    }
    document.addEventListener('keydown', onKey)

    window.DshState.setNotify(() => {
      // 数据变化时：设置台不整页重绘（局部状态多），仅主视图重绘
      if (routeRef.current === 'main') rerenderRef.current()
    })
    const unsubscribe = subscribe(() => {
      if (routeRef.current === 'main') rerenderRef.current()
    })

    void boot(currentMode()).then(() => {
      rerenderRef.current()
      startPolling()
      // quick：自动拉起 sdk 快速对话通道；shell：ensureWeb 由 ShellView 挂载后触发
      if (currentMode() === 'quick') void window.DshState.ensureSdk()
    })

    return () => {
      document.removeEventListener('keydown', onKey)
      unsubscribe()
    }
  }, [boot, currentMode, sendComposer, startPolling, subscribe])

  const go = useCallback((next) => setRoute(next), [])

  const mode = currentMode()
  const main = route === 'settings'
    ? <SettingsView state={state} onBack={() => go('main')} />
    : mode === 'quick'
      ? (
        <CockpitView
          state={state}
          onGoSettings={() => go('settings')}
          onGoShell={() => go('main')}
          onNewSession={() => void window.DshState.newQuickSession()}
          onPickSession={(sessionId) => void window.DshState.loadSession(sessionId)}
          onSend={(input) => void sendComposer(input)}
        />
      )
      : (
        <ShellView
          state={state}
          onGoSettings={() => go('settings')}
          onRestart={async () => {
            await window.DshApi.call('web.restart', {})
            window.DshState.commit({ webBooting: true })
          }}
          onBrowser={() => {
            const web = state.status?.web
            if (web?.readyUrl) window.DshApi.openExternal(web.readyUrl)
          }}
        />
      )
  // ShellView 挂载且 web 未就绪时自动拉起（原 renderShell 尾部 ensureWeb 等价，已内聚到 ShellView 的 effect）
  return main
}
