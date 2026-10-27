/** Quick V1 的隔离呈现页。仅用 enestQuick，不持有应用路径、普通插件桥或业务视图。 */
import { h, reconcileChildren, setAttribute, setProperty, setStyle, setText } from '../shared/dom.js'
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
let lastLayoutInputs = ''
let actionError = ''
let cards = []
const itemViews = new Map()
const groupViews = new Map()
let currentItems = new Map()
let emptyView = null
let emptyKey = ''

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
  setAttribute(root, 'data-theme', mode)
  setAttribute(root, 'data-anim', animation)
  setStyle(root, 'color-scheme', mode)
  for (const key of ['--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-2', '--text-3', '--accent', '--ok', '--danger', '--border', '--border-strong', '--link']) {
    setStyle(root, key, tokens[key])
  }
  const body = [fonts.latin, fonts.cjk].filter(Boolean).join(', ') || fonts.body
  setStyle(root, '--font', body)
  setStyle(root, '--font-heading', fonts.heading || body)
  setStyle(root, '--font-mono', fonts.mono)
  setStyle(root, '--appearance-font-scale', fonts.scale)
  setStyle(root, '--font-size-base', `${14 * fonts.scale}px`)
  setStyle(root, 'font-size', `${14 * fonts.scale}px`)
  for (const [key, value] of Object.entries(components)) {
    const name = { controlRadius: 'control-radius', cardRadius: 'card-radius', panelRadius: 'panel-radius', borderWidth: 'border-width' }[key]
    if (name) setStyle(root, `--appearance-${name}`, `${value}px`)
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
  const changed = error.textContent !== (message || '') || error.hidden !== !message
  setText(error, message)
  setProperty(error, 'hidden', !message)
  if (snapshot?.plugin) setText(pluginStatus, message || (snapshot.plugin.loading ? '正在加载…' : '点击聚焦内容'))
  if (snapshot && !snapshot.plugin) setProperty(market, 'hidden', snapshot.loading || Boolean(message) || !(snapshot.emptyMarket || (!snapshot.searching && snapshot.items.length === 0)))
  if (changed) queueLayout()
}

function submitQuery() {
  if (disposed || composing || input.value === pendingQuery || (pendingQuery === null && input.value === snapshot?.query)) return
  pendingQuery = input.value
  actionError = ''
  showError()
  // 从原生 input 直接提交；不重建 input，不改写光标、选区或输入法候选。
  void act({ type: 'query', query: pendingQuery })
}
input.addEventListener('compositionstart', () => {
  composing = true
  void act({ type: 'composition', active: true })
})
input.addEventListener('compositionend', () => {
  composing = false
  queueMicrotask(() => {
    submitQuery()
    void act({ type: 'composition', active: false })
    if (focusRequest) focusSearch(focusRequest)
  })
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

function createItemView(item) {
  const tile = h('span', { class: 'skq-glyph', 'aria-hidden': 'true' })
  const title = h('strong')
  const subtitle = h('span', { class: 'skq-subtitle' })
  const card = h('button', { type: 'button', class: 'skq-card', role: 'option', tabIndex: -1, 'aria-selected': 'false' }, tile, title, subtitle)
  const events = new AbortController()
  const view = { item, card, events, glyph: undefined }
  const current = () => !disposed && !snapshot?.plugin && currentItems.get(view.item.id)
  card.addEventListener('mouseenter', () => {
    const entry = current()
    if (entry && !snapshot.busy && snapshot.selectedId !== entry.id) void act({ type: 'select', id: entry.id })
  }, { signal: events.signal })
  // The current opaque handle is never derived from presentation text or an old snapshot.
  card.addEventListener('click', () => {
    const entry = current()
    if (entry && !snapshot.busy) void act({ type: 'open', id: entry.id })
  }, { signal: events.signal })
  view.update = (next, index) => {
    view.item = next
    const glyph = next.kind === 'action' ? 'action' : `text:${Array.from(next.title || '?')[0]}`
    if (glyph !== view.glyph) {
      view.glyph = glyph
      tile.replaceChildren(next.kind === 'action' ? icon('spark', 22) : Array.from(next.title || '?')[0])
    }
    setAttribute(card, 'id', `skq-item-${index}`)
    setAttribute(card, 'title', [next.title, next.subtitle].filter(Boolean).join(' · '))
    setAttribute(card, 'data-kind', next.kind)
    setText(title, next.title)
    setText(subtitle, next.subtitle || KIND_NAMES[next.kind])
  }
  view.dispose = () => { events.abort(); card.remove() }
  return view
}

function renderItems(state) {
  // This theme paints glyphs, not DTO icons; icon enrichment must not rebuild the grid.
  const signature = JSON.stringify([state.items.map(item => [item.id, item.group, item.kind, item.title, item.subtitle]),
    !state.items.length && [state.loading, state.searching, state.emptyMarket, state.error]])
  if (signature === lastItems) return
  lastItems = signature
  const groups = []
  const occurrences = new Map()
  let group
  let previousGroup
  cards = state.items.map((item, index) => {
    // Preserve contiguous DTO groups and the host's selection order.
    if (!group || previousGroup !== item.group) {
      previousGroup = item.group
      const occurrence = occurrences.get(item.group) ?? 0
      occurrences.set(item.group, occurrence + 1)
      const key = JSON.stringify([item.group, occurrence])
      let view = groupViews.get(key)
      if (!view) {
        const heading = h('h2')
        const grid = h('div', { class: 'skq-grid' })
        view = { heading, grid, node: h('section', { class: 'skq-group', role: 'group' }, heading, grid) }
        groupViews.set(key, view)
      }
      const label = `skq-group-${index}`
      setAttribute(view.heading, 'id', label)
      setAttribute(view.node, 'aria-labelledby', label)
      setText(view.heading, GROUP_NAMES[item.group] || item.group || '启动项')
      group = { key, view, nodes: [] }
      groups.push(group)
    }
    let view = itemViews.get(item.id)
    if (!view) { view = createItemView(item); itemViews.set(item.id, view) }
    view.update(item, index)
    group.nodes.push(view.card)
    return view
  })
  const wantedGroups = new Set(groups.map(entry => entry.key))
  for (const [key, view] of groupViews) if (!wantedGroups.has(key)) { view.node.remove(); groupViews.delete(key) }
  for (const entry of groups) reconcileChildren(entry.view.grid, entry.nodes)
  if (!cards.length) {
    const key = JSON.stringify([state.loading, state.searching, state.emptyMarket, state.error])
    if (!emptyView || key !== emptyKey) {
      emptyKey = key
      if (state.loading) {
        emptyView = h('div', { class: 'skq-grid skq-skeletons', 'aria-hidden': 'true' })
        for (let index = 0; index < 6; index++) emptyView.appendChild(h('div', { class: 'skq-skeleton' }, h('i'), h('span')))
      } else {
        emptyView = h('div', { class: 'skq-empty' }, icon('search', 27),
          h('strong', null, state.error ? '搜索暂时不可用' : state.searching ? '没有找到匹配项' : '还没有可用的启动项'),
          h('span', null, state.error ? '请稍后重试搜索。' : state.emptyMarket ? '试试其他关键词，或去插件市场找工具。' : state.searching ? '试试其他关键词或搜索类型。' : '可以先去插件市场安装常用工具。'))
      }
    }
    reconcileChildren(resultContent, [emptyView])
  } else {
    emptyView = null
    emptyKey = ''
    reconcileChildren(resultContent, groups.map(entry => entry.view.node))
  }
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
  currentItems = new Map(state.items.map(item => [item.id, item]))
  let removedItems = false
  for (const [id, view] of itemViews) {
    const item = currentItems.get(id)
    if (item) view.item = item
    else { view.dispose(); itemViews.delete(id); removedItems = true }
  }
  if (removedItems) {
    lastItems = ''
    cards = cards.filter(view => currentItems.has(view.item.id))
    // Plugin mode skips list rendering, but must still release vanished result groups.
    for (const [key, view] of groupViews) if (!view.grid.childElementCount) {
      view.node.remove()
      groupViews.delete(key)
    }
  }
  applyQuickAppearance(state.appearance)
  const plugin = Boolean(state.plugin)
  setAttribute(surface, 'data-mode', plugin ? 'plugin' : 'list')
  setProperty(back, 'hidden', !plugin)
  setProperty(pluginBar, 'hidden', !plugin)
  setProperty(panel, 'hidden', plugin)
  setAttribute(input, 'placeholder', state.plugin?.placeholder || '搜索应用、插件或操作')
  setAttribute(input, 'aria-label', plugin ? `搜索 ${state.plugin.title}` : '搜索应用、插件或操作')
  setAttribute(input, 'aria-expanded', !plugin)
  if (plugin) setAttribute(input, 'aria-activedescendant', null)
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
    setText(pluginTitle, state.plugin.title)
    setText(pluginStatus, state.plugin.loading ? '正在加载…' : '点击聚焦内容')
    setProperty(pin, 'disabled', state.busy || state.plugin.loading)
  } else {
    filterButtons.forEach((control, index) => {
      setAttribute(control, 'aria-pressed', state.filter === FILTERS[index][0])
      setProperty(control, 'disabled', state.busy)
    })
    setText(status, state.busy ? '正在打开…' : state.loading ? '正在查找…' : state.items.length ? `${state.items.length} 项${state.hiddenCount ? `，另有 ${state.hiddenCount} 项` : ''}` : '')
    setAttribute(results, 'aria-busy', state.loading || state.busy)
    renderItems(state)
    let active
    cards.forEach(({ item, card }) => {
      const selected = item.id === state.selectedId
      setAttribute(card, 'aria-selected', selected)
      setProperty(card, 'disabled', state.busy)
      if (selected) active = card
    })
    if (active) {
      setAttribute(input, 'aria-activedescendant', active.id)
      if (previousSelected !== state.selectedId) active.scrollIntoView({ block: 'nearest' })
    } else setAttribute(input, 'aria-activedescendant', null)
    setProperty(more, 'hidden', !state.expanded && state.hiddenCount === 0)
    setProperty(more, 'disabled', state.busy)
    setAttribute(more, 'aria-expanded', state.expanded)
    setText(more, state.expanded ? '收起' : `更多 ${state.hiddenCount} 项`)
    setProperty(market, 'hidden', state.loading || Boolean(state.error || actionError) || !(state.emptyMarket || (!state.searching && state.items.length === 0)))
    setProperty(market, 'disabled', state.busy)
    setProperty(keys, 'hidden', !state.items.length)
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
  const layoutInputs = JSON.stringify([lastAppearance, lastItems, plugin, state.plugin?.title, state.plugin?.loading,
    state.busy, state.loading, state.expanded, state.hiddenCount, state.emptyMarket, state.error, actionError])
  if (layoutInputs !== lastLayoutInputs) { lastLayoutInputs = layoutInputs; queueLayout() }
}

function queueLayout() {
  if (disposed || !ready || layoutFrame) return
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    const width = surface.clientWidth
    if (!width || !snapshot) return
    columns = Math.max(1, Math.min(8, Math.floor((width - 24 + 10) / 134)))
    setStyle(surface, '--skq-columns', columns)
    // 测量内层自然高度，不能用已被宿主 clamp 的视口高度反推所需尺寸。
    const height = snapshot.plugin ? 64 : Math.max(64, Math.min(545, Math.ceil(64 + filters.offsetHeight + status.offsetHeight + error.offsetHeight + resultContent.scrollHeight + footer.offsetHeight)))
    const key = `${columns}:${height}`
    if (key === lastLayout) return
    lastLayout = key
    void act({ type: 'layout', columns, height })
  })
}

function syncVisibility() { setAttribute(root, 'data-sk-visible', !document.hidden) }
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
  for (const view of itemViews.values()) view.dispose()
  itemViews.clear()
  groupViews.clear()
  currentItems.clear()
  cards = []
  emptyView = null
  snapshot = null
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
