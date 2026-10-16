/**
 * main.jsx — 进程与端口 · React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心复用 ./core.js（纯逻辑，未改动）；宿主 sys.* / runtime API 调用语义不变。
 * PluginKit.dataTable（DOM 工厂）在 useEffect 中等价触发；采样器卸载时清理。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  formatKb, formatPct, isSystemProc, searchProc, searchPort,
  makeSampler, SampleRing, drawSparkline, shortName,
  thresholdLevel, summarize, topProcesses,
} from '../js/core.js'

const api = window.enest || window.zapi

const INTERVALS = [1500, 3000, 5000, 10000]

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function App() {
  const kitRef = useRef(null)
  const modeRef = useRef('shell')
  const dlgHostRef = useRef(null)

  // —— 全局状态（latest-ref，与原 state 对象对应）——
  const st = useRef({
    procs: [],
    ports: [],
    search: '',
    hideSys: false,
    favs: new Set(),
    linkedPid: null,
    tab: 'dash',
    intervalMs: 1500,
    cpuRing: new SampleRing(80),
    memRing: new SampleRing(80),
    sampler: null,
    chartTimer: null,
  }).current

  // —— 渲染状态 ——
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((t) => t + 1), [])
  const [foot, setFoot] = useState('就绪')
  const [mode, setModeState] = useState('shell')
  const [tab, setTab] = useState('dash')
  const [hideSys, setHideSys] = useState(false)
  const [intervalMs, setIntervalMs] = useState(1500)
  const [quickQuery, setQuickQuery] = useState('')
  const [quickList, setQuickList] = useState({ kind: 'rows', rows: [] }) // 渲染快照
  const [dashVersion, setDashVersion] = useState(0)

  const setStatus = useCallback((text) => setFoot(text), [])

  const thresholds = () => ({
    cpuWarn: Number(kitRef.current?.settings.cpuWarn) || 70,
    cpuDanger: Number(kitRef.current?.settings.cpuDanger) || 90,
    memWarn: Number(kitRef.current?.settings.memWarn) || 70,
    memDanger: Number(kitRef.current?.settings.memDanger) || 90,
  })

  // —— 持久化 ——
  const persist = useCallback(async () => {
    await kitRef.current?.save('sysguard_prefs', {
      hideSys: st.hideSys,
      favs: [...st.favs],
      intervalMs: st.intervalMs,
    })
  }, [st])

  // —— 数据加载 ——
  const refresh = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setStatus('采样中…')
      const [procs, ports] = await Promise.all([
        api.sys.processes(),
        api.sys.ports().catch(() => []),
      ])
      st.procs = procs ?? []
      st.ports = ports ?? []
      if (st.procs.length) {
        const totalCpu = Math.min(100, st.procs.reduce((n, p) => n + (p.pcpu ?? 0), 0))
        const totalMemKb = st.procs.reduce((n, p) => n + (p.rss ?? 0), 0)
        st.cpuRing.push(totalCpu)
        st.memRing.push(totalMemKb)
      }
      setStatus(`进程 ${st.procs.length} · 监听端口 ${st.ports.length} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
      // 触发当前视图更新（表格/仪表盘/quick 由各自 effect 消费）
      st.error = null
      if (modeRef.current === 'quick') renderQuickList(st._quickInput ?? '')
      else setDashVersion((v) => v + 1)
      rerender()
      return true
    } catch (err) {
      setStatus('采样失败')
      st.error = err?.message ?? String(err)
      rerender()
      return false
    }
  }, [rerender, setStatus, st])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // —— 采样器 ——
  const restartSampler = useCallback(() => {
    void st.sampler?.stop()
    st.sampler = makeSampler({
      intervalMs: st.intervalMs,
      acquire: async () => {
        if (!api?.runtime?.acquireActivity) return null
        return await api.runtime.acquireActivity('sysguard-sampling')
      },
      release: (token) => api?.runtime?.releaseActivity?.(token).catch(() => {}),
      sample: () => refreshRef.current({ silent: true }),
    })
    st.sampler.start()
  }, [st])

  const stopSampler = useCallback(() => {
    void st.sampler?.stop()
    if (st.chartTimer) { clearInterval(st.chartTimer); st.chartTimer = 0 }
  }, [st])

  // —— 视图切换 ——
  const applyMode = useCallback((m) => {
    modeRef.current = m
    setModeState(m)
    restartSampler()
  }, [restartSampler])

  // —— 进程/端口行 ——
  function procRows() {
    let rows = searchProc(st.procs, st.search)
    if (st.hideSys) rows = rows.filter((p) => !isSystemProc(p.user))
    const fav = rows.filter((p) => st.favs.has(p.pid))
    const rest = rows.filter((p) => !st.favs.has(p.pid))
    return [...fav, ...rest]
  }
  function portRows() {
    return searchPort(st.ports, st.search)
  }

  // —— Quick 形态列表（等价原 renderQuickList）——
  const renderQuickList = useCallback((q) => {
    st._quickInput = q
    const list = []
    const query = String(q ?? '').trim()
    if (!query) {
      setQuickList({ kind: 'empty', rows: [] })
      return
    }
    const asPort = /^\d{1,5}$/.test(query)
    if (asPort) {
      const hits = st.ports.filter((p) => String(p.port) === query)
      if (!hits.length) list.push({ kind: 'empty-text', text: `端口 ${query} 当前无监听进程` })
      for (const p of hits) {
        list.push({
          kind: 'port', protocol: p.protocol, address: `${p.address}:${p.port}`,
          name: p.command || shortName(p.name), pid: p.pid,
          proc: { ...p, command: p.command || p.name, rss: 0, pcpu: 0 },
        })
      }
    }
    const procHits = searchProc(st.procs, query).slice(0, asPort ? 8 : 30)
    if (procHits.length && asPort) list.push({ kind: 'head', text: '相关进程' })
    for (const p of procHits) {
      list.push({ kind: 'proc', pid: p.pid, name: shortName(p.command), cpu: formatPct(p.pcpu), mem: formatKb(p.rss), proc: p })
    }
    if (!asPort && !procHits.length) list.push({ kind: 'empty-text', text: `未找到匹配「${query}」的进程` })
    setQuickList({ kind: 'rows', rows: list })
  }, [st]) // eslint-disable-line react-hooks/exhaustive-deps
  const renderQuickListRef = useRef(renderQuickList)
  renderQuickListRef.current = renderQuickList

  // —— 危险确认（结束进程，原生 dialog#dlg）——
  const showKillDialog = useCallback((proc) => {
    const dlg = dlgHostRef.current
    if (!dlg) return
    const root = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'sg-dlg-head'
    const span = document.createElement('span')
    span.textContent = '结束进程'
    head.append(span)
    const x = document.createElement('button')
    x.className = 'sg-btn tiny ghost'
    x.textContent = '✕'
    x.addEventListener('click', () => dlg.close())
    head.append(x)
    const body = document.createElement('div')
    body.className = 'sg-dlg-body'
    const warn = document.createElement('div')
    warn.innerHTML = `确认结束进程 <b class="mono">#${proc.pid}</b>「${escapeHtml(shortName(proc.command))}」？<br><span class="pk-muted">该操作将发送 TERM 信号，进程未保存的数据可能丢失。</span>`
    body.append(warn)
    const meta = document.createElement('dl')
    meta.className = 'sg-dlg-meta'
    const addMeta = (k, v) => {
      meta.append(Object.assign(document.createElement('dt'), { textContent: k }))
      meta.append(Object.assign(document.createElement('dd'), { textContent: v }))
    }
    addMeta('PID', String(proc.pid))
    addMeta('用户', proc.user)
    addMeta('CPU', formatPct(proc.pcpu))
    addMeta('内存', formatKb(proc.rss))
    addMeta('命令', proc.command)
    body.append(meta)
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;'
    const cancel = document.createElement('button')
    cancel.className = 'sg-btn'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => dlg.close())
    const ok = document.createElement('button')
    ok.className = 'sg-btn danger'
    ok.textContent = `结束 #${proc.pid}`
    ok.addEventListener('click', async () => {
      ok.disabled = true
      ok.textContent = '结束中…'
      try {
        await api.sys.kill(proc.pid, { signal: 'TERM', confirmed: true })
        kitRef.current?.toast(`已结束 #${proc.pid} ${shortName(proc.command)}`, 'success')
        dlg.close()
        await refreshRef.current()
      } catch (err) {
        ok.disabled = false
        ok.textContent = `结束 #${proc.pid}`
        kitRef.current?.toast(`结束失败：${err?.message}`, 'error')
      }
    })
    row.append(cancel, ok)
    body.append(row)
    root.append(head, body)
    dlg.replaceChildren(root)
    dlg.showModal()
  }, [])
  const killRef = useRef(showKillDialog)
  killRef.current = showKillDialog

  // —— 桌面：进程表 / 端口表（PluginKit.dataTable 等价触发）——
  const procPaneRef = useRef(null)
  const portPaneRef = useRef(null)
  const procSearchRef = useRef(null)
  const portSearchRef = useRef(null)
  const procTableRef = useRef(null)
  const portTableRef = useRef(null)
  const chartCpuRef = useRef(null)
  const chartMemRef = useRef(null)
  const quickCanvasRef = useRef(null)
  const dashCardRefs = useRef({})

  const decorateProcRows = useCallback(() => {
    const table = procTableRef.current
    if (!table) return
    const byPid = new Map(procRows().map((r) => [String(r.pid), r]))
    for (const tr of table.el.querySelectorAll('tbody tr')) {
      const pidText = tr.children[1]?.textContent?.trim()
      const row = byPid.get(pidText)
      if (!row) continue
      const [favTd, , nameTd, , , , opTd] = tr.children
      if (favTd && !favTd.firstElementChild) {
        const btn = document.createElement('button')
        btn.className = 'fav-btn' + (st.favs.has(row.pid) ? ' on' : '')
        btn.textContent = st.favs.has(row.pid) ? '★' : '☆'
        btn.title = st.favs.has(row.pid) ? '取消置顶' : '收藏置顶'
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          st.favs.has(row.pid) ? st.favs.delete(row.pid) : st.favs.add(row.pid)
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
        btn.addEventListener('click', (e) => { e.stopPropagation(); killRef.current(row) })
        opTd.replaceChildren(btn)
      }
      tr.classList.toggle('linked', st.linkedPid === row.pid)
      tr.classList.toggle('fav', st.favs.has(row.pid))
    }
  }, [persist, st])

  const updateProcTable = useCallback(() => {
    const table = procTableRef.current
    if (!table) return
    table.update(procRows())
    decorateProcRows()
  }, [decorateProcRows])
  const updateProcTableRef = useRef(updateProcTable)
  updateProcTableRef.current = updateProcTable

  const updatePortTable = useCallback(() => {
    portTableRef.current?.update(portRows())
  }, [st]) // eslint-disable-line react-hooks/exhaustive-deps

  // 数据变化时增量更新缓存面板（等价原 renderTabBody 的 update 分支）
  useEffect(() => {
    if (mode !== 'shell') return
    if (tab === 'proc') updateProcTable()
    else if (tab === 'port') updatePortTable()
  }, [dashVersion, tab, mode, updatePortTable, updateProcTable])

  // —— Tab 管理 ——
  const switchTab = useCallback((next) => {
    st.tab = next
    st.search = $('.sg-search')?.value ?? st.search
    setTab(next)
  }, [st])
  function $(sel) {
    return document.querySelector(sel)
  }

  // —— 曲线 tab 定时重绘 ——
  useEffect(() => {
    if (mode !== 'shell' || tab !== 'chart') return
    const draw = () => {
      const cpuCv = chartCpuRef.current
      const memCv = chartMemRef.current
      if (!cpuCv || !memCv) return
      const css = getComputedStyle(document.documentElement)
      const accent = css.getPropertyValue('--accent').trim() || '#bd542b'
      const ok = css.getPropertyValue('--ok').trim() || '#318469'
      drawSparkline(cpuCv, [{ data: st.cpuRing.items, color: accent, fill: css.getPropertyValue('--accent-soft').trim() || 'transparent' }], { max: 100 })
      const memMax = Math.max(1, ...st.memRing.items)
      drawSparkline(memCv, [{ data: st.memRing.items, color: ok, fill: css.getPropertyValue('--ok-soft').trim() || 'transparent' }], { max: memMax })
      const cpuV = document.getElementById('sg-cpu-v')
      const memV = document.getElementById('sg-mem-v')
      const cpuLast = st.cpuRing.items.at(-1)
      const memLast = st.memRing.items.at(-1)
      if (cpuV) cpuV.textContent = cpuLast != null ? formatPct(cpuLast) : '-'
      if (memV) memV.textContent = memLast != null ? formatKb(memLast) : '-'
    }
    draw()
    if (!st.chartTimer) st.chartTimer = setInterval(draw, Math.max(500, st.intervalMs))
    return () => {
      if (st.chartTimer) { clearInterval(st.chartTimer); st.chartTimer = 0 }
    }
  }, [tab, mode, dashVersion, st])

  // —— 概览仪表盘重绘 ——
  useEffect(() => {
    if (mode !== 'shell' || tab !== 'dash') return
    const cards = dashCardRefs.current
    if (!cards?.cpu) return
    const s = summarize(st.procs, st.ports)
    const th = thresholds()
    const css = getComputedStyle(document.documentElement)
    const accent = css.getPropertyValue('--accent').trim() || '#bd542b'
    const ok = css.getPropertyValue('--ok').trim() || '#318469'
    const accentSoft = css.getPropertyValue('--accent-soft').trim() || 'transparent'
    const okSoft = css.getPropertyValue('--ok-soft').trim() || 'transparent'
    const cpuLevel = thresholdLevel(s.totalCpu, th.cpuWarn, th.cpuDanger)
    const memLevel = thresholdLevel(s.memPct, th.memWarn, th.memDanger)
    const cpuLast = st.cpuRing.items.at(-1)
    const memLast = st.memRing.items.at(-1)
    const updateCard = (card, { text, value, series, color, fill, max, level, sub }) => {
      if (!card) return
      if (card.value.textContent !== text) card.value.textContent = text
      card.card.dataset.level = level
      if (sub !== undefined && card.footEl.textContent !== sub) card.footEl.textContent = sub
      if (series) drawSparkline(card.spark, [{ data: series, color, fill }], { max, grid: false })
    }
    updateCard(cards.cpu, {
      text: formatPct(cpuLast ?? s.totalCpu),
      level: cpuLevel,
      series: st.cpuRing.items, color: accent, fill: accentSoft, max: 100,
      sub: `阈值 ${th.cpuWarn}% / ${th.cpuDanger}%`,
    })
    updateCard(cards.mem, {
      text: formatKb(memLast ?? s.totalMemKb),
      level: memLevel,
      series: st.memRing.items, color: ok, fill: okSoft, max: Math.max(1, ...st.memRing.items),
      sub: `占用 ${formatPct(s.memPct)} · 阈值 ${th.memWarn}% / ${th.memDanger}%`,
    })
    updateCard(cards.procs, {
      text: String(s.procCount), level: 'ok',
      sub: `内存最高 ${s.memTop ? shortName(s.memTop.command) : '—'}`,
    })
    updateCard(cards.ports, {
      text: String(s.portCount), level: s.portCount > 0 ? 'ok' : 'warn',
      sub: `${s.listenCount} 个进程在监听`,
    })
    const fillTopList = (listEl, items, fmt, level) => {
      if (!listEl) return
      listEl.replaceChildren()
      for (const item of items) {
        const li = document.createElement('li')
        li.className = 'sg-toplist-item'
        const name = document.createElement('span')
        name.className = 'sg-toplist-name'
        name.textContent = item.name
        const value = document.createElement('span')
        value.className = `sg-toplist-value mono lv-${level(item.value)}`
        value.textContent = fmt(item.value)
        li.append(name, value)
        listEl.append(li)
      }
      if (!items.length) listEl.append(Object.assign(document.createElement('li'), { className: 'sg-toplist-empty', textContent: '暂无数据' }))
    }
    fillTopList(cards.cpuList, topProcesses(st.procs, 'pcpu', 5), (v) => formatPct(v), (v) => thresholdLevel(v, th.cpuWarn, th.cpuDanger))
    fillTopList(cards.memList, topProcesses(st.procs, 'rss', 5), (v) => formatKb(v), () => 'ok')
  }, [tab, mode, dashVersion, st])

  // —— Quick spark 重绘 ——
  useEffect(() => {
    if (mode !== 'quick') return
    const cv = quickCanvasRef.current
    if (!cv) return
    const css = getComputedStyle(document.documentElement)
    drawSparkline(cv, [
      { data: st.cpuRing.items, color: css.getPropertyValue('--accent').trim() || '#bd542b' },
      { data: st.memRing.items, color: css.getPropertyValue('--ok').trim() || '#318469', fill: 'transparent' },
    ], { max: Math.max(100, Math.max(1, ...st.memRing.items)), grid: false })
    const cpuLast = st.cpuRing.items.at(-1)
    const memLast = st.memRing.items.at(-1)
    const cpuEl = document.getElementById('q-cpu')
    const memEl = document.getElementById('q-mem')
    if (cpuEl) cpuEl.textContent = cpuLast != null ? formatPct(cpuLast) : '-'
    if (memEl) memEl.textContent = memLast != null ? formatKb(memLast) : '-'
    const procsEl = document.getElementById('q-procs')
    if (procsEl) procsEl.textContent = st.procs.length ? `${st.procs.length} 进程` : ''
  }, [mode, quickList, dashVersion, st])

  // —— 生命周期 / 启动 ——
  useEffect(() => {
    let alive = true
    const kit = PluginKit.create({
      title: '进程与端口',
      quickPlaceholder: '端口号查占用 / 进程名搜索',
      height: 460,
      defaults: { intervalMs: 1500, cpuWarn: 70, cpuDanger: 90, memWarn: 70, memDanger: 90 },
    })
    kitRef.current = kit
    modeRef.current = kit.mode
    setModeState(kit.mode)

    document.addEventListener('visibilitychange', onVis)
    api?.onOut?.(() => stopSamplerRef.current())
    api?.onEnter?.((event) => {
      applyMode(event?.mode ?? kit.mode)
      void refreshRef.current({ silent: true })
    })
    api?.ui?.onThemeChange?.(() => setDashVersion((v) => v + 1))
    api?.onModeChange?.((m) => applyMode(m))
    api?.onBeforeClose?.(async () => {
      stopSamplerRef.current()
      await persistRef.current()
    })

    void (async () => {
      const prefs = await kit.load('sysguard_prefs', null)
      if (!alive) return
      if (prefs) {
        st.hideSys = prefs.hideSys === true
        st.favs = new Set(Array.isArray(prefs.favs) ? prefs.favs : [])
        if (INTERVALS.includes(Number(prefs.intervalMs))) st.intervalMs = Number(prefs.intervalMs)
      }
      await kit.ready
      if (!alive) return
      const hostInterval = Number(kit.settings.intervalMs)
      if (INTERVALS.includes(hostInterval)) st.intervalMs = hostInterval
      setHideSys(st.hideSys)
      setIntervalMs(st.intervalMs)
      PluginKit.upgradeSelects() // 纯 .value 赋值不触发 change，同步自定义下拉标签
      const capacity = Math.min(240, Math.max(16, Math.round(60000 / st.intervalMs)))
      st.cpuRing.setCapacity(capacity)
      st.memRing.setCapacity(capacity)
      applyMode(kit.mode)
      await refreshRef.current()
      if (!alive) return
      if (kit.mode === 'quick') {
        void api?.ui?.resize?.({ height: 460 })
      }
    })()

    function onVis() {
      if (document.hidden) stopSamplerRef.current()
      else {
        restartSamplerRef.current()
        void refreshRef.current({ silent: true })
      }
    }

    const onResize = () => setDashVersion((v) => v + 1)
    window.addEventListener('resize', onResize)

    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('resize', onResize)
      stopSamplerRef.current()
      kit.destroy?.()
    }
  }, [applyMode, st])
  const stopSamplerRef = useRef(stopSampler)
  stopSamplerRef.current = stopSampler
  const restartSamplerRef = useRef(restartSampler)
  restartSamplerRef.current = restartSampler
  const persistRef = useRef(persist)
  persistRef.current = persist

  // —— 进程表面板挂载（dataTable 工厂在 effect 中创建一次）——
  useEffect(() => {
    if (mode !== 'shell' || tab !== 'proc' || procPaneRef.current?._table) return
    const table = PluginKit.dataTable({
      sortBy: 'pcpu',
      sortDir: 'desc',
      onRowClick: (row) => killRef.current(row),
      columns: [
        { key: 'fav', label: '', sortable: false, width: '30px' },
        { key: 'pid', label: 'PID', num: true, sortable: true, width: '84px' },
        { key: 'name', label: '进程', sortable: true },
        { key: 'user', label: '用户', sortable: true, width: '96px' },
        { key: 'pcpu', label: 'CPU%', num: true, sortable: true, width: '84px' },
        { key: 'rss', label: '内存', num: true, sortable: true, width: '96px', render: (row) => formatKb(row.rss) },
        { key: 'op', label: '', sortable: false, width: '72px' },
      ],
    })
    procTableRef.current = table
    if (procPaneRef.current) {
      procPaneRef.current.appendChild(table.el)
      procPaneRef.current._table = table
      if (procSearchRef.current && procSearchRef.current.value !== st.search) procSearchRef.current.value = st.search
    }
    updateProcTableRef.current()
    return () => {
      procTableRef.current = null
      if (procPaneRef.current) procPaneRef.current.innerHTML = ''
    }
  }, [mode, tab, st])

  // —— 端口表面板挂载 ——
  useEffect(() => {
    if (mode !== 'shell' || tab !== 'port' || portPaneRef.current?._table) return
    const table = PluginKit.dataTable({
      sortBy: 'port',
      sortDir: 'asc',
      onRowClick: (row) => {
        st.linkedPid = row.pid
        st.search = String(row.pid)
        const procSearch = procSearchRef.current
        if (procSearch) procSearch.value = st.search
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
          },
        },
        { key: 'pid', label: 'PID', num: true, sortable: true, width: '84px' },
        { key: 'user', label: '用户', width: '96px' },
      ],
    })
    portTableRef.current = table
    if (portPaneRef.current) {
      portPaneRef.current.appendChild(table.el)
      portPaneRef.current._table = table
      if (portSearchRef.current && portSearchRef.current.value !== st.search) portSearchRef.current.value = st.search
    }
    updatePortTable()
    return () => {
      portTableRef.current = null
      if (portPaneRef.current) portPaneRef.current.innerHTML = ''
    }
  }, [mode, tab, st, updatePortTable, switchTab])

  // —— 概览卡 DOM refs 采集（canvas 无法走 React ref 的兄弟节点结构保持原样）——
  const dashRef = useCallback((node) => {
    if (!node) return
    const q = (sel, root) => root.querySelector(sel)
    const makeCard = (key) => {
      const card = q(`[data-card="${key}"]`, node)
      if (!card) return null
      return { card, value: q('.sg-card-value', card), spark: q('canvas', card), footEl: q('.sg-card-sub', card) }
    }
    dashCardRefs.current = {
      cpu: makeCard('cpu'),
      mem: makeCard('mem'),
      procs: makeCard('procs'),
      ports: makeCard('ports'),
      cpuList: q('.sg-toplist:nth-of-type(1) .sg-toplist-list', node),
      memList: q('.sg-toplist:nth-of-type(2) .sg-toplist-list', node),
    }
    setDashVersion((v) => v + 1)
  }, [])

  // —— 事件处理器（与原 wireDom 对应）——
  const onHideSys = async (e) => {
    st.hideSys = e.target.checked
    setHideSys(e.target.checked)
    await persist()
    updateProcTable()
  }

  const onInterval = async (e) => {
    const value = Number(e.target.value)
    if (!INTERVALS.includes(value)) return
    st.intervalMs = value
    setIntervalMs(value)
    const capacity = Math.min(240, Math.max(16, Math.round(60000 / value)))
    st.cpuRing.setCapacity(capacity)
    st.memRing.setCapacity(capacity)
    await persist()
    restartSampler()
    setStatus(`刷新频率：每 ${value / 1000} 秒`)
  }

  let quickDeb = 0
  const onQuickInput = (e) => {
    clearTimeout(quickDeb)
    const value = e.target.value
    quickDeb = setTimeout(() => renderQuickListRef.current(value), 160)
  }
  const onQuickKeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      renderQuickListRef.current(e.target.value)
    }
  }

  // —— 渲染 ——
  const quick = quickList
  const renderQuickRows = () => {
    if (!quick || quick.kind !== 'rows' || !Array.isArray(quick.rows)) {
      return <div className="sg-empty">{'输入端口号查询监听占用\n或输入进程名 / pid 搜索并结束进程'}</div>
    }
    return quick.rows.map((r, i) => {
      if (r.kind === 'empty-text') return <div className="sg-empty" key={i}>{r.text}</div>
      if (r.kind === 'head') return <div className="sg-row36 sg-row-head" key={i}><span className="pk-muted">{r.text}</span></div>
      if (r.kind === 'port') {
        return (
          <div className="sg-row36" key={i}>
            <span className="pk-muted mono">{r.protocol}</span>
            <span className="mono">{r.address}</span>
            <span className="name">{r.name}</span>
            <span className="num">{`#${r.pid}`}</span>
            <button className="sg-btn tiny danger" type="button" onClick={() => killRef.current(r.proc)}>结束</button>
          </div>
        )
      }
      return (
        <div className="sg-row36" key={i}>
          <span className="num pk-muted">{`#${r.pid}`}</span>
          <span className="name">{r.name}</span>
          <span className="num">{r.cpu}</span>
          <span className="num">{r.mem}</span>
          <button className="sg-btn tiny danger" type="button" onClick={() => killRef.current(r.proc)}>结束</button>
        </div>
      )
    })
  }

  return (
    <main className="sg" id="app">
      {/* Quick：单列表 */}
      <section className="sg-quick" id="quick-view" hidden={mode !== 'quick'}>
        <div className="sg-quick-bar">
          <input id="q-input" type="search" placeholder="输入端口号查占用，或进程名 / pid 搜索"
            onInput={onQuickInput} onKeyDown={onQuickKeydown}
          />
          <button type="button" className="sg-btn primary" id="q-search"
            onClick={(e) => renderQuickListRef.current(e.target.previousElementSibling?.value ?? '')}>查询</button>
        </div>
        <div className="sg-quick-list" id="q-list">
          {mode === 'quick' && st.error ? (
            <div className="sg-error">{`采样失败：${st.error}\n请确认宿主已授权 sys.inspect 权限`}</div>
          ) : renderQuickRows()}
        </div>
        <div className="sg-quick-spark" id="q-spark">
          <div className="sg-quick-meter" aria-hidden="true">
            <canvas id="q-canvas" ref={quickCanvasRef} height="56" aria-label="CPU / 内存曲线"></canvas>
          </div>
          <div className="sg-quick-legend">
            <span><i className="dot" style={{ background: 'var(--accent)' }}></i>CPU <b id="q-cpu">-</b></span>
            <span><i className="dot" style={{ background: 'var(--ok)' }}></i>内存 <b id="q-mem">-</b></span>
            <span className="sg-quick-procs" id="q-procs"></span>
          </div>
        </div>
      </section>

      {/* 桌面：概览 | 进程 | 端口 | 曲线 */}
      <section className="sg-desktop" id="desktop-view" hidden={mode !== 'shell'}>
        <header className="sg-top">
          <h1 className="sg-logo">进程与端口</h1>
          <nav className="sg-tabs" id="tabs" role="tablist">
            {[['dash', '概览'], ['proc', '进程'], ['port', '端口'], ['chart', '曲线']].map(([key, label]) => (
              <button key={key} type="button" data-tab={key}
                className={tab === key ? 'active' : ''}
                aria-selected={String(tab === key)}
                onClick={() => switchTab(key)}>{label}</button>
            ))}
          </nav>
          <div className="sg-spacer"></div>
          <label className="sg-check" title="隐藏 uid<500 或 root 的系统进程">
            <input type="checkbox" id="hide-sys" checked={hideSys} onChange={onHideSys} /> 隐藏系统进程
          </label>
          <label className="sg-check sg-check-select" title="采样刷新频率">
            <select id="interval" aria-label="刷新频率" value={String(intervalMs)} onChange={onInterval}>
              {INTERVALS.map((v) => <option key={v} value={String(v)}>{`${v / 1000} 秒`.replace('1.5 秒', '1.5 秒')}</option>)}
            </select>
          </label>
          <button type="button" className="sg-btn" id="refresh" onClick={() => void refresh()}>刷新</button>
        </header>
        <div className="sg-body" id="tab-body">
          {mode === 'shell' && st.error ? (
            <div className="sg-error">{`采样失败：${st.error}\n请确认宿主已授权 sys.inspect 权限`}</div>
          ) : (
            <>
              {tab === 'dash' && (
            <div className="sg-dash" ref={dashRef}>
              <div className="sg-dash-cards">
                <article className="sg-card" data-card="cpu">
                  <div className="sg-card-label">CPU 总占用</div>
                  <div className="sg-card-value mono">—</div>
                  <canvas className="sg-card-spark" aria-hidden="true"></canvas>
                  <div className="sg-card-sub"></div>
                </article>
                <article className="sg-card" data-card="mem">
                  <div className="sg-card-label">物理内存合计</div>
                  <div className="sg-card-value mono">—</div>
                  <canvas className="sg-card-spark" aria-hidden="true"></canvas>
                  <div className="sg-card-sub"></div>
                </article>
                <article className="sg-card" data-card="procs">
                  <div className="sg-card-label">进程数</div>
                  <div className="sg-card-value mono">—</div>
                  <canvas className="sg-card-spark" aria-hidden="true"></canvas>
                  <div className="sg-card-sub"></div>
                </article>
                <article className="sg-card" data-card="ports">
                  <div className="sg-card-label">监听端口</div>
                  <div className="sg-card-value mono">—</div>
                  <canvas className="sg-card-spark" aria-hidden="true"></canvas>
                  <div className="sg-card-sub"></div>
                </article>
              </div>
              <div className="sg-dash-tops">
                <section className="sg-toplist">
                  <h3 className="sg-toplist-title">CPU 占用最高</h3>
                  <ol className="sg-toplist-list"></ol>
                </section>
                <section className="sg-toplist">
                  <h3 className="sg-toplist-title">内存占用最高</h3>
                  <ol className="sg-toplist-list"></ol>
                </section>
              </div>
            </div>
          )}
          {tab === 'proc' && (
            <div className="sg-table-wrap sg-table proc" ref={(node) => { procPaneRef.current = node }}>
              <input ref={procSearchRef} className="sg-search" type="search" placeholder="搜索进程名 / pid"
                data-input-context="editor"
                onInput={(e) => {
                  st.search = e.target.value
                  clearTimeout(st._deb)
                  st._deb = setTimeout(updateProcTable, 160)
                }}
              />
            </div>
          )}
          {tab === 'port' && (
            <div className="sg-table-wrap sg-table port" ref={(node) => { portPaneRef.current = node }}>
              <input ref={portSearchRef} className="sg-search" type="search" placeholder="搜索端口 / pid / 进程名"
                data-input-context="editor"
                onInput={(e) => {
                  st.search = e.target.value
                  clearTimeout(st._debPort)
                  st._debPort = setTimeout(updatePortTable, 160)
                }}
              />
            </div>
          )}
          {tab === 'chart' && (
            <div className="sg-chart">
              <div className="sg-chart-card">
                <div className="sg-chart-head">
                  <span style={{ color: 'var(--accent)' }}>■</span>
                  {' CPU 总占用 '}
                  <b id="sg-cpu-v">-</b>
                </div>
                <canvas id="sg-cpu-cv" ref={chartCpuRef}></canvas>
              </div>
              <div className="sg-chart-card">
                <div className="sg-chart-head">
                  <span style={{ color: 'var(--ok)' }}>■</span>
                  {' 物理内存合计 '}
                  <b id="sg-mem-v">-</b>
                </div>
                <canvas id="sg-mem-cv" ref={chartMemRef}></canvas>
              </div>
              <div className="sg-chart-legend">
                <span><i className="dot" style={{ background: 'var(--accent)' }}></i>CPU%（0-100）</span>
                <span><i className="dot" style={{ background: 'var(--ok)' }}></i>内存（自适应满刻度）</span>
                <span className="pk-muted">滚动窗口 · 隐藏自动暂停</span>
              </div>
            </div>
          )}
            </>
          )}
        </div>
      </section>

      <footer className="sg-foot">
        <span id="foot">{foot}</span>
        <span className="sg-foot-hint">宿主 1s 采样缓存 · 结束进程需二次确认</span>
      </footer>

      <dialog id="dlg" ref={dlgHostRef}></dialog>
    </main>
  )
}
