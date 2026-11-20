/**
 * charts.mjs — A2UI 组件内的图表引擎（由旧围栏渲染层迁移）
 * Mermaid：动态 import + svgCache（code+dark 键，上限 24）；主题变量跟随插件深浅色。
 * ECharts：按需 core + Bar/Line/Pie/Scatter + Grid/Tooltip/Legend + CanvasRenderer；
 * option 为纯 JSON 对象（A2UI 数据绑定天然不带函数）；实例池上限 12（LRU dispose）。
 * 对外仍导出 isDarkTheme/watchThemeChanges 供面板与空态使用。
 */

const SVG_CACHE_MAX = 24
const CHART_POOL_MAX = 12

const svgCache = new Map()
let mermaidModule = null
let mermaidLoading = null
let mermaidSeq = 0

const chartPool = new Map() // container -> instance
let echartsCore = null
let echartsLoading = null

export function isDarkTheme() {
  const root = document.documentElement
  return root.dataset.theme === 'dark' || root.dataset.scheme === 'dark' || root.dataset.paper === 'dark' || root.dataset.paper === 'board'
}

function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ── Mermaid ── */

async function loadMermaid() {
  if (mermaidModule) return mermaidModule
  if (!mermaidLoading) {
    mermaidLoading = import('mermaid').then((mod) => {
      mermaidModule = mod.default ?? mod
      return mermaidModule
    })
  }
  return mermaidLoading
}

function mermaidConfig(dark) {
  const lightVars = {
    background: '#ffffff',
    primaryColor: '#f5f2ec',
    primaryTextColor: '#2f3437',
    primaryBorderColor: '#b8b2a6',
    lineColor: '#8a8578',
    secondaryColor: '#eee9df',
    tertiaryColor: '#f7f6f3',
    fontFamily: 'inherit'
  }
  const darkVars = {
    background: '#1e2126',
    primaryColor: '#2a2f36',
    primaryTextColor: '#e6e3dc',
    primaryBorderColor: '#5c6672',
    lineColor: '#8a94a0',
    secondaryColor: '#313842',
    tertiaryColor: '#262b31',
    fontFamily: 'inherit'
  }
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    fontFamily: 'inherit',
    theme: 'base',
    themeVariables: dark ? darkVars : lightVars
  }
}

/** 渲染 mermaid 到 holder；失败降级源码 + 错误提示（不白屏） */
export async function renderMermaid(code, holder) {
  const dark = isDarkTheme()
  const cacheKey = `${dark ? 1 : 0}|${code}`
  try {
    let svg = svgCache.get(cacheKey)
    if (!svg) {
      const mermaid = await loadMermaid()
      const id = `dbai-mermaid-svg-${++mermaidSeq}`
      mermaid.initialize(mermaidConfig(dark))
      const rendered = await mermaid.render(id, code)
      svg = rendered.svg
      if (svgCache.size >= SVG_CACHE_MAX) svgCache.delete(svgCache.keys().next().value)
      svgCache.set(cacheKey, svg)
    }
    if (!holder.isConnected) return
    holder.innerHTML = svg
    holder.classList.add('dbai-mermaid-done')
    const svgEl = holder.querySelector('svg')
    if (svgEl) {
      svgEl.removeAttribute('height')
      svgEl.style.maxWidth = '100%'
    }
  } catch (error) {
    if (!holder.isConnected) return
    holder.classList.add('dbai-chart-error')
    const message = error instanceof Error ? error.message : String(error)
    holder.innerHTML = `<div class="dbai-chart-error-card"><span class="dbai-chart-error-title">Mermaid 图形渲染失败</span><pre>${esc(message)}</pre><pre class="dbai-chart-source">${esc(code)}</pre></div>`
  }
}

/* ── ECharts ── */

async function loadECharts() {
  if (echartsCore) return echartsCore
  if (!echartsLoading) {
    echartsLoading = Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers')
    ]).then(([core, charts, components, renderers]) => {
      core.use([
        charts.BarChart, charts.LineChart, charts.PieChart, charts.ScatterChart,
        components.GridComponent, components.TooltipComponent, components.LegendComponent,
        renderers.CanvasRenderer
      ])
      echartsCore = core
      return core
    })
  }
  return echartsLoading
}

function darkChartOption(option) {
  // 深色底：透明背景 + 浅色文字；只覆盖顶层 textStyle/legend/tooltip 的颜色
  return {
    backgroundColor: 'transparent',
    textStyle: { color: '#e6e3dc', ...(option.textStyle || {}) },
    legend: option.legend ? (Array.isArray(option.legend) ? option.legend.map((l) => ({ textStyle: { color: '#e6e3dc' }, ...l })) : { textStyle: { color: '#e6e3dc' }, ...option.legend }) : undefined,
    tooltip: { ...option.tooltip },
    ...option
  }
}

/** 渲染 echarts option 到容器；import 失败降级错误卡 */
export async function renderEChartOption(option, container) {
  try {
    const echarts = await loadECharts()
    if (!container.isConnected) return
    disposeChart(container)
    // 缓存 option：主题切换 refreshCharts dispose 后能按内容重画（A2UI 组件的 option
    // 是对象，不像旧围栏有 data-code 可取）
    container.__echartsOption = option
    const dark = isDarkTheme()
    const instance = echarts.init(container, null, { renderer: 'canvas' })
    instance.setOption(dark ? darkChartOption(option) : { backgroundColor: 'transparent', ...option })
    chartPool.set(container, instance)
    if (chartPool.size > CHART_POOL_MAX) {
      const oldest = chartPool.keys().next().value
      if (oldest && oldest !== container) {
        chartPool.get(oldest)?.dispose()
        chartPool.delete(oldest)
        if (oldest.isConnected) oldest.classList.add('dbai-chart-evicted')
      }
    }
  } catch (error) {
    if (!container.isConnected) return
    container.classList.add('dbai-chart-error')
    const message = error instanceof Error ? error.message : String(error)
    container.innerHTML = `<div class="dbai-chart-error-card"><span class="dbai-chart-error-title">ECharts 渲染失败</span><pre>${esc(message)}</pre></div>`
  }
}

export function disposeChart(container) {
  const instance = chartPool.get(container)
  if (instance) {
    instance.dispose()
    chartPool.delete(container)
  }
}

export function resizeChart(container) {
  chartPool.get(container)?.resize()
}

/** 主题切换后重画：echarts 按缓存的 option 重画（深浅色不同 option 包装），mermaid 按源码重画 */
export function refreshCharts(root = document) {
  for (const [container, instance] of chartPool) {
    if (!container.isConnected) { instance.dispose(); chartPool.delete(container); continue }
    instance.dispose()
    chartPool.delete(container)
    const option = container.__echartsOption
    if (option) void renderEChartOption(option, container)
  }
  root.querySelectorAll('.dbai-mermaid[data-code]').forEach((holder) => {
    holder.classList.remove('dbai-mermaid-done')
    void renderMermaid(holder.dataset.code, holder)
  })
}

/** 主题变化监听（panel 初始化时挂一次） */
export function watchThemeChanges(onChange) {
  const observer = new MutationObserver(() => onChange?.())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'data-paper'] })
  return () => observer.disconnect()
}
