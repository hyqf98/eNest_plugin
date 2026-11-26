/**
 * Server overview list: one card per saved server, one row each.
 *
 * Rendering is incremental. Each profile owns one <article> that is created once; a status push
 * only rewrites that row's numbers, bars and sparklines, so a 40-server fleet refreshing every
 * few seconds never rebuilds the list or loses scroll position.
 */

import { bytesText, rateText, uptimeText, networkTotal, rootDisk, sumGpu, manualText } from './server-overview.js'

const PAGE_SIZE = 12
const PLATFORM_NAME = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }
/** Mount points shown with a readable name instead of a raw device path. */
const MOUNT_NAME = { '/': '根分区', '/System/Volumes/Data': '数据卷' }
const mountName = mount => MOUNT_NAME[mount] || mount || ''

const ICON = {
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  memory: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 7v10M12 7v10M17 7v10M6 17v3M12 17v3M18 17v3"/>',
  disk: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M5.6 5.6a9 9 0 0 1 4-2.3"/>',
  gpu: '<path d="M4 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z"/><path d="M2 9v6M8 18v3M16 18v3M9 10h6M9 13h4"/>',
  net: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>',
  terminal: '<path d="m5 7 5 5-5 5M12 17h7"/>',
}
const icon = name => `<svg class="sov-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const pct = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'

function metricCell(kind, label) {
  return `<div class="sov-metric" data-metric="${kind}">${icon(kind)}<div class="sov-metric-body"><div class="sov-metric-head"><span class="sov-metric-label">${label}</span><strong class="sov-metric-value">—</strong></div><div class="sov-track"><i class="sov-fill"></i></div><canvas class="sov-spark" aria-hidden="true"></canvas><small class="sov-metric-sub"></small></div></div>`
}

function rowHtml(profile) {
  const envName = { prod: '生产', staging: '预发', dev: '开发', test: '测试' }[profile.env] || profile.env
  const port = Number(profile.port) || 22
  // `data-server`, not `data-profile`: the connection list in the sidebar already uses the latter.
  return `<article class="sov-card" data-server="${escapeHtml(profile.id)}" tabindex="0" aria-label="${escapeHtml((profile.name || profile.host) + '，按 Enter 打开终端')}">
    <span class="sov-rail" aria-hidden="true"></span>
    <div class="sov-identity">
      <div class="sov-name-row"><strong class="sov-name" title="${escapeHtml(profile.name || profile.host)}">${escapeHtml(profile.name || profile.host)}</strong>${envName ? `<span class="sov-env" data-env="${escapeHtml(profile.env)}">${escapeHtml(envName)}</span>` : ''}<span class="sov-platform"></span></div>
      <div class="sov-target" title="${escapeHtml(profile.username + '@' + profile.host + (port !== 22 ? ':' + port : ''))}"><span class="sov-target-user">${escapeHtml(profile.username)}</span><span class="sov-at">@</span><span class="sov-target-host">${escapeHtml(profile.host)}</span>${port !== 22 ? `<span class="sov-at">:</span><span class="sov-target-port">${port}</span>` : ''}</div>
      <p class="sov-note" role="status"></p>
    </div>
    ${metricCell('cpu', 'CPU')}
    ${metricCell('memory', '内存')}
    ${metricCell('disk', '磁盘')}
    ${metricCell('gpu', 'GPU')}
    ${metricCell('net', '网络')}
    <dl class="sov-facts"></dl>
    <div class="sov-actions">
      <button type="button" class="sov-btn" data-act="signin" hidden title="完成登录后开始监控">登录</button>
      <button type="button" class="sov-btn" data-act="terminal" title="打开终端">${icon('terminal')}<span>终端</span></button>
    </div>
  </article>`
}

/** Levels mirror the plugin's warn/danger thresholds; a level never lowers a stronger one on the same row. */
function levelOf(value, warn, danger) {
  if (!Number.isFinite(value)) return ''
  if (value >= danger) return 'danger'
  if (value >= warn) return 'warn'
  return ''
}

export function createServerOverviewView(root, { thresholds, onTerminal, onSignin, onRetry }) {
  const cards = new Map()
  let visible = 0, rows = []
  const sentinel = document.createElement('div')
  sentinel.className = 'sov-sentinel'
  sentinel.setAttribute('aria-hidden', 'true')
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && visible < rows.length) { visible = Math.min(rows.length, visible + PAGE_SIZE); paint() } }, { root, rootMargin: '240px' }) : null
  if (observer) observer.observe(sentinel)

  /** Draws one polyline. Percent series use a fixed 0-100 scale so two rows are comparable; throughput scales to its own peak. */
  function spark(canvas, values, color, fixedScale) {
    if (!canvas) return
    const width = canvas.clientWidth || 72, height = canvas.clientHeight || 18
    if (!width || !height) return
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    const bitmapWidth = Math.round(width * ratio), bitmapHeight = Math.round(height * ratio)
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) { canvas.width = bitmapWidth; canvas.height = bitmapHeight }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const points = values.filter(value => Number.isFinite(value))
    if (points.length < 2) return
    const peak = fixedScale ? 100 : Math.max(1, ...points)
    ctx.beginPath()
    points.forEach((value, index) => {
      const x = index / (points.length - 1) * width
      const y = height - 1.5 - Math.min(1, Math.max(0, value) / peak) * (height - 3)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()
  }

  function colorOf(element, name) {
    return getComputedStyle(element).getPropertyValue(name).trim()
  }

  function paintRow(card, row) {
    const sample = row.sample, warn = thresholds().warn, danger = thresholds().danger
    card.dataset.state = row.state
    const live = row.state === 'live' && !!sample
    card.classList.toggle('is-live', live)
    card.classList.toggle('is-stale', row.state === 'stale')
    card.classList.toggle('is-failed', row.state === 'failed')
    const signin = card.querySelector('[data-act="signin"]')
    signin.hidden = row.state !== 'manual'
    signin.classList.toggle('sov-btn-signin', row.state === 'manual')
    const note = card.querySelector('.sov-note')
    const noteText = row.state === 'manual' ? manualText(row.manualReason) : row.state === 'connecting' ? '正在连接…' : row.state === 'failed' ? row.error || '连接失败' : row.state === 'stale' ? row.error || '连接中断，显示上次读数' : ''
    if (note.textContent !== noteText) note.textContent = noteText
    card.classList.toggle('has-note', !!noteText)
    const platform = card.querySelector('.sov-platform')
    const platformText = sample ? PLATFORM_NAME[sample.platform] || '' : ''
    if (platform.textContent !== platformText) platform.textContent = platformText

    // `has` says whether a reading exists; the value is already display text ("91.0%", "—", "无")
    // and must not be inspected for that, or every cell would count as empty.
    const set = (kind, { value, sub = '', subTitle, fill, level = '', series, fixedScale, has }) => {
      const cell = card.querySelector(`[data-metric="${kind}"]`)
      if (!cell) return
      cell.dataset.level = level
      cell.classList.toggle('is-empty', !has)
      const valueNode = cell.querySelector('.sov-metric-value')
      if (valueNode.textContent !== value) valueNode.textContent = value
      const subNode = cell.querySelector('.sov-metric-sub')
      const tip = subTitle || sub
      if (subNode.textContent !== sub) { subNode.textContent = sub; subNode.title = tip }
      else if (subNode.title !== tip) subNode.title = tip
      const fillNode = cell.querySelector('.sov-fill')
      const width = Number.isFinite(fill) ? `${Math.max(0, Math.min(100, fill)).toFixed(1)}%` : '0%'
      if (fillNode.style.width !== width) fillNode.style.width = width
      const canvas = cell.querySelector('.sov-spark')
      if (canvas && series) spark(canvas, series, colorOf(cell, '--m'), fixedScale)
    }

    const gpu = sumGpu(sample)
    const disk = rootDisk(sample)
    const net = networkTotal(sample)
    const gpuSub = !gpu ? sample?.gpuError ? '读取失败' : ''
      : gpu.count > 1 ? `${gpu.count} 张` + (gpu.tempC != null ? ` · ${Math.round(gpu.tempC)}°C` : '')
      : gpu.tempC != null ? `${Math.round(gpu.tempC)}°C` : bytesText(gpu.vramUsed)
    // Subtitles are short on purpose: at the 96px column floor anything longer is cut mid-value.
    // The used figure drops its unit only when both share one ("26.7 / 59.6 GB"); "512 MB / 64.0 GB"
    // must keep both, or the used figure would read as 512 GB.
    const memoryUsedText = sample ? bytesText(sample.memUsed) : ''
    const memoryTotalText = sample ? bytesText(sample.memTotal) : ''
    const memoryUnit = memoryTotalText.replace(/^[\d.]+ /, '')
    const memoryText = memoryUsedText.endsWith(' ' + memoryUnit) ? `${memoryUsedText.slice(0, -(memoryUnit.length + 1))} / ${memoryTotalText}` : `${memoryUsedText} / ${memoryTotalText}`.replace(/^ \/ $/, '')
    const diskText = disk ? `${bytesText(disk.used)} / ${bytesText(disk.total)}` : ''
    const netText = sample?.diskReadMbps != null ? `${sample.diskReadMbps.toFixed(1)} / ${sample.diskWriteMbps.toFixed(1)} MB/s` : ''
    set('cpu', { value: pct(sample?.cpuPercent), sub: sample?.cpuCores ? `${sample.cpuCores} 核` : '', fill: sample?.cpuPercent, level: levelOf(sample?.cpuPercent, warn, danger), series: row.series.cpu, fixedScale: true, has: Number.isFinite(sample?.cpuPercent) })
    set('memory', { value: pct(sample?.memPercent), sub: memoryText, fill: sample?.memPercent, level: levelOf(sample?.memPercent, warn, danger), series: row.series.mem, fixedScale: true, has: Number.isFinite(sample?.memPercent) })
    set('disk', { value: pct(disk?.usedPercent), sub: disk ? mountName(disk.mount) : '', subTitle: diskText || undefined, fill: disk?.usedPercent, level: levelOf(disk?.usedPercent, warn, danger), has: Number.isFinite(disk?.usedPercent) })
    // "无" is a real answer (the server has no accelerator), so the cell is not empty once sampled.
    set('gpu', { value: gpu ? pct(gpu.utilPercent) : sample ? '无' : '—', sub: gpuSub, fill: gpu?.memPercent, level: levelOf(gpu?.utilPercent, warn, danger), series: row.series.gpu, fixedScale: true, has: !!gpu || !!sample })
    set('net', { value: rateText(net), sub: netText, series: row.series.net.length > 1 ? row.series.net : undefined, has: Number.isFinite(net) })

    const facts = []
    if (sample?.load1 != null) facts.push(['负载', sample.load1.toFixed(2) + (sample.load5 != null ? ` / ${sample.load5.toFixed(2)}` : '')])
    if (sample?.uptimeSec != null) facts.push(['运行', uptimeText(sample.uptimeSec)])
    if (sample?.processCount != null) facts.push(['进程', String(sample.processCount)])
    if (sample?.tempC != null) facts.push(['温度', `${Math.round(sample.tempC)}°C`])
    const factsNode = card.querySelector('.sov-facts')
    // The facts column is clipped on narrow windows, so each value keeps its full text in a tooltip.
    const factsHtml = facts.map(([term, value]) => `<div title="${escapeHtml(term + ' ' + value)}"><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')
    if (factsNode.dataset.html !== factsHtml) { factsNode.innerHTML = factsHtml; factsNode.dataset.html = factsHtml }
  }

  function paint() {
    if (!root) return
    const list = root.querySelector('.sov-list')
    if (!list) return
    let index = 0
    for (const row of rows) {
      const card = cards.get(row.profileId)
      if (!card) continue
      const show = index < visible
      card.hidden = !show
      if (show) paintRow(card, row)
      index++
    }
    const remaining = rows.length - visible
    sentinel.textContent = remaining > 0 ? `还有 ${remaining} 台，向下滚动查看` : ''
    const empty = root.querySelector('.sov-empty')
    if (empty) empty.hidden = rows.length > 0
    list.hidden = rows.length === 0
  }

  /** Rebuilds card elements only when the profile set itself changed; order follows `next`. */
  function render(next, profilesById) {
    rows = next
    const list = root.querySelector('.sov-list')
    if (!list) return
    const order = next.map(row => row.profileId)
    const sameSet = order.length === cards.size && order.every(id => cards.has(id))
    if (!sameSet) {
      const keep = new Map()
      for (const row of next) {
        let card = cards.get(row.profileId)
        if (!card) {
          const template = document.createElement('template')
          template.innerHTML = rowHtml(profilesById(row.profileId)).trim()
          card = template.content.firstElementChild
        }
        keep.set(row.profileId, card)
      }
      list.replaceChildren(...keep.values(), sentinel)
      cards.clear()
      for (const [id, card] of keep) cards.set(id, card)
      visible = Math.min(PAGE_SIZE, next.length)
    }
    if (observer && sentinel.isConnected !== true) observer.observe(sentinel)
    paint()
  }

  return {
    render,
    resetPages() { visible = Math.min(PAGE_SIZE, rows.length); paint() },
    get visibleCount() { return visible },
    focusFirst() { for (const card of cards.values()) if (!card.hidden) { card.focus(); return } },
    handleAction(event) {
      const card = event.target.closest('[data-server]')
      if (!card) return false
      const action = event.target.closest('[data-act]')?.dataset.act
      if (action === 'terminal') { onTerminal(card.dataset.server); return true }
      if (action === 'signin') { onSignin(card.dataset.server); return true }
      if (action === 'retry') { onRetry?.(card.dataset.server); return true }
      return false
    },
    /** Enter on a focused card opens its terminal; a double click anywhere on the card does the same. */
    activate(profileId) { onTerminal(profileId) },
    destroy() { observer?.disconnect(); cards.clear() },
  }
}
