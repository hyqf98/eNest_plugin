import * as core from './core.js'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)
const esc = PluginKit.escape
const KEY = 'snippets_v1'
const HOTKEY_SETTING = 'globalHotkey'

let snippets = []
let query = ''
let selected = ''
let activeGroup = '' // '' = 全部
let editing = null
let pendingCopy = null
let ready = false
let confirmTimer = 0

const kit = PluginKit.create({
  title: '代码片段',
  quickPlaceholder: '搜索片段，回车复制选中',
  height: 430,
  defaults: { globalHotkey: '' },
})

const visible = () => {
  let rows = core.sortSnippets(core.filterSnippets(snippets, query))
  if (activeGroup) rows = rows.filter((s) => core.groupOf(s) === activeGroup)
  return rows
}

async function persist() {
  await kit.save(KEY, { version: 1, snippets })
}

function touchUse(id) {
  const s = snippets.find((x) => x.id === id)
  if (!s) return
  s.useCount = (s.useCount || 0) + 1
  s.lastUsedAt = Date.now()
  void persist().catch(() => {})
}

// —— 渲染 —— //
function render() {
  renderGroups()
  const rows = visible()
  if (!rows.some((s) => s.id === selected)) selected = rows[0]?.id || ''
  $('list-count').textContent = rows.length ? String(rows.length) : ''
  $('list').innerHTML = rows.length
    ? rows
        .map(
          (s) => `<div class="snippet ${selected === s.id ? 'selected' : ''}" role="option" aria-selected="${selected === s.id}" data-id="${esc(s.id)}" tabindex="0">
  <div class="snippet-main">
    <div class="snippet-title">${esc(s.title)}</div>
    <div class="snippet-meta"><span class="lang ${core.langClass(s.lang)}">${esc(s.lang || 'text')}</span>${s.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
  </div>
  <span class="snippet-count mono">${s.useCount ? s.useCount : ''}</span>
</div>`,
        )
        .join('')
    : `<div class="empty">${query ? '没有匹配的片段' : activeGroup ? '该分组还没有片段' : '还没有片段<br><small>点「新建片段」添加第一条</small>'}</div>`
  $('count').textContent = `${snippets.length} 条片段 · ${snippets.reduce((a, s) => a + (s.useCount || 0), 0)} 次复制`
  if (kit.mode === 'shell') renderDetail()
}

function renderGroups() {
  const counts = core.groupCounts(snippets)
  const total = snippets.length
  const item = (name, count, active) =>
    `<div class="group ${active ? 'active' : ''}" role="treeitem" aria-selected="${active}" data-group="${esc(name)}" tabindex="0">
  <span class="group-name">${esc(name)}</span>
  <span class="group-count mono">${count || ''}</span>
</div>`
  const all = `<div class="group ${!activeGroup ? 'active' : ''}" role="treeitem" aria-selected="${!activeGroup}" data-group="" tabindex="0"><span class="group-name">全部</span><span class="group-count mono">${total || ''}</span></div>`
  $('group-tree').innerHTML =
    all +
    core
      .collectGroups(snippets)
      .map((g) => item(g, counts.get(g) || 0, activeGroup === g))
      .join('')
  $('group-options').innerHTML = core
    .collectGroups(snippets)
    .filter((g) => g !== '未分组')
    .map((g) => `<option value="${esc(g)}"></option>`)
    .join('')
}

// —— 详情代码块：高亮 + 行号 + 缩进折叠（折叠状态跟随片段，切换片段重置） —— //
let foldCtx = null // { id, byStart: Map<startLine, fold>, collapsed: Set }

function codeBlockHtml(s) {
  const scope = core.langScope(s.lang)
  const folds = core.computeFoldRanges(s.content)
  if (!folds) {
    // 超过 1500 行的长片段只做整体高亮，不逐行建折叠（性能取舍）
    return `<pre class="code mono" tabindex="0">${core.highlightToHtml(s.content, scope)}</pre>`
  }
  const lines = core.highlightLines(s.content, scope)
  const byStart = new Map(folds.map((f) => [f.start, f]))
  foldCtx =
    foldCtx && foldCtx.id === s.id
      ? { ...foldCtx, byStart } // 内容编辑后重建映射，保留已折叠状态
      : { id: s.id, byStart, collapsed: new Set() }
  const rows = lines
    .map((lc, i) => {
      const f = byStart.get(i)
      const folded = foldCtx.collapsed.has(i)
      const btn = f
        ? `<button class="fold-btn" data-fold="${i}" aria-expanded="${!folded}" aria-label="折叠第 ${i + 1} 行的块" tabindex="-1"></button>`
        : `<span class="fold-sp"></span>`
      const ell = f
        ? `<span class="fold-ell"${folded ? '' : ' hidden'}> ⋯ ${f.end - f.start} 行</span>`
        : ''
      return `<span class="cl${folded ? ' folded' : ''}" data-l="${i}"><span class="ln">${i + 1}</span>${btn}<span class="lc">${lc || ' '}</span>${ell}</span>`
    })
    .join('')
  return `<div class="codewrap">
    <div class="code-tools">
      <button class="chip" data-code-fold="all">全部折叠</button>
      <button class="chip" data-code-fold="none">全部展开</button>
      <span class="grow"></span>
      <span class="muted mono">${lines.length} 行${folds.length ? ` · ${folds.length} 处可折叠` : ''}</span>
    </div>
    <pre class="code foldable mono" tabindex="0">${rows}</pre>
  </div>`
}

function applySnippetFolds() {
  const pre = document.querySelector('#detail .code.foldable')
  if (!pre || !foldCtx) return
  const rows = [...pre.querySelectorAll('.cl')]
  rows.forEach((row, i) => {
    let hide = false
    for (const start of foldCtx.collapsed) {
      const f = foldCtx.byStart.get(start)
      if (f && i > f.start && i <= f.end) {
        hide = true
        break
      }
    }
    row.hidden = hide
  })
  for (const [start] of foldCtx.byStart) {
    const folded = foldCtx.collapsed.has(start)
    const row = rows[start]
    row.classList.toggle('folded', folded)
    const btn = row.querySelector('.fold-btn')
    if (btn) btn.setAttribute('aria-expanded', String(!folded))
    const ell = row.querySelector('.fold-ell')
    if (ell) ell.hidden = !folded
  }
}

function renderDetail() {
  const s = snippets.find((x) => x.id === selected)
  if (!s) {
    foldCtx = null
    $('detail').innerHTML = '<div class="empty">左侧选择片段<br><small>或点「新建片段」添加第一条</small></div>'
    return
  }
  const vars = core.extractVars(s.content)
  $('detail').innerHTML = `
    <div class="detail-head">
      <div class="detail-name">
        <h2>${esc(s.title)}</h2>
        <div class="snippet-meta"><span class="lang ${core.langClass(s.lang)}">${esc(s.lang || 'text')}</span><button class="group-chip" data-act="group" title="修改分组">${esc(core.groupOf(s))}</button>${s.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
      </div>
      <div class="detail-actions">
        <button data-act="edit">编辑</button>
        <button data-act="delete" class="danger">删除</button>
      </div>
    </div>
    ${codeBlockHtml(s)}
    <div class="detail-foot">
      <span class="muted">${s.useCount ? `已复制 ${s.useCount} 次` : '尚未使用'}${vars.length ? ` · ${vars.length} 个占位符` : ''}</span>
      <button class="primary" data-act="copy">复制${vars.length ? '（填值）' : ''}</button>
    </div>`
  applySnippetFolds()
}

// —— 复制（含占位符流程） —— //
async function copySnippet(s) {
  const vars = core.extractVars(s.content)
  if (vars.length) {
    pendingCopy = s
    $('vars-fields').innerHTML = vars
      .map(
        (name, i) =>
          `<label>${esc(name)}<input data-var="${esc(name)}" placeholder="填入 ${esc(name)}" ${i === 0 ? 'autofocus' : ''} /></label>`,
      )
      .join('')
    $('vars-hint').textContent = `「${s.title}」包含 ${vars.length} 个占位符`
    $('vars-dialog').showModal()
    return
  }
  await finishCopy(s, {})
}

async function finishCopy(s, values) {
  const text = core.renderVars(s.content, values)
  try {
    await api.clipboard.writeText(text)
  } catch (e) {
    kit.toast(e?.message || '复制失败', 'error')
    return
  }
  touchUse(s.id)
  render()
  kit.toast(`已复制「${s.title}」`, 'success')
}

$('vars-cancel').onclick = () => {
  pendingCopy = null
  $('vars-dialog').close()
}
$('vars-form').onsubmit = (e) => {
  e.preventDefault()
  const values = {}
  $('vars-fields').querySelectorAll('[data-var]').forEach((el) => (values[el.dataset.var] = el.value))
  const s = pendingCopy
  pendingCopy = null
  $('vars-dialog').close()
  if (s) void finishCopy(s, values)
}

// —— 键盘导航：↑↓ 移动选择，Enter 复制 —— //
function moveSelection(delta) {
  const rows = visible()
  if (!rows.length) return
  const i = rows.findIndex((s) => s.id === selected)
  const next = rows[Math.min(rows.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))]
  if (next) {
    selected = next.id
    render()
    $('list').querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }
}
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.defaultPrevented) return
  if (document.querySelector('dialog[open]')) return
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && kit.mode === 'shell') {
    e.preventDefault()
    openEditor(null)
    return
  }
  if (inField) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
  } else if (e.key === 'Enter' && selected && kit.mode === 'shell') {
    const s = snippets.find((x) => x.id === selected)
    if (s) {
      e.preventDefault()
      void copySnippet(s)
    }
  }
})

// —— 编辑器 —— //
function openEditor(snippet) {
  editing = snippet || null
  $('editor-title').textContent = snippet ? '编辑片段' : '新建片段'
  $('f-title').value = snippet?.title || ''
  $('f-lang').value = snippet?.lang || ''
  $('f-group').value = snippet ? core.groupOf(snippet) : activeGroup && activeGroup !== '未分组' ? activeGroup : ''
  $('f-tags').value = snippet?.tags.join(', ') || ''
  $('f-content').value = snippet?.content || ''
  $('editor-error').hidden = true
  $('editor').showModal()
  $('f-title').focus()
}
$('new-snippet').onclick = () => openEditor(null)
$('editor-cancel').onclick = () => $('editor').close()
$('editor-form').onsubmit = (e) => {
  e.preventDefault()
  try {
    const normalized = core.normalizeSnippet(
      {
        ...(editing || {}),
        title: $('f-title').value,
        lang: $('f-lang').value,
        group: core.validGroupName($('f-group').value),
        tags: $('f-tags').value,
        content: $('f-content').value,
      },
      editing?.id,
    )
    if (editing) {
      const i = snippets.findIndex((s) => s.id === editing.id)
      if (i >= 0) snippets[i] = normalized
    } else {
      snippets.unshift(normalized)
    }
    selected = normalized.id
    $('editor').close()
    void persist().catch((err) => kit.toast(err.message, 'error'))
    render()
  } catch (err) {
    $('editor-error').textContent = err.message
    $('editor-error').hidden = false
  }
}

// —— 列表交互（点击选中 / Enter 或 Quick 下点击即复制） —— //
function activate(id) {
  const s = snippets.find((x) => x.id === id)
  if (!s) return
  if (kit.mode === 'quick') return void copySnippet(s)
  selected = id
  render()
}
$('list').onclick = (e) => {
  const row = e.target.closest('[data-id]')
  if (row) activate(row.dataset.id)
}
$('list').onkeydown = (e) => {
  if (e.isComposing) return
  const row = e.target.closest('[data-id]')
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    activate(row.dataset.id)
  }
}

// —— 分组交互 —— //
$('group-tree').onclick = (e) => {
  const row = e.target.closest('[data-group]')
  if (!row) return
  activeGroup = row.dataset.group
  render()
}
$('group-tree').onkeydown = (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const row = e.target.closest('[data-group]')
  if (row) {
    e.preventDefault()
    activeGroup = row.dataset.group
    render()
  }
}
$('new-group').onclick = () => {
  const name = core.validGroupName(prompt('分组名称'))
  if (!name) return
  if (!core.collectGroups(snippets).includes(name)) {
    // 空分组没有片段载体，预置一条占位片段让分组可见
    snippets.unshift(
      core.normalizeSnippet({ title: `${name} · 新片段`, lang: '', group: name, content: '// 在此粘贴代码' }),
    )
    selected = snippets[0].id
    void persist().catch(() => {})
    render()
  }
  activeGroup = name
  render()
}

// —— 详情操作（折叠 / 复制 / 编辑 / 删除二次确认 / 改分组） —— //
$('detail').onclick = (e) => {
  const fb = e.target.closest('.fold-btn')
  if (fb && foldCtx) {
    const start = Number(fb.dataset.fold)
    if (foldCtx.collapsed.has(start)) foldCtx.collapsed.delete(start)
    else foldCtx.collapsed.add(start)
    applySnippetFolds()
    return
  }
  const ct = e.target.closest('[data-code-fold]')
  if (ct) {
    if (!foldCtx) return
    foldCtx.collapsed.clear()
    if (ct.dataset.codeFold === 'all')
      for (const [start, f] of foldCtx.byStart) if (f.depth === 0) foldCtx.collapsed.add(start)
    applySnippetFolds()
    return
  }
  const act = e.target.closest('[data-act]')?.dataset.act
  if (!act) return
  const s = snippets.find((x) => x.id === selected)
  if (!s) return
  if (act === 'copy') return void copySnippet(s)
  if (act === 'edit') return openEditor(s)
  if (act === 'group') {
    const next = core.validGroupName(prompt('修改分组', core.groupOf(s)))
    if (!next) return
    s.group = next
    s.updatedAt = Date.now()
    void persist().catch(() => {})
    render()
    return
  }
  if (act === 'delete') {
    const btn = e.target.closest('[data-act="delete"]')
    if (!btn.dataset.confirming) {
      btn.dataset.confirming = '1'
      btn.textContent = '确认删除？'
      clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => {
        delete btn.dataset.confirming
        btn.textContent = '删除'
      }, 2600)
      return
    }
    clearTimeout(confirmTimer)
    snippets = snippets.filter((x) => x.id !== s.id)
    selected = ''
    void persist().catch(() => {})
    render()
    kit.toast('片段已删除')
  }
}

// —— 侧栏分区折叠（分组 / 片段列表），状态记忆在本地 —— //
const SECTION_BODY = { groups: 'group-tree', list: 'list' }
let sideCollapsed = { groups: false, list: false }
try {
  sideCollapsed = { groups: false, list: false, ...JSON.parse(localStorage.getItem('snippets_side_v1') || '{}') }
} catch {}
function applySideSections() {
  for (const [key, bodyId] of Object.entries(SECTION_BODY)) {
    const head = document.querySelector(`.side-head[data-section="${key}"]`)
    const body = document.getElementById(bodyId)
    if (!head || !body) continue
    const collapsed = !!sideCollapsed[key]
    head.classList.toggle('collapsed', collapsed)
    head.setAttribute('aria-expanded', String(!collapsed))
    body.hidden = collapsed
  }
  try {
    localStorage.setItem('snippets_side_v1', JSON.stringify(sideCollapsed))
  } catch {}
}
document.querySelectorAll('.side-head[data-section]').forEach((head) => {
  const toggle = () => {
    const key = head.dataset.section
    sideCollapsed[key] = !sideCollapsed[key]
    applySideSections()
  }
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return // ＋新建分组等按钮不触发折叠
    toggle()
  })
  head.addEventListener('keydown', (e) => {
    if (e.target.closest('button')) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  })
})
applySideSections()

// —— 搜索 —— //
function onSearch(value) {
  query = value
  kit.setQuery(query)
  render()
}
$('search').oninput = (e) => onSearch(e.target.value)

// —— 导入导出 —— //
function mergeImport(incoming) {
  const known = new Set(snippets.map((s) => s.id))
  for (const s of incoming) if (known.has(s.id)) s.id = core.uuid()
  snippets.push(...incoming)
}
$('export').onclick = () =>
  kit.saveText('代码片段.json', JSON.stringify(core.buildExport(snippets), null, 2)).catch((e) => kit.toast(e.message, 'error'))
$('import').onclick = () => {
  $('import-error').hidden = true
  $('import-text').value = ''
  $('import-dialog').showModal()
}
$('import-cancel').onclick = () => $('import-dialog').close()
$('import-form').onsubmit = (e) => {
  e.preventDefault()
  try {
    const incoming = core.parseImport($('import-text').value)
    mergeImport(incoming)
    $('import-dialog').close()
    void persist().catch(() => {})
    render()
    kit.toast(`已导入 ${incoming.length} 条片段`, 'success')
  } catch (err) {
    $('import-error').textContent = err.message
    $('import-error').hidden = false
  }
}
$('import-file').onclick = async () => {
  try {
    const [f] = await api.localFiles.pick({ kind: 'file', access: 'read' })
    if (!f) return
    if (f.size > 5e6) throw new Error('导入文件不能超过 5 MB')
    const incoming = core.parseImport(await api.localFiles.read({ handleId: f.id, encoding: 'text', maxBytes: 5000000 }))
    mergeImport(incoming)
    void persist().catch(() => {})
    render()
    kit.toast(`已导入 ${incoming.length} 条片段`, 'success')
  } catch (err) {
    kit.toast(err.message, 'error')
  }
}

// —— Quick provider：Quick 搜索条直接搜片段，回车复制并 toast —— //
function registerProvider() {
  if (!api?.contribute) return
  api.contribute.registerQuickProvider?.({ id: 'snippets', explain: '搜索并复制代码片段' }).catch(() => {})
  api.contribute.onQuickQuery?.(({ reqId, query: q }) => {
    const rows = core.filterSnippets(snippets, q).slice(0, 8)
    const items = rows.map((s) => ({
      id: s.id,
      title: s.title,
      subtitle: `代码片段${s.lang ? ' · ' + s.lang : ''}`,
      explain: s.tags.length ? s.tags.join(' ') : s.content.split('\n')[0]?.slice(0, 60) || '',
      code: 'copy-snippet',
      snippetId: s.id,
    }))
    api.contribute.respondQuickQuery?.(reqId, items).catch(() => {})
  })
}

// —— 全局热键（默认不占用，用户在设置中填写 accelerator 后生效） —— //
let registeredHotkey = ''
async function applyHotkey() {
  const acc = String(kit.settings[HOTKEY_SETTING] || '').trim()
  if (!api?.hotkey) return
  if (registeredHotkey && registeredHotkey !== acc) {
    await api.hotkey.unregister(registeredHotkey).catch(() => {})
    registeredHotkey = ''
  }
  const state = $('hotkey-state')
  if (acc && acc !== registeredHotkey) {
    const res = await api.hotkey.register(acc).catch(() => ({ ok: false, error: '注册失败' }))
    if (res?.ok) {
      registeredHotkey = acc
      if (state) state.textContent = `全局热键 ${acc} 生效`
    } else if (state) {
      state.textContent = `热键注册失败：${res?.error || '组合键被占用'}`
    }
  } else if (!acc && state) {
    state.textContent = '全局热键未设置 · 在设置中配置后随时呼出'
  }
}
api?.hotkey?.onHotkey?.(({ accelerator }) => {
  if (accelerator === registeredHotkey) {
    const rows = visible()
    if (rows[0]) void copySnippet(rows[0])
  }
})
kit.onSettings(() => void applyHotkey())

// —— 启动（可重入） —— //
const booted = (async () => {
  await kit.ready
  const data = await kit.load(KEY, null)
  if (data && Array.isArray(data.snippets)) snippets = data.snippets.map((s) => core.normalizeSnippet(s))
  ready = true
  render()
  registerProvider()
  void applyHotkey()
  // 桌面首次使用预置一条示例，便于理解占位符
  if (!snippets.length && kit.mode === 'shell') {
    snippets.push(
      core.normalizeSnippet({
        title: '示例：fetch 超时封装',
        lang: 'js',
        group: '网络',
        tags: ['网络', '示例'],
        content:
          'const res = await fetch(url, { signal: AbortSignal.timeout(${timeoutMs}) })\nif (!res.ok) throw new Error(`HTTP ${res.status}`)\nreturn res.json()',
      }),
    )
    void persist().catch(() => {})
    render()
  }
})()

api?.onEnter?.(async (event) => {
  await booted
  const payload = event?.payload
  const pid = typeof payload === 'string' ? payload : payload?.snippetId
  if (pid) {
    const s = snippets.find((x) => x.id === pid)
    if (s) return void copySnippet(s)
  }
  if (event?.code === 'copy-snippet' && payload?.text) {
    try {
      await api.clipboard.writeText(String(payload.text))
      kit.toast('已复制', 'success')
    } catch {}
    return
  }
  if (kit.mode === 'quick') $('search')?.focus()
})

api?.onBeforeClose?.(async () => {
  if (!ready) return
  try {
    await persist()
  } catch {}
})

kit.onMode(() => {
  if (ready) render()
})
