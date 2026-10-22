/** Quick V1 的隔离呈现页。仅用 enestQuick，不持有应用路径、普通插件桥或业务视图。 */
import { h } from '../shared/dom.js'
import { icon } from '../shared/icons.js'
import { createSketchPaper, mountSketchDefs } from '../shared/sketchPrimitives.js'

const api = window.enestQuick
const container = document.getElementById('quick-root')
if (!container) throw new Error('#quick-root is missing')

const FILTERS = [[null, '全部'], ['app', '应用'], ['plugin', '插件'], ['action', '操作']]
const KIND_NAMES = { app: '应用', plugin: '插件', action: '操作' }
const GROUP_NAMES = { best: '最佳匹配', match: '匹配结果', recommendation: '推荐', provider: '插件提供', recent: '最近使用', apps: '应用', plugins: '插件', actions: '操作' }
const root = document.documentElement
const cleanups = []
let snapshot = null
let disposed = false
let ready = false
let layoutFrame = 0
let composing = false
let pendingQuery = null
let focusRequest = null
let columns = 1
let lastLayout = ''
let lastAppearance = ''
let lastItems = ''
let actionError = ''
let cards = []

const button = (label, glyph, onClick, className = 'skq-tool') => h('button', {
  type: 'button', class: className, title: label, 'aria-label': label, onClick,
}, glyph ? icon(glyph, 18) : null, h('span', { class: 'skq-button-label' }, label))

const input = h('input', {
  id: 'skq-query', class: 'skq-input', type: 'text', role: 'combobox',
  placeholder: '搜索应用、插件或操作', 'aria-label': '搜索应用、插件或操作',
  'aria-autocomplete': 'list', 'aria-controls': 'skq-results', 'aria-expanded': 'true',
  autocomplete: 'off', spellcheck: false,
})
const search = h('div', { class: 'skq-search', role: 'search' }, icon('search', 21), input)
const back = button('返回搜索', 'arrowLeft', () => { void act({ type: 'plugin-back' }) })
const pluginTitle = h('strong', { class: 'skq-plugin-title' })
const pluginStatus = h('span', { class: 'skq-plugin-status', role: 'status' })
const pluginFocus = h('button', {
  type: 'button', class: 'skq-plugin-focus', title: '聚焦插件内容', 'aria-label': '聚焦插件内容',
  onClick: () => { void act({ type: 'plugin-focus' }) },
}, pluginTitle, pluginStatus)
const pin = button('固定到主窗', 'pin', () => { void act({ type: 'plugin-pin' }) })
back.hidden = true
const pluginBar = h('div', { class: 'skq-plugin-bar', hidden: true }, pluginFocus, pin)
const hide = button('收起 Quick', 'close', () => { void act({ type: 'hide' }) })
const bar = h('header', { class: 'skq-bar' }, back, search, pluginBar, hide)
const filters = h('nav', { class: 'skq-filters', 'aria-label': '搜索类型' })
const filterButtons = FILTERS.map(([kind, label]) => {
  const control = h('button', {
    type: 'button', 'aria-pressed': String(kind === null),
    onClick: () => { void act({ type: 'filter', kind }) },
  }, label)
  filters.appendChild(control)
  return control
})
const status = h('p', { class: 'skq-status', role: 'status', 'aria-live': 'polite' })
const error = h('p', { class: 'skq-error', role: 'alert', hidden: true })
const resultContent = h('div', { class: 'skq-result-content' })
const results = h('main', { id: 'skq-results', class: 'skq-results', role: 'listbox', 'aria-label': '启动项', 'aria-busy': 'true' }, resultContent)
const more = h('button', {
  type: 'button', class: 'skq-more', 'aria-controls': 'skq-results', hidden: true,
  onClick: () => { if (snapshot) void act({ type: 'expand', expanded: !snapshot.expanded }) },
})
const market = button('去插件市场', 'layers', () => { void act({ type: 'open-market' }) }, 'skq-market')
const keys = h('span', { class: 'skq-keys' }, '↑ ↓ / Tab 选择', h('kbd', null, 'Enter'), '打开')
const footer = h('footer', { class: 'skq-footer' }, keys, more, market)
const panel = h('section', { class: 'skq-panel' }, filters, status, error, results, footer)
const surface = h('div', { class: 'sk-work sk-quick', 'data-mode': 'list' }, createSketchPaper(), bar, panel)
mountSketchDefs(document.body)
container.replaceChildren(surface)

/** Quick 只应用安全标量外观；V1 fonts 资源为空，不 fetch 媒体、manifest 或旧协议字体。 */
function applyQuickAppearance(appearance) {
  const signature = JSON.stringify(appearance)
  if (signature === lastAppearance) return
  lastAppearance = signature
  const { tokens, fonts, components, mode, animation } = appearance
  root.dataset.theme = mode
  root.dataset.anim = animation
  root.style.colorScheme = mode
  for (const key of ['--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-2', '--text-3', '--accent', '--ok', '--danger', '--border', '--border-strong', '--link']) {
    if (tokens[key]) root.style.setProperty(key, tokens[key])
    else root.style.removeProperty(key)
  }
  const body = [fonts.latin, fonts.cjk].filter(Boolean).join(', ') || fonts.body
  root.style.setProperty('--font', body)
  root.style.setProperty('--font-heading', fonts.heading || body)
  root.style.setProperty('--font-mono', fonts.mono)
  root.style.setProperty('--appearance-font-scale', String(fonts.scale))
  root.style.setProperty('--font-size-base', `${14 * fonts.scale}px`)
  root.style.fontSize = `${14 * fonts.scale}px`
  for (const [key, value] of Object.entries(components)) {
    const name = { controlRadius: 'control-radius', cardRadius: 'card-radius', panelRadius: 'panel-radius', borderWidth: 'border-width' }[key]
    if (name) root.style.setProperty(`--appearance-${name}`, `${value}px`)
  }
}

async function act(action) {
  if (disposed || !api) return false
  try {
    const result = await api.action(action)
    if (disposed) return false
    if (!result.ok) {
      actionError = result.error || '操作未完成，请重试。'
      showError()
    }
    return result.ok
  } catch {
    if (!disposed) { actionError = 'Quick 暂时无法响应，请重试。'; showError() }
    return false
  }
}

function showError() {
  const message = snapshot?.error || actionError
  error.textContent = message || ''
  error.hidden = !message
  if (snapshot?.plugin) pluginStatus.textContent = message || (snapshot.plugin.loading ? '正在加载…' : '点击聚焦内容')
  if (snapshot && !snapshot.plugin) market.hidden = snapshot.loading || Boolean(message) || !(snapshot.emptyMarket || (!snapshot.searching && snapshot.items.length === 0))
  queueLayout()
}

function submitQuery() {
  if (disposed || composing || input.value === pendingQuery || (pendingQuery === null && input.value === snapshot?.query)) return
  pendingQuery = input.value
  actionError = ''
  showError()
  // 从原生 input 直接提交；不重建 input，不改写光标、选区或输入法候选。
  void act({ type: 'query', query: pendingQuery })
}
input.addEventListener('compositionstart', () => { composing = true })
input.addEventListener('compositionend', () => {
  composing = false
  queueMicrotask(() => { submitQuery(); if (focusRequest) focusSearch(focusRequest) })
})
input.addEventListener('input', event => { if (!event.isComposing) submitQuery() })
input.addEventListener('keydown', event => {
  if (event.isComposing || composing || event.keyCode === 229) return
  // 左右/Home/End/选区仍由 input 原生处理。Esc、Cmd+K、Cmd+Enter 留给宿主 before-input。
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (!['ArrowUp', 'ArrowDown', 'Tab', 'Enter'].includes(event.key)) return
  if ((event.key === 'Enter' || event.key === 'Tab') && input.selectionStart !== input.selectionEnd) return
  event.preventDefault()
  void act({ type: 'key', key: event.key, shift: event.shiftKey })
})

function renderItems(state) {
  const signature = JSON.stringify([state.items, state.loading && !state.items.length, state.searching, state.emptyMarket, state.error])
  if (signature === lastItems) return
  lastItems = signature
  cards = []
  const fragment = document.createDocumentFragment()
  if (!state.items.length) {
    if (state.loading) {
      const skeletons = h('div', { class: 'skq-grid skq-skeletons', 'aria-hidden': 'true' })
      for (let index = 0; index < 6; index++) skeletons.appendChild(h('div', { class: 'skq-skeleton' }, h('i'), h('span')))
      fragment.appendChild(skeletons)
    } else {
      fragment.appendChild(h('div', { class: 'skq-empty' }, icon('search', 27),
        h('strong', null, state.error ? '搜索暂时不可用' : state.searching ? '没有找到匹配项' : '还没有可用的启动项'),
        h('span', null, state.error ? '请稍后重试搜索。' : state.emptyMarket ? '试试其他关键词，或去插件市场找工具。' : state.searching ? '试试其他关键词或搜索类型。' : '可以先去插件市场安装常用工具。')))
    }
  }
  let previousGroup
  let grid
  state.items.forEach((item, index) => {
    // 保持 DTO 原顺序，不按 kind 重排，以免与宿主网格选中算法不一致。
    if (!grid || previousGroup !== item.group) {
      previousGroup = item.group
      const label = `skq-group-${index}`
      grid = h('div', { class: 'skq-grid' })
      fragment.appendChild(h('section', { class: 'skq-group', role: 'group', 'aria-labelledby': label },
        h('h2', { id: label }, GROUP_NAMES[item.group] || item.group || '启动项'), grid))
    }
    const tile = h('span', { class: 'skq-glyph', 'aria-hidden': 'true' },
      item.kind === 'action' ? icon('spark', 22) : Array.from(item.title || '?')[0])
    const card = h('button', {
      id: `skq-item-${index}`, type: 'button', class: 'skq-card', role: 'option', tabIndex: -1,
      title: [item.title, item.subtitle].filter(Boolean).join(' · '), 'aria-selected': 'false',
      onMouseenter: () => {
        if (!snapshot?.busy && snapshot?.items.some(entry => entry.id === item.id) && snapshot.selectedId !== item.id) void act({ type: 'select', id: item.id })
      },
      // 句柄不解析、不推导路径；直接从真实 click 交给宿主验证和打开。
      onClick: () => { if (!snapshot?.busy) void act({ type: 'open', id: item.id }) },
    }, tile, h('strong', null, item.title), h('span', { class: 'skq-subtitle' }, item.subtitle || KIND_NAMES[item.kind]))
    card.dataset.kind = item.kind
    cards.push({ item, card })
    grid.appendChild(card)
  })
  resultContent.replaceChildren(fragment)
}

function focusSearch(request) {
  if (!snapshot || composing) { focusRequest = request; return }
  focusRequest = null
  input.focus({ preventScroll: true })
  if (request.selectAll) input.select()
}

function acceptState(state) {
  if (disposed || !state || state.version !== 1 || (snapshot && state.revision < snapshot.revision)) return
  const wasPlugin = Boolean(snapshot?.plugin)
  const previousSelected = snapshot?.selectedId
  snapshot = state
  applyQuickAppearance(state.appearance)
  const plugin = Boolean(state.plugin)
  surface.dataset.mode = plugin ? 'plugin' : 'list'
  back.hidden = !plugin
  pluginBar.hidden = !plugin
  panel.hidden = plugin
  input.placeholder = state.plugin?.placeholder || '搜索应用、插件或操作'
  input.setAttribute('aria-label', plugin ? `搜索 ${state.plugin.title}` : '搜索应用、插件或操作')
  input.setAttribute('aria-expanded', String(!plugin))
  if (plugin) input.removeAttribute('aria-activedescendant')
  if (!composing && (pendingQuery === null || state.query === pendingQuery || plugin !== wasPlugin)) {
    pendingQuery = null
    // 相同内容绝不赋值，异步状态更新也不重置选区。
    if (input.value !== state.query) {
      const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection
      input.value = state.query
      if (document.activeElement === input && start !== null && end !== null) input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length), direction)
    }
  }
  if (plugin) {
    pluginTitle.textContent = state.plugin.title
    pluginStatus.textContent = state.plugin.loading ? '正在加载…' : '点击聚焦内容'
    pin.disabled = state.busy || state.plugin.loading
  } else {
    filterButtons.forEach((control, index) => { control.setAttribute('aria-pressed', String(state.filter === FILTERS[index][0])); control.disabled = state.busy })
    status.textContent = state.busy ? '正在打开…' : state.loading ? '正在查找…' : state.items.length ? `${state.items.length} 项${state.hiddenCount ? `，另有 ${state.hiddenCount} 项` : ''}` : ''
    results.setAttribute('aria-busy', String(state.loading || state.busy))
    renderItems(state)
    let active
    cards.forEach(({ item, card }) => {
      const selected = item.id === state.selectedId
      card.setAttribute('aria-selected', String(selected))
      card.disabled = state.busy
      if (selected) active = card
    })
    if (active) {
      input.setAttribute('aria-activedescendant', active.id)
      if (previousSelected !== state.selectedId) active.scrollIntoView({ block: 'nearest' })
    } else input.removeAttribute('aria-activedescendant')
    more.hidden = !state.expanded && state.hiddenCount === 0
    more.disabled = state.busy
    more.setAttribute('aria-expanded', String(state.expanded))
    more.textContent = state.expanded ? '收起' : `更多 ${state.hiddenCount} 项`
    market.hidden = state.loading || Boolean(state.error || actionError) || !(state.emptyMarket || (!state.searching && state.items.length === 0))
    market.disabled = state.busy
    keys.hidden = !state.items.length
  }
  showError()
  if (focusRequest) focusSearch(focusRequest)
  else if (wasPlugin && !plugin) focusSearch({ selectAll: false })
  if (!ready) {
    // 隐藏预热可能暂停 rAF：首份安全快照同步渲染完成即确认，由宿主负责显示与失败兜底。
    api.ready()
    ready = true
    focusSearch({ selectAll: false })
  }
  queueLayout()
}

function queueLayout() {
  if (disposed || !ready || layoutFrame) return
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    const width = surface.clientWidth
    if (!width || !snapshot) return
    columns = Math.max(1, Math.min(8, Math.floor((width - 24 + 10) / 134)))
    surface.style.setProperty('--skq-columns', String(columns))
    // 测量内层自然高度，不能用已被宿主 clamp 的视口高度反推所需尺寸。
    const height = snapshot.plugin ? 64 : Math.max(64, Math.min(545, Math.ceil(64 + filters.offsetHeight + status.offsetHeight + error.offsetHeight + resultContent.scrollHeight + footer.offsetHeight)))
    const key = `${columns}:${height}`
    if (key === lastLayout) return
    lastLayout = key
    void act({ type: 'layout', columns, height })
  })
}

function syncVisibility() { root.dataset.skVisible = String(!document.hidden) }
syncVisibility()
document.addEventListener('visibilitychange', syncVisibility)
cleanups.push(() => document.removeEventListener('visibilitychange', syncVisibility))
window.addEventListener('resize', queueLayout)
cleanups.push(() => window.removeEventListener('resize', queueLayout))
const observer = new ResizeObserver(queueLayout)
observer.observe(surface)
observer.observe(resultContent)
cleanups.push(() => observer.disconnect())
window.addEventListener('pagehide', () => {
  disposed = true
  cleanups.splice(0).forEach(cleanup => cleanup())
  cancelAnimationFrame(layoutFrame)
}, { once: true })

if (!api) {
  status.textContent = '请从 eNest Quick 打开本页。'
  input.disabled = true
  filters.hidden = true
  footer.hidden = true
  // 不伪造数据或 ready；缺失桥接由宿主保留内置 Quick。
} else {
  cleanups.push(api.onState(acceptState))
  cleanups.push(api.onFocus(request => { if (!disposed) focusSearch(request) }))
  void api.getState().then(acceptState).catch(() => {
    if (!disposed && !snapshot) status.textContent = '无法读取 Quick 状态，等待宿主恢复。'
  })
}
