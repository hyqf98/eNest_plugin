import { sessionsList, sessionsRead, netFetch, errMsg } from './api.js'
/**
 * com.github.eNest.ccswitch — 用量统计
 * 数据源：agent.sessions 通道逐文件解析 assistant 行 usage
 * （claude: message.usage.{input,output,cache_read_input,cache_creation_input}_tokens；
 *   codex: event_msg token_count payload.info.total_token_usage；
 *   gemini: messages[].tokens.{input,output,cached,thoughts}）
 * 聚合：token 总量 / 请求数 / 按日趋势条形图 / 年度热力图 / 模型分布。
 * 纯前端 canvas，主题 token 配色。命名空间挂 window.CCS.usage。
 */

function tsToDay(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 行级 usage 提取：返回 { ts, model, input, output, cacheRead, cacheWrite } 或 null */
function extractUsage(line) {
  const v = line.json
  if (!v || typeof v !== 'object') return null
  const ts = Date.parse(v.timestamp)
  if (!Number.isFinite(ts)) return null
  // claude 语义
  if (v.type === 'assistant' && v.message?.usage) {
    const u = v.message.usage
    const total = (u.input_tokens || 0) + (u.output_tokens || 0)
    if (!total) return null
    return {
      ts,
      model: v.message.model || 'unknown',
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0
    }
  }
  // codex 语义（token_count 快照近似为增量）
  if (v.type === 'event_msg' && v.payload?.type === 'token_count') {
    const u = v.payload.info?.total_token_usage || v.payload.info?.last_token_usage
    if (!u) return null
    const total = (u.input_tokens || 0) + (u.output_tokens || 0)
    if (!total) return null
    return {
      ts,
      model: v.payload.info?.model || v.payload.model || 'unknown',
      input: u.input_tokens || 0,
      output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
      cacheRead: u.cached_input_tokens || u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_write_input_tokens || 0
    }
  }
  // gemini 语义
  if (v.type === 'gemini' && v.tokens) {
    const t = v.tokens
    const total = (t.input || 0) + (t.output || 0)
    if (!total) return null
    return {
      ts,
      model: v.model || 'unknown',
      input: t.input || 0,
      output: (t.output || 0) + (t.thoughts || 0),
      cacheRead: t.cached || 0,
      cacheWrite: 0
    }
  }
  return null
}

/** 全量聚合一个应用的 usage（读列表全部文件；单文件 maxBytes 256KB 平衡速度） */
async function aggregate(app, { onProgress } = {}) {
  const roots = await sessionsList(app)
  const records = []
  let files = 0
  for (const root of roots || []) {
    for (const file of root.files || []) {
      files++
      try {
        const r = await sessionsRead(app, file.file, 256 * 1024)
        for (const line of r.lines) {
          const u = extractUsage(line)
          if (u) records.push(u)
        }
      } catch { /* 单文件失败跳过 */ }
      if (onProgress) onProgress(files, (root.files || []).length)
    }
  }
  // —— 聚合 ——
  const byDay = new Map()
  const byModel = new Map()
  let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0
  for (const r of records) {
    totalIn += r.input
    totalOut += r.output
    totalCacheRead += r.cacheRead
    totalCacheWrite += r.cacheWrite
    const day = tsToDay(r.ts)
    const d = byDay.get(day) || { day, tokens: 0, requests: 0 }
    d.tokens += r.input + r.output + r.cacheRead
    d.requests += 1
    byDay.set(day, d)
    const m = byModel.get(r.model) || { model: r.model, tokens: 0, requests: 0 }
    m.tokens += r.input + r.output
    m.requests += 1
    byModel.set(r.model, m)
  }
  return {
    app,
    files,
    records: records.length,
    totals: { input: totalIn, output: totalOut, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, requests: records.length },
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens)
  }
}

/* —— canvas 图表（主题 token 配色）—— */

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** 按日趋势条形图（近 30 天） */
function drawDaily(canvas, days) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 600
  const h = 160
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)
  const text2 = cssVar('--text-2', '#888')
  const accent = cssVar('--accent', '#e8a33d')
  const border = cssVar('--border', '#333')

  const byDay = new Map(days.map(d => [d.day, d]))
  const buckets = []
  const today = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000)
    const key = tsToDay(d.getTime())
    buckets.push({ key, ...byDay.get(key) })
  }
  const max = Math.max(1, ...buckets.map(b => b.tokens || 0))
  const bw = w / buckets.length
  ctx.font = '10px sans-serif'
  ctx.fillStyle = text2
  ctx.textAlign = 'center'
  buckets.forEach((b, i) => {
    const bh = ((b.tokens || 0) / max) * (h - 36)
    const x = i * bw + bw * 0.15
    ctx.fillStyle = accent
    ctx.globalAlpha = b.tokens ? 0.9 : 0.25
    ctx.fillRect(x, h - 22 - bh, bw * 0.7, Math.max(b.tokens ? 2 : 1, bh))
    ctx.globalAlpha = 1
    if (i % 5 === 0 || i === 29) {
      ctx.fillStyle = text2
      ctx.fillText(b.key.slice(5), i * bw + bw / 2, h - 8)
    }
  })
  ctx.strokeStyle = border
  ctx.beginPath()
  ctx.moveTo(0, h - 21.5)
  ctx.lineTo(w, h - 21.5)
  ctx.stroke()
  // max 标注
  ctx.fillStyle = text2
  ctx.textAlign = 'left'
  ctx.fillText(fmtTokens(max), 4, 12)
}

/** 年度热力图（近 53 周 × 7） */
function drawHeatmap(canvas, days) {
  const dpr = window.devicePixelRatio || 1
  const cell = 10
  const gap = 2
  const weeks = 53
  const w = canvas.clientWidth || 600
  const leftPad = 18
  const topPad = 14
  const h = topPad + 7 * (cell + gap) + 4
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.height = h + 'px'
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  const accent = cssVar('--accent', '#e8a33d')
  const border = cssVar('--border', '#333')
  const text2 = cssVar('--text-2', '#888')

  const byDay = new Map(days.map(d => [d.day, d]))
  const today = new Date()
  // 从本周周六对齐往回 53 周
  const end = new Date(today)
  const start = new Date(end.getTime() - (weeks * 7 - 1 - end.getDay()) * 86400000)
  const max = Math.max(1, ...days.map(d => d.tokens || 0))

  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getTime() + i * 86400000)
    if (d > today) break
    const key = tsToDay(d.getTime())
    const v = byDay.get(key)?.tokens || 0
    const week = Math.floor(i / 7)
    const dow = d.getDay()
    const x = leftPad + week * (cell + gap)
    const y = topPad + dow * (cell + gap)
    ctx.fillStyle = v ? accent : border
    ctx.globalAlpha = v ? 0.25 + 0.75 * (v / max) : 0.35
    ctx.fillRect(x, y, cell, cell)
    ctx.globalAlpha = 1
  }
  ctx.font = '10px sans-serif'
  ctx.fillStyle = text2
  ctx.textAlign = 'left'
  ctx.fillText('少', leftPad, topPad + 7 * (cell + gap) + 14)
  for (let i = 0; i < 4; i++) {
    ctx.globalAlpha = 0.25 + (i / 3) * 0.75
    ctx.fillStyle = accent
    ctx.fillRect(leftPad + 18 + i * 14, topPad + 7 * (cell + gap) + 6, cell, 8)
    ctx.globalAlpha = 1
  }
  ctx.fillStyle = text2
  ctx.fillText('多', leftPad + 18 + 4 * 14 + 4, topPad + 7 * (cell + gap) + 14)
}

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n || 0)
}

/* —— 余额 / 配额（预设带 quotaEndpoint 时）—— */
async function fetchQuota(provider, secretRefPlain) {
  if (!provider?.quotaEndpoint) return null
  const started = performance.now()
  try {
    const headers = {}
    if (secretRefPlain) headers.Authorization = 'Bearer ' + secretRefPlain
    const r = await netFetch({
      url: provider.quotaEndpoint,
      method: 'GET',
      headers,
      timeoutMs: 5000
    })
    return { ok: r.status >= 200 && r.status < 300, status: r.status, latency: Math.round(performance.now() - started), body: r.body }
  } catch (e) {
    return { ok: false, error: errMsg(e), latency: Math.round(performance.now() - started) }
  }
}

/* —— 连接测试：/v1/models 或 HEAD，超时 5s —— */
async function testEndpoint(baseUrl) {
  const target = String(baseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(target)) return { ok: false, error: '端点必须是 http(s):// 开头' }
  const started = performance.now()
  const candidates = [
    { url: target + '/v1/models', method: 'GET' },
    { url: target + '/models', method: 'GET' },
    { url: target, method: 'HEAD' }
  ]
  let lastErr = ''
  for (const c of candidates) {
    try {
      const r = await netFetch({ url: c.url, method: c.method, timeoutMs: 5000 })
      const latency = Math.round(performance.now() - started)
      if (r.status >= 200 && r.status < 500) {
        return { ok: r.status < 400, status: r.status, latency, url: c.url }
      }
      lastErr = 'HTTP ' + r.status
    } catch (e) {
      lastErr = errMsg(e)
    }
  }
  return { ok: false, error: lastErr || '不可达', latency: Math.round(performance.now() - started) }
}

export { extractUsage, aggregate, drawDaily, drawHeatmap, fmtTokens, fetchQuota, testEndpoint }
