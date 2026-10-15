/**
 * core.js — sysguard 纯逻辑（浏览器 / node 通用）
 * 导出：formatKb、formatPct、isSystemProc、searchProc、searchPort、
 *       linkPortsToProc、makeSampler、drawSparkline、SampleRing、decodeArgs、
 *       thresholdLevel、summarize、topProcesses
 */

export function formatKb(kb) {
  if (!Number.isFinite(kb) || kb < 0) return '0 KB'
  if (kb < 1024) return `${Math.round(kb)} KB`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${(kb / 1024 / 1024).toFixed(2)} GB`
}

export function formatPct(v) {
  return `${Number(v ?? 0).toFixed(1)}%`
}

/** 系统进程判定：root 或数字 uid < 500（宿主未回传 uid，按用户名近似：root / _sys* / *daemon 等由开关消费端约定） */
export function isSystemProc(user) {
  const u = String(user ?? '')
  if (u === 'root' || u === '_windowserver' || u === '_launchservicesd') return true
  const m = /^_(.+)$/.exec(u)
  if (!m) return false
  const num = Number(m[1])
  return Number.isFinite(num) ? num < 500 : true
}

/** 进程搜索：名称（command 不区分大小写子串）或 pid 精确/前缀 */
export function searchProc(list, q) {
  const query = String(q ?? '').trim().toLowerCase()
  if (!query) return list
  const asNum = Number(query)
  return list.filter((p) => {
    if (Number.isFinite(asNum) && String(asNum) === String(p.pid)) return true
    return p.command.toLowerCase().includes(query)
  })
}

/** 端口搜索：端口号精确或包含；同时匹配 pid / 进程名 */
export function searchPort(list, q) {
  const query = String(q ?? '').trim().toLowerCase()
  if (!query) return list
  return list.filter((p) => {
    if (String(p.port).includes(query)) return true
    if (String(p.pid) === query) return true
    return String(p.command ?? '').toLowerCase().includes(query)
  })
}

/** 端口表 ↔ 进程表联动：按 pid 建映射 */
export function linkPortsToProc(ports) {
  const map = new Map()
  for (const p of ports ?? []) {
    if (!map.has(p.pid)) map.set(p.pid, [])
    map.get(p.pid).push(p)
  }
  return map
}

/**
 * 采样器：1.5s 周期取宿主 sys.processes，聚合总 CPU% 与总 RSS（KB）。
 * 宿主有 1s 采样缓存，1.5s 周期天然命中缓存节律。
 * acquire: async () => { token } / release: async (token) => {}，页面隐藏时暂停。
 */
export function makeSampler({ intervalMs = 1500, acquire, release, sample }) {
  let timer = 0
  let token = null
  let running = false
  async function tick() {
    if (document.hidden) return
    try {
      if (!token && acquire) {
        token = await acquire()
      }
      await sample()
    } catch { /* 单次失败不终止 */ }
  }
  return {
    start() {
      if (running) return
      running = true
      timer = setInterval(tick, intervalMs)
      void tick()
    },
    async stop() {
      running = false
      if (timer) { clearInterval(timer); timer = 0 }
      if (token && release) {
        try { await release(token) } catch { /* 已释放 */ }
        token = null
      }
    },
    get running() {
      return running
    }
  }
}

/** 环形样本序列：capacity 上限；setCapacity 动态调整（刷新频率设置切换时保留已有样本） */
export class SampleRing {
  constructor(capacity = 64) {
    this.capacity = capacity
    this.items = []
  }
  push(v) {
    this.items.push(v)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
    return this.items
  }
  setCapacity(capacity) {
    this.capacity = Math.max(2, capacity)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }
  clear() {
    this.items = []
  }
  get length() {
    return this.items.length
  }
}

/**
 * 折线绘制（canvas，主题 token 配色；devicePixelRatio 适配）。
 * series: [{ data: number[], color, fill? }]，max：纵轴满刻度（0-100 或自动）。
 */
export function drawSparkline(canvas, series, { max = 100, grid = true } = {}) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || canvas.width
  const h = canvas.clientHeight || canvas.height
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (grid) {
    ctx.strokeStyle = 'rgba(128,128,128,0.18)'
    ctx.lineWidth = 1
    for (const frac of [0.25, 0.5, 0.75]) {
      const y = Math.round(h * frac) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
  }
  for (const s of series) {
    const data = s.data
    if (!data.length) continue
    const step = data.length > 1 ? w / (data.length - 1) : w
    ctx.beginPath()
    data.forEach((v, i) => {
      const x = i * step
      const y = h - Math.min(1, Math.max(0, v / max)) * (h - 2) - 1
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = s.color
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()
    if (s.fill) {
      ctx.lineTo((data.length - 1) * step, h)
      ctx.lineTo(0, h)
      ctx.closePath()
      ctx.fillStyle = s.fill
      ctx.fill()
    }
  }
}

/** 从 ps comm 行提取短名（末段路径） */
export function shortName(command) {
  const c = String(command ?? '').trim()
  if (!c) return '(unknown)'
  const last = c.split('/').pop()
  return last || c
}

/**
 * 阈值分级：v 相对阈值 [warn, danger] 返回 'ok' | 'warn' | 'danger'。
 * CPU 与内存共用同一套 0-100 语义；宿主未提供系统级指标时按进程聚合值评估。
 */
export function thresholdLevel(v, warn = 70, danger = 90) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 'ok'
  return n >= danger ? 'danger' : n >= warn ? 'warn' : 'ok'
}

/**
 * 数据汇总：进程数组 → 仪表盘指标（全部派生自宿主 sys.processes / sys.ports）。
 * totalCpu 已按核数归一到 0-100（ps 的 pcpu 单进程上限即 100，总和无须再裁），
 * 这里仍 clamp 100 防御异常样本。
 */
export function summarize(procs, ports) {
  const list = Array.isArray(procs) ? procs : []
  const totalCpu = Math.min(100, list.reduce((n, p) => n + (p.pcpu ?? 0), 0))
  const totalMemKb = list.reduce((n, p) => n + (p.rss ?? 0), 0)
  // 内存压力：pmem 为占物理内存百分比，取和（ps 语义上限 100）
  const memPct = Math.min(100, list.reduce((n, p) => n + (p.pmem ?? 0), 0))
  const portList = Array.isArray(ports) ? ports : []
  const listenProcs = new Set(portList.map((p) => p.pid))
  return {
    procCount: list.length,
    totalCpu,
    totalMemKb,
    memPct,
    memTop: list.reduce((m, p) => ((p.rss ?? 0) > (m?.rss ?? -1) ? p : m), null),
    cpuTop: list.reduce((m, p) => ((p.pcpu ?? 0) > (m?.pcpu ?? -1) ? p : m), null),
    portCount: portList.length,
    listenCount: listenProcs.size
  }
}

/** Top 进程：按 key（pcpu / rss）降序取前 n，name 为 shortName 结果 */
export function topProcesses(procs, key = 'pcpu', n = 5) {
  const list = Array.isArray(procs) ? procs : []
  return [...list]
    .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))
    .slice(0, Math.max(0, n))
    .map((p) => ({ pid: p.pid, name: shortName(p.command), value: p[key] ?? 0 }))
}
