/**
 * gallery — 画廊页：搜索 / 排序 / 筛选 / 分页 / 卡片网格 / hover 动效。
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
  } catch { /* 检测失败不阻塞画廊 */
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

/** 画廊页渲染入口 */
export async function renderGallery(body, kit, { onNavigate, cursorPet }) {
  const state = galleryStateFromHash()
  body.innerHTML = `
    <div class="cp-toolbar">
      <form class="cp-search" id="g-search" role="search">
        <input id="g-q" type="search" placeholder="搜索宠物（名称 / 描述 / 作者 / 标签）" value="${escapeHtml(state.query)}" aria-label="搜索宠物" />
        <button type="submit" class="cp-btn">查找</button>
      </form>
      <div class="cp-sorts" role="tablist" aria-label="排序">
        ${GALLERY_SORTS.map(s => `<button type="button" role="tab" class="cp-sort${s.id === state.sort ? ' is-active' : ''}" data-sort="${s.id}" aria-selected="${s.id === state.sort}">${s.label}</button>`).join('')}
      </div>
      <button type="button" class="cp-btn ghost" id="g-filters">筛选${state.tags.length ? `（${state.tags.length}）` : ''}</button>
    </div>
    <div class="cp-meta">
      <span id="g-count">加载中…</span>
      <span id="g-page"></span>
    </div>
    <div class="cp-grid" id="g-grid"></div>
    <nav class="cp-pager" id="g-pager" aria-label="分页"></nav>
    <dialog id="g-filters-dlg" class="cp-filters-dlg"><div class="cp-filters-body"></div></dialog>
  `

  const grid = body.querySelector('#g-grid')
  const countEl = body.querySelector('#g-count')
  const pageEl = body.querySelector('#g-page')
  const pager = body.querySelector('#g-pager')

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

  // 筛选抽屉
  body.querySelector('#g-filters').addEventListener('click', () => openFilters(body, state, onNavigate))

  // 数据加载
  let data
  try {
    data = await listPets(state)
  } catch (err) {
    grid.innerHTML = `<div class="cp-empty">加载失败：${escapeHtml(err.message)}</div>`
    countEl.textContent = ''
    return
  }
  const pets = (data.pets ?? []).map(normalizePet)
  const totalPages = Math.max(1, data.totalPages ?? 1)
  const total = data.total ?? pets.length
  countEl.textContent = `${Number(total).toLocaleString()} 只宠物`
  pageEl.textContent = `第 ${data.page ?? state.page} / ${totalPages} 页`

  if (pets.length === 0) {
    grid.innerHTML = '<div class="cp-empty">没有找到宠物</div>'
    pager.innerHTML = ''
    return
  }

  renderCards(grid, pets, kit, { onNavigate, cursorPet })
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

function renderCards(grid, pets, kit, { onNavigate, cursorPet }) {
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
    // hover 动效：拉全图播放 hash 选行 + 光标跟随宠物（对齐原站行为）
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
      fetchImageBlob('spritesheet', pet.spritesheetUrl)
        .then(blobUrl => cursorPet?.show(pet, blobUrl))
        .catch(() => { /* 光标宠物失败静默 */ })
    })
    card.addEventListener('pointerleave', () => {
      card.classList.remove('is-hover')
      spriteLayer.classList.remove('is-playing')
      cursorPet?.hide()
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

function renderPager(pager, page, totalPages, go) {
  pager.innerHTML = `
    <button type="button" class="cp-btn ghost" data-prev ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="cp-pager-num">第 <input type="number" min="1" max="${totalPages}" value="${page}" aria-label="页码" /> / ${totalPages} 页
      <button type="button" class="cp-btn ghost" data-go>跳转</button></span>
    <button type="button" class="cp-btn ghost" data-next ${page >= totalPages ? 'disabled' : ''}>下一页</button>
  `
  pager.querySelector('[data-prev]').addEventListener('click', () => { if (page > 1) go(page - 1) })
  pager.querySelector('[data-next]').addEventListener('click', () => { if (page < totalPages) go(page + 1) })
  pager.querySelector('[data-go]').addEventListener('click', () => {
    const value = Number(pager.querySelector('input').value)
    if (Number.isInteger(value) && value >= 1 && value <= totalPages) go(value)
  })
}

function openFilters(body, state, onNavigate) {
  const dlg = body.querySelector('#g-filters-dlg')
  const wrap = dlg.querySelector('.cp-filters-body')
  wrap.innerHTML = `
    <h3>筛选</h3>
    <div class="cp-filter-group">
      <h4>标签（任一命中）</h4>
      <div class="cp-filter-tags">
        ${FILTER_TAGS.map(t => `<button type="button" class="cp-tag${state.tags.includes(t) ? ' is-active' : ''}" data-tag="${t}">${t}</button>`).join('')}
      </div>
    </div>
    <div class="cp-filter-group">
      <h4>类型</h4>
      <div class="cp-filter-seg">
        ${KIND_OPTIONS.map(k => `<button type="button" class="cp-seg${state.kind === k.id ? ' is-active' : ''}" data-kind="${k.id}">${k.label}</button>`).join('')}
      </div>
    </div>
    <div class="cp-filter-group">
      <h4>格式</h4>
      <div class="cp-filter-seg">
        ${FORMAT_OPTIONS.map(f => `<button type="button" class="cp-seg${state.format === f.id ? ' is-active' : ''}" data-format="${f.id}">${f.label}</button>`).join('')}
      </div>
    </div>
    <div class="cp-filter-group">
      <h4>内容</h4>
      <div class="cp-filter-seg">
        ${CONTENT_MODES.map(c => `<button type="button" class="cp-seg${state.content === c.id ? ' is-active' : ''}" data-content="${c.id}">${c.label}</button>`).join('')}
      </div>
    </div>
    <div class="cp-filter-actions">
      <button type="button" class="cp-btn ghost" data-clear>清除筛选</button>
      <button type="button" class="cp-btn primary" data-close>完成</button>
    </div>
  `
  let next = { ...state, tags: [...state.tags] }
  const apply = () => { onNavigate(galleryHash({ ...next, page: 1 })); dlg.close() }
  for (const btn of wrap.querySelectorAll('[data-tag]')) {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag
      const i = next.tags.indexOf(tag)
      if (i >= 0) { next.tags.splice(i, 1); btn.classList.remove('is-active') }
      else { next.tags.push(tag); btn.classList.add('is-active') }
    })
  }
  for (const btn of wrap.querySelectorAll('[data-kind]')) {
    btn.addEventListener('click', () => { next.kind = btn.dataset.kind; apply() })
  }
  for (const btn of wrap.querySelectorAll('[data-format]')) {
    btn.addEventListener('click', () => { next.format = btn.dataset.format; apply() })
  }
  for (const btn of wrap.querySelectorAll('[data-content]')) {
    btn.addEventListener('click', () => { next.content = btn.dataset.content; apply() })
  }
  wrap.querySelector('[data-clear]').addEventListener('click', () => onNavigate(galleryHash({ ...DEFAULT_GALLERY_STATE })))
  wrap.querySelector('[data-close]').addEventListener('click', () => dlg.close())
  dlg.addEventListener('close', () => {}, { once: true })
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
