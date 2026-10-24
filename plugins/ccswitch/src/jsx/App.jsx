/**
 * com.enest.ccswitch — React 版主控（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变。
 * 业务核心复用 src/js/*（api/providers/history/mcp/sessions/usage/snapshot/presets，语义未改动）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreMenu } from '../ui/index.jsx'
import {
  toast as AToast, notify as ANotify, errMsg as AErrMsg,
  agentApps, agentRead, agentBackups, agentRestore,
  sessionsList, sessionsRead,
  vaultSet, vaultRemove,
  storageGet, storageSet,
  saveTextFile, copyText,
  registerQuickProvider, onQuickQuery, respondQuickQuery,
  getThemeTokens, onThemeChange, onEnter, getLaunchMode,
  settingsGet, settingsSet,
} from '../js/api.js'
import {
  APPS, APP_MAP, tagsOf, loadProviders, sorted as sortedProviders,
  upsertProvider, removeProvider, reorder, applyProvider,
  extractCurrent, extractCurrentFromText, buildDiff,
  exportPayload, importPayload, resetProviderCache,
} from '../js/providers.js'
import {
  loadHistory, recordHistory, clearHistory, rollback, readCurrentState, HISTORY_LIMIT,
} from '../js/history.js'
import {
  TEMPLATES as MCP_TEMPLATES, loadMcp, upsertMcp, removeMcp,
  toggleMcpApp, resetMcpCache, syncToApp, importFromApp,
} from '../js/mcp.js'
import { listSessions, readSession, resumeCommand, exportMarkdown } from '../js/sessions.js'
import { exportAll as exportSnapshotAll, importAll as importSnapshotAll } from '../js/snapshot.js'
import { aggregate as aggregateUsage, drawDaily, drawHeatmap, fmtTokens, testEndpoint } from '../js/usage.js'
import { PRESETS, instantiate } from '../js/presets.js'

const PROJECTS_KEY = 'ccswitch.projects.v1'
const NAV_ITEMS = [
  ['history', '◷', '切换历史'],
  ['mcp', '⌗', 'MCP'],
  ['sessions', '❯', '会话'],
  ['usage', '▤', '用量'],
  ['backups', '⏱', '备份'],
  ['projects', '❖', '项目预设'],
  ['settings', '⚙', '设置'],
]

function host(hostname) {
  try { return new URL(hostname).host } catch { return hostname || '—' }
}
function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}
function fmtDate(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function fmtAgo(ms) {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  return Math.floor(diff / 86_400_000) + ' 天前'
}

/* —— 全局可变状态（latest-ref；渲染状态单独走 useState） —— */
const state = {
  apps: [],
  installed: new Set(),
  active: new Set(),
  currentApp: 'claude-code',
  page: 'providers',
  snapshots: new Map(),
  currentProvider: new Map(),
  sessionsCache: null,
  sessionDetail: null,
  sessionListApp: null,
  usageData: null,
  diffPending: null,
  _diffBefore: new Map(),
  editProviderId: null,
  editMcpId: null,
  latencyCache: new Map(),
  presetTag: '',
}
const tagFilters = new Map() // app → tag

export function App() {
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((t) => t + 1), [])

  // 渲染状态（原命令式 DOM 写回的等价镜像）
  const [appsReady, setAppsReady] = useState(false)
  const [navApps, setNavApps] = useState(APPS.map((a) => ({ ...a, installed: false, active: false })))
  const [page, setPage] = useState('providers')
  const [providersTitle, setProvidersTitle] = useState('供应商')
  const [providersSub, setProvidersSub] = useState('')
  const [summaryItems, setSummaryItems] = useState(null) // null = strip hidden
  const [tagChips, setTagChips] = useState([])
  const [providerCards, setProviderCards] = useState(null) // null = 加载中
  const [searchKw, setSearchKw] = useState('')
  const [historyRows, setHistoryRows] = useState(null)
  const [historySub, setHistorySub] = useState('最近 50 次切换记录，可一键回退')
  const [mcpRows, setMcpRows] = useState(null)
  const [sessionsView, setSessionsView] = useState({ mode: 'list', list: [], sub: '', error: null, detail: null })
  const [sessionSearch, setSessionSearch] = useState('')
  const [usageView, setUsageView] = useState({ loading: false, sub: 'token / 请求 / 按日趋势 / 热力图', data: null, error: null })
  const [backupsView, setBackupsView] = useState({ rows: null, sub: '切换前自动备份，保留最近 20 份' })
  const [projectsRows, setProjectsRows] = useState(null)
  const [settingsView, setSettingsView] = useState(null)
  const [toasts, setToasts] = useState([])
  // 抽屉/弹层
  const [drawer, setDrawer] = useState({ open: false, title: '新建供应商' })
  const [pf, setPf] = useState({ name: '', tags: '', baseurl: '', apikey: '', keyType: 'password', model: '', appsSel: new Set(['claude-code']), env: '', toml: '', universal: false, json: '', keyHint: '', testResult: '', formHint: '', presetChips: [] })
  const [pfTab, setPfTab] = useState('form')
  const [modalPresets, setModalPresets] = useState({ open: false, grid: [], source: '' })
  const [presetSearch, setPresetSearch] = useState('')
  const [presetTagFilter, setPresetTagFilter] = useState([])
  const [modalMcp, setModalMcp] = useState({ open: false, title: '新建 MCP', tab: 'form', type: 'stdio', appsSel: new Set() })
  const [modalDiff, setModalDiff] = useState({ open: false, app: '', rows: [], multi: 0 })
  const [modalMcpTpl, setModalMcpTpl] = useState(false)
  const [modalConfirm, setModalConfirm] = useState(null) // { title, text, hint, okText, danger, resolve }
  const drawerRef = useRef(null)
  const navRef = useRef(null)
  const navCollapseRef = useRef(null)
  const navigationRef = useRef(null)
  const [navCollapsed, setNavCollapsed] = useState(false)

  const showToast = useCallback((msg, type) => {
    AToast(msg, type)
    const id = Math.random().toString(36).slice(2)
    setToasts((prev) => [...prev, { id, msg, type: type || '' }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2600)
  }, [])

  const confirmDialog = useCallback(({ title, text, hint, okText = '确认', danger = false }) => {
    return new Promise((resolve) => {
      setModalConfirm({ title, text, hint, okText, danger, resolve })
    })
  }, [])
  const settleConfirm = (val) => {
    setModalConfirm((cur) => { cur?.resolve?.(val); return null })
  }

  // 撤销删除 toast
  const undoToast = useCallback((name, snapshotItem) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((prev) => [...prev, { id, msg: '已删除「' + name + '」', type: 'undoable', undo: snapshotItem }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000)
  }, [])
  const undoDelete = async (t) => {
    try {
      await upsertProvider(t.undo)
      setToasts((prev) => prev.filter((x) => x.id !== t.id))
      showToast('已恢复「' + t.undo.name + '」', 'success')
      if (state.page === 'providers') void refreshCurrentApp()
    } catch (e) { showToast('恢复失败：' + AErrMsg(e), 'error') }
  }

  /* ================ 应用侧栏 ================ */
  const renderNavApps = useCallback(() => {
    setNavApps(APPS.map((meta) => ({
      ...meta,
      installed: state.installed.has(meta.id),
      active: state.active.has(meta.id),
      current: state.currentApp === meta.id,
    })))
    setAppsReady(true)
  }, [])

  const onNavApp = (meta) => {
    if (!state.installed.has(meta.id)) {
      showToast(meta.name + ' 未安装或未初始化，灰显不可操作', 'info')
      return
    }
    state.currentApp = meta.id
    if (['providers', 'backups'].includes(state.page)) {
      void refreshCurrentApp()
    } else {
      renderNavApps()
      if (state.page === 'sessions') { state.sessionsCache = null; state.sessionDetail = null; void loadSessionsPage() }
      if (state.page === 'usage') { state.usageData = null; void loadUsagePage() }
    }
    renderNavApps()
  }

  const renderSummary = useCallback((all, current) => {
    const list = all || sortedProviders().filter((p) => !p.apps || p.apps.length === 0 || p.apps.includes(state.currentApp))
    const cur = current !== undefined ? current : detectCurrentProviderSync(state.currentApp, list)
    const items = []
    items.push({ label: '当前生效', value: cur ? cur.name : '官方默认', accent: true })
    items.push({ label: '已配置', value: String(list.length) + ' 个供应商' })
    let shared = 0
    for (const p of list) {
      const n = (p.apps || []).filter((a) => state.installed.has(a)).length
      if (n > 1) shared++
    }
    items.push({ label: '多应用共用', value: shared ? String(shared) + ' 个供应商' : '无' })
    const lat = cur?.baseUrl ? state.latencyCache.get(cur.baseUrl) : null
    items.push({
      label: '连通性',
      value: lat ? (lat.ok ? lat.latency + ' ms' : '不可达') : '未测',
      tone: lat ? (lat.ok ? 'ok' : 'danger') : '',
    })
    setSummaryItems(items)
  }, [])

  async function ensureSnapshot(app) {
    if (!state.snapshots.has(app)) {
      try {
        state.snapshots.set(app, await agentRead(app))
      } catch (e) {
        state.snapshots.set(app, { files: [], active: false, error: AErrMsg(e) })
      }
    }
    return state.snapshots.get(app)
  }

  function detectCurrentProviderSync(app, providers) {
    const snap = state.snapshots.get(app)
    if (!snap) return null
    const cur = extractCurrent(app, snap) || extractCurrentFromText(app, snap.files?.[0]?.content)
    if (!cur) return null
    return providers.find((p) =>
      p.baseUrl && cur.baseUrl && (
        host(p.baseUrl) === host(cur.baseUrl) ||
        String(p.baseUrl).replace(/\/+$/, '') === String(cur.baseUrl).replace(/\/+$/, '')
      )
    ) || null
  }

  /* ================ 供应商页 ================ */
  const refreshCurrentApp = useCallback(async () => {
    renderNavApps()
    const appName = APP_MAP[state.currentApp]?.name || state.currentApp
    setProvidersTitle(appName + ' · 供应商')
    const mode = APP_MAP[state.currentApp]?.mode
    setProvidersSub(mode === 'additive' ? '共存式：多选添加 / 移除' : '切换式：单选启用')
    await Promise.all([renderProviders(), loadBackups()])
  }, [renderNavApps]) // eslint-disable-line react-hooks/exhaustive-deps

  const renderProviders = useCallback(async () => {
    const app = state.currentApp
    if (!state.installed.has(app)) {
      setProviderCards({ kind: 'guide', big: '⌾', text: APP_MAP[app]?.name + ' 尚未安装或未初始化', hint: '安装并首次运行该 CLI 后，此处可管理其供应商配置' })
      renderSummary()
      return
    }
    await Promise.all([loadProviders(), ensureSnapshot(app)])
    const all = sortedProviders().filter((p) => !p.apps || p.apps.length === 0 || p.apps.includes(app))
    const current = detectCurrentProviderSync(app, all)
    state.currentProvider.set(app, current?.id || null)

    if (all.length === 0) {
      setProviderCards({ kind: 'guide', big: '⇄', text: '还没有供应商', hint: '从「预设库」一键实例化，或「新建」自定义', actions: true })
      renderSummary()
      return
    }
    // 标签过滤 chips
    const counts = new Map()
    for (const p of all) {
      const tags = tagsOf(p)
      if (!tags.length) counts.set('未分组', (counts.get('未分组') || 0) + 1)
      for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1)
    }
    const activeTag = tagFilters.get(app) || ''
    const chips = [{ label: '全部', on: !activeTag && !state._kw, tag: '' }]
    for (const [tag, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      chips.push({ label: tag + ' ' + n, on: activeTag === tag, tag })
    }
    setTagChips(chips)
    let filtered = all
    if (activeTag) filtered = filtered.filter((p) => tagsOf(p).includes(activeTag))
    const kw = (state._kw || '').trim().toLowerCase()
    if (kw) filtered = filtered.filter((p) => (p.name + ' ' + p.baseUrl + ' ' + p.model + ' ' + tagsOf(p).join(' ')).toLowerCase().includes(kw))
    if (filtered.length === 0) {
      setProviderCards({ kind: 'empty', text: '没有匹配的供应商' })
      renderSummary(all, current)
      return
    }
    const mode = APP_MAP[app]?.mode
    const ordered = [...filtered].sort((a, b) => (current && current.id === b.id ? 1 : 0) - (current && current.id === a.id ? 1 : 0))
    setProviderCards({ kind: 'grid', cards: ordered.map((p) => ({ p, isCurrent: current && current.id === p.id, mode })), app })
    renderSummary(all, current)
  }, [renderSummary])

  const onProviderSearch = (e) => {
    state._kw = e.target.value
    setSearchKw(e.target.value)
    if (state.page === 'providers') void renderProviders()
  }

  async function confirmDeleteProvider(p) {
    const app = state.currentApp
    const isCurrent = state.currentProvider.get(app) === p.id
    if (p.isDefault) { showToast('默认供应商不可删除', 'error'); return }
    if (isCurrent) { showToast('该供应商正在使用中，先切换到其它供应商再删除', 'error'); return }
    const snapshotItem = JSON.parse(JSON.stringify(p))
    const ok = await confirmDialog({
      title: '删除供应商',
      text: `确定删除「${p.name}」？此操作只移除插件内配置，不改动已写入的应用配置文件。`,
      hint: '删除后可通过提示条内的「撤销」一键恢复。',
      okText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await removeProvider(p.id)
      if (p.secretRef) await vaultRemove(p.secretRef)
      showToast('已删除 ' + p.name, 'success')
      await renderProviders()
      undoToast(p.name, snapshotItem)
    } catch (e) { showToast(AErrMsg(e), 'error') }
  }

  async function duplicateProvider(p) {
    const copy = { ...p, id: '', name: p.name + ' 副本', isDefault: false }
    await upsertProvider(copy)
    showToast('已复制 ' + p.name, 'success')
    await renderProviders()
  }

  function providerMenuItems(p, isCurrent, mode) {
    return [
      { key: 'switch', label: isCurrent ? '当前使用中' : mode === 'additive' ? '添加到应用' : '启用', disabled: isCurrent, onSelect: () => switchProvider(p) },
      { key: 'edit', label: '编辑', onSelect: () => openProviderModal(p) },
      { key: 'duplicate', label: '复制', onSelect: () => duplicateProvider(p) },
      { key: 'test', label: '测速', onSelect: () => testProviderLatency(p) },
      { sep: true },
      { key: 'delete', label: '删除', danger: true, disabled: p.isDefault || isCurrent, onSelect: () => confirmDeleteProvider(p) },
    ]
  }

  // 右键与可点击菜单共用逐项闭包，菜单打开后不会跟随另一张卡片。
  function providerCardMenu(event, p, isCurrent, mode) {
    event.preventDefault()
    const items = providerMenuItems(p, isCurrent, mode)
    window.PluginKit.openMenu(event, items, (key) => {
      const action = items.find((item) => item.key === key)
      if (action && !action.disabled) void action.onSelect?.()
    }, { align: 'end' })
  }

  /* —— 切换流程：diff 预览 → 确认 → write → 历史记录 —— */
  async function switchProvider(p, { skipConfirm } = {}) {
    const app = state.currentApp
    try {
      const targetApps = p.universal && Array.isArray(p.apps) && p.apps.length > 1 ? p.apps.filter((a) => state.installed.has(a)) : [app]
      const beforeStates = new Map()
      for (const target of targetApps) beforeStates.set(target, await readCurrentState(target))
      const diffs = []
      for (const target of targetApps) {
        const snap = await ensureSnapshot(target)
        const diff = buildDiff(target, p, snap)
        if (!diff) { showToast(APP_MAP[target]?.name + ' 不支持供应商切换，已跳过', 'info'); continue }
        diffs.push({ app: target, provider: p, diff })
      }
      if (diffs.length === 0) return
      const diffConfirmOn = await settingsGet('diffConfirm', true)
      if (!skipConfirm && diffConfirmOn !== false) {
        showDiffModal(diffs, beforeStates)
        return
      }
      await applyDiffs(diffs, beforeStates)
    } catch (e) {
      showToast('切换失败：' + AErrMsg(e), 'error')
    }
  }

  function showDiffModal(diffs, beforeStates) {
    state.diffPending = diffs
    state._diffBefore = beforeStates || new Map()
    const first = diffs[0]
    setModalDiff({
      open: true,
      app: diffs.map((d) => `${APP_MAP[d.app]?.name || d.app} → ${d.provider.name}`).join('；'),
      rows: first.diff.rows,
      multi: diffs.length,
    })
  }

  async function applyDiffs(diffs, beforeStates) {
    const before = beforeStates || state._diffBefore || new Map()
    let lastErr = null
    const written = []
    for (const d of diffs) {
      try {
        await applyProvider(d.app, d.provider)
        state.snapshots.delete(d.app)
        written.push(d.app)
      } catch (e) { lastErr = e }
    }
    if (lastErr) {
      showToast('部分应用切换失败：' + AErrMsg(lastErr), 'error')
    } else {
      showToast(`已切换到 ${diffs[0].provider.name}（已自动备份）`, 'success')
      ANotify('供应商切换', `已切换到 ${diffs[0].provider.name}`)
      try {
        await recordHistory(diffs[0].provider, {
          ...(before.get(written[0]) || {}),
          providerId: null,
          name: null,
        }, written)
      } catch { /* 历史失败不影响切换 */ }
    }
    setModalDiff((m) => ({ ...m, open: false }))
    await renderProviders()
  }

  /* ================ 编辑抽屉 ================ */
  function openDrawer() {
    setDrawer((d) => ({ ...d, open: true }))
    requestAnimationFrame(() => drawerRef.current?.classList.add('open'))
    setTimeout(() => document.getElementById('pf-name')?.focus(), 120)
  }
  function closeDrawer() {
    const d = drawerRef.current
    if (!d || !drawer.open) return
    d.classList.remove('open')
    const done = () => setDrawer((prev) => ({ ...prev, open: false }))
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) done()
    else setTimeout(done, 200)
  }

  function fillProviderForm(p) {
    const selected = new Set(p.apps && p.apps.length ? p.apps : [state.currentApp])
    setPf({
      name: p.name || '',
      tags: tagsOf(p).join(', '),
      baseurl: p.baseUrl || '',
      apikey: '',
      keyType: 'password',
      model: p.model || '',
      appsSel: selected,
      env: p.extraEnv ? JSON.stringify(p.extraEnv, null, 2) : '',
      toml: p.tomlExtra ? JSON.stringify(p.tomlExtra, null, 2) : '',
      universal: Boolean(p.universal),
      json: JSON.stringify({
        name: p.name || '', tag: tagsOf(p)[0] || '', tags: tagsOf(p), baseUrl: p.baseUrl || '',
        model: p.model || '', apps: [...selected], universal: Boolean(p.universal),
      }, null, 2),
      keyHint: p.secretRef ? '已存密钥（保险库引用），留空则保持不变' : '密钥将存入保险库（vault），配置导出默认脱敏',
      testResult: '',
      formHint: '',
      presetChips: [],
    })
  }

  function openProviderModal(existing, presetInit) {
    state.editProviderId = existing?.id || null
    const p = existing || presetInit || {}
    setDrawer({ open: false, title: existing ? '编辑供应商' : '新建供应商' })
    fillProviderForm(p)
    // 抽屉顶部「从模板开始」chips
    const app = state.currentApp
    const relevant = PRESETS.filter((x) => x.apps.includes(app))
    const list = (relevant.length >= 4 ? relevant : PRESETS).slice(0, 8)
    const chips = list.map((preset) => ({
      name: preset.name,
      title: preset.baseUrl || '官方默认端点',
      apply: () => {
        const inst = instantiate(preset, { apps: [state.currentApp] })
        fillProviderForm(inst)
        setPf((f) => ({ ...f, formHint: '已套用模板「' + preset.name + '」，补入 API Key 即可保存' }))
      },
    }))
    setPf((f) => ({ ...f, presetChips: chips, formHint: presetInit && !existing ? '已从预设库带入「' + presetInit.name + '」' : f.formHint }))
    setPfTab('form')
    openDrawer()
  }

  async function saveProviderModal() {
    const isJsonTab = pfTab === 'json'
    let base
    if (isJsonTab) {
      try {
        base = JSON.parse(pf.json)
      } catch (e) {
        showToast('JSON 源码解析失败：' + AErrMsg(e), 'error')
        return
      }
    } else {
      base = {
        name: pf.name.trim(),
        tags: pf.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        baseUrl: pf.baseurl.trim(),
        model: pf.model.trim(),
      }
      if (!base.name) { showToast('名称必填', 'error'); return }
    }
    const apps = isJsonTab ? (Array.isArray(base.apps) ? base.apps : [state.currentApp]) : [...pf.appsSel]
    const tags = Array.isArray(base.tags) && base.tags.length ? base.tags.map((s) => String(s).trim()).filter(Boolean) : []
    const item = {
      id: state.editProviderId || '',
      name: String(base.name || '').trim(),
      tag: tags[0] || '',
      tags,
      baseUrl: String(base.baseUrl || '').trim(),
      model: String(base.model || '').trim(),
      apps,
      universal: isJsonTab ? Boolean(base.universal) : pf.universal,
    }
    if (!isJsonTab) {
      try {
        if (pf.env.trim()) item.extraEnv = JSON.parse(pf.env)
        if (pf.toml.trim()) item.tomlExtra = JSON.parse(pf.toml)
      } catch (e) {
        showToast('高级片段 JSON 解析失败：' + AErrMsg(e), 'error')
        return
      }
    }
    const keyInput = pf.apikey.trim()
    if (keyInput) {
      try {
        const res = await vaultSet('ccswitch.' + (item.name || Date.now()), keyInput)
        item.secretRef = res?.secretRef || ''
        item.plainSecret = keyInput
      } catch (e) {
        showToast('密钥保存失败：' + AErrMsg(e), 'error')
      }
    }
    if (state.editProviderId) {
      const providers = await loadProviders()
      const old = providers.find((x) => x.id === state.editProviderId)
      if (old) {
        if (!item.secretRef) item.secretRef = old.secretRef
        item.isDefault = old.isDefault
        item.plainSecret = item.plainSecret || old.plainSecret
      }
    }
    const plain = item.plainSecret
    delete item.plainSecret
    await upsertProvider(item)
    item.plainSecret = plain
    closeDrawer()
    showToast('已保存 ' + item.name, 'success')
    await renderProviders()
  }

  /* ================ 测速 ================ */
  async function testFromDrawer() {
    const url = pf.baseurl.trim()
    if (!url) { showToast('先填写 Base URL', 'info'); return }
    setPf((f) => ({ ...f, testResult: '测速中…' }))
    const r = await testEndpoint(url)
    if (r.ok) {
      setPf((f) => ({ ...f, testResult: `可达 · ${r.latency}ms · HTTP ${r.status}` }))
      state.latencyCache.set(url, { ok: true, latency: r.latency, status: r.status, ts: Date.now() })
      showToast(`可达 · ${r.latency}ms · HTTP ${r.status}`, 'success')
    } else {
      setPf((f) => ({ ...f, testResult: '不可达：' + r.error }))
      showToast('不可达：' + r.error, 'error')
    }
    if (state.page === 'providers') renderSummary()
  }

  /** 卡片右键「测速」：对供应商 Base URL 探测一次并回写摘要条 */
  async function testProviderLatency(p) {
    const url = (p.baseUrl || '').trim()
    if (!url) { showToast('该供应商使用官方默认端点，无需测速', 'info'); return }
    showToast('测速中…', 'info')
    const r = await testEndpoint(url)
    if (r.ok) {
      state.latencyCache.set(url, { ok: true, latency: r.latency, status: r.status, ts: Date.now() })
      showToast(`${p.name} 可达 · ${r.latency}ms · HTTP ${r.status}`, 'success')
    } else {
      state.latencyCache.set(url, { ok: false, ts: Date.now() })
      showToast(`${p.name} 不可达：${r.error}`, 'error')
    }
    renderSummary()
  }

  /* ================ 预设库 ================ */
  const renderPresetGrid = useCallback((q) => {
    let list = PRESETS.filter((p) => {
      const kw = String(q || '').trim().toLowerCase()
      if (!kw) return true
      return (p.name + ' ' + p.tag + ' ' + p.baseUrl + ' ' + p.model).toLowerCase().includes(kw)
    })
    if (state.presetTag) list = list.filter((p) => p.tag === state.presetTag)
    setModalPresets((m) => ({
      ...m,
      grid: list.map((preset) => ({ preset })),
      source: `共 ${PRESETS.length} 个预设 · 内置（移植自 cc-switch Apache-2.0 社区清单） · v1`,
    }))
  }, [])

  function openPresetLib() {
    state.presetTag = ''
    setPresetTagFilter([...new Set(PRESETS.map((p) => p.tag))])
    setModalPresets((m) => ({ ...m, open: true }))
    renderPresetGrid('')
  }

  async function onPresetInstantiate(preset) {
    const installedApps = preset.apps.filter((a) => state.installed.has(a))
    const inst = instantiate(preset, { apps: installedApps.length ? installedApps : preset.apps })
    await upsertProvider(inst)
    showToast(`已从预设创建「${preset.name}」，可点击编辑补入密钥`, 'success')
    setModalPresets((m) => ({ ...m, open: false }))
    if (state.page === 'providers') await renderProviders()
  }

  /* ================ 导入导出 ================ */
  async function exportProviders() {
    const payload = exportPayload(false)
    try {
      const r = await saveTextFile({
        defaultName: 'ccswitch-providers.json',
        filename: 'ccswitch-providers.json',
        content: JSON.stringify(payload, null, 2),
      })
      if (r) showToast('已导出（密钥已脱敏）', 'success')
    } catch (e) { showToast('导出失败：' + AErrMsg(e), 'error') }
  }

  function importProvidersModal() {
    openTextPromptModal({
      title: '导入供应商',
      placeholder: '粘贴导出的 JSON（或 cc-switch 兼容格式）',
      okText: '导入',
      onSubmit: async (data, close) => {
        try {
          const parsed = JSON.parse(data)
          const res = await importPayload(parsed)
          close()
          showToast(`导入完成：新增 ${res.added}，跳过 ${res.skipped}`, 'success')
          await renderProviders()
        } catch (e) { showToast('导入失败：' + AErrMsg(e), 'error') }
      },
    })
  }

  /* ================ 全量快照（备份页） ================ */
  async function exportSnapshot() {
    try {
      const payload = await exportSnapshotAll()
      const r = await saveTextFile({
        defaultName: 'ccswitch-full-backup.json',
        filename: 'ccswitch-full-backup.json',
        content: JSON.stringify(payload, null, 2),
      })
      if (r) showToast('全量导出成功（不含密钥明文）', 'success')
    } catch (e) { showToast('导出失败：' + AErrMsg(e), 'error') }
  }

  function importSnapshotModal() {
    openTextPromptModal({
      title: '从 JSON 恢复',
      placeholder: '粘贴「导出全量 JSON」的内容（也兼容旧的供应商导出格式）',
      okText: '恢复',
      mergeCheck: true,
      onSubmit: async (data, close, merge) => {
        try {
          const parsed = JSON.parse(data)
          if (!merge) {
            const ok = await confirmDialog({
              title: '覆盖恢复',
              text: '覆盖模式将清空当前的供应商 / MCP / 项目预设再写入快照内容。',
              hint: '建议先「导出全量 JSON」留一份当前状态。',
              okText: '覆盖恢复',
              danger: true,
            })
            if (!ok) return
          }
          const res = await importSnapshotAll(parsed, { merge })
          resetMcpCache()
          resetProviderCache()
          close()
          showToast(`恢复完成（${res.mode}）：供应商 +${res.providers.added ?? 0}，MCP ${res.mcp}，项目 ${res.projects}`, 'success')
          await renderProviders()
        } catch (e) { showToast('恢复失败：' + AErrMsg(e), 'error') }
      },
    })
  }

  // 动态文本导入弹层（原 h() 动态构建的 modal，等价 React 态）
  const [promptModal, setPromptModal] = useState(null)
  function openTextPromptModal({ title, placeholder, okText, onSubmit, mergeCheck }) {
    setPromptModal({ title, placeholder, okText, onSubmit, mergeCheck, value: '', merge: false })
  }

  /* ================ 切换历史页 ================ */
  const loadHistoryPage = useCallback(async () => {
    const list = await loadHistory()
    setHistorySub(`最近 ${HISTORY_LIMIT} 次切换记录，可一键回退 · 当前共 ${list.length} 条`)
    if (list.length === 0) {
      setHistoryRows({ kind: 'guide', big: '◷', text: '还没有切换记录', hint: '每次确认切换后自动记录（保留最近 50 条），可随时回退' })
      return
    }
    setHistoryRows({ kind: 'list', list })
  }, [])

  /* ================ MCP 页 ================ */
  const renderMcp = useCallback(async () => {
    const entries = await loadMcp()
    if (entries.length === 0) {
      setMcpRows({ kind: 'guide', big: '⌗', text: '还没有 MCP 服务器', hint: '从模板添加、导入现有配置，或自定义 JSON' })
      return
    }
    setMcpRows({ kind: 'list', entries })
  }, [])

  function openMcpModal(existing, tplInit) {
    state.editMcpId = existing?.id || null
    const spec = existing?.spec || tplInit?.spec || { type: 'stdio' }
    const selected = new Set(Object.keys(existing?.apps || {}).filter((k) => existing.apps[k]))
    if (!existing && !tplInit) selected.add(state.currentApp)
    if (tplInit) selected.add(state.currentApp)
    setModalMcp({
      open: true,
      title: existing ? '编辑 MCP' : tplInit ? `添加模板：${tplInit.name}` : '新建 MCP',
      tab: 'form',
      type: spec.type === 'http' ? 'http' : 'stdio',
      appsSel: selected,
      id: existing?.id || tplInit?.id || '',
      command: spec.command || '',
      args: Array.isArray(spec.args) ? spec.args.join(' ') : '',
      url: spec.url || '',
      headers: spec.headers ? JSON.stringify(spec.headers) : '',
      env: spec.env ? JSON.stringify(spec.env) : '',
      json: JSON.stringify(spec, null, 2),
    })
  }

  async function deleteMcpEntry(entry) {
    const ok = await confirmDialog({
      title: '删除 MCP',
      text: `删除 MCP「${entry.id}」？`,
      hint: '将从所有已启用应用的配置文件中同步移除。',
      okText: '删除',
      danger: true,
    })
    if (!ok) return
    await removeMcp(entry.id)
    for (const appId of Object.keys(entry.apps || {})) {
      if (entry.apps[appId] && state.installed.has(appId)) {
        try { await syncToApp(appId) } catch { /* best-effort */ }
      }
    }
    await renderMcp()
  }

  /** MCP 卡片右键：编辑 / 删除（danger） */
  function mcpCardMenu(event, entry) {
    event.preventDefault()
    window.PluginKit.openMenu(
      event,
      [
        ['edit', '编辑'],
        'sep',
        ['delete', '删除', { danger: true }],
      ],
      (key) => {
        if (key === 'edit') openMcpModal(entry)
        if (key === 'delete') void deleteMcpEntry(entry)
      },
      { align: 'end' },
    )
  }

  async function saveMcpModal() {
    const isJson = modalMcp.tab === 'json'
    const id = modalMcp.id.trim()
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      showToast('名称/ID 必填（字母数字-_）', 'error')
      return
    }
    let spec
    if (isJson) {
      try { spec = JSON.parse(modalMcp.json) } catch (e) {
        showToast('JSON 解析失败：' + AErrMsg(e), 'error'); return
      }
    } else {
      const type = modalMcp.type
      spec = { type }
      if (type === 'http') {
        spec.url = modalMcp.url.trim()
        if (modalMcp.headers.trim()) {
          try { spec.headers = JSON.parse(modalMcp.headers) } catch { showToast('headers JSON 解析失败', 'error'); return }
        }
      } else {
        spec.command = modalMcp.command.trim()
        const args = modalMcp.args.trim()
        if (args) spec.args = args.split(/\s+/)
        if (modalMcp.env.trim()) {
          try { spec.env = JSON.parse(modalMcp.env) } catch { showToast('env JSON 解析失败', 'error'); return }
        }
      }
    }
    const apps = {}
    for (const appId of modalMcp.appsSel) apps[appId] = true
    const entry = { id, name: id, spec, apps }
    await upsertMcp(entry)
    let synced = 0
    for (const appId of Object.keys(apps)) {
      if (!state.installed.has(appId)) continue
      try { await syncToApp(appId); synced++ } catch (e) {
        showToast(APP_MAP[appId]?.name + ' 同步失败：' + AErrMsg(e), 'error')
      }
    }
    setModalMcp((m) => ({ ...m, open: false }))
    showToast(`已保存 ${id}，同步 ${synced} 个应用`, 'success')
    await renderMcp()
  }

  /* ================ 会话页 ================ */
  const loadSessionsPage = useCallback(async () => {
    const app = state.currentApp
    setSessionsView({ mode: 'list', list: [], sub: '', error: null, loading: true })
    try {
      if (!state.sessionsCache || state.sessionListApp !== app) {
        state.sessionsCache = await listSessions(app)
        state.sessionListApp = app
      }
      renderSessionList()
    } catch (e) {
      setSessionsView({ mode: 'list', list: [], sub: '', error: '会话目录读取失败：' + AErrMsg(e) + '（该应用可能不支持会话浏览）' })
    }
  }, [])

  const renderSessionList = useCallback(() => {
    const kw = (state._sessionKw || '').trim().toLowerCase()
    const list = kw
      ? state.sessionsCache.filter((s) => (s.title + s.project + s.sessionId).toLowerCase().includes(kw))
      : state.sessionsCache
    setSessionsView({ mode: 'list', list: list.slice(0, 200), total: state.sessionsCache.length, sub: `${state.sessionsCache.length} 个会话` })
  }, [])

  async function openSessionDetail(s) {
    setSessionsView((v) => ({ ...v, mode: 'detail', loading: true }))
    try {
      const detail = await readSession(state.currentApp, s.file)
      state.sessionDetail = { session: s, detail }
      setSessionsView({ mode: 'detail', session: s, detail, sub: `${s.sessionId.slice(0, 8)} · ${detail.turns.length} 轮${detail.truncated ? ' · 文件超 512KB 已截断' : ''}` })
    } catch (e) {
      setSessionsView({ mode: 'list', list: [], error: '读取失败：' + AErrMsg(e) })
    }
  }

  async function exportSessionMd() {
    if (!state.sessionDetail) return
    try {
      const r = await exportMarkdown(
        { ...state.sessionDetail.session, app: state.currentApp },
        state.sessionDetail.detail,
      )
      if (r) showToast('已导出 Markdown', 'success')
    } catch (e) { showToast('导出失败：' + AErrMsg(e), 'error') }
  }

  /* ================ 用量页 ================ */
  const loadUsagePage = useCallback(async () => {
    const app = state.currentApp
    setUsageView({ loading: true, sub: 'token / 请求 / 按日趋势 / 热力图', data: null, error: null })
    try {
      const data = await aggregateUsage(app, {
        onProgress: (done, total) => setUsageView((v) => ({ ...v, sub: `解析中 ${done}/${total} …` })),
      })
      state.usageData = data
      setUsageView({ loading: false, sub: `${data.files} 个会话文件 · ${data.records} 条请求记录`, data })
    } catch (e) {
      setUsageView({ loading: false, sub: '', data: null, error: '用量统计失败：' + AErrMsg(e) })
    }
  }, [])

  // 图表绘制（canvas 原样复用 usage.js）
  useEffect(() => {
    if (page !== 'usage' || !usageView.data) return
    const raf = requestAnimationFrame(() => {
      const c1 = document.getElementById('chart-daily')
      const c2 = document.getElementById('chart-heat')
      if (c1) drawDaily(c1, usageView.data.days)
      if (c2) drawHeatmap(c2, usageView.data.days)
    })
    return () => cancelAnimationFrame(raf)
  }, [page, usageView.data])

  /* ================ 备份页 ================ */
  const loadBackups = useCallback(async () => {
    if (state.page !== 'backups') return
    const app = state.currentApp
    setBackupsView({ rows: null, sub: APP_MAP[app]?.name + ' · 切换前自动备份，保留最近 20 份' })
    try {
      const backups = await agentBackups(app)
      setBackupsView({ rows: backups, sub: APP_MAP[app]?.name + ' · 切换前自动备份，保留最近 20 份' })
    } catch (e) {
      setBackupsView({ rows: { error: AErrMsg(e) }, sub: '' })
    }
  }, [])

  /* ================ 项目预设页 ================ */
  const renderProjects = useCallback(async () => {
    const projects = (await storageGet(PROJECTS_KEY, [])) || []
    if (projects.length === 0) {
      setProjectsRows({ kind: 'guide', big: '❖', text: '还没有项目预设', hint: '保存当前供应商 + MCP 整套配置，一键应用' })
      return
    }
    setProjectsRows({ kind: 'list', projects })
  }, [])

  async function saveCurrentProject() {
    const name = window.prompt('项目预设名称：')
    if (!name) return
    const providers = sortedProviders()
    const currentId = state.currentProvider.get(state.currentApp)
    const current = providers.find((p) => p.id === currentId) || null
    const mcpEntries = await loadMcp()
    const proj = {
      id: 'j' + Date.now().toString(36),
      name,
      app: state.currentApp,
      providerName: current?.name || null,
      provider: current,
      mcpIds: mcpEntries.filter((e) => e.apps?.[state.currentApp]).map((e) => e.id),
      savedAt: Date.now(),
    }
    const projects = (await storageGet(PROJECTS_KEY, [])) || []
    projects.unshift(proj)
    await storageSet(PROJECTS_KEY, projects)
    showToast('已保存项目预设', 'success')
    await renderProjects()
  }

  /* ================ 设置页 ================ */
  const renderSettings = useCallback(async () => {
    const defaultApp = await settingsGet('defaultApp', 'claude-code')
    const diffConfirm = await settingsGet('diffConfirm', true)
    setSettingsView({ defaultApp, diffConfirm: diffConfirm !== false })
  }, [])

  /* ================ 页面路由 ================ */
  const PAGE_LOADERS = {
    providers: refreshCurrentApp,
    history: loadHistoryPage,
    mcp: renderMcp,
    sessions: loadSessionsPage,
    usage: loadUsagePage,
    backups: () => loadBackups(),
    projects: renderProjects,
    settings: renderSettings,
  }

  const navigate = useCallback((next) => {
    state.page = next
    setPage(next)
    const loader = PAGE_LOADERS[next]
    if (loader) Promise.resolve(loader()).catch((e) => console.warn('[ccswitch] page load:', e))
  }, [loadBackups, loadHistoryPage, loadSessionsPage, loadUsagePage, refreshCurrentApp, renderMcp, renderProjects, renderSettings]) // eslint-disable-line react-hooks/exhaustive-deps

  navigationRef.current = { navApps, page, onNavApp, navigate }
  useEffect(() => {
    const anchor = navCollapseRef.current
    if (!anchor) return
    const flyout = window.PluginKit.hoverFlyout(anchor, () => {
      const current = navigationRef.current
      return [
        { key: 'page:providers', label: '供应商', checked: current.page === 'providers' },
        ...current.navApps.map((app) => ({ key: 'app:' + app.id, label: app.name, disabled: !app.installed, checked: app.current })),
        'sep',
        ...NAV_ITEMS.map(([id, , label]) => ({ key: 'page:' + id, label, checked: current.page === id })),
      ]
    }, {
      enabled: () => (navRef.current?.getBoundingClientRect().width || Infinity) <= 60,
      handleClick: false,
      side: 'right', delay: 120, hideDelay: 300, ariaLabel: '收起导航快捷入口',
      onPick: (key) => {
        const current = navigationRef.current
        if (key.startsWith('page:')) current.navigate(key.slice(5))
        if (key.startsWith('app:')) {
          const app = current.navApps.find((item) => item.id === key.slice(4))
          if (app?.installed) current.onNavApp(app)
        }
      },
    })
    return () => flyout.destroy()
  }, [])

  /* ================ Quick provider ================ */
  async function registerQuick() {
    try {
      const r = await registerQuickProvider({ id: 'ccswitch-providers', explain: '供应商切换：cc <名称> 直达切换' })
      if (!r || r.ok !== true) return
      onQuickQuery(async (event) => {
        try {
          const q = String(event.query || '').trim().toLowerCase()
          if (!q || q.length < 1) return
          const providers = sortedProviders()
          const hits = providers.filter((p) => p.name.toLowerCase().includes(q) || (p.baseUrl || '').toLowerCase().includes(q)).slice(0, 5)
          if (hits.length === 0) return
          await respondQuickQuery(event.reqId, hits.map((p) => ({
            id: p.id,
            title: 'cc 切换 → ' + p.name,
            subtitle: [p.baseUrl ? host(p.baseUrl) : '官方默认', p.model].filter(Boolean).join(' · '),
            explain: '回车切换该供应商（默认应用）',
            code: 'quick-switch:' + p.id,
            payload: { providerId: p.id },
          })))
        } catch { /* quick 查询失败静默 */ }
      })
    } catch { /* contribute 能力缺失时静默 */ }
  }

  async function handleQuickSwitch(providerId) {
    const providers = await loadProviders()
    const p = providers.find((x) => x.id === providerId)
    if (!p) return
    const defaultApp = await settingsGet('defaultApp', state.currentApp)
    state.currentApp = state.installed.has(defaultApp) ? defaultApp : state.currentApp
    await switchProvider(p)
  }

  /* ================ 主题 ================ */
  function applyTokens() {
    getThemeTokens().then((res) => {
      if (!res?.tokens) return
      for (const [k, v] of Object.entries(res.tokens)) {
        if (k.startsWith('--')) document.documentElement.style.setProperty(k, v)
      }
    }).catch(() => {})
  }

  /* ================ 启动 ================ */
  const bootRef = useRef(false)
  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    void (async () => {
      try {
        await loadApps()
        const defaultApp = await settingsGet('defaultApp', 'claude-code')
        if (state.installed.has(defaultApp)) state.currentApp = defaultApp
        navigate('providers')
        void registerQuick()
      } catch (e) { console.warn('[ccswitch] boot:', e) }
    })()

    onEnter(async (event) => {
      const code = event?.code || ''
      if (code === 'mcp') navigate('mcp')
      else if (code === 'sessions') navigate('sessions')
      else if (code === 'settings') navigate('settings')
      else if (code === 'main') navigate('providers')
      if (typeof event?.payload?.providerId === 'string') await handleQuickSwitch(event.payload.providerId)
      if (getLaunchMode() === 'quick') document.body.classList.add('quick-mode')
    })
    // onModeChange 由 themeAware kit 域提供：保底走原生 API
    window.enest?.onModeChange?.((mode) => document.body.classList.toggle('quick-mode', mode === 'quick'))

    applyTokens()
    onThemeChange(() => {
      applyTokens()
      if (state.page === 'usage' && state.usageData) void loadUsagePage()
    })
    window.enest?.onHotkey?.(() => { navigate('providers') })

    async function loadApps() {
      try {
        const list = await agentApps()
        const byId = new Map((list || []).map((a) => [a.app, a]))
        state.apps = APPS.map((meta) => {
          const hit = byId.get(meta.id)
          return { app: meta.id, id: meta.id, name: meta.name, mode: meta.mode, color: meta.color, configPaths: hit?.configPaths || [], installed: Boolean(hit?.installed), active: Boolean(hit?.active) }
        })
      } catch (e) {
        state.apps = APPS.map((a) => ({ app: a.id, id: a.id, name: a.name, mode: a.mode, color: a.color, installed: false, active: false, configPaths: [] }))
        console.warn('[ccswitch] agentApps failed:', e)
      }
      state.installed = new Set(state.apps.filter((a) => a.installed).map((a) => a.app))
      state.active = new Set(state.apps.filter((a) => a.active).map((a) => a.app))
      renderNavApps()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Esc 关抽屉
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.isComposing && drawer.open) { e.preventDefault(); closeDrawer() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer.open]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ============ 渲染（DOM 结构 / 类名与原 index.html 一致） ============ */
  const navItems = NAV_ITEMS
  const kwNow = searchKw

  const renderProviderGrid = () => {
    if (!providerCards) return <div className="empty">加载中…</div>
    if (providerCards.kind === 'guide') {
      return (
        <div className="guide">
          <div className="big">{providerCards.big}</div>
          <div>{providerCards.text}</div>
          <div className="field-hint">{providerCards.hint}</div>
          {providerCards.actions && (
            <div className="guide-actions">
              <button className="pk-btn pk-btn-primary" onClick={openPresetLib}>打开预设库</button>
              <button className="pk-btn pk-btn-ghost" onClick={() => openProviderModal(null)}>新建供应商</button>
            </div>
          )}
        </div>
      )
    }
    if (providerCards.kind === 'empty') return <div className="empty">{providerCards.text}</div>
    return (
      <div className="grid">
        {providerCards.cards.map(({ p, isCurrent, mode }) => (
          <div
            key={p.id}
            className={'card provider-card' + (isCurrent ? ' current' : '')}
            draggable
            data-id={p.id}
            tabIndex={0}
            role="group"
            aria-label={p.name + (isCurrent ? '（当前使用）' : '')}
            data-row-actions
            onContextMenu={(e) => providerCardMenu(e, p, isCurrent, mode)}
            onDragStart={(e) => { e.currentTarget.classList.add('dragging'); e.dataTransfer.setData('text/plain', 'reorder:' + p.id) }}
            onDragEnd={(e) => e.currentTarget.classList.remove('dragging')}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drop-before') }}
            onDragLeave={(e) => e.currentTarget.classList.remove('drop-before')}
            onDrop={async (e) => {
              e.preventDefault()
              e.currentTarget.classList.remove('drop-before')
              const data = e.dataTransfer.getData('text/plain')
              if (data.startsWith('reorder:')) {
                await reorder(data.slice(8), p.id)
                await renderProviders()
              }
            }}
            onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); openProviderModal(p) } }}
          >
            <div className="card-row">
              <span className="drag-handle" title="拖拽排序">⠿</span>
              <span className="name">{p.name}</span>
              {p.isDefault && <span className="tag">默认</span>}
              {p.universal && <span className="tag">通用</span>}
              {isCurrent && <span className="badge">当前使用</span>}
            </div>
            <div className="card-row">
              <span className="k">端点</span>
              <span className="v" title={p.baseUrl || '官方默认'}>{p.baseUrl ? host(p.baseUrl) : '官方默认'}</span>
            </div>
            <div className="card-row">
              <span className="k">模型</span>
              <span className="v" title={p.model || '默认'}>{p.model || '默认'}</span>
            </div>
            {tagsOf(p).length > 0 && (
              <div className="card-row tag-row">
                {tagsOf(p).map((t) => <span className="tag" key={t}>{t}</span>)}
              </div>
            )}
            <div className="card-actions">
              <button
                className={'pk-btn pk-btn-sm' + (isCurrent ? '' : ' pk-btn-primary')}
                disabled={isCurrent}
                onClick={() => switchProvider(p)}
              >{isCurrent ? '使用中' : mode === 'additive' ? '添加' : '启用'}</button>
              <span className="pk-row-actions">
                <MoreMenu buttonClassName="pk-btn-sm" ariaLabel={p.name + ' 的更多操作'} items={providerMenuItems(p, isCurrent, mode)} />
              </span>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const renderHistoryBody = () => {
    if (!historyRows) return <div className="empty">加载中…</div>
    if (historyRows.kind === 'guide') {
      return (
        <div className="guide">
          <div className="big">{historyRows.big}</div>
          <div>{historyRows.text}</div>
          <div className="field-hint">{historyRows.hint}</div>
        </div>
      )
    }
    return (
      <div className="history-list">
        {historyRows.list.map((entry) => {
          const appNames = (entry.apps || (entry.app ? [entry.app] : []))
            .map((a) => APP_MAP[a]?.name || a).join('、')
          return (
            <div className="history-item" key={entry.id}>
              <div className="history-main">
                <div className="row1">
                  <span className="name">{entry.providerName}</span>
                  <span className="tag">{appNames || '—'}</span>
                  {entry.rolledBackFrom && <span className="tag">回退产生</span>}
                  {entry.changed === false && <span className="tag">端点未变</span>}
                </div>
                <div className="meta mono">
                  <span>{(entry.baseUrl ? host(entry.baseUrl) : '官方默认') + ' · ' + (entry.model || '默认模型')}</span>
                  {entry.prevName && <span>{' ← 原为 ' + entry.prevName}</span>}
                </div>
              </div>
              <div className="history-side">
                <span className="when" title={new Date(entry.at).toLocaleString('zh-CN')}>{fmtAgo(entry.at)}</span>
                <button
                  className="pk-btn pk-btn-sm pk-btn-ghost"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: '回退切换',
                      text: `将「${APP_MAP[entry.app]?.name || entry.app}」恢复到「${entry.prevName || '切换前状态'}」（${entry.prevBaseUrl ? host(entry.prevBaseUrl) : '官方默认'}）。`,
                      hint: '回退前插件后端自动快照当前状态，可在「备份」页再恢复。',
                      okText: '回退',
                    })
                    if (!ok) return
                    try {
                      await rollback(entry)
                      state.snapshots.delete(entry.app)
                      showToast('已回退到 ' + (entry.prevName || '切换前状态'), 'success')
                      await Promise.all([loadHistoryPage(), renderProviders()])
                    } catch (e) { showToast('回退失败：' + AErrMsg(e), 'error') }
                  }}
                >回退</button>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const renderMcpBody = () => {
    if (!mcpRows) return <div className="empty">加载中…</div>
    if (mcpRows.kind === 'guide') {
      return (
        <div className="guide">
          <div className="big">{mcpRows.big}</div>
          <div>{mcpRows.text}</div>
          <div className="field-hint">{mcpRows.hint}</div>
        </div>
      )
    }
    return (
      <>
        {mcpRows.entries.map((entry) => (
          <div
            className="card mcp-card"
            data-row-actions
            key={entry.id}
            onContextMenu={(e) => mcpCardMenu(e, entry)}
          >
            <div className="card-row">
              <span className="name">{entry.name || entry.id}</span>
              <span className="tag">{entry.spec?.type || 'stdio'}</span>
              <div className="spacer"></div>
              <span className="pk-row-actions">
                <button className="pk-btn pk-btn-sm pk-btn-ghost" onClick={() => openMcpModal(entry)}>编辑</button>
                <button className="pk-btn pk-btn-sm pk-btn-danger" onClick={() => deleteMcpEntry(entry)}>删除</button>
              </span>
            </div>
            <div className="card-row">
              <span className="k">命令</span>
              <span className="v mono">{entry.spec?.command || entry.spec?.url || '—'}</span>
            </div>
            <div className="field-hint">点击应用名启用/停用并同步到对应配置文件</div>
            <div className="chips">
              {APPS.map((meta) => {
                const on = Boolean(entry.apps?.[meta.id])
                return (
                  <button
                    key={meta.id}
                    className={'chip' + (on ? ' on' : '') + (state.installed.has(meta.id) ? '' : ' off')}
                    title={meta.name}
                    onClick={async (e) => {
                      if (!state.installed.has(meta.id)) { showToast(meta.name + ' 未安装', 'info'); return }
                      const next = !entry.apps?.[meta.id]
                      await toggleMcpApp(entry.id, meta.id, next)
                      await renderMcp()
                      try {
                        await syncToApp(meta.id)
                        showToast(`已${next ? '启用' : '停用'} ${meta.name} 的 ${entry.id}（写入其 MCP 配置）`, 'success')
                      } catch (err) {
                        showToast(meta.name + ' 同步失败：' + AErrMsg(err), 'error')
                      }
                    }}
                  >{meta.name}</button>
                )
              })}
            </div>
          </div>
        ))}
      </>
    )
  }

  const renderTurn = (turn) => {
    const search = sessionSearch.trim().toLowerCase()
    const hit = search ? (turn.text || '').toLowerCase().includes(search) : false
    return (
      <TurnView key={turn.__i} turn={turn} hit={hit} sessionSearch={sessionSearch} />
    )
  }

  const renderSessionsBody = () => {
    if (sessionsView.error) return <div className="error-inline">{sessionsView.error}</div>
    if (sessionsView.loading) return null
    if (sessionsView.mode === 'detail') {
      const { detail } = sessionsView
      return (
        <div className="session-detail">
          {detail.turns.map((turn, i) => renderTurn({ ...turn, __i: i }))}
          {detail.turns.length === 0 && <div className="empty">未解析出对话轮次</div>}
        </div>
      )
    }
    if (!sessionsView.list || !sessionsView.list.length) return <div className="empty">选择左侧应用</div>
    return (
      <div className="session-list">
        {sessionsView.list.map((s) => (
          <div
            className="session-item"
            data-row-actions
            key={s.sessionId + s.file}
            tabIndex={0}
            role="group"
            aria-label={s.title || s.sessionId}
            onClick={() => void openSessionDetail(s)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || e.isComposing || !['Enter', ' '].includes(e.key)) return
              e.preventDefault(); void openSessionDetail(s)
            }}
            onContextMenu={(e) => sessionRowMenu(e, s)}
          >
            <div className="row1">
              <span className="title">{s.title || s.sessionId}</span>
              <span className="pk-row-actions">
                <button
                  className="pk-btn pk-btn-sm pk-btn-ghost"
                  onClick={async (e) => {
                    e.stopPropagation()
                    await copyResume(s)
                  }}
                >复制 resume</button>
              </span>
            </div>
            <div className="meta">
              <span>{s.project ? s.project.split('/').pop() : ''}</span>
              <span>{fmtDate(s.lastActiveAt)}</span>
              <span>{s.messageCount + ' 条消息'}</span>
              <span>{fmtBytes(s.bytes)}</span>
            </div>
          </div>
        ))}
      </div>
    )
  }

  async function copyResume(s) {
    try {
      await copyText(resumeCommand(state.currentApp, s.sessionId))
      showToast('已复制：' + resumeCommand(state.currentApp, s.sessionId), 'success')
    } catch (err) { showToast(AErrMsg(err), 'error') }
  }

  /** 会话行右键：打开 / 复制 resume */
  function sessionRowMenu(event, s) {
    event.preventDefault()
    window.PluginKit.openMenu(
      event,
      [
        ['open', '打开会话'],
        ['copy', '复制 resume 命令'],
      ],
      (key) => {
        if (key === 'open') void openSessionDetail(s)
        if (key === 'copy') void copyResume(s)
      },
      { align: 'end' },
    )
  }

  const renderUsageBody = () => {
    if (usageView.error) return <div className="error-inline">{usageView.error}</div>
    if (usageView.loading) return null
    if (!usageView.data) return <div className="empty">选择左侧应用</div>
    const data = usageView.data
    const maxM = Math.max(1, ...data.models.map((m) => m.tokens))
    return (
      <>
        <div className="usage-cards">
          {[['总 Token', fmtTokens(data.totals.input + data.totals.output + data.totals.cacheRead)], ['输入', fmtTokens(data.totals.input)], ['输出', fmtTokens(data.totals.output)], ['缓存读', fmtTokens(data.totals.cacheRead)], ['请求数', fmtTokens(data.totals.requests)]].map(([lbl, num]) => (
            <div className="usage-card" key={lbl}>
              <div className="num">{num}</div>
              <div className="lbl">{lbl}</div>
            </div>
          ))}
        </div>
        <div className="chart-box">
          <h3>按日趋势（近 30 天）</h3>
          <canvas id="chart-daily"></canvas>
        </div>
        <div className="chart-box">
          <h3>年度热力图</h3>
          <canvas id="chart-heat"></canvas>
        </div>
        <div className="chart-box">
          <h3>模型分布</h3>
          <div className="model-bars">
            {data.models.slice(0, 12).map((m) => (
              <div className="model-bar" key={m.model}>
                <span className="mono" title={m.model}>{m.model}</span>
                <progress className="bar" max={maxM} value={m.tokens} aria-label={m.model}></progress>
                <span className="n">{fmtTokens(m.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      </>
    )
  }

  async function restoreBackup(b) {
    const ok = await confirmDialog({ title: '恢复快照', text: '恢复到此快照？', hint: '恢复前会再自动备份当前状态。', okText: '恢复' })
    if (!ok) return
    try {
      await agentRestore(state.currentApp, b.id)
      state.snapshots.delete(state.currentApp)
      showToast('已恢复', 'success')
      await Promise.all([loadBackups(), renderProviders()])
    } catch (e) { showToast('恢复失败：' + AErrMsg(e), 'error') }
  }

  async function copyBackupId(b) {
    try { await copyText(b.id); showToast('已复制快照 ID', 'success') } catch (e) { showToast(AErrMsg(e), 'error') }
  }

  /** 快照行右键：恢复 / 复制快照 ID */
  function backupRowMenu(event, b) {
    event.preventDefault()
    window.PluginKit.openMenu(
      event,
      [
        ['restore', '恢复到此快照'],
        ['copy', '复制快照 ID'],
      ],
      async (key) => {
        if (key === 'restore') void restoreBackup(b)
        if (key === 'copy') void copyBackupId(b)
      },
      { align: 'end' },
    )
  }

  const renderBackupsBody = () => {
    if (!backupsView.rows) return null
    if (backupsView.rows.error) return <div className="error-inline">{backupsView.rows.error}</div>
    if (backupsView.rows.length === 0) return <div className="empty">暂无快照（每次切换/写入前自动创建，保留最近 20 份）</div>
    return (
      <>
        {backupsView.rows.map((b) => (
          <div className="backup-item" data-row-actions key={b.id} onContextMenu={(e) => backupRowMenu(e, b)}>
            <span className="when">{`${new Date(b.createdAt || Date.parse(b.id.replace(/\./g, ':')) || Date.now()).toLocaleString('zh-CN')} · ${b.files.length} 个文件`}</span>
            <span className="pk-row-actions">
              <button className="pk-btn pk-btn-sm" onClick={() => void restoreBackup(b)}>恢复</button>
              <MoreMenu buttonClassName="pk-btn-sm" ariaLabel="快照更多操作" items={[
                { key: 'restore', label: '恢复到此快照', onSelect: () => restoreBackup(b) },
                { key: 'copy', label: '复制快照 ID', onSelect: () => copyBackupId(b) },
              ]} />
            </span>
          </div>
        ))}
      </>
    )
  }

  async function applyProject(proj) {
    try {
      if (proj.provider) {
        await applyProvider(state.currentApp, proj.provider)
        state.snapshots.delete(state.currentApp)
      }
      if (Array.isArray(proj.mcpIds)) {
        const entries = await loadMcp()
        for (const id of proj.mcpIds) {
          const hit = entries.find((e) => e.id === id)
          if (hit) {
            hit.apps = hit.apps || {}
            hit.apps[state.currentApp] = true
            await upsertMcp(hit)
          }
        }
        await syncToApp(state.currentApp)
      }
      showToast(`已应用项目预设「${proj.name}」`, 'success')
    } catch (e) { showToast('应用失败：' + AErrMsg(e), 'error') }
  }

  async function deleteProject(proj) {
    const ok = await confirmDialog({ title: '删除项目预设', text: `删除项目预设「${proj.name}」？`, okText: '删除', danger: true })
    if (!ok) return
    await storageSet(PROJECTS_KEY, projectsRows.projects.filter((x) => x.id !== proj.id))
    await renderProjects()
  }

  /** 项目预设行右键：应用 / 删除（danger） */
  function projectRowMenu(event, proj) {
    event.preventDefault()
    window.PluginKit.openMenu(
      event,
      [
        ['apply', '应用此预设'],
        'sep',
        ['delete', '删除', { danger: true }],
      ],
      (key) => {
        if (key === 'apply') void applyProject(proj)
        if (key === 'delete') void deleteProject(proj)
      },
      { align: 'end' },
    )
  }

  const renderProjectsBody = () => {
    if (!projectsRows) return <div className="empty">加载中…</div>
    if (projectsRows.kind === 'guide') {
      return (
        <div className="guide">
          <div className="big">{projectsRows.big}</div>
          <div>{projectsRows.text}</div>
          <div className="field-hint">{projectsRows.hint}</div>
        </div>
      )
    }
    return (
      <>
        {projectsRows.projects.map((proj) => (
          <div className="project-item" data-row-actions key={proj.id} onContextMenu={(e) => projectRowMenu(e, proj)}>
            <span className="name">{`${proj.name} · ${proj.providerName || '无供应商'} · MCP×${(proj.mcpIds || []).length}`}</span>
            <button
              className="pk-btn pk-btn-sm pk-btn-primary"
              onClick={() => void applyProject(proj)}
            >应用</button>
            <span className="pk-row-actions">
              <button
                className="pk-btn pk-btn-sm pk-btn-danger"
                onClick={() => void deleteProject(proj)}
              >删除</button>
            </span>
          </div>
        ))}
      </>
    )
  }

  return (
    <div className="app" id="app">
      {/* 三区之一：左导航 */}
      <aside className={'nav' + (navCollapsed ? ' collapsed' : '')} id="nav" ref={navRef}>
        <div className="nav-head">
          <div className="nav-logo">⇄</div>
          <div className="nav-title">供应商切换</div>
        </div>
        <div className="nav-scroll">
          <div className="nav-group" id="nav-apps" data-label="应用">
            {!appsReady && <div className="nav-loading">加载中…</div>}
            {navApps.map((meta) => (
              <button
                key={meta.id}
                className={'nav-item app-item' + (meta.current ? ' active' : '') + (meta.installed ? '' : ' disabled')}
                data-app={meta.id}
                title={meta.name + (meta.installed ? '' : '（未安装/未初始化）')}
                onClick={() => onNavApp(meta)}
              >
                <span className={'dot' + (meta.active ? '' : ' off')}></span>
                <span className="t">{meta.name}</span>
              </button>
            ))}
          </div>
          <div className="nav-group" data-label="功能">
            {navItems.map(([pg, glyph, label]) => (
              <button key={pg} className={'nav-item' + (page === pg ? ' active' : '')} data-page={pg} onClick={() => navigate(pg)}>
                <span className="glyph">{glyph}</span><span className="t">{label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="nav-foot">
          <button className="nav-item" id="nav-collapse" ref={navCollapseRef}
            title={navCollapsed ? '展开导航（悬停查看快捷入口）' : '收起导航'}
            aria-label={navCollapsed ? '展开导航' : '收起导航'} aria-controls="nav" aria-expanded={!navCollapsed}
            onClick={() => setNavCollapsed((value) => !value)}>
            <span className="glyph">{navCollapsed ? '»' : '«'}</span><span className="t">收起</span>
          </button>
        </div>
      </aside>

      {/* 三区之二：内容区 */}
      <main className="main">
        {/* 供应商页 */}
        <section className="page" id="page-providers" hidden={page !== 'providers'}>
          <header className="page-head">
            <div className="page-titles">
              <div className="page-title" id="providers-title">{providersTitle}</div>
              <div className="page-sub" id="providers-sub">{providersSub}</div>
            </div>
            <div className="spacer"></div>
            <MoreMenu
              ariaLabel="供应商页更多操作"
              items={[
                { key: 'presets', label: '打开预设库', onSelect: openPresetLib },
                { key: 'import', label: '导入供应商', onSelect: importProvidersModal },
                { key: 'export', label: '导出供应商', onSelect: exportProviders },
              ]}
            />
            <button className="pk-btn pk-btn-primary" id="btn-new-provider" onClick={() => openProviderModal(null)}>＋ 新建</button>
          </header>
          <div className="summary-strip" id="summary-strip" hidden={!summaryItems}>
            {(summaryItems || []).map((it) => (
              <div key={it.label} className={'summary-item' + (it.accent ? ' accent' : '') + (it.tone ? ' tone-' + it.tone : '')}>
                <div className="summary-value mono">{it.value}</div>
                <div className="summary-label">{it.label}</div>
              </div>
            ))}
          </div>
          <div className="toolbar">
            <input id="provider-search" type="search" placeholder="搜索名称 / 端点 / 模型" aria-label="搜索供应商" value={kwNow} onInput={onProviderSearch} />
            <div className="chips" id="provider-tags" aria-label="按标签过滤">
              {tagChips.map((c) => (
                <button key={c.label} className={'chip' + (c.on ? ' active' : '')} type="button"
                  onClick={() => {
                    tagFilters.set(state.currentApp, c.tag ? (c.on ? '' : c.tag) : '')
                    void renderProviders()
                  }}>{c.label}</button>
              ))}
            </div>
          </div>
          <div className="content" id="providers-body">{renderProviderGrid()}</div>
        </section>

        {/* 切换历史页 */}
        <section className="page" id="page-history" hidden={page !== 'history'}>
          <header className="page-head">
            <div className="page-titles">
              <div className="page-title">切换历史</div>
              <div className="page-sub" id="history-sub">{historySub}</div>
            </div>
            <div className="spacer"></div>
            <button className="pk-btn pk-btn-ghost" id="btn-history-refresh" onClick={() => void loadHistoryPage()}>↻ 刷新</button>
            <MoreMenu
              ariaLabel="历史页更多操作"
              items={[
                {
                  key: 'clear',
                  label: '清空切换历史',
                  danger: true,
                  onSelect: async () => {
                    const ok = await confirmDialog({
                      title: '清空切换历史',
                      text: '清空全部切换记录？回退入口将一并消失。',
                      hint: '不影响当前各应用的生效配置。',
                      okText: '清空',
                      danger: true,
                    })
                    if (!ok) return
                    await clearHistory()
                    showToast('已清空切换历史', 'success')
                    await loadHistoryPage()
                  },
                },
              ]}
            />
          </header>
          <div className="content" id="history-body">{renderHistoryBody()}</div>
        </section>

        {/* MCP 页 */}
        <section className="page" id="page-mcp" hidden={page !== 'mcp'}>
          <header className="page-head">
            <div className="page-titles">
              <div className="page-title">MCP 服务器</div>
              <div className="page-sub">统一定义，按应用投射</div>
            </div>
            <div className="spacer"></div>
            <MoreMenu
              ariaLabel="MCP 页更多操作"
              items={[
                {
                  key: 'import-app',
                  label: '导入现有',
                  onSelect: async () => {
                    try {
                      const r = await importFromApp(state.currentApp)
                      showToast(`从 ${APP_MAP[state.currentApp]?.name} 导入 ${r.added} 个 MCP（共发现 ${r.total}）`, 'success')
                      await renderMcp()
                    } catch (e) { showToast('导入失败：' + AErrMsg(e), 'error') }
                  },
                },
                { key: 'template', label: '从模板添加', onSelect: () => setModalMcpTpl(true) },
              ]}
            />
            <button className="pk-btn pk-btn-primary" id="btn-mcp-new" onClick={() => openMcpModal(null)}>＋ 新建</button>
          </header>
          <div className="content" id="mcp-body">{renderMcpBody()}</div>
        </section>

        {/* 会话页 */}
        <section className="page" id="page-sessions" hidden={page !== 'sessions'}>
          <header className="page-head">
            <button className="pk-btn pk-btn-ghost" id="btn-session-back"
              hidden={sessionsView.mode !== 'detail'}
              onClick={() => { state.sessionDetail = null; setSessionsView((v) => ({ ...v, mode: 'list' })); renderSessionList() }}
            >← 返回</button>
            <div className="page-titles">
              <div className="page-title" id="sessions-title">会话</div>
              <div className="page-sub" id="sessions-sub">{sessionsView.sub}</div>
            </div>
            <div className="spacer"></div>
            <input id="session-search" type="search" placeholder="搜索会话" aria-label="搜索会话"
              value={sessionSearch}
              onInput={(e) => {
                state._sessionKw = e.target.value
                setSessionSearch(e.target.value)
                if (!state.sessionDetail && state.sessionsCache) renderSessionList()
              }}
            />
            {sessionsView.mode === 'detail' && (
              <MoreMenu
                ariaLabel="会话页更多操作"
                items={[{ key: 'export', label: '导出 Markdown', onSelect: exportSessionMd }]}
              />
            )}
          </header>
          <div className="content" id="sessions-body">{renderSessionsBody()}</div>
        </section>

        {/* 用量页 */}
        <section className="page" id="page-usage" hidden={page !== 'usage'}>
          <header className="page-head">
            <div className="page-titles">
              <div className="page-title">用量统计</div>
              <div className="page-sub" id="usage-sub">{usageView.sub}</div>
            </div>
            <div className="spacer"></div>
            <div className="chips" id="usage-range"></div>
          </header>
          <div className="content usage" id="usage-body">{renderUsageBody()}</div>
        </section>

        {/* 备份页 */}
        <section className="page" id="page-backups" hidden={page !== 'backups'}>
          <header className="page-head">
            <div className="page-titles">
              <div className="page-title">配置快照</div>
              <div className="page-sub" id="backups-sub">{backupsView.sub}</div>
            </div>
            <div className="spacer"></div>
            <button className="pk-btn pk-btn-ghost" id="btn-backups-refresh" onClick={() => void loadBackups()}>↻ 刷新</button>
            <MoreMenu
              ariaLabel="备份页更多操作"
              items={[
                { key: 'export-all', label: '导出全量 JSON', onSelect: exportSnapshot },
                { key: 'import-all', label: '从 JSON 恢复', onSelect: importSnapshotModal },
              ]}
            />
          </header>
          <div className="content" id="backups-body">{renderBackupsBody()}</div>
        </section>

        {/* 项目预设页 */}
        <section className="page" id="page-projects" hidden={page !== 'projects'}>
          <header className="page-head">
            <div className="page-titles">
              <div className="page-title">项目预设</div>
              <div className="page-sub">供应商 + MCP 整套保存 / 应用</div>
            </div>
            <div className="spacer"></div>
            <button className="pk-btn pk-btn-primary" id="btn-project-save" onClick={saveCurrentProject}>＋ 保存当前为项目</button>
          </header>
          <div className="content" id="projects-body">{renderProjectsBody()}</div>
        </section>

        {/* 设置页 */}
        <section className="page" id="page-settings" hidden={page !== 'settings'}>
          <header className="page-head">
            <div className="page-titles">
              <div className="page-title">设置</div>
            </div>
          </header>
          <div className="content settings" id="settings-body">
            {!settingsView ? <div className="settings-loading">加载中…</div> : (
              <>
                <div className="field-row">
                  <div className="lbl">默认应用<div className="desc">Quick 切换与启动时的默认应用</div></div>
                  <select
                    className="settings-select"
                    value={settingsView.defaultApp}
                    onChange={async (e) => { await settingsSet('defaultApp', e.target.value); setSettingsView((s) => ({ ...s, defaultApp: e.target.value })) }}
                  >
                    {['claude-code', 'codex', 'gemini-cli'].map((o) => (
                      <option key={o} value={o}>{APP_MAP[o]?.name || o}</option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div className="lbl">切换前 diff 确认<div className="desc">关闭后一键直接切换（仍自动快照）</div></div>
                  <input
                    type="checkbox"
                    checked={settingsView.diffConfirm}
                    onChange={async (e) => { await settingsSet('diffConfirm', e.target.checked); setSettingsView((s) => ({ ...s, diffConfirm: e.target.checked })) }}
                  />
                </div>
                <div className="field-row">
                  <div className="lbl">备份保留策略</div>
                  <span className="field-hint">插件后端自动快照 · 每应用保留最近 20 份</span>
                </div>
                <div className="field-row">
                  <div className="lbl">切换历史</div>
                  <span className="field-hint">环形保留最近 50 条，可在「切换历史」页回退或清空</span>
                </div>
                <div className="field-row">
                  <div className="lbl">数据来源</div>
                  <span className="field-hint">功能语义与预设数据复刻自 cc-switch（Apache-2.0）</span>
                </div>
              </>
            )}
          </div>
        </section>
      </main>

      {/* 三区之三：详情编辑抽屉 */}
      <aside className={'drawer' + (drawer.open ? '' : '')} id="drawer-provider" hidden={!drawer.open} aria-hidden={!drawer.open} ref={drawerRef}>
        <div className="drawer-scrim" data-drawer-close onClick={closeDrawer}></div>
        <div className="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="provider-modal-title">
          <header className="drawer-head">
            <div>
              <div className="drawer-title" id="provider-modal-title">{drawer.title}</div>
              <div className="drawer-sub">保存后写入插件存储，切换时才落到应用配置</div>
            </div>
            <button className="icon-btn" data-drawer-close title="关闭（Esc）" onClick={closeDrawer}>×</button>
          </header>
          <div className="drawer-body">
            <div className="form-tabs" id="provider-form-tabs" role="tablist">
              <button className={pfTab === 'form' ? 'active' : ''} data-tab="form" role="tab" onClick={() => setPfTab('form')}>表单</button>
              <button className={pfTab === 'json' ? 'active' : ''} data-tab="json" role="tab" onClick={() => setPfTab('json')}>JSON 源码</button>
            </div>
            <div className="form-pane" id="provider-form-pane" hidden={pfTab !== 'form'}>
              <div className="preset-quick" id="pf-preset-quick">
                <span className="preset-quick-label">从模板开始</span>
                <div className="chips" id="pf-preset-chips">
                  {pf.presetChips.map((c) => (
                    <button key={c.name} className="chip" type="button" title={c.title} onClick={c.apply}>{c.name}</button>
                  ))}
                </div>
              </div>
              <label className="field"><span>名称</span><input id="pf-name" type="text" placeholder="如 DeepSeek" value={pf.name} onInput={(e) => setPf((f) => ({ ...f, name: e.target.value }))} /></label>
              <label className="field"><span>分组标签（逗号分隔）</span><input id="pf-tags" type="text" placeholder="如 官方, 常用" value={pf.tags} onInput={(e) => setPf((f) => ({ ...f, tags: e.target.value }))} /></label>
              <label className="field"><span>Base URL</span><input id="pf-baseurl" type="text" className="mono" placeholder="https://api.example.com" value={pf.baseurl} onInput={(e) => setPf((f) => ({ ...f, baseurl: e.target.value }))} /></label>
              <label className="field"><span>API Key</span>
                <div className="key-row">
                  <input id="pf-apikey" type={pf.keyType} className="mono" placeholder="sk-…（存入保险库，不落配置导出）" value={pf.apikey} onInput={(e) => setPf((f) => ({ ...f, apikey: e.target.value }))} />
                  <button className="pk-btn pk-btn-sm pk-btn-ghost" id="pf-key-view" type="button" onClick={() => setPf((f) => ({ ...f, keyType: f.keyType === 'password' ? 'text' : 'password' }))}>显示</button>
                </div>
                <div className="field-hint" id="pf-key-hint">{pf.keyHint}</div>
              </label>
              <label className="field"><span>模型</span><input id="pf-model" type="text" className="mono" placeholder="如 deepseek-chat / gpt-5" value={pf.model} onInput={(e) => setPf((f) => ({ ...f, model: e.target.value }))} /></label>
              <div className="field"><span>目标应用</span><div className="chips" id="pf-apps">
                {APPS.map((meta) => (
                  <button
                    key={meta.id}
                    className={'chip' + (pf.appsSel.has(meta.id) ? ' on' : '')}
                    type="button"
                    data-app={meta.id}
                    onClick={() => setPf((f) => {
                      const next = new Set(f.appsSel)
                      next.has(meta.id) ? next.delete(meta.id) : next.add(meta.id)
                      return { ...f, appsSel: next }
                    })}
                  >{meta.name}</button>
                ))}
              </div></div>
              <div className="field-actions">
                <button className="pk-btn pk-btn-sm pk-btn-ghost" id="btn-provider-test" type="button" onClick={testFromDrawer}>测速</button>
                <span className="field-hint" id="pf-test-result" aria-live="polite">{pf.testResult}</span>
              </div>
              <details className="advanced">
                <summary>高级（env / toml 片段）</summary>
                <div id="pf-advanced">
                  <div className="field"><span>额外 env（JSON）</span>
                    <textarea className="mono" placeholder='额外 env（JSON 对象，如 {"API_TIMEOUT_MS":"30000"}）' value={pf.env} onInput={(e) => setPf((f) => ({ ...f, env: e.target.value }))}></textarea>
                  </div>
                  <div className="field"><span>TOML 顶层键片段（JSON 表示）</span>
                    <textarea className="mono" placeholder='TOML 顶层键片段（JSON 表示，仅 toml 应用，如 {"model_reasoning_effort":"high"}）' value={pf.toml} onInput={(e) => setPf((f) => ({ ...f, toml: e.target.value }))}></textarea>
                  </div>
                  <label className="field-row field-row-inline">
                    <input type="checkbox" checked={pf.universal} onChange={(e) => setPf((f) => ({ ...f, universal: e.target.checked }))} />
                    <span>通用供应商：保存后绑定所选应用，切换时同步写入</span>
                  </label>
                </div>
              </details>
            </div>
            <div className="form-pane" id="provider-json-pane" hidden={pfTab !== 'json'}>
              <textarea id="pf-json" className="mono" rows="14" spellCheck="false" placeholder='{"name":"…","settingsConfig":{…}}' value={pf.json} onInput={(e) => setPf((f) => ({ ...f, json: e.target.value }))}></textarea>
              <div className="field-hint">直接编辑 JSON 源；保存时与表单字段合并校验</div>
            </div>
          </div>
          <footer className="drawer-foot">
            <div className="field-hint" id="pf-form-hint">{pf.formHint}</div>
            <div className="spacer"></div>
            <button className="pk-btn pk-btn-ghost" data-drawer-close onClick={closeDrawer}>取消</button>
            <button className="pk-btn pk-btn-primary" id="btn-provider-save" onClick={saveProviderModal}>保存</button>
          </footer>
        </div>
      </aside>

      {/* 弹层：预设库 */}
      <div className="modal" id="modal-presets" hidden={!modalPresets.open} onClick={(e) => { if (e.target === e.currentTarget) setModalPresets((m) => ({ ...m, open: false })) }}>
        <div className="modal-card wide">
          <div className="modal-head">
            <div className="modal-title">预设库</div>
            <input id="preset-search" type="search" placeholder="搜索预设（官方 / DeepSeek / GLM / 中转 …）"
              value={presetSearch}
              onInput={(e) => { setPresetSearch(e.target.value); renderPresetGrid(e.target.value) }}
            />
            <button className="icon-btn modal-close" data-close="modal-presets" onClick={() => setModalPresets((m) => ({ ...m, open: false }))}>×</button>
          </div>
          <div className="modal-body">
            <div className="chips preset-tag-filter" id="preset-tag-filter">
              {presetTagFilter.map((t) => (
                <button
                  key={t}
                  className={'chip' + (state.presetTag === t ? ' active' : '')}
                  onClick={() => {
                    state.presetTag = state.presetTag === t ? '' : t
                    setModalPresets((m) => ({ ...m }))
                    renderPresetGrid(presetSearch)
                  }}
                >{t}</button>
              ))}
            </div>
            <div className="preset-grid" id="preset-grid">
              {modalPresets.grid.length === 0 ? <div className="empty">没有匹配的预设</div> : modalPresets.grid.map(({ preset }) => (
                <div className="preset-card" key={preset.id}>
                  <div className="card-row">
                    <span className="name">{preset.name}</span>
                    <span className="tag">{preset.tag}</span>
                  </div>
                  <div className="url mono">{preset.baseUrl ? host(preset.baseUrl) : '官方默认端点'}</div>
                  <div className="url mono">{preset.model || ''}</div>
                  <div className="card-actions">
                    <button className="pk-btn pk-btn-sm pk-btn-primary" onClick={() => void onPresetInstantiate(preset)}>实例化</button>
                    <button className="pk-btn pk-btn-sm pk-btn-ghost" onClick={() => { setModalPresets((m) => ({ ...m, open: false })); openProviderModal(null, instantiate(preset)) }}>编辑后添加</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="modal-foot">
            <div className="field-hint" id="preset-source">{modalPresets.source || '预设数据移植自 cc-switch（Apache-2.0）社区清单，支持后续远程更新'}</div>
            <div className="spacer"></div>
            <button className="pk-btn pk-btn-ghost" data-close="modal-presets" onClick={() => setModalPresets((m) => ({ ...m, open: false }))}>关闭</button>
          </div>
        </div>
      </div>

      {/* 弹层：MCP 编辑 */}
      <div className="modal" id="modal-mcp" hidden={!modalMcp.open} onClick={(e) => { if (e.target === e.currentTarget) setModalMcp((m) => ({ ...m, open: false })) }}>
        <div className="modal-card">
          <div className="modal-head">
            <div className="modal-title" id="mcp-modal-title">{modalMcp.title}</div>
            <button className="icon-btn modal-close" data-close="modal-mcp" onClick={() => setModalMcp((m) => ({ ...m, open: false }))}>×</button>
          </div>
          <div className="modal-body">
            <label className="field"><span>名称 / ID</span><input id="mf-name" type="text" placeholder="如 github" value={modalMcp.id || ''} onInput={(e) => setModalMcp((m) => ({ ...m, id: e.target.value }))} /></label>
            <div className="field"><span>启用应用</span><div className="chips" id="mf-apps">
              {APPS.map((meta) => (
                <button
                  key={meta.id}
                  className={'chip' + (modalMcp.appsSel.has(meta.id) ? ' on' : '')}
                  type="button"
                  data-app={meta.id}
                  onClick={() => setModalMcp((m) => {
                    const next = new Set(m.appsSel)
                    next.has(meta.id) ? next.delete(meta.id) : next.add(meta.id)
                    return { ...m, appsSel: next }
                  })}
                >{meta.name}</button>
              ))}
            </div></div>
            <div className="form-tabs" id="mcp-form-tabs">
              <button className={modalMcp.tab === 'form' ? 'active' : ''} data-tab="form" onClick={() => setModalMcp((m) => ({ ...m, tab: 'form' }))}>表单</button>
              <button className={modalMcp.tab === 'json' ? 'active' : ''} data-tab="json" onClick={() => setModalMcp((m) => ({ ...m, tab: 'json' }))}>JSON</button>
            </div>
            <div className="form-pane" id="mcp-form-pane" hidden={modalMcp.tab !== 'form'}>
              <div className="seg" id="mf-type">
                {['stdio', 'http'].map((v) => (
                  <button key={v} className={modalMcp.type === v ? 'active' : ''} data-v={v}
                    onClick={() => setModalMcp((m) => ({ ...m, type: v }))}>{v}</button>
                ))}
              </div>
              <label className="field stdio-only" hidden={modalMcp.type !== 'stdio'}><span>command</span><input id="mf-command" type="text" className="mono" placeholder="npx / uvx / node" value={modalMcp.command || ''} onInput={(e) => setModalMcp((m) => ({ ...m, command: e.target.value }))} /></label>
              <label className="field stdio-only" hidden={modalMcp.type !== 'stdio'}><span>args</span><input id="mf-args" type="text" className="mono" placeholder="-y @example/mcp-server" value={modalMcp.args || ''} onInput={(e) => setModalMcp((m) => ({ ...m, args: e.target.value }))} /></label>
              <label className="field http-only" hidden={modalMcp.type !== 'http'}><span>url</span><input id="mf-url" type="text" className="mono" placeholder="https://mcp.example.com/mcp" value={modalMcp.url || ''} onInput={(e) => setModalMcp((m) => ({ ...m, url: e.target.value }))} /></label>
              <label className="field http-only" hidden={modalMcp.type !== 'http'}><span>headers（JSON）</span><input id="mf-headers" type="text" className="mono" placeholder='{"Authorization":"Bearer …"}' value={modalMcp.headers || ''} onInput={(e) => setModalMcp((m) => ({ ...m, headers: e.target.value }))} /></label>
              <label className="field stdio-only" hidden={modalMcp.type !== 'stdio'}><span>env（JSON）</span><input id="mf-env" type="text" className="mono" placeholder='{"TOKEN":"…"}' value={modalMcp.env || ''} onInput={(e) => setModalMcp((m) => ({ ...m, env: e.target.value }))} /></label>
            </div>
            <div className="form-pane" id="mcp-json-pane" hidden={modalMcp.tab !== 'json'}>
              <textarea id="mf-json" className="mono" rows="10" spellCheck="false" placeholder='{"command":"npx","args":["-y","…"]}' value={modalMcp.json || ''} onInput={(e) => setModalMcp((m) => ({ ...m, json: e.target.value }))}></textarea>
            </div>
          </div>
          <div className="modal-foot">
            <div className="spacer"></div>
            <button className="pk-btn pk-btn-ghost" data-close="modal-mcp" onClick={() => setModalMcp((m) => ({ ...m, open: false }))}>取消</button>
            <button className="pk-btn pk-btn-primary" id="btn-mcp-save" onClick={saveMcpModal}>保存并同步</button>
          </div>
        </div>
      </div>

      {/* 弹层：切换 diff 确认 */}
      <div className="modal" id="modal-diff" hidden={!modalDiff.open} onClick={(e) => { if (e.target === e.currentTarget) setModalDiff((m) => ({ ...m, open: false })) }}>
        <div className="modal-card">
          <div className="modal-head">
            <div className="modal-title">切换确认</div>
            <button className="icon-btn modal-close" data-close="modal-diff" onClick={() => setModalDiff((m) => ({ ...m, open: false }))}>×</button>
          </div>
          <div className="modal-body">
            <div className="diff-app" id="diff-app">{modalDiff.app}</div>
            <div className="diff-table" id="diff-table">
              <div className="diff-head"><span>字段</span><span>当前</span><span>切换后</span></div>
              {modalDiff.rows.map((row, i) => (
                <div className={'diff-row' + (row.changed ? ' changed' : '')} key={i}>
                  <span className="k" title={row.k}>{row.k}</span>
                  <span className="before" title={row.before}>{row.before}</span>
                  <span className="after" title={row.after}>{row.after}</span>
                </div>
              ))}
              {modalDiff.multi > 1 && <div className="field-hint">{`通用供应商：将同步写入 ${modalDiff.multi} 个应用`}</div>}
            </div>
            <div className="field-hint">写入前插件后端自动快照当前配置（可在「备份」页恢复），本次切换会记入「切换历史」</div>
          </div>
          <div className="modal-foot">
            <div className="spacer"></div>
            <button className="pk-btn pk-btn-ghost" data-close="modal-diff" onClick={() => setModalDiff((m) => ({ ...m, open: false }))}>取消</button>
            <button className="pk-btn pk-btn-primary" id="btn-diff-confirm" onClick={() => applyDiffs(state.diffPending || [], state._diffBefore)}>确认切换</button>
          </div>
        </div>
      </div>

      {/* 弹层：MCP 模板 */}
      <div className="modal" id="modal-mcp-templates" hidden={!modalMcpTpl} onClick={(e) => { if (e.target === e.currentTarget) setModalMcpTpl(false) }}>
        <div className="modal-card">
          <div className="modal-head">
            <div className="modal-title">MCP 模板</div>
            <button className="icon-btn modal-close" data-close="modal-mcp-templates" onClick={() => setModalMcpTpl(false)}>×</button>
          </div>
          <div className="modal-body">
            <div className="tpl-grid" id="tpl-grid">
              {MCP_TEMPLATES.map((tpl) => (
                <div className="preset-card" key={tpl.id}>
                  <div className="card-row"><span className="name">{tpl.name}</span><span className="tag">{tpl.spec.type}</span></div>
                  <div className="url mono">{tpl.spec.command ? tpl.spec.command + ' ' + (tpl.spec.args || []).join(' ') : tpl.spec.url}</div>
                  {tpl.envHint && <div className="field-hint">需要环境变量：{tpl.envHint}</div>}
                  <button className="pk-btn pk-btn-sm pk-btn-primary" onClick={() => { setModalMcpTpl(false); openMcpModal(null, tpl) }}>添加</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 通用确认弹层 */}
      <div className="modal" id="modal-confirm" hidden={!modalConfirm} onClick={(e) => { if (e.target === e.currentTarget) settleConfirm(false) }}>
        <div className="modal-card sm">
          <div className="modal-head">
            <div className="modal-title" id="confirm-title">{modalConfirm?.title || '确认'}</div>
            <button className="icon-btn modal-close" data-close="modal-confirm" onClick={() => settleConfirm(false)}>×</button>
          </div>
          <div className="modal-body">
            <div id="confirm-text">{modalConfirm?.text}</div>
            <div className="field-hint" id="confirm-hint">{modalConfirm?.hint}</div>
          </div>
          <div className="modal-foot">
            <div className="spacer"></div>
            <button className="pk-btn pk-btn-ghost" data-close="modal-confirm" onClick={() => settleConfirm(false)}>取消</button>
            <button
              className={'pk-btn ' + (modalConfirm?.danger ? 'pk-btn-danger' : 'pk-btn-primary')}
              id="btn-confirm-ok"
              hidden={!modalConfirm?.okText}
              onClick={() => settleConfirm(true)}
            >{modalConfirm?.okText || '确认'}</button>
          </div>
        </div>
      </div>

      {/* 动态导入弹层（导入供应商 / 从 JSON 恢复） */}
      {promptModal && (
        <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) setPromptModal(null) }}>
          <div className="modal-card">
            <div className="modal-head"><div className="modal-title">{promptModal.title}</div></div>
            <div className="modal-body">
              <textarea className="mono" rows="12" placeholder={promptModal.placeholder}
                value={promptModal.value}
                onInput={(e) => setPromptModal((m) => ({ ...m, value: e.target.value }))}
              ></textarea>
              {promptModal.mergeCheck && (
                <label className="field-row field-row-inline field-row-spaced">
                  <input type="checkbox" checked={promptModal.merge} onChange={(e) => setPromptModal((m) => ({ ...m, merge: e.target.checked }))} />
                  <span>合并导入（保留现有数据，按名称/ID 去重）；不勾选则覆盖</span>
                </label>
              )}
              {promptModal.mergeCheck && <div className="field-hint">快照不含密钥明文；secretRef 引用原样保留，跨环境使用需重新录入密钥</div>}
            </div>
            <div className="modal-foot">
              <div className="spacer"></div>
              <button className="pk-btn pk-btn-ghost" onClick={() => setPromptModal(null)}>取消</button>
              <button className="pk-btn pk-btn-primary" onClick={() => promptModal.onSubmit(promptModal.value, () => setPromptModal(null), promptModal.merge)}>{promptModal.okText}</button>
            </div>
          </div>
        </div>
      )}

      {/* toast 容器 */}
      <div className="toasts" id="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + (t.type || '')}>
            <span>{t.msg}</span>
            {t.type === 'undoable' && (
              <button className="pk-btn pk-btn-sm pk-btn-primary undo-btn" onClick={() => undoDelete(t)}>撤销</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 会话轮次视图（折叠 / 展开 / 命中高亮，等价原 renderTurn 的 DOM 类切换） */
function TurnView({ turn, hit, sessionSearch }) {
  const [collapsed, setCollapsed] = useState(!hit)
  const [expanded, setExpanded] = useState(hit)
  const search = sessionSearch.trim().toLowerCase()
  const text = turn.text || ''
  return (
    <div className={'turn' + (collapsed ? ' collapsed' : '') + (hit ? ' hit expanded' : '')} data-role={turn.role}>
      <div className="turn-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="role">{turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '助手' : '工具'}</span>
        <span className="turn-title">{(turn.title || '') + (turn.isError ? ' · 出错' : '')}</span>
        {turn.usage && <span className="token-chip mono">{`${fmtTokens(turn.usage.input + turn.usage.output)} tok`}</span>}
        <span className="token-chip">{turn.ts ? fmtDate(turn.ts) : ''}</span>
      </div>
      <div className="turn-body">
        <div className="text">{text}</div>
        {text.length > 600 && (
          <div
            className="expand-toggle"
            onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x) }}
          >{expanded ? '收起' : '展开全部'}</div>
        )}
      </div>
    </div>
  )
}
