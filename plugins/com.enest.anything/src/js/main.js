/** Anything 文件搜索主流程：双模式搜索、结果导航、文件操作与 Quick 推送。 */
import { backend, backendReady } from './backend.js'
import { fileIcon } from './icons.js'
import { formatSize, formatWhen, highlightName, parseQuery } from './query.js'
import { createPreview } from './preview.js'

const api = () => window.enest || window.zapi
const $ = id => document.getElementById(id)
const escape = PluginKit.escape

const kit = PluginKit.create({
  title: 'Anything 文件搜索',
  height: 490,
  quickPlaceholder: '搜索全盘文件，如 报告 pdf…',
  defaults: { resultLimit: 100, everythingPort: 0, everythingAuth: '' },
  onQuery: value => onQueryInput(value),
  onAction: action => {
    if (action === 'next') move(1)
    else if (action === 'previous') move(-1)
    else if (action === 'submit') void activateSelected()
    else if (action === 'clear') { state.query = ''; renderIdle() }
  }
})

const state = {
  query: '', directory: '', sort: 'relevance',
  results: [], selected: -1, offset: 0, hasMore: false,
  seq: 0, searching: false, provider: null, report: null,
  booted: false, timer: 0
}

const preview = createPreview($('preview'))

// —— 状态条与引擎徽标 —— //

const PROVIDER_LABEL = { spotlight: 'Spotlight', everything: 'Everything' }

function setStatus(text, kind = '') {
  const status = $('status')
  status.textContent = text
  status.dataset.kind = kind
}

function updateEngineBadge(report) {
  const badge = $('engine-badge')
  const active = report?.providers?.find(item => item.id === report.active)
  if (!active) {
    badge.hidden = true
    return
  }
  badge.hidden = false
  badge.textContent = active.label
  badge.title = active.detail
}

// —— 搜索流 —— //

function onQueryInput(value) {
  state.query = String(value ?? '')
  clearTimeout(state.timer)
  if (!state.query.trim()) {
    state.seq++
    renderIdle()
    return
  }
  state.timer = setTimeout(() => void runSearch(true), kit.mode === 'quick' ? 120 : 220)
}

async function runSearch(reset) {
  const query = state.query.trim()
  if (!query) return
  const seq = ++state.seq
  state.searching = true
  setStatus(`搜索中 · ${query}`, 'busy')
  const limit = Math.max(20, Math.min(Number(kit.settings.resultLimit) || 100, 500))
  const offset = reset ? 0 : state.offset
  try {
    const res = await backend.search(query, {
      directory: state.directory || undefined,
      limit, offset, sort: state.sort,
      everythingPort: Number(kit.settings.everythingPort) || 0,
      everythingAuth: String(kit.settings.everythingAuth || '') || undefined
    })
    if (seq !== state.seq) return
    state.provider = res.provider
    if (reset) {
      state.results = res.results
      state.selected = res.results.length ? 0 : -1
    } else {
      state.results = state.results.concat(res.results)
    }
    state.offset = offset + res.results.length
    state.hasMore = res.truncated
    state.searching = false
    renderList()
    const label = PROVIDER_LABEL[res.provider] || res.provider
    const truncatedNote = res.truncated ? '（已截断）' : ''
    setStatus(res.results.length
      ? `${label} · ${reset ? res.total : state.results.length} 条 · ${res.elapsedMs} ms${truncatedNote}`
      : '没有找到匹配的文件，试试更短的关键词或移除目录限定')
    if (reset) void previewSelected()
  } catch (error) {
    if (seq !== state.seq) return
    state.searching = false
    if (reset) {
      state.results = []
      state.selected = -1
      state.hasMore = false
      renderList()
    }
    setStatus(error.message, 'error')
  }
}

// —— 结果列表 —— //

function renderList() {
  const list = $('list')
  const tokens = parseQuery(state.query)
  list.replaceChildren()
  state.results.forEach((file, index) => {
    const row = document.createElement('div')
    row.className = 'row' + (index === state.selected ? ' active' : '')
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', index === state.selected ? 'true' : 'false')
    row.style.setProperty('--i', Math.min(index, 16))

    const icon = document.createElement('span')
    icon.className = 'ficon-slot'
    icon.innerHTML = fileIcon(file)

    const main = document.createElement('span')
    main.className = 'row-main'
    const name = document.createElement('span')
    name.className = 'name'
    name.innerHTML = highlightName(escape(file.name), tokens)
    const where = document.createElement('span')
    where.className = 'where'
    where.textContent = file.dir
    main.append(name, where)

    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = [formatWhen(file.mtimeMs), formatSize(file.size, file.isDirectory)].filter(Boolean).join(' · ')

    row.append(icon, main, meta)
    if (kit.mode === 'quick') {
      row.addEventListener('click', () => { select(index, false); void activateSelected() })
    } else {
      row.addEventListener('click', () => select(index, true))
      row.addEventListener('dblclick', () => void activateSelected())
    }
    list.append(row)
  })
  $('more').hidden = !state.hasMore
  if (state.selected >= 0) ensureVisible(state.selected)
}

function ensureVisible(index) {
  const row = $('list').children[index]
  if (row) row.scrollIntoView({ block: 'nearest' })
}

function select(index, withPreview) {
  if (index < 0 || index >= state.results.length) return
  state.selected = index
  const previous = $('list').querySelector('.row.active')
  if (previous) previous.classList.remove('active')
  const row = $('list').children[index]
  if (row) {
    row.classList.add('active')
    row.setAttribute('aria-selected', 'true')
  }
  if (previous) previous.setAttribute('aria-selected', 'false')
  ensureVisible(index)
  if (withPreview) void previewSelected()
}

function move(delta) {
  if (!state.results.length) return
  const next = Math.max(0, Math.min(state.selected + delta, state.results.length - 1))
  select(next, kit.mode === 'shell')
}

function selectedFile() {
  return state.selected >= 0 ? state.results[state.selected] : null
}

function previewSelected() {
  const file = selectedFile()
  if (file && kit.mode === 'shell') preview.load(file)
}

// —— 文件操作 —— //

function dismissQuick() {
  if (kit.mode === 'quick' && typeof api()?.ui?.dismissQuick === 'function') {
    api().ui.dismissQuick().catch(() => {})
  }
}

async function openTarget(path, dismissAfter) {
  try {
    await backend.open(path)
    kit.toast('已打开', 'success')
    if (dismissAfter) dismissQuick()
  } catch (error) {
    kit.toast(error.message, 'error')
  }
}

async function activateSelected() {
  const file = selectedFile()
  if (file) await openTarget(file.path, true)
}

async function revealSelected() {
  const file = selectedFile()
  if (!file) return
  try {
    await backend.reveal(file.path)
    kit.toast('已在文件管理器中定位', 'success')
    dismissQuick()
  } catch (error) {
    kit.toast(error.message, 'error')
  }
}

function copySelectedPath() {
  const file = selectedFile()
  if (file) void kit.copy(file.path)
}

function askTrash() {
  const file = selectedFile()
  if (!file) return
  $('trash-text').textContent = `${file.name}（${file.path}）将移入系统废纸篓，可在废纸篓中恢复。`
  $('confirm-trash').showModal()
}

async function confirmTrash() {
  const file = selectedFile()
  if (!file) return
  try {
    await backend.trash(file.path)
    kit.toast('已移入废纸篓', 'success')
    state.results.splice(state.selected, 1)
    if (state.selected >= state.results.length) state.selected = state.results.length - 1
    renderList()
    void previewSelected()
  } catch (error) {
    kit.toast(error.message, 'error')
  }
}

// —— 空态 / 引导 —— //

function renderIdle() {
  state.results = []
  state.selected = -1
  state.hasMore = false
  const list = $('list')
  list.replaceChildren()
  const panel = document.createElement('div')
  panel.className = 'idle'
  const syntax = document.createElement('dl')
  const rules = [
    ['多个关键词', '同时命中文件名，顺序不限：报告 pdf'],
    ['"精确短语"', '引号内连续匹配："年度报告"'],
    ['-排除词', '剔除命中：logo -png'],
    ['* 通配符', '*.sketch 或 report-*-final']
  ]
  for (const [term, explain] of rules) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = explain
    syntax.append(dt, dd)
  }
  const heading = document.createElement('p')
  heading.className = 'idle-title'
  heading.textContent = '输入关键词即搜全盘文件'
  panel.append(heading, syntax)
  list.append(panel)
  $('more').hidden = true
  const label = state.report?.active ? (PROVIDER_LABEL[state.report.active] || '') : ''
  setStatus(label ? `引擎 ${label} 就绪，输入开始搜索` : '输入开始搜索')
  preview.placeholder('选择左侧文件查看预览')
}

function renderNoEngine() {
  const platform = state.report?.platform || ''
  const list = $('list')
  list.replaceChildren()
  const panel = document.createElement('div')
  panel.className = 'idle'
  const heading = document.createElement('p')
  heading.className = 'idle-title'
  const detail = document.createElement('p')
  detail.className = 'idle-text'
  if (platform === 'win32') {
    heading.textContent = '需要 Everything 提供搜索引擎'
    detail.textContent = '安装 Everything（voidtools.com），在 选项 → HTTP 服务器 中开启服务，然后回到本插件的偏好设置填入端口。'
  } else {
    heading.textContent = '当前平台暂无可用搜索引擎'
    detail.textContent = 'Linux 支持将在后续版本提供。'
  }
  panel.append(heading, detail)
  list.append(panel)
  setStatus(platform === 'win32' ? '未检测到 Everything HTTP 服务' : '无可用引擎', 'error')
}

// —— 引擎探测与设置联动 —— //

async function probeProviders() {
  if (!backendReady()) {
    setStatus('后端接口不可用，请更新 eNest 壳子', 'error')
    return
  }
  try {
    const report = await backend.providers({
      everythingPort: Number(kit.settings.everythingPort) || 0,
      everythingAuth: String(kit.settings.everythingAuth || '') || undefined
    })
    state.report = report
    updateEngineBadge(report)
    if (!report.active) renderNoEngine()
  } catch (error) {
    setStatus(`引擎探测失败：${error.message}`, 'error')
  }
}

kit.onSettings(async (_settings, key) => {
  if (key === 'everythingPort' || key === 'everythingAuth') await probeProviders()
})

// —— Quick 推送（Quick 搜索条直接出文件结果，回车打开）—— //

let providerCache = { query: '', items: [] }

function registerProvider() {
  if (!api()?.contribute || !backendReady()) return
  api().contribute.registerQuickProvider?.({ id: 'anything', explain: '全盘文件搜索' }).catch(() => {})
  api().contribute.onQuickQuery?.(({ reqId, query }) => {
    const text = String(query || '').trim()
    const respond = items => { api().contribute.respondQuickQuery?.(reqId, items).catch(() => {}) }
    if (!state.booted || text.length < 2) return respond([])
    if (providerCache.query === text) return respond(providerCache.items)
    backend.search(text, {
      limit: 8, sort: 'relevance',
      everythingPort: Number(kit.settings.everythingPort) || 0,
      everythingAuth: String(kit.settings.everythingAuth || '') || undefined
    })
      .then(res => {
        const items = res.results.map(file => ({
          id: file.path,
          title: file.name,
          subtitle: file.dir,
          explain: file.isDirectory ? '目录' : (file.ext ? `.${file.ext}` : '文件'),
          code: 'open-file',
          payload: { path: file.path }
        }))
        providerCache = { query: text, items }
        respond(items)
      })
      .catch(() => respond([]))
  })
}

// —— 入口事件：触发词 / over 文本 / provider 条目 —— //

api()?.onEnter?.(({ code, payload }) => {
  if (code === 'open-file' && payload && typeof payload === 'object' && typeof payload.path === 'string') {
    void openTarget(payload.path, true)
    return
  }
  const text = typeof payload === 'string' ? payload : payload?.type === 'text' && typeof payload.text === 'string' ? payload.text : ''
  if (code === 'find' && text) {
    state.query = text
    const input = $('query')
    input.value = text
    kit.setQuery(text)
    void runSearch(true)
  } else if (code === 'find' && kit.mode === 'shell') {
    $('query').focus()
  }
})

// —— DOM 接线 —— //

function wireDom() {
  const input = $('query')
  input.addEventListener('input', () => onQueryInput(input.value))
  input.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Enter') {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey) void revealSelected()
      else void activateSelected()
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault()
      input.value = ''
      onQueryInput('')
    }
  })

  $('sort').addEventListener('change', event => {
    state.sort = event.target.value
    if (state.query.trim()) void runSearch(true)
  })

  $('scope-pick').addEventListener('click', async () => {
    if (state.directory) {
      state.directory = ''
      $('scope-pick').textContent = '范围：全盘'
      if (state.query.trim()) void runSearch(true)
      return
    }
    const [picked] = await api()?.localFiles?.pick?.({ kind: 'directory' }) ?? []
    if (picked?.displayPath) {
      state.directory = picked.displayPath
      $('scope-pick').textContent = `范围：${picked.name || picked.displayPath}`
      $('scope-pick').title = `点击清除范围（当前 ${picked.displayPath}）`
      if (state.query.trim()) void runSearch(true)
    }
  })

  $('more').addEventListener('click', () => void runSearch(false))
  $('open').addEventListener('click', () => void activateSelected())
  $('reveal').addEventListener('click', () => void revealSelected())
  $('copy-path').addEventListener('click', copySelectedPath)
  $('trash').addEventListener('click', askTrash)
  $('trash-cancel').addEventListener('click', () => $('confirm-trash').close(''))
  $('confirm-trash').addEventListener('close', () => {
    if ($('confirm-trash').returnValue === 'ok') void confirmTrash()
  })
  $('trash-ok').addEventListener('click', () => { $('confirm-trash').close('ok') })

  kit.onMode(() => {
    renderList()
    if (kit.mode === 'shell' && state.query.trim() && !state.results.length) void runSearch(true)
    if (kit.mode === 'shell') void previewSelected()
  })
}

// —— 启动 —— //

void (async () => {
  await kit.ready
  wireDom()
  renderIdle()
  await probeProviders()
  state.booted = true
  registerProvider()
})()
