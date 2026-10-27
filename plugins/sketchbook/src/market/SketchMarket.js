/**
 * 素描本 · 市场工作区（DOM 版，零构建）
 *
 * 两条宿主路由：catalog（目录）、detail（详情）；已安装是目录的本地筛选。
 * 只读 controller 的公开状态，导航与安装都走宿主动作；全局设置入口由宿主持有。
 *
 * 视觉：螺旋装订的笔记本 + 手抖描边索引卡 + 拼贴。手绘感由 SVG 位移滤镜、
 * 手绘涂鸦、胶带与装订环承担，不靠 CSS 圆角。
 *
 * 为什么不用框架：主题首页在 dev 源码态由宿主直接从磁盘读取并注入
 * `script-src 'self'` 的 CSP，没有 vite/JSX 转译例外。纯 JS 才能改完即刷新。
 */
import { h, reconcileChildren, setAttribute, setProperty, setStyle, setText } from '../shared/dom.js'
import { icon } from '../shared/icons.js'
import { createSketchPaper, doodle, tape } from '../shared/sketchPrimitives.js'

const CATEGORY_ORDER = ['效率', '开发', '设计', '媒体', '其它']
const CATEGORY_INK = ['var(--ink-1)', 'var(--ink-2)', 'var(--ink-3)', 'var(--ink-4)', 'var(--ink-5)', 'var(--ink-6)']

const inkFor = category => {
  const index = CATEGORY_ORDER.indexOf(category)
  return CATEGORY_INK[(index < 0 ? 3 : index) % CATEGORY_INK.length]
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 只接受宿主目录槽位；本地 mock 预览额外允许内联图片，生产页面不会放宽。 */
const HOST_MEDIA = /^enest-home:\/\/catalog\/[^/]+\/(?:icon|screenshot\/\d+)$/
const INLINE_MEDIA = /^data:image\/(?:png|jpeg|webp|svg\+xml)[;,]/

function safeMedia(value) {
  if (typeof value !== 'string') return null
  if (HOST_MEDIA.test(value)) return value
  if (INLINE_MEDIA.test(value) && document.documentElement.dataset.sketchbookMock === 'true') return value
  return null
}

const safeIcon = item => safeMedia(item?.icon)
const safeShots = detail => (detail?.screenshots ?? []).map(safeMedia).filter(Boolean)

/** 插件图标：有真实市场图标就用图标，否则用手写首字，保证每张卡都有落点。 */
function avatar(item) {
  return createAvatar(item).node
}

function createAvatar(item) {
  const node = h('span', { class: 'sk-avatar' })
  let source
  let glyph = ''
  let image = null
  let releaseImage = () => {}
  function update(next) {
    const src = safeIcon(next)
    glyph = (next?.glyph || Array.from(next?.name || '?')[0] || '?').slice(0, 1)
    setStyle(node, '--avatar-ink', inkFor(next?.category))
    if (src !== source) {
      releaseImage()
      source = src
      image = src ? h('img', { src, alt: '', loading: 'lazy', draggable: 'false' }) : null
      if (image) {
        const current = image
        const fail = () => {
          if (image !== current) return
          image = null
          if (node.classList.contains('has-image')) node.classList.remove('has-image')
          setText(node, glyph)
        }
        image.addEventListener('error', fail, { once: true })
        releaseImage = () => current.removeEventListener('error', fail)
        node.replaceChildren(image)
      } else releaseImage = () => {}
    }
    if (node.classList.contains('has-image') !== Boolean(image)) node.classList.toggle('has-image', Boolean(image))
    if (!image) setText(node, glyph)
  }
  update(item)
  return { node, update, dispose: () => { releaseImage(); image = null } }
}

/** 装订独立于滚动内容，超出视口的环由自己的裁切层收住。 */
function binding() {
  const wrap = h('div', { class: 'sk-binding', 'aria-hidden': 'true' })
  for (let index = 0; index < 64; index += 1) {
    wrap.appendChild(h('span', null, h('i', { class: 'sk-ring' }), h('i', { class: 'sk-hole' })))
  }
  return wrap
}

function readmeBlocks(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let list = null
  let code = null
  let paragraph = null
  const flush = () => {
    if (!paragraph) return
    out.push(h('p', null, paragraph.join(' ')))
    paragraph = null
  }
  for (const line of lines) {
    if (line.startsWith('```')) {
      flush(); list = null
      if (code) { out.push(h('pre', null, h('code', null, code.join('\n')))); code = null }
      else code = []
      continue
    }
    if (code) { code.push(line); continue }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flush(); list = null
      out.push(h(`h${heading[1].length}`, null, heading[2]))
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      if (!list) { list = h('ul'); out.push(list) }
      list.appendChild(h('li', null, bullet[1]))
      continue
    }
    if (!line.trim()) { flush(); list = null; continue }
    list = null
    // 连续普通文本行属于同一段（CommonMark 软换行），不能每行断成新段
    if (paragraph) paragraph.push(line.trim())
    else paragraph = [line.trim()]
  }
  flush()
  if (code) out.push(h('pre', null, h('code', null, code.join('\n'))))
  return out
}

/** 视图：持有 controller 与 DOM 根，按状态局部更新。 */
export function createMarketView(controller) {
  const root = h('div', { class: 'sk-market' })
  const paper = createSketchPaper()
  const scroll = h('div', { class: 'sk-scroll' })
  const page = h('main', { class: 'sk-page', tabIndex: -1 })
  const headerSlot = h('div')
  const contentSlot = h('div', { class: 'sk-catalog-content' })
  scroll.appendChild(page)
  // 环与 scroll 是同级；底部裁切留给宿主原生设置 dock，不制造替代入口。
  root.append(paper, scroll, binding())

  const seenPlugins = new Set()
  let lastCatalogKey = ''
  let lastSearchKey = ''
  let lastDetailKey = ''
  let entered = false
  let disposed = false
  let composing = false
  let modal = null
  let returnFocus = null
  let closing = false
  let latestState = controller.getState()
  const catalogCards = new Map()
  const featuredCards = new Map()
  const categoryGroups = new Map()
  const categoryChips = new Map()
  const catalogEvents = new AbortController()

  // 隐藏预热期间的重建不消耗首次入场；可见后同一插件的卡片与推荐项不再重播。
  function rememberVisiblePlugins() {
    if (!latestState.visible || !latestState.appearance || document.hidden) return
    for (const node of contentSlot.querySelectorAll('[data-entry-plugin]')) seenPlugins.add(node.dataset.entryPlugin)
    const staticEntry = latestState.appearance.appearance.animation.effective === 'low'
      || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    if (staticEntry) for (const entry of [...catalogCards.values(), ...featuredCards.values()]) entry.finishEntry()
  }

  /** 宿主已完成真正开屏，首次可见只让内容轻移入场，不再放全屏覆盖层。 */
  function maybeEnter(state) {
    if (entered || !state.visible || !state.appearance) return
    entered = true
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (state.appearance.appearance.animation.effective !== 'low' && !reduced) root.classList.add('is-entering')
  }
  function finishEntry(event) {
    if (event.target === scroll) root.classList.remove('is-entering')
  }
  scroll.addEventListener('animationend', finishEntry)
  scroll.addEventListener('animationcancel', finishEntry)

  // 搜索节点只创建一次，异步结果、分类与外观变化都不能拆走输入节点/IME 会话。
  const searchInput = h('input', {
    type: 'search', placeholder: '搜索插件、功能或指令', 'aria-label': '搜索插件',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': 'sk-quick-results', 'aria-expanded': 'false',
  })
  const searchClear = h('button', { type: 'button', class: 'sk-search-clear', 'aria-label': '清除搜索', hidden: true }, icon('close', 14))
  const searchHint = h('kbd', null, '⌘F')
  const searchResults = h('div', { id: 'sk-quick-results', class: 'sk-results', role: 'listbox', 'aria-label': '搜索结果', hidden: true })
  const searchWrap = h('div', { class: 'sk-search' }, icon('search', 17), searchInput, searchClear, searchHint, searchResults)
  page.append(headerSlot, searchWrap, contentSlot)
  searchInput.addEventListener('input', event => controller.setQuery(searchInput.value, { composing: composing || event.isComposing }))
  searchInput.addEventListener('compositionstart', () => {
    composing = true
    controller.setQuery(searchInput.value, { composing: true })
  })
  searchInput.addEventListener('compositionend', () => {
    composing = false
    controller.setQuery(searchInput.value)
  })
  searchInput.addEventListener('keydown', event => {
    if (composing || event.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      controller.setQuery('')
    } else if (event.key === 'Enter') {
      // 不能闭包捕获旧 results：搜索响应往往晚于输入事件。
      const first = controller.getState().quickResults?.items?.find(entry => !entry.disabled)
      if (first) {
        event.preventDefault()
        void controller.activateSearchHandle(first.handle)
      }
    }
  })
  searchClear.addEventListener('click', () => { controller.setQuery(''); searchInput.focus({ preventScroll: true }) })
  function findSearch(event) {
    if (modal || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
  }
  root.addEventListener('keydown', findSearch)

  function updateSearch(state) {
    // query 与 quickResults 都参与局部刷新，不能再把正在输入当成固定 key。
    const key = JSON.stringify([state.query, state.quickResults])
    if (key === lastSearchKey) return
    lastSearchKey = key
    if (!composing && searchInput.value !== state.query) searchInput.value = state.query
    searchClear.hidden = !state.query
    searchHint.hidden = Boolean(state.query)
    const results = state.quickResults?.items ?? []
    const open = Boolean(state.query.trim()) && Boolean(state.quickResults)
    searchResults.hidden = !open
    searchInput.setAttribute('aria-expanded', String(open))
    searchResults.replaceChildren(...results.map(entry => {
      const badge = avatar({ ...entry, name: entry.title, category: entry.tags?.[0] })
      badge.classList.add('sk-result-icon')
      const row = h('button', { type: 'button', class: 'sk-result', role: 'option', 'aria-selected': 'false', disabled: entry.disabled }, badge,
        h('span', null, h('strong', null, entry.title), entry.subtitle ? h('span', null, entry.subtitle) : null))
      row.addEventListener('click', () => void controller.activateSearchHandle(entry.handle))
      return row
    }))
    if (open && results.length === 0) searchResults.appendChild(h('div', { class: 'sk-results-empty', role: 'status' }, '没有匹配的插件或指令'))
  }

  function cardEntry(node, item) {
    const events = new AbortController()
    const entry = {
      node, item, events, entering: !seenPlugins.has(item.pluginId),
      finishEntry() {
        if (!entry.entering) return
        entry.entering = false
        node.classList.remove('is-new')
      },
    }
    node.addEventListener('animationend', event => {
      if (event.target === node) entry.finishEntry()
    }, { signal: events.signal })
    return entry
  }

  function createFeatureCard(item) {
    const portrait = createAvatar(item)
    const visual = h('span', { class: 'sk-feature-visual is-icon', 'aria-hidden': 'true' })
    const eyebrow = h('span', { class: 'sk-feature-eyebrow' })
    const name = h('strong')
    const description = h('span', { class: 'sk-feature-desc' })
    const tags = h('span', { class: 'sk-feature-tags' })
    const detail = h('button', { type: 'button', class: 'sk-feature-link', dataset: { focusKey: `feature:${item.pluginId}` } },
      eyebrow, visual, h('span', { class: 'sk-feature-copy' }, name, description, tags,
        h('span', { class: 'sk-feature-cue' }, '翻开这一页', icon('arrowLeft', 14))))
    const open = h('button', { type: 'button', class: 'sk-btn sk-feature-open', dataset: { focusKey: `feature-open:${item.pluginId}` } }, '打开插件', icon('spark', 13))
    const stickyTape = tape()
    const entry = cardEntry(h('article', { dataset: { entryPlugin: item.pluginId } }, stickyTape, detail), item)
    const options = { signal: entry.events.signal }
    detail.addEventListener('click', () => void controller.navigate({ page: 'detail', pluginId: entry.item.pluginId }), options)
    open.addEventListener('click', () => { if (entry.item.installed) void controller.openPlugin(entry.item.pluginId) }, options)
    let lead
    let mark
    let source
    let image = null
    let releaseImage = () => {}
    let tagsKey = ''
    entry.update = (next, index) => {
      entry.item = next
      const nextLead = index === 0
      if (lead !== nextLead) {
        lead = nextLead
        mark = doodle(lead ? 'star' : 'arrow', lead ? 44 : 26)
      }
      const shot = safeShots(next)[0]
      if (shot !== source) {
        releaseImage()
        source = shot
        image = shot ? h('img', { class: 'sk-feature-shot', src: shot, alt: '', loading: 'lazy', draggable: 'false' }) : null
        if (image) {
          const current = image
          const fail = () => {
            if (image !== current) return
            image = null
            setAttribute(visual, 'class', 'sk-feature-visual is-icon')
            current.remove()
          }
          image.addEventListener('error', fail, { once: true })
          releaseImage = () => current.removeEventListener('error', fail)
        } else releaseImage = () => {}
      }
      portrait.update(next)
      reconcileChildren(visual, [image, portrait.node, mark].filter(Boolean))
      setAttribute(visual, 'class', `sk-feature-visual ${image ? 'has-shot' : 'is-icon'}`)
      setAttribute(entry.node, 'class', `sk-feature ${lead ? 'is-lead' : 'is-index'}${entry.entering ? ' is-new' : ''}`)
      setStyle(entry.node, '--i', index)
      setStyle(entry.node, '--feat-ink', inkFor(next.category))
      setAttribute(detail, 'aria-label', `查看 ${next.name} 详情`)
      setText(eyebrow, lead ? '本页主推荐' : `索引 / ${String(index + 1).padStart(2, '0')}`)
      setText(name, next.name)
      setText(description, next.description || '来自插件仓库的推荐插件。')
      const values = [...new Set([...(next.tags ?? []), next.category].filter(Boolean))].slice(0, 3)
      const key = JSON.stringify(values)
      if (key !== tagsKey) { tagsKey = key; tags.replaceChildren(...values.map(tag => h('i', null, tag))) }
      reconcileChildren(entry.node, next.installed ? [stickyTape, detail, open] : [stickyTape, detail])
    }
    entry.dispose = () => { entry.events.abort(); releaseImage(); portrait.dispose(); entry.node.remove() }
    return entry
  }

  function createPluginCard(item) {
    const portrait = createAvatar(item)
    const name = h('h3')
    const meta = h('div', { class: 'sk-card-meta' })
    const description = h('p', { class: 'sk-card-desc' })
    const badge = h('span', { class: 'sk-badge' })
    const detail = h('button', { type: 'button', class: 'sk-btn is-quiet', dataset: { focusKey: `detail:${item.pluginId}` } }, '详情')
    const primary = h('button', { type: 'button', dataset: { focusKey: `primary:${item.pluginId}` } })
    const node = h('article', { dataset: { entryPlugin: item.pluginId } }, tape(),
      h('div', { class: 'sk-card-head' }, portrait.node, h('div', { class: 'sk-card-title' }, name, meta)), description,
      h('div', { class: 'sk-card-foot' }, h('span', null, badge), h('span', { class: 'sk-actions' }, detail, primary)))
    const entry = cardEntry(node, item)
    const options = { signal: entry.events.signal }
    detail.addEventListener('click', () => void controller.navigate({ page: 'detail', pluginId: entry.item.pluginId }), options)
    primary.addEventListener('click', () => {
      const current = entry.item
      if (current.installed) void controller.openPlugin(current.pluginId)
      else void controller.navigate({ page: 'detail', pluginId: current.pluginId })
    }, options)
    let metaKey = ''
    let badgeKey = ''
    entry.update = (next, index, state) => {
      entry.item = next
      const disabled = next.installed && next.enabled === false
      const hasUpdate = next.installed && next.latestVersion && next.latestVersion !== next.version
      setAttribute(node, 'class', `sk-card${state.busy.has(next.pluginId) ? ' is-busy' : ''}${disabled ? ' is-disabled' : ''}${entry.entering ? ' is-new' : ''}`)
      setStyle(node, '--i', index)
      setStyle(node, '--card-ink', inkFor(next.category))
      portrait.update(next)
      setAttribute(name, 'title', next.name)
      setText(name, next.name)
      setText(description, next.description || '这个插件还没有写简介。')
      const nextMeta = JSON.stringify([next.author, next.version, next.category])
      if (nextMeta !== metaKey) {
        metaKey = nextMeta
        meta.replaceChildren(...[
          next.author ? h('span', null, next.author) : null,
          next.author && next.version ? h('i', null, '·') : null,
          next.version ? h('span', null, `v${next.version}`) : null,
          next.category ? [h('i', null, '·'), h('span', null, next.category)] : [],
        ].flat().filter(Boolean))
      }
      const kind = disabled ? '' : hasUpdate ? ' is-update' : next.installed ? ' is-installed' : ''
      const label = disabled ? '已停用' : hasUpdate ? `可更新 ${next.latestVersion}` : next.installed ? '已安装' : formatBytes(next.packageSize) || '未安装'
      const nextBadge = `${kind}:${label}`
      if (nextBadge !== badgeKey) {
        badgeKey = nextBadge
        setAttribute(badge, 'class', `sk-badge${kind}`)
        badge.replaceChildren(...(kind === ' is-installed' ? [icon('check', 10), label] : [label]))
      }
      setAttribute(primary, 'class', `sk-btn${next.installed ? '' : ' is-primary'}`)
      setText(primary, next.installed ? '打开' : '安装')
    }
    entry.dispose = () => { entry.events.abort(); portrait.dispose(); node.remove() }
    return entry
  }

  const catalogTitle = h('h1')
  const totalCount = h('b')
  const installedCountNode = h('b')
  const emptyCount = document.createTextNode('')
  const refresh = h('button', { type: 'button', class: 'sk-round', 'aria-label': '刷新市场目录' }, icon('refresh', 17))
  refresh.addEventListener('click', () => void controller.refreshCatalog(), { signal: catalogEvents.signal })
  headerSlot.appendChild(h('header', { class: 'sk-head' },
    h('div', { class: 'sk-head-main' }, catalogTitle,
      h('p', { class: 'sk-head-sub' }, totalCount, ' 个插件，已装 ', installedCountNode, ' 个', emptyCount)), refresh))
  const noticeText = h('span')
  const dismiss = h('button', { type: 'button', class: 'sk-btn is-quiet' }, '关闭')
  dismiss.addEventListener('click', () => controller.dismissNotice(), { signal: catalogEvents.signal })
  const notice = h('div', { class: 'sk-notice', role: 'status' }, noticeText, dismiss)
  const tabs = h('div', { class: 'sk-seg', role: 'tablist', 'aria-label': '目录视图' })
  const tabButtons = new Map()
  for (const [value, label] of [['catalog', '全部插件'], ['installed', '已安装']]) {
    const tab = h('button', { type: 'button', role: 'tab' }, label)
    tab.addEventListener('click', () => controller.setBasePage(value), { signal: catalogEvents.signal })
    tabButtons.set(value, tab)
    tabs.appendChild(tab)
  }
  const chips = h('div', { class: 'sk-chips', role: 'group', 'aria-label': '分类筛选' })
  const toolbar = h('div', { class: 'sk-toolbar' }, tabs, chips)
  const featuredGrid = h('div', { class: 'sk-featured-grid' })
  const featuredSection = h('section', { class: 'sk-featured', 'aria-label': '精选推荐' },
    h('div', { class: 'sk-section-label' }, '精选推荐', h('span', null, '来自插件仓库')), featuredGrid)
  const emptyTitle = h('strong')
  const emptyDescription = h('span')
  const reset = h('button', { type: 'button', class: 'sk-btn' }, icon('plus', 13), '查看全部插件')
  reset.addEventListener('click', () => {
    controller.setCategory('全部')
    controller.setQuery('')
    controller.setBasePage('catalog')
  }, { signal: catalogEvents.signal })
  const emptyCatalog = h('div', { class: 'sk-empty' }, doodle('star', 24), emptyTitle, emptyDescription, reset)

  function pruneEntries(entries, wanted) {
    for (const [key, entry] of entries) if (!wanted.has(key)) {
      entry.dispose()
      entries.delete(key)
    }
  }

  // Catalog nodes are keyed by identity; filters change membership, not every surviving card.
  function updateCatalog(state) {
    const items = state.catalog?.items ?? []
    const seg = state.basePage === 'installed' ? 'installed' : 'catalog'
    const searching = Boolean(state.query.trim())
    const scoped = items.filter(item => seg !== 'installed' || item.installed)

    const present = new Set(scoped.map(item => item.category || '其它'))
    const categories = ['全部', ...CATEGORY_ORDER.filter(name => present.has(name)), ...[...present].filter(name => !CATEGORY_ORDER.includes(name))]
    if (!categories.includes(state.category)) { controller.setCategory('全部'); return }

    const visible = scoped.filter(item => state.category === '全部' || (item.category || '其它') === state.category)
    const order = state.category === '全部' ? categories.slice(1) : [state.category]
    const groups = order
      .map(name => ({ name, items: visible.filter(item => (item.category || '其它') === name) }))
      .filter(group => group.items.length > 0)
    const featured = seg === 'catalog' && state.category === '全部' && !searching
      ? items.filter(item => item.featured).slice(0, 3) : []
    setText(catalogTitle, seg === 'installed' ? '已安装' : '插件市场')
    setText(totalCount, items.length)
    setText(installedCountNode, items.filter(item => item.installed).length)
    setText(emptyCount, items.length ? '' : ' · 目录为空')
    setText(noticeText, state.notice)
    for (const [value, tab] of tabButtons) setAttribute(tab, 'aria-selected', seg === value)

    pruneEntries(categoryChips, new Set(categories))
    reconcileChildren(chips, categories.map(name => {
      let entry = categoryChips.get(name)
      if (!entry) {
        const node = h('button', { type: 'button', class: 'sk-chip' }, name)
        const events = new AbortController()
        node.addEventListener('click', () => controller.setCategory(name), { signal: events.signal })
        entry = { node, dispose: () => { events.abort(); node.remove() } }
        categoryChips.set(name, entry)
      }
      setAttribute(entry.node, 'aria-pressed', state.category === name)
      return entry.node
    }))

    pruneEntries(featuredCards, new Set(featured.map(item => item.pluginId)))
    reconcileChildren(featuredGrid, featured.map((item, index) => {
      let entry = featuredCards.get(item.pluginId)
      if (!entry) { entry = createFeatureCard(item); featuredCards.set(item.pluginId, entry) }
      entry.update(item, index)
      return entry.node
    }))

    pruneEntries(catalogCards, new Set(visible.map(item => item.pluginId)))
    const groupNodes = []
    let cardIndex = 0
    for (const group of groups) {
      let entry = categoryGroups.get(group.name)
      if (!entry) {
        const count = h('span', { class: 'sk-count' })
        const grid = h('div', { class: 'sk-grid' })
        const node = h('section', { class: 'sk-group', 'aria-label': `${group.name}分类` },
          h('div', { class: 'sk-group-head' }, h('h2', null, group.name), h('span', { class: 'sk-rule', 'aria-hidden': 'true' }), count), grid)
        entry = { node, count, grid, dispose: () => node.remove() }
        categoryGroups.set(group.name, entry)
      }
      setText(entry.count, String(group.items.length).padStart(2, '0'))
      reconcileChildren(entry.grid, group.items.map(item => {
        let card = catalogCards.get(item.pluginId)
        if (!card) { card = createPluginCard(item); catalogCards.set(item.pluginId, card) }
        card.update(item, cardIndex++, state)
        return card.node
      }))
      groupNodes.push(entry.node)
    }
    pruneEntries(categoryGroups, new Set(groups.map(group => group.name)))
    setText(emptyTitle, seg === 'installed' ? '本子还是空的' : '这个筛选下没有插件')
    setText(emptyDescription, seg === 'installed' ? '去插件市场挑一个，装好后会记在这里。' : '换一个分类，或清除搜索关键词再试。')
    reconcileChildren(contentSlot, [state.notice ? notice : null, searching ? null : toolbar,
      featured.length ? featuredSection : null, ...(groups.length ? groupNodes : [emptyCatalog])].filter(Boolean))
    const known = new Set(items.map(item => item.pluginId))
    for (const id of seenPlugins) if (!known.has(id)) seenPlugins.delete(id)
  }

  // ── 详情 ──
  function detailView(state) {
    const detail = state.detail
    const page = h('div', { class: 'sk-detail' })
    if (state.notice) page.appendChild(h('div', { class: 'sk-notice', role: 'status' }, state.notice))

    if (!detail) {
      const failed = state.detailStatus === 'error'
      page.appendChild(h('div', { class: 'sk-empty', role: 'status', 'aria-live': 'polite' },
        doodle('star', 22),
        h('strong', null, failed ? '详情暂时无法读取' : '正在读取插件详情'),
        h('span', null, failed ? '可以重试，或合上这一页返回目录。' : '正在读取宿主提供的插件档案。'),
        failed ? (() => {
          const retry = h('button', { type: 'button', class: 'sk-btn' }, '重试读取')
          retry.addEventListener('click', () => void controller.navigate({ ...state.route }))
          return retry
        })() : null))
      return page
    }

    const busy = Boolean(state.busy.has(detail.pluginId))
    const disabled = detail.installed && detail.enabled === false
    const shots = safeShots(detail)
    const perms = detail.permissions ?? []

    const actionButton = (label, className, onClick, isDisabled = false) => {
      const button = h('button', {
        type: 'button', class: `sk-btn ${className}`.trim(), disabled: isDisabled || busy,
        'aria-busy': String(busy), dataset: { actionDisabled: String(Boolean(isDisabled)) },
      }, label)
      button.addEventListener('click', onClick)
      return button
    }
    const actions = h('div', { class: 'sk-detail-actions' })
    if (!detail.installed) {
      actions.appendChild(actionButton([icon('download', 14), '安装插件'], 'is-primary',
        () => void controller.manage({ type: 'installPlugin', pluginId: detail.pluginId }, detail.pluginId)))
    } else {
      actions.appendChild(actionButton([icon('spark', 14), disabled ? '已停用' : '打开插件'], 'is-primary',
        () => void controller.openPlugin(detail.pluginId), disabled))
      if (detail.latestVersion && detail.latestVersion !== detail.version) {
        actions.appendChild(actionButton([icon('download', 14), `更新到 ${detail.latestVersion}`], '',
          () => void controller.manage({ type: 'updatePlugin', pluginId: detail.pluginId }, detail.pluginId)))
      }
      actions.appendChild(actionButton(disabled ? '启用' : '停用', 'is-quiet',
        () => void controller.manage({ type: 'setPluginEnabled', pluginId: detail.pluginId, enabled: disabled }, detail.pluginId)))
      actions.appendChild(actionButton('卸载', 'is-quiet',
        () => void controller.manage({ type: 'uninstallPlugin', pluginId: detail.pluginId }, detail.pluginId)))
    }

    page.appendChild(h('header', { class: 'sk-detail-hero' },
      avatar(detail),
      h('div', { class: 'sk-detail-title' },
        h('h1', null, detail.name),
        h('p', null, detail.description || '这个插件还没有写简介。'),
        h('div', { class: 'sk-detail-meta' },
          detail.author ? h('span', null, '作者 ', h('b', null, detail.author)) : null,
          detail.version ? h('span', null, '版本 ', h('b', null, detail.version)) : null,
          detail.latestVersion && detail.latestVersion !== detail.version
            ? h('span', null, '最新 ', h('b', null, detail.latestVersion)) : null,
          detail.category ? h('span', null, '分类 ', h('b', null, detail.category)) : null,
          formatBytes(detail.packageSize) ? h('span', null, '包大小 ', h('b', null, formatBytes(detail.packageSize))) : null,
          detail.installs ? h('span', null, '安装量 ', h('b', null, detail.installs)) : null),
        perms.length ? h('div', { class: 'sk-perms' }, perms.map(permission => h('span', { class: 'sk-perm' }, permission))) : null),
      actions))

    let shotsBody
    if (shots.length > 0) {
      shotsBody = h('div', { class: 'sk-shots' }, shots.map((shot, index) => h('figure', { class: 'sk-shot' },
        tape(),
        h('img', { src: shot, alt: `${detail.name} 界面截图 ${index + 1}`, loading: 'lazy', draggable: 'false' }))))
    } else {
      shotsBody = h('div', { class: 'sk-empty' }, doodle('star', 20),
        h('strong', null, '暂无截图'),
        h('span', null, '这个插件的市场条目还没有上传界面截图。'))
    }

    let readmeBody
    if (state.readme?.status === 'loading') readmeBody = h('div', { class: 'sk-empty' }, h('strong', null, '正在读取说明'))
    else if (state.readme?.status === 'error') readmeBody = h('div', { class: 'sk-empty' }, h('strong', null, '说明暂时无法读取'), h('span', null, '可以稍后重新打开详情。'))
    else if (state.readme?.status === 'empty') readmeBody = h('div', { class: 'sk-empty' }, h('strong', null, '暂无说明'), h('span', null, 'README 由插件作者在插件仓库维护。'))
    else if (state.readme?.status === 'ok') readmeBody = h('div', { class: 'sk-readme' }, readmeBlocks(state.readme.text))
    else readmeBody = null

    page.appendChild(h('div', { class: 'sk-detail-body' },
      h('section', { class: 'sk-panel', 'aria-label': '界面截图' }, h('h2', null, '界面截图'), shotsBody),
      h('section', { class: 'sk-panel', 'aria-label': '插件说明' }, h('h2', null, '插件说明'), readmeBody)))
    return page
  }

  const focusables = container => [...container.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
    .filter(node => !node.hidden && node.getClientRects().length > 0)

  function restoreFocus(node, key) {
    const target = node?.isConnected ? node : key
      ? [...page.querySelectorAll('[data-focus-key]')].find(entry => entry.dataset.focusKey === key) : null
    ;(target ?? page).focus({ preventScroll: true })
  }

  async function requestClose() {
    if (!modal || closing || disposed) return
    closing = true
    // 只请求宿主导航，不在本地假造 route；ACK 返回前仍保留模态约束。
    await controller.navigate({ page: 'catalog' })
    closing = false
  }

  function closeDetail(restore = true) {
    if (!modal) return
    const current = modal
    modal = null
    current.events.abort()
    if (current.dialog.open) current.dialog.close()
    current.dialog.remove()
    scroll.inert = false
    scroll.removeAttribute('aria-hidden')
    root.classList.remove('has-detail')
    if (restore) restoreFocus(returnFocus?.node, returnFocus?.key)
    returnFocus = null
    lastDetailKey = ''
    closing = false
  }

  function updateDetail(state) {
    if (state.route.page !== 'detail') { closeDetail(); return }
    if (!modal) {
      const active = document.activeElement
      returnFocus = { node: active instanceof HTMLElement && page.contains(active) ? active : page, key: active?.dataset?.focusKey }
      const dialog = h('dialog', { class: 'sk-modal', 'aria-labelledby': 'sk-detail-label' })
      const close = h('button', { type: 'button', class: 'sk-round', 'aria-label': '关闭插件详情', autofocus: true }, icon('close', 18))
      const body = h('div', { class: 'sk-modal-body', tabIndex: 0, 'aria-label': '插件详情内容' })
      const label = h('h2', { id: 'sk-detail-label' }, '插件详情')
      const events = new AbortController()
      const options = { signal: events.signal }
      dialog.append(h('header', { class: 'sk-modal-bar' }, label, close), body)
      modal = { dialog, close, body, label, events, pluginId: null }
      close.addEventListener('click', requestClose, options)
      dialog.addEventListener('cancel', event => { event.preventDefault(); void requestClose() }, options)
      // dialog 本身是全视口透明遮罩，只有从空白区域按下并抬起才关闭。
      let backdropDown = false
      dialog.addEventListener('pointerdown', event => { backdropDown = event.target === dialog }, options)
      dialog.addEventListener('click', event => {
        if (event.target === dialog && backdropDown) void requestClose()
        backdropDown = false
      }, options)
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); void requestClose(); return }
        if (event.key !== 'Tab') return
        const targets = focusables(dialog)
        const first = targets[0] ?? close
        const last = targets[targets.length - 1] ?? close
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault(); last.focus({ preventScroll: true })
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault(); first.focus({ preventScroll: true })
        }
      }, options)
      document.addEventListener('focusin', event => {
        if (modal?.dialog === dialog && !dialog.contains(event.target)) close.focus({ preventScroll: true })
      }, options)
      root.appendChild(dialog)
      root.classList.add('has-detail')
      // showModal 同步加入 top layer；隐藏预热无需等 visible/rAF，不参与 ACK 屏障。
      dialog.showModal()
      scroll.inert = true
      scroll.setAttribute('aria-hidden', 'true')
      close.focus({ preventScroll: true })
    }
    // busy 只改变当前详情的动作按钮，不拆走正文、截图或焦点节点。
    const busy = state.busy.has(state.route.pluginId)
    for (const button of modal.body.querySelectorAll('.sk-detail-actions button')) {
      button.disabled = button.dataset.actionDisabled === 'true' || busy
      button.setAttribute('aria-busy', String(busy))
    }
    const key = JSON.stringify([state.route.pluginId, state.detailStatus, state.detail, state.readme, state.notice])
    if (key === lastDetailKey) return
    lastDetailKey = key
    const { body, dialog, close, label } = modal
    const samePlugin = modal.pluginId === state.route.pluginId
    const top = samePlugin ? body.scrollTop : 0
    const active = body.contains(document.activeElement) ? document.activeElement : null
    const actionIndex = active ? [...body.querySelectorAll('button')].indexOf(active) : -1
    label.textContent = state.detail ? `${state.detail.name} · 插件详情` : '插件详情'
    body.setAttribute('aria-busy', String(state.detailStatus === 'loading'))
    body.replaceChildren(detailView(state))
    body.scrollTop = top
    modal.pluginId = state.route.pluginId
    if (active) ([...body.querySelectorAll('button')][actionIndex] ?? close).focus({ preventScroll: true })
    if (!dialog.contains(document.activeElement)) close.focus({ preventScroll: true })
  }

  function update(state) {
    if (disposed) return
    latestState = state
    setAttribute(root, 'data-route', state.route.page)
    setAttribute(root, 'data-visible', state.visible)
    maybeEnter(state)
    updateSearch(state)

    // detail/readme/appearance/quickResults/refreshing 不属于 catalog key；弹框期间保留真实底层节点。
    const key = JSON.stringify([state.basePage, state.category, state.loading,
      state.catalog?.revision, state.query, state.notice, [...state.busy].sort()])
    if ((!modal || state.route.page !== 'detail') && key !== lastCatalogKey) {
      lastCatalogKey = key
      const top = scroll.scrollTop
      const active = page.contains(document.activeElement) ? document.activeElement : null
      const focusKey = active?.dataset?.focusKey
      updateCatalog(state)
      if (scroll.scrollTop !== top) scroll.scrollTop = top
      if (active && document.activeElement !== active) restoreFocus(active, focusKey)
    }
    setProperty(refresh, 'disabled', state.refreshing)
    setAttribute(refresh, 'aria-busy', state.refreshing)
    setAttribute(refresh, 'title', state.refreshing ? '正在刷新…' : '刷新市场目录')
    rememberVisiblePlugins()
    updateDetail(state)
  }

  function onVisibility() {
    // 宿主恢复可见时只校正焦点与入场记录，不以此延迟预热渲染或 ACK。
    rememberVisiblePlugins()
    if (!document.hidden && latestState.visible && modal) modal.close.focus({ preventScroll: true })
  }
  document.addEventListener('visibilitychange', onVisibility)

  function dispose() {
    if (disposed) return
    disposed = true
    closeDetail(false)
    document.removeEventListener('visibilitychange', onVisibility)
    root.removeEventListener('keydown', findSearch)
    scroll.removeEventListener('animationend', finishEntry)
    scroll.removeEventListener('animationcancel', finishEntry)
    catalogEvents.abort()
    for (const entries of [catalogCards, featuredCards, categoryGroups, categoryChips]) pruneEntries(entries, new Set())
    seenPlugins.clear()
    root.remove()
  }

  return { root, update, dispose }
}
