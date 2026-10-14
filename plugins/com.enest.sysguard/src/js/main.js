/**
 * main.js — 进程与端口 · 入口
 * 依赖：plugin-kit（PluginKit.create / dataTable / badge）、./core.js
 * 宿主：enest.sys.processes / sys.ports / sys.kill(confirmed) / storage / ui.toast
 * 结构：Quick 单列表（端口查询 / 进程搜索即杀候选）+ 桌面双表联动 + 曲线 Tab
 */
import {
  formatKb, formatPct, isSystemProc, searchProc, searchPort,
  linkPortsToProc, makeSampler, SampleRing, drawSparkline, shortName
} from './core.js'

const api = window.enest || window.zapi
const $ = (sel, root = document) => root.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const kit = PluginKit.create({
  title: '进程与端口',
  quickPlaceholder: '端口号查占用 / 进程名搜索',
  height: 460
})

// ———— 全局状态 ————

const state = {
  procs: [],
  ports: [],
  search: '',
  hideSys: false,
  favs: new Set(),      // 收藏 pid（置顶）
  linkedPid: null,      // 端口表 → 进程表联动高亮
  tab: 'proc',
  cpuRing: new SampleRing(64),
  memRing: new SampleRing(64),
  sampler: null,
  chartTimer: null,
  mode: kit.mode
}

const foot = $('#foot')
function setStatus(text) {
  foot.textContent = text
}

// ———— 持久化 ————

async function persist() {
  await kit.save('sysguard_prefs', {
    hideSys: state.hideSys,
    favs: [...state.favs]
  })
}

async function restore() {
  const prefs = await kit.load('sysguard_prefs', null)
  if (prefs) {
    state.hideSys = prefs.hideSys === true
    state.favs = new Set(Array.isArray(prefs.favs) ? prefs.favs : [])
  }
}

// ———— 数据加载 ————

async function refresh({ silent = false } = {}) {
  try {
    if (!silent) setStatus('采样中…')
    const [procs, ports] = await Promise.all([
      api.sys.processes(),
      api.sys.ports().catch(() => [])
    ])
    state.procs = procs ?? []
    state.ports = ports ?? []
    // 曲线采样同步：总 CPU%（pcpu 求和）与总内存（rss 求和 KB）
    if (state.procs.length) {
      const totalCpu = state.procs.reduce((n, p) => n + (p.pcpu ?? 0), 0)
      const totalMemKb = state.procs.reduce((n, p) => n + (p.rss ?? 0), 0)
      state.cpuRing.push(Math.min(100, totalCpu))
      state.memRing.push(totalMemKb)
    }
    setStatus(`进程 ${state.procs.length} · 监听端口 ${state.ports.length} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
    renderCurrent()
    return true
  } catch (err) {
    setStatus('采样失败')
    renderError(err?.message ?? String(err))
    return false
  }
}

// ———— 视图切换 ————

function applyMode(mode) {
  state.mode = mode
  $('#quick-view').hidden = mode !== 'quick'
  $('#desktop-view').hidden = mode !== 'shell'
  if (mode === 'shell') {
    renderCurrent()
    startSampler()
  } else {
    stopSampler()
    renderQuick()
    startSampler()
  }
}

// ———— 采样器（宿主 1s 缓存节律 / 1.5s 周期；隐藏时暂停）———

function startSampler() {
  if (state.sampler?.running) return
  let acquiring = false
  state.sampler = makeSampler({
    intervalMs: 1500,
    acquire: async () => {
      if (acquiring || !api?.runtime?.acquireActivity) return null
      acquiring = true
      try {
        return await api.runtime.acquireActivity('sysguard-sampling')
      } finally {
        acquiring = false
      }
    },
    release: (token) => api?.runtime?.releaseActivity?.(token).catch(() => {}),
    sample: () => refresh({ silent: true })
  })
  state.sampler.start()
}

function stopSampler() {
  void state.sampler?.stop()
  if (state.chartTimer) { clearInterval(state.chartTimer); state.chartTimer = 0 }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopSampler()
  } else {
    startSampler()
    void refresh({ silent: true })
  }
})

api?.onOut?.(() => stopSampler())
api?.onEnter?.(() => {
  applyMode(event?.mode ?? kit.mode)
  void refresh({ silent: true })
})

// ———— 桌面：进程表 ————

function procRows() {
  let rows = searchProc(state.procs, state.search)
  if (state.hideSys) rows = rows.filter((p) => !isSystemProc(p.user))
  const fav = rows.filter((p) => state.favs.has(p.pid))
  const rest = rows.filter((p) => !state.favs.has(p.pid))
  return [...fav, ...rest]
}

function buildProcTable() {
  const wrap = el('div', 'sg-table-wrap sg-table proc')
  const search = el('input', 'sg-search')
  search.type = 'search'
  search.placeholder = '搜索进程名 / pid'
  search.value = state.search
  search.setAttribute('data-input-context', 'editor')
  let deb = 0
  search.addEventListener('input', () => {
    state.search = search.value
    clearTimeout(deb)
    deb = setTimeout(updateProcTable, 160)
  })
  const table = PluginKit.dataTable({
    sortBy: 'pcpu',
    sortDir: 'desc',
    onRowClick: (row) => showKillDialog(row),
    // render 返回文本（dataTable 以 String() 写入 td）；行内按钮由 decorateProcRows 在每次 update 后注入
    columns: [
      { key: 'fav', label: '', sortable: false, width: '30px' },
      { key: 'pid', label: 'PID', num: true, sortable: true, width: '84px' },
      { key: 'name', label: '进程', sortable: true },
      { key: 'user', label: '用户', sortable: true, width: '96px' },
      { key: 'pcpu', label: 'CPU%', num: true, sortable: true, width: '84px' },
      {
        key: 'rss', label: '内存', num: true, sortable: true, width: '96px',
        render: (row) => formatKb(row.rss)
      },
      { key: 'op', label: '', sortable: false, width: '72px' }
    ]
  })
  wrap.append(search, table.el)
  wrap.__table = table
  return wrap
}

/** 每次 dataTable.update 后注入收藏/结束按钮、进程名省略与联动/收藏行样式（按行内 pid 文本回配数据） */
function decorateProcRows(wrap) {
  const byPid = new Map(procRows().map((r) => [String(r.pid), r]))
  for (const tr of wrap.__table.el.querySelectorAll('tbody tr')) {
    const pidText = tr.children[1]?.textContent?.trim()
    const row = byPid.get(pidText)
    if (!row) continue
    const [favTd, , nameTd, , , , opTd] = tr.children
    if (favTd && !favTd.firstElementChild) {
      const btn = document.createElement('button')
      btn.className = 'fav-btn' + (state.favs.has(row.pid) ? ' on' : '')
      btn.textContent = state.favs.has(row.pid) ? '★' : '☆'
      btn.title = state.favs.has(row.pid) ? '取消置顶' : '收藏置顶'
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        state.favs.has(row.pid) ? state.favs.delete(row.pid) : state.favs.add(row.pid)
        void persist()
        updateProcTable()
      })
      favTd.replaceChildren(btn)
    }
    if (nameTd) {
      const span = document.createElement('span')
      span.className = 'proc-name'
      span.textContent = shortName(row.command)
      span.title = row.command
      nameTd.replaceChildren(span)
    }
    if (opTd && !opTd.firstElementChild) {
      const btn = document.createElement('button')
      btn.className = 'kill'
      btn.textContent = '结束'
      btn.setAttribute('data-danger', '')
      btn.addEventListener('click', (e) => { e.stopPropagation(); showKillDialog(row) })
      opTd.replaceChildren(btn)
    }
    tr.classList.toggle('linked', state.linkedPid === row.pid)
    tr.classList.toggle('fav', state.favs.has(row.pid))
  }
}

function updateProcTable() {
  const wrap = $('.sg-table-wrap.proc')
  if (!wrap?.__table) return
  wrap.__table.update(procRows())
  decorateProcRows(wrap)
}

// ———— 桌面：端口表 ————

function portRows() {
  return searchPort(state.ports, state.search)
}

function buildPortTable() {
  const wrap = el('div', 'sg-table-wrap sg-table port')
  const search = el('input', 'sg-search')
  search.type = 'search'
  search.placeholder = '搜索端口 / pid / 进程名'
  search.value = state.search
  search.setAttribute('data-input-context', 'editor')
  let deb = 0
  search.addEventListener('input', () => {
    state.search = search.value
    clearTimeout(deb)
    deb = setTimeout(updatePortTable, 160)
  })
  const table = PluginKit.dataTable({
    sortBy: 'port',
    sortDir: 'asc',
    onRowClick: (row) => {
      // 联动：点端口行高亮对应进程并切到进程表（先落搜索词再切，renderTabBody 回填缓存面板）
      state.linkedPid = row.pid
      state.search = String(row.pid)
      const procPane = tabPanes.get('proc')
      const procSearch = procPane && $('.sg-search', procPane)
      if (procSearch) procSearch.value = state.search
      switchTab('proc')
    },
    columns: [
      { key: 'protocol', label: '协议', width: '72px' },
      { key: 'address', label: '本地地址' },
      { key: 'port', label: '端口', num: true, sortable: true, width: '96px' },
      {
        key: 'command', label: '进程',
        render: (row) => {
          const span = document.createElement('span')
          span.className = 'proc-name'
          span.textContent = row.command || shortName(row.name)
          span.title = row.name
          return span
        }
      },
      { key: 'pid', label: 'PID', num: true, sortable: true, width: '84px' },
      { key: 'user', label: '用户', width: '96px' }
    ]
  })
  wrap.append(search, table.el)
  wrap.__table = table
  return wrap
}

function updatePortTable() {
  const wrap = $('.sg-table-wrap.port')
  if (wrap?.__table) wrap.__table.update(portRows())
}

// ———— 桌面：曲线 ————

function buildChart() {
  const wrap = el('div', 'sg-chart')
  const cpuCard = el('div', 'sg-chart-card')
  const cpuHead = el('div', 'sg-chart-head')
  cpuHead.innerHTML = '<span style="color:var(--accent)">■</span> CPU 总占用 <b id="sg-cpu-v">-</b>'
  const cpuCv = el('canvas')
  cpuCv.id = 'sg-cpu-cv'
  cpuCard.append(cpuHead, cpuCv)

  const memCard = el('div', 'sg-chart-card')
  const memHead = el('div', 'sg-chart-head')
  memHead.innerHTML = '<span style="color:var(--ok)">■</span> 物理内存合计 <b id="sg-mem-v">-</b>'
  const memCv = el('canvas')
  memCv.id = 'sg-mem-cv'
  memCard.append(memHead, memCv)

  const legend = el('div', 'sg-chart-legend')
  legend.innerHTML =
    '<span><i class="dot" style="background:var(--accent)"></i>CPU%（0-100）</span>' +
    '<span><i class="dot" style="background:var(--ok)"></i>内存（自适应满刻度）</span>' +
    '<span class="pk-muted">60s 滚动 · 1.5s 采样 · 隐藏自动暂停</span>'

  wrap.append(cpuCard, memCard, legend)
  wrap.__cpuCv = cpuCv
  wrap.__memCv = memCv
  return wrap
}

function updateChart() {
  const cpuCv = $('#sg-cpu-cv')
  const memCv = $('#sg-mem-cv')
  if (!cpuCv || !memCv) return
  const css = getComputedStyle(document.documentElement)
  const accent = css.getPropertyValue('--accent').trim() || '#bd542b'
  const ok = css.getPropertyValue('--ok').trim() || '#318469'
  drawSparkline(cpuCv, [{ data: state.cpuRing.items, color: accent, fill: css.getPropertyValue('--accent-soft').trim() || 'transparent' }], { max: 100 })
  const memMax = Math.max(1, ...state.memRing.items)
  drawSparkline(memCv, [{ data: state.memRing.items, color: ok, fill: css.getPropertyValue('--ok-soft').trim() || 'transparent' }], { max: memMax })
  const cpuV = $('#sg-cpu-v')
  const memV = $('#sg-mem-v')
  const cpuLast = state.cpuRing.items.at(-1)
  const memLast = state.memRing.items.at(-1)
  if (cpuV) cpuV.textContent = cpuLast != null ? formatPct(cpuLast) : '-'
  if (memV) memV.textContent = memLast != null ? formatKb(memLast) : '-'
}

// ———— Tab 管理 ————

const tabPanes = new Map() // tab → { build, update, node }
function switchTab(tab) {
  state.tab = tab
  for (const b of $('#tabs').children) {
    b.classList.toggle('active', b.dataset.tab === tab)
    b.setAttribute('aria-selected', String(b.dataset.tab === tab))
  }
  renderTabBody()
}

function renderTabBody() {
  const body = $('#tab-body')
  // 离开当前 Tab 前保存搜索词；进入后回填到缓存面板的搜索框（联动切换时同步）
  const prevSearch = $('.sg-search', body)?.value
  if (prevSearch) state.search = prevSearch
  body.replaceChildren()
  if (state.tab === 'proc') {
    if (!tabPanes.has('proc')) tabPanes.set('proc', buildProcTable())
    const pane = tabPanes.get('proc')
    const search = $('.sg-search', pane)
    if (search && search.value !== state.search) search.value = state.search
    body.append(pane)
    updateProcTable()
  } else if (state.tab === 'port') {
    if (!tabPanes.has('port')) tabPanes.set('port', buildPortTable())
    const pane = tabPanes.get('port')
    const search = $('.sg-search', pane)
    if (search && search.value !== state.search) search.value = state.search
    body.append(pane)
    updatePortTable()
  } else {
    body.append(buildChart())
    updateChart()
    if (!state.chartTimer) state.chartTimer = setInterval(updateChart, 1500)
  }
}

function renderCurrent() {
  if (state.mode === 'quick') renderQuick()
  else renderTabBody()
}

function renderError(message) {
  const body = state.mode === 'quick' ? $('#q-list') : $('#tab-body')
  body.replaceChildren(el('div', 'sg-error', `采样失败：${message}\n请确认宿主已授权 sys.inspect 权限`))
}

// ———— 危险确认（结束进程）———

function showKillDialog(proc) {
  const dlg = $('#dlg')
  dlg.replaceChildren()
  const head = el('div', 'sg-dlg-head')
  head.append(el('span', '', '结束进程'))
  const x = el('button', 'sg-btn tiny ghost', '✕')
  x.addEventListener('click', () => dlg.close())
  head.append(x)
  const body = el('div', 'sg-dlg-body')
  const warn = el('div', '')
  warn.innerHTML = `确认结束进程 <b class="mono">#${proc.pid}</b>「${escapeHtml(shortName(proc.command))}」？<br><span class="pk-muted">该操作将发送 TERM 信号，进程未保存的数据可能丢失。</span>`
  body.append(warn)
  const meta = el('dl', 'sg-dlg-meta')
  const addMeta = (k, v) => {
    meta.append(el('dt', '', k))
    const dd = el('dd', '', v)
    meta.append(dd)
  }
  addMeta('PID', String(proc.pid))
  addMeta('用户', proc.user)
  addMeta('CPU', formatPct(proc.pcpu))
  addMeta('内存', formatKb(proc.rss))
  addMeta('命令', proc.command)
  body.append(meta)
  const row = el('div')
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;'
  const cancel = el('button', 'sg-btn', '取消')
  cancel.addEventListener('click', () => dlg.close())
  const ok = el('button', 'sg-btn danger', `结束 #${proc.pid}`)
  ok.addEventListener('click', async () => {
    ok.disabled = true
    ok.textContent = '结束中…'
    try {
      await api.sys.kill(proc.pid, { signal: 'TERM', confirmed: true })
      kit.toast(`已结束 #${proc.pid} ${shortName(proc.command)}`, 'success')
      dlg.close()
      await refresh()
    } catch (err) {
      ok.disabled = false
      ok.textContent = `结束 #${proc.pid}`
      kit.toast(`结束失败：${err?.message}`, 'error')
    }
  })
  row.append(cancel, ok)
  body.append(row)
  dlg.append(head, body)
  dlg.showModal()
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// ———— Quick 形态 ————

function renderQuick() {
  renderQuickList($('#q-input')?.value ?? '')
}

function renderQuickList(q) {
  const list = $('#q-list')
  list.replaceChildren()
  const query = String(q ?? '').trim()
  if (!query) {
    list.append(el('div', 'sg-empty', '输入端口号查询监听占用\n或输入进程名 / pid 搜索并结束进程'))
    updateQuickSpark()
    return
  }
  const asPort = /^\d{1,5}$/.test(query)
  if (asPort) {
    const hits = state.ports.filter((p) => String(p.port) === query)
    if (!hits.length) {
      list.append(el('div', 'sg-empty', `端口 ${query} 当前无监听进程`))
    }
    for (const p of hits) {
      const row = el('div', 'sg-row36')
      row.append(el('span', 'pk-muted mono', p.protocol))
      row.append(el('span', 'mono', `${p.address}:${p.port}`))
      row.append(el('span', 'name', p.command || shortName(p.name)))
      row.append(el('span', 'num', `#${p.pid}`))
      const kill = el('button', 'sg-btn tiny danger', '结束')
      kill.addEventListener('click', () => showKillDialog({ ...p, command: p.command || p.name, rss: 0, pcpu: 0 }))
      row.append(kill)
      list.append(row)
    }
  }
  // 同时给出进程名命中（port 查询也允许同名进程补充）
  const procHits = searchProc(state.procs, query).slice(0, asPort ? 8 : 30)
  if (procHits.length && asPort) list.append(el('div', 'sg-row36', el('span', 'pk-muted', '— 相关进程 —')))
  for (const p of procHits) {
    const row = el('div', 'sg-row36')
    row.append(el('span', 'num pk-muted', `#${p.pid}`))
    row.append(el('span', 'name', shortName(p.command)))
    row.append(el('span', 'num', formatPct(p.pcpu)))
    row.append(el('span', 'num', formatKb(p.rss)))
    const kill = el('button', 'sg-btn tiny danger', '结束')
    kill.addEventListener('click', () => showKillDialog(p))
    row.append(kill)
    list.append(row)
  }
  if (!asPort && !procHits.length) list.append(el('div', 'sg-empty', `未找到匹配「${query}」的进程`))
  updateQuickSpark()
}

function updateQuickSpark() {
  const cv = $('#q-canvas')
  if (!cv) return
  const css = getComputedStyle(document.documentElement)
  drawSparkline(cv, [
    { data: state.cpuRing.items, color: css.getPropertyValue('--accent').trim() || '#bd542b' },
    {
      data: state.memRing.items,
      color: css.getPropertyValue('--ok').trim() || '#318469',
      fill: 'transparent'
    }
  ], { max: Math.max(100, Math.max(1, ...state.memRing.items)), grid: false })
  const cpuLast = state.cpuRing.items.at(-1)
  const memLast = state.memRing.items.at(-1)
  const cpuEl = $('#q-cpu')
  const memEl = $('#q-mem')
  if (cpuEl) cpuEl.textContent = cpuLast != null ? formatPct(cpuLast) : '-'
  if (memEl) memEl.textContent = memLast != null ? formatKb(memLast) : '-'
}

// ———— 事件绑定 ————

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]')
  if (btn) switchTab(btn.dataset.tab)
})

$('#refresh').addEventListener('click', () => void refresh())
$('#hide-sys').addEventListener('change', (e) => {
  state.hideSys = e.target.checked
  void persist()
  updateProcTable()
})

let quickDeb = 0
$('#q-input').addEventListener('input', (e) => {
  clearTimeout(quickDeb)
  quickDeb = setTimeout(() => renderQuickList(e.target.value), 160)
})
$('#q-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    renderQuickList(e.target.value)
  }
})
$('#q-search').addEventListener('click', () => renderQuickList($('#q-input').value))

window.addEventListener('resize', () => {
  if (state.tab === 'chart') updateChart()
  updateQuickSpark()
})

api?.ui?.onThemeChange?.(() => {
  if (state.tab === 'chart') updateChart()
  updateQuickSpark()
})

api?.onModeChange?.((mode) => applyMode(mode))

api?.onBeforeClose?.(async () => {
  stopSampler()
  await persist()
})

// ———— 启动 ————

async function boot() {
  await restore()
  $('#hide-sys').checked = state.hideSys
  applyMode(kit.mode)
  await refresh()
  // Quick 高度按内容收敛；桌面记录即可
  if (kit.mode === 'quick') {
    void api?.ui?.resize?.({ height: 460 })
  }
}

void boot()
