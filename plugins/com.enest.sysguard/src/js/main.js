/**
 * main.js — 进程与端口 · 入口
 * 依赖：plugin-kit（PluginKit.create / dataTable）、./core.js
 * 宿主：enest.sys.processes / sys.ports / sys.kill(confirmed) / storage / ui.toast / runtime.acquireActivity
 * 结构：Quick 单列表（端口查询 / 进程搜索即杀候选）+ 桌面「概览仪表盘 / 进程 / 端口 / 曲线」
 * 仪表盘：CPU·内存·进程数·监听端口四张数据卡 + 迷你趋势 + 阈值告警 + Top 进程；
 * 刷新为增量更新（只改文本与样式，不整页重绘，避免闪烁）。
 */
import {
  formatKb, formatPct, isSystemProc, searchProc, searchPort,
  linkPortsToProc, makeSampler, SampleRing, drawSparkline, shortName,
  thresholdLevel, summarize, topProcesses
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
  height: 460,
  defaults: { intervalMs: 1500, cpuWarn: 70, cpuDanger: 90, memWarn: 70, memDanger: 90 }
})

// ———— 全局状态 ————

const INTERVALS = [1500, 3000, 5000, 10000]
const state = {
  procs: [],
  ports: [],
  search: '',
  hideSys: false,
  favs: new Set(),      // 收藏 pid（置顶）
  linkedPid: null,      // 端口表 → 进程表联动高亮
  tab: 'dash',
  intervalMs: 1500,
  cpuRing: new SampleRing(80),
  memRing: new SampleRing(80),
  sampler: null,
  chartTimer: null,
  mode: kit.mode
}

// 阈值（宿主 settings 可覆盖默认；按 0-100 百分比）
const thresholds = () => ({
  cpuWarn: Number(kit.settings.cpuWarn) || 70,
  cpuDanger: Number(kit.settings.cpuDanger) || 90,
  memWarn: Number(kit.settings.memWarn) || 70,
  memDanger: Number(kit.settings.memDanger) || 90
})

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
    // 向后兼容：无 intervalMs 记录时保持默认 1.5s
    if (INTERVALS.includes(Number(prefs.intervalMs))) state.intervalMs = Number(prefs.intervalMs)
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
    // 曲线采样同步：总 CPU%（pcpu 求和，裁到 100）与总内存（rss 求和 KB）
    if (state.procs.length) {
      const totalCpu = Math.min(100, state.procs.reduce((n, p) => n + (p.pcpu ?? 0), 0))
      const totalMemKb = state.procs.reduce((n, p) => n + (p.rss ?? 0), 0)
      state.cpuRing.push(totalCpu)
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
  restartSampler()
  if (mode === 'shell') {
    renderTabBody()
  } else {
    renderQuick()
  }
}

// ———— 采样器（周期 = 设置的刷新频率；隐藏时暂停）———

function restartSampler() {
  void state.sampler?.stop()
  state.sampler = makeSampler({
    intervalMs: state.intervalMs,
    acquire: async () => {
      if (!api?.runtime?.acquireActivity) return null
      return await api.runtime.acquireActivity('sysguard-sampling')
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
    restartSampler()
    void refresh({ silent: true })
  }
})

api?.onOut?.(() => stopSampler())
api?.onEnter?.(() => {
  applyMode(event?.mode ?? kit.mode)
  void refresh({ silent: true })
})

// ———— 桌面：概览仪表盘 ————
// 静态骨架只建一次；采样循环只更新文本 / 数据卡配色 / 重绘 spark，不重建 DOM（增量更新，无闪烁）。

function buildDash() {
  const wrap = el('div', 'sg-dash')

  const cards = el('div', 'sg-dash-cards')
  const makeCard = (key, label, sub) => {
    const card = el('article', 'sg-card')
    card.dataset.card = key
    const head = el('div', 'sg-card-label', label)
    const value = el('div', 'sg-card-value mono', '—')
    const spark = el('canvas', 'sg-card-spark')
    spark.setAttribute('aria-hidden', 'true')
    const footEl = el('div', 'sg-card-sub', sub)
    card.append(head, value, spark, footEl)
    cards.append(card)
    return { card, value, spark, footEl }
  }
  const cpu = makeCard('cpu', 'CPU 总占用', '')
  const mem = makeCard('mem', '物理内存合计', '')
  const procs = makeCard('procs', '进程数', '')
  const ports = makeCard('ports', '监听端口', '')
  wrap.__cards = { cpu, mem, procs, ports }

  // Top 列表：CPU / 内存两列
  const tops = el('div', 'sg-dash-tops')
  const makeTop = (key, title) => {
    const box = el('section', 'sg-toplist')
    box.append(el('h3', 'sg-toplist-title', title))
    const list = el('ol', 'sg-toplist-list')
    box.append(list)
    tops.append(box)
    return { box, list }
  }
  wrap.__tops = { cpu: makeTop('cpu', 'CPU 占用最高'), mem: makeTop('mem', '内存占用最高') }

  wrap.append(cards, tops)
  return wrap
}

/** 单卡更新：文本 + 阈值配色 + spark 重绘（增量） */
function updateCard(card, { text, value, unit, series, color, fill, max, level, sub }) {
  if (!card) return
  if (card.value.textContent !== text) card.value.textContent = text
  card.card.dataset.level = level
  if (sub !== undefined && card.footEl.textContent !== sub) card.footEl.textContent = sub
  if (series) drawSparkline(card.spark, [{ data: series, color, fill }], { max, grid: false })
}

function updateDash() {
  const wrap = $('.sg-dash')
  if (!wrap) return
  const s = summarize(state.procs, state.ports)
  const th = thresholds()
  const css = getComputedStyle(document.documentElement)
  const accent = css.getPropertyValue('--accent').trim() || '#bd542b'
  const ok = css.getPropertyValue('--ok').trim() || '#318469'
  const accentSoft = css.getPropertyValue('--accent-soft').trim() || 'transparent'
  const okSoft = css.getPropertyValue('--ok-soft').trim() || 'transparent'

  const cpuLevel = thresholdLevel(s.totalCpu, th.cpuWarn, th.cpuDanger)
  const memLevel = thresholdLevel(s.memPct, th.memWarn, th.memDanger)
  const cpuLast = state.cpuRing.items.at(-1)
  const memLast = state.memRing.items.at(-1)

  updateCard(wrap.__cards.cpu, {
    text: formatPct(cpuLast ?? s.totalCpu),
    level: cpuLevel,
    series: state.cpuRing.items, color: accent, fill: accentSoft, max: 100,
    sub: `阈值 ${th.cpuWarn}% / ${th.cpuDanger}%`
  })
  updateCard(wrap.__cards.mem, {
    text: formatKb(memLast ?? s.totalMemKb),
    level: memLevel,
    series: state.memRing.items, color: ok, fill: okSoft, max: Math.max(1, ...state.memRing.items),
    sub: `占用 ${formatPct(s.memPct)} · 阈值 ${th.memWarn}% / ${th.memDanger}%`
  })
  updateCard(wrap.__cards.procs, {
    text: String(s.procCount), level: 'ok',
    sub: `内存最高 ${s.memTop ? shortName(s.memTop.command) : '—'}`
  })
  updateCard(wrap.__cards.ports, {
    text: String(s.portCount), level: s.portCount > 0 ? 'ok' : 'warn',
    sub: `${s.listenCount} 个进程在监听`
  })

  // Top 列表增量重绘（数量小，直接重建列表内容）
  fillTopList(wrap.__tops.cpu.list, topProcesses(state.procs, 'pcpu', 5), (v) => formatPct(v), (v) => thresholdLevel(v, th.cpuWarn, th.cpuDanger))
  fillTopList(wrap.__tops.mem.list, topProcesses(state.procs, 'rss', 5), (v) => formatKb(v), () => 'ok')
}

function fillTopList(listEl, items, fmt, level) {
  listEl.replaceChildren()
  for (const item of items) {
    const li = el('li', 'sg-toplist-item')
    li.append(el('span', 'sg-toplist-name', item.name))
    li.append(el('span', `sg-toplist-value mono lv-${level(item.value)}`, fmt(item.value)))
    listEl.append(li)
  }
  if (!items.length) listEl.append(el('li', 'sg-toplist-empty', '暂无数据'))
}

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
    '<span class="pk-muted">滚动窗口 · 隐藏自动暂停</span>'

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
  if (state.tab === 'dash') {
    if (!tabPanes.has('dash')) tabPanes.set('dash', buildDash())
    body.append(tabPanes.get('dash'))
    updateDash()
  } else if (state.tab === 'proc') {
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
    if (!state.chartTimer) state.chartTimer = setInterval(updateChart, Math.max(500, state.intervalMs))
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
  if (procHits.length && asPort) {
    const head = el('div', 'sg-row36 sg-row-head')
    head.append(el('span', 'pk-muted', '相关进程'))
    list.append(head)
  }
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
  const procsEl = $('#q-procs')
  if (procsEl) procsEl.textContent = state.procs.length ? `${state.procs.length} 进程` : ''
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

$('#interval').addEventListener('change', (e) => {
  const value = Number(e.target.value)
  if (!INTERVALS.includes(value)) return
  state.intervalMs = value
  // 窗口容量按「60s 窗口」语义随频率伸缩：容量 = 窗口时长 / 周期，上限 240 点
  const capacity = Math.min(240, Math.max(16, Math.round(60000 / value)))
  state.cpuRing.setCapacity(capacity)
  state.memRing.setCapacity(capacity)
  void persist()
  restartSampler()
  setStatus(`刷新频率：每 ${value / 1000} 秒`)
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
  if (state.tab === 'dash') updateDash()
  updateQuickSpark()
})

api?.ui?.onThemeChange?.(() => {
  if (state.tab === 'chart') updateChart()
  if (state.tab === 'dash') updateDash()
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
  await kit.ready
  $('#hide-sys').checked = state.hideSys
  // 设置：宿主 settings.intervalMs（数字或字符串毫秒）优先，其次本地偏好
  const hostInterval = Number(kit.settings.intervalMs)
  if (INTERVALS.includes(hostInterval)) state.intervalMs = hostInterval
  $('#interval').value = String(state.intervalMs)
  PluginKit.upgradeSelects() // 纯 .value 赋值不触发 change，同步自定义下拉标签
  const capacity = Math.min(240, Math.max(16, Math.round(60000 / state.intervalMs)))
  state.cpuRing.setCapacity(capacity)
  state.memRing.setCapacity(capacity)
  applyMode(kit.mode)
  await refresh()
  if (kit.mode === 'quick') {
    void api?.ui?.resize?.({ height: 460 })
  }
}

void boot()
