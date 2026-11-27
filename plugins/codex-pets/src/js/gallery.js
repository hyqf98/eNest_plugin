/**
 * gallery — 宠物市场页：搜索 / 排序 / 筛选 / 分页 / 卡片网格 / hover 动效。
 */
import { listPets } from './api.js'
import { normalizePet, formatCount } from './api.js'
import { fetchImageBlob } from './netbin.js'
import { galleryCardState, applySpriteStyle } from './sprite.js'
import { installPet, listInstalled } from './installer.js'
import {
  GALLERY_SORTS, FILTER_TAGS, KIND_OPTIONS, FORMAT_OPTIONS, CONTENT_MODES,
  PAGE_SIZE, RANDOM_PAGE_SIZE, DEFAULT_GALLERY_STATE
} from './config.js'

const installedIds = new Set()

export async function refreshInstalledMarks() {
  installedIds.clear()
  try {
    for (const item of await listInstalled()) installedIds.add(item.id)
  } catch { /* 检测失败不阻塞宠物市场 */
  }
}

export function galleryStateFromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#\/?/, '').split('?')[1] ?? '')
  const state = { ...DEFAULT_GALLERY_STATE }
  const q = params.get('q')
  if (q) state.query = q
  state.tags = params.getAll('tag').filter(t => FILTER_TAGS.includes(t) || t === 'nsfw')
  const sort = params.get('sort')
  if (GALLERY_SORTS.some(s => s.id === sort)) state.sort = sort
  const page = Number(params.get('page'))
  if (Number.isInteger(page) && page > 0) state.page = page
  const kind = params.get('kind')
  if (KIND_OPTIONS.some(k => k.id === kind)) state.kind = kind
  const format = params.get('format')
  if (FORMAT_OPTIONS.some(f => f.id === format)) state.format = format
  const content = params.get('content')
  if (content === 'all') state.content = 'all'
  return state
}

export function galleryHash(state) {
  const params = new URLSearchParams()
  if (state.query) params.set('q', state.query)
  for (const tag of state.tags) params.append('tag', tag)
  if (state.sort !== DEFAULT_GALLERY_STATE.sort) params.set('sort', state.sort)
  if (state.page !== DEFAULT_GALLERY_STATE.page) params.set('page', String(state.page))
  if (state.kind !== DEFAULT_GALLERY_STATE.kind) params.set('kind', state.kind)
  if (state.format !== DEFAULT_GALLERY_STATE.format) params.set('format', state.format)
  if (state.content !== DEFAULT_GALLERY_STATE.content) params.set('content', state.content)
  const suffix = params.toString()
  return suffix ? `#/?${suffix}` : '#/'
}

/** 宠物市场页渲染入口 */
export async function renderGallery(body, kit, { onNavigate }) {
  const state = galleryStateFromHash()
  const activeSort = GALLERY_SORTS.find(sort => sort.id === state.sort)
  const filterCount = state.tags.length + Number(Boolean(state.query)) +
    Number(state.kind !== DEFAULT_GALLERY_STATE.kind) + Number(state.format !== DEFAULT_GALLERY_STATE.format) +
    Number(state.content !== DEFAULT_GALLERY_STATE.content)
  const clearFilters = () => onNavigate(galleryHash({ ...DEFAULT_GALLERY_STATE, sort: state.sort }))
  body.innerHTML = `
    <div class="cp-toolbar">
      <form class="cp-search shell-only" id="g-search" role="search">
        <input id="g-q" type="search" placeholder="搜索宠物（名称 / 描述 / 作者 / 标签）" value="${escapeHtml(state.query)}" aria-label="搜索宠物" />
        <button type="submit" class="cp-btn">查找</button>
      </form>
      <div class="cp-filters-row">
        <div class="cp-sorts shell-only" role="tablist" aria-label="排序">
          ${GALLERY_SORTS.map(s => `<button type="button" role="tab" class="cp-sort${s.id === state.sort ? ' is-active' : ''}" data-sort="${s.id}" aria-selected="${s.id === state.sort}">${s.label}</button>`).join('')}
        </div>
        <button type="button" class="cp-btn quick-only" id="g-sort" aria-haspopup="menu" aria-expanded="false">排序：${activeSort.label}<span aria-hidden="true">⌄</span></button>
        <span class="cp-meta" id="g-count" role="status"></span>
        <button type="button" class="cp-btn ghost" id="g-filters"><span class="shell-only">筛选</span><span class="quick-only">搜索与筛选</span>${filterCount ? `<span>${filterCount}</span>` : ''}</button>
      </div>
    </div>
    <div class="cp-grid" id="g-grid"><div class="pk-empty-state" role="status">正在加载宠物…</div></div>
    <dialog id="g-filters-dlg" class="cp-filters-dlg" aria-labelledby="g-filter-title"><form class="cp-filters-body"></form></dialog>
  `

  const grid = body.querySelector('#g-grid')
  const countEl = body.querySelector('#g-count')
  // 分页容器在底栏（App.jsx 的 footer 内），不随视图重建。
  const pager = document.querySelector('#g-pager')
  pager.replaceChildren()

  // 搜索
  body.querySelector('#g-search').addEventListener('submit', event => {
    event.preventDefault()
    const q = body.querySelector('#g-q').value.trim()
    onNavigate(galleryHash({ ...state, query: q, page: 1 }))
  })

  // 排序
  for (const btn of body.querySelectorAll('.cp-sort')) {
    btn.addEventListener('click', () => onNavigate(galleryHash({ ...state, sort: btn.dataset.sort, page: 1 })))
  }
  const sortButton = body.querySelector('#g-sort')
  sortButton.addEventListener('click', () => {
    window.PluginKit.openMenu(sortButton, GALLERY_SORTS.map(sort => ({ key: sort.id, label: sort.label, checked: sort.id === state.sort })),
      sort => onNavigate(galleryHash({ ...state, sort, page: 1 })), { ariaLabel: '宠物排序' })
  })

  // 筛选抽屉
  body.querySelector('#g-filters').addEventListener('click', () => openFilters(body, state, onNavigate, clearFilters))

  // 数据加载
  let data
  try {
    data = await listPets(state)
  } catch (err) {
    if (!grid.isConnected) return
    grid.innerHTML = `<div class="pk-empty-state" role="alert"><strong class="pk-empty-title">无法加载宠物</strong><p class="pk-empty-hint">${escapeHtml(err.message)}</p><button type="button" class="cp-btn" data-retry>重试</button></div>`
    grid.querySelector('[data-retry]').addEventListener('click', () => onNavigate(galleryHash(state)))
    return
  }
  if (!grid.isConnected) return
  const pets = (data.pets ?? []).map(normalizePet)
  const totalPages = Math.max(1, data.totalPages ?? 1)
  const total = data.total ?? pets.length
  if (pets.length === 0) {
    grid.innerHTML = filterCount
      ? '<div class="pk-empty-state"><strong class="pk-empty-title">没有匹配的宠物</strong><p class="pk-empty-hint">换个关键词或减少筛选条件。</p><button type="button" class="cp-btn" data-clear>清除筛选</button></div>'
      : '<div class="pk-empty-state"><strong class="pk-empty-title">暂无宠物</strong></div>'
    grid.querySelector('[data-clear]')?.addEventListener('click', clearFilters)
    return
  }

  countEl.textContent = `${Number(total).toLocaleString()} 只宠物`
  renderCards(grid, pets, kit, { onNavigate })
  renderPager(pager, data.page ?? state.page, totalPages, next => onNavigate(galleryHash({ ...state, page: next })))

  // 视口懒加载 poster
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      loadPoster(entry.target)
    }
  }, { rootMargin: '200px' })
  for (const el of grid.querySelectorAll('.cp-card-poster[data-poster]')) observer.observe(el)
}

function renderCards(grid, pets, kit, { onNavigate }) {
  grid.innerHTML = ''
  for (const pet of pets) {
    const card = document.createElement('article')
    card.className = 'cp-card'
    const state = galleryCardState(pet)
    card.innerHTML = `
      <div class="cp-card-stage">
        <img class="cp-card-poster" data-poster="${escapeHtml(pet.posterUrl)}" alt="" loading="lazy" decoding="async" draggable="false" />
        <div class="cp-card-sprite" aria-hidden="true"></div>
        ${installedIds.has(pet.id) ? '<span class="cp-installed-mark" title="已安装到本机 Codex">已装 ✓</span>' : ''}
        ${pet.spriteVersionNumber === 1 ? '<span class="cp-legacy-mark">V1 · 旧版</span>' : ''}
      </div>
      <div class="cp-card-info">
        <h2 class="cp-card-title">${escapeHtml(pet.displayName)}</h2>
        <p class="cp-card-by">by ${escapeHtml(pet.ownerName || pet.ownerHandle || '匿名')}</p>
        <p class="cp-card-stats" title="浏览 / 点赞 / 下载">
          <span>👁 ${formatCount(pet.viewCount)}</span>
          <span>♥ ${formatCount(pet.likeCount)}</span>
          <span>⬇ ${formatCount(pet.downloadCount)}</span>
        </p>
        <p class="cp-card-desc">${escapeHtml(pet.description)}</p>
        <div class="cp-card-tags">${pet.tags.map(t => `<button type="button" class="cp-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>
      </div>
      <div class="cp-card-actions">
        <button type="button" class="cp-btn primary" data-install>安装</button>
        <button type="button" class="cp-btn ghost" data-detail>详情</button>
      </div>
    `
    // 点击标题/详情 → 详情页
    card.querySelector('.cp-card-title').addEventListener('click', () => onNavigate(`#/pets/${encodeURIComponent(pet.id)}`))
    card.querySelector('[data-detail]').addEventListener('click', () => onNavigate(`#/pets/${encodeURIComponent(pet.id)}`))
    // 标签点击 → 筛选
    for (const tagBtn of card.querySelectorAll('.cp-tag')) {
      tagBtn.addEventListener('click', event => {
        event.stopPropagation()
        const tag = tagBtn.dataset.tag
        const grid2 = galleryStateFromHash()
        const tags = grid2.tags.includes(tag) ? grid2.tags : [...grid2.tags, tag]
        onNavigate(galleryHash({ ...grid2, tags, page: 1 }))
      })
    }
    // hover 动效：拉全图播放 hash 选行动画（原站另有光标跟随宠物，小窗内易被窗口边缘裁切，不引入）
    const spriteLayer = card.querySelector('.cp-card-sprite')
    card.addEventListener('pointerenter', () => {
      card.classList.add('is-hover')
      fetchImageBlob('spritesheet', pet.spritesheetUrl)
        .then(blobUrl => {
          if (!card.isConnected) return
          applySpriteStyle(spriteLayer.querySelector('.sprite') ?? mountSprite(spriteLayer), {
            url: blobUrl,
            row: state.row,
            frames: state.frames,
            version: pet.spriteVersionNumber
          })
          spriteLayer.classList.add('is-playing')
        })
        .catch(() => { /* 全图加载失败保持静帧 */ })
    })
    card.addEventListener('pointerleave', () => {
      card.classList.remove('is-hover')
      spriteLayer.classList.remove('is-playing')
    })
    // 安装
    card.querySelector('[data-install]').addEventListener('click', async event => {
      event.stopPropagation()
      await runInstall(pet, kit, card)
    })
    grid.append(card)
  }
}

function mountSprite(layer) {
  const el = document.createElement('div')
  el.className = 'sprite'
  layer.append(el)
  return el
}

async function loadPoster(img) {
  const url = img.dataset.poster
  if (!url) return
  try {
    img.src = await fetchImageBlob('poster', url)
    img.classList.add('is-loaded')
  } catch {
    img.classList.add('is-error')
  }
}

/**
 * 分页控件（渲染进底栏的 #g-pager）。
 *
 * 底栏只有一行、左右还各有状态与原站链接，所以用「‹ 第 N / M 页 ›」的紧凑形态，
 * 不用「上一页 / 跳转 / 下一页」三个按钮——那会把底栏撑高、挤掉中间空间。
 * 页码输入保留（大页数时直接跳），但收窄成 3.2em 宽。
 */
function renderPager(pager, page, totalPages, go) {
  pager.innerHTML = `
    <button type="button" class="cp-pager-btn" data-prev ${page <= 1 ? 'disabled' : ''} aria-label="上一页" title="上一页">‹</button>
    <span class="cp-pager-num">第 <input type="number" min="1" max="${totalPages}" value="${page}" aria-label="页码" /> / ${totalPages} 页</span>
    <button type="button" class="cp-pager-btn" data-next ${page >= totalPages ? 'disabled' : ''} aria-label="下一页" title="下一页">›</button>
  `
  pager.querySelector('[data-prev]').addEventListener('click', () => { if (page > 1) go(page - 1) })
  pager.querySelector('[data-next]').addEventListener('click', () => { if (page < totalPages) go(page + 1) })
  // 输入页码后回车即跳转（底栏空间紧，不放"跳转"按钮）
  pager.querySelector('input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    const value = Number(event.currentTarget.value)
    if (Number.isInteger(value) && value >= 1 && value <= totalPages) go(value)
  })
}

function openFilters(body, state, onNavigate, clearFilters) {
  const dlg = body.querySelector('#g-filters-dlg')
  const wrap = dlg.querySelector('.cp-filters-body')
  const groups = [
    ['kind', '类型', KIND_OPTIONS],
    ['format', '格式', FORMAT_OPTIONS],
    ['content', '内容', CONTENT_MODES],
  ]
  wrap.innerHTML = `
    <h3 id="g-filter-title"><span class="quick-only">搜索与</span>筛选</h3>
    <label class="cp-filter-query quick-only">
      <span>关键词</span>
      <input class="pk-input" id="g-filter-query" type="search" placeholder="名称、描述、作者或标签" value="${escapeHtml(state.query)}" />
    </label>
    <div class="cp-filter-group">
      <h4>标签（任一命中）</h4>
      <div class="cp-filter-tags">
        ${FILTER_TAGS.map(tag => `<button type="button" class="cp-tag${state.tags.includes(tag) ? ' is-active' : ''}" data-tag="${tag}" aria-pressed="${state.tags.includes(tag)}">${tag}</button>`).join('')}
      </div>
    </div>
    ${groups.map(([key, label, choices]) => `<div class="cp-filter-group">
      <h4>${label}</h4>
      <div class="cp-filter-seg" role="group" aria-label="${label}">
        ${choices.map(choice => `<button type="button" class="cp-seg${state[key] === choice.id ? ' is-active' : ''}" data-filter-key="${key}" data-filter-value="${choice.id}" aria-pressed="${state[key] === choice.id}">${choice.label}</button>`).join('')}
      </div>
    </div>`).join('')}
    <div class="cp-filter-actions">
      <button type="button" class="cp-btn ghost" data-clear>清除筛选</button>
      <button type="button" class="cp-btn ghost" data-close>取消</button>
      <button type="submit" class="cp-btn primary">应用</button>
    </div>
  `
  const next = { ...state, tags: [...state.tags] }
  const setPressed = (button, pressed) => {
    button.classList.toggle('is-active', pressed)
    button.setAttribute('aria-pressed', String(pressed))
  }
  for (const btn of wrap.querySelectorAll('[data-tag]')) {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag
      const index = next.tags.indexOf(tag)
      if (index >= 0) next.tags.splice(index, 1)
      else next.tags.push(tag)
      setPressed(btn, index < 0)
    })
  }
  for (const btn of wrap.querySelectorAll('[data-filter-key]')) {
    btn.addEventListener('click', () => {
      const { filterKey, filterValue } = btn.dataset
      next[filterKey] = filterValue
      for (const sibling of btn.parentElement.children) setPressed(sibling, sibling === btn)
    })
  }
  wrap.onsubmit = (event) => {
    event.preventDefault()
    const query = wrap.querySelector('#g-filter-query').value.trim()
    dlg.close()
    onNavigate(galleryHash({ ...next, query, page: 1 }))
  }
  wrap.querySelector('[data-clear]').addEventListener('click', () => { dlg.close(); clearFilters() })
  wrap.querySelector('[data-close]').addEventListener('click', () => dlg.close())
  dlg.showModal()
}

/** 卡片/详情共用安装流程（含确认对话框与状态反馈） */
export async function runInstall(pet, kit, cardOrPanel) {
  const label = cardOrPanel?.querySelector('[data-install]')
  const original = label?.textContent
  const steps = {
    detect: '检测 Codex…',
    download: '下载宠物包…',
    verify: '校验包…',
    write: '等待确认写入…'
  }
  try {
    if (label) label.textContent = '检测中…'
    const result = await installPet(pet, (step) => {
      if (label && steps[step]) label.textContent = steps[step]
    })
    if (label) { label.textContent = '已安装 ✓'; label.disabled = true }
    installedIds.add(pet.id)
    kit.toast(`已安装「${pet.displayName}」到 ~/.codex/pets/${result.petId}。在 Codex 设置 → Pets 或 /pet 命令中选择它。`, 'success')
  } catch (err) {
    if (label) { label.textContent = original || '安装'; label.disabled = false }
    kit.toast(`安装失败：${err.message}`, 'error')
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
