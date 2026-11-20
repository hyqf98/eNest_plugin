/**
 * holder.mjs — 旧围栏回放的图表懒挂载容器（IntersectionObserver）
 * 供 PanelBody 的 legacy 围栏降级路径使用；新会话的 EChart/Mermaid A2UI 组件
 * 直接调 charts.mjs 引擎（React 生命周期驱动），不经过这里。
 */

import { renderMermaid, renderEChartOption } from './charts.mjs'

function esc(t) {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mountErrorCard(holder, title, source) {
  holder.classList.add('dbai-chart-error')
  holder.innerHTML = `<div class="dbai-chart-error-card"><span class="dbai-chart-error-title">${esc(title)}</span><pre class="dbai-chart-source">${esc(source)}</pre></div>`
}

function tryParseOption(code) {
  try {
    const option = JSON.parse(code)
    if (!option || typeof option !== 'object' || Array.isArray(option)) return null
    return option
  } catch { return null }
}

const lazyObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    lazyObserver.unobserve(entry.target)
    const holder = entry.target
    const code = holder.dataset.code || ''
    if (!code) continue
    if (holder.dataset.chartKind === 'echarts') {
      const option = tryParseOption(code)
      if (option) void renderEChartOption(option, holder)
      else mountErrorCard(holder, 'ECharts 配置不是合法 JSON', code)
    } else {
      void renderMermaid(code, holder)
    }
  }
}, { rootMargin: '120px' })

/** 围栏语言 → 图表类型（非图表围栏返回 null） */
export function chartKindOf(lang) {
  const normalized = String(lang || '').trim().toLowerCase()
  if (normalized === 'mermaid') return 'mermaid'
  if (normalized === 'echarts') return 'echarts'
  return null
}

/** 挂一个懒渲染图表容器（kind: 'mermaid' | 'echarts'） */
export function mountHolder(kind, code) {
  const holder = document.createElement('div')
  holder.className = kind === 'echarts' ? 'dbai-echarts' : 'dbai-mermaid'
  holder.dataset.chartKind = kind
  holder.dataset.code = code
  lazyObserver.observe(holder)
  return holder
}
