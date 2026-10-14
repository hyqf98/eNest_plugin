import * as core from './core.js'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)
const esc = PluginKit.escape
const KEY = 'snippets_v1'
const HOTKEY_SETTING = 'globalHotkey'

let snippets = []
let query = ''
let selected = ''
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

const visible = () => core.sortSnippets(core.filterSnippets(snippets, query))

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
  const rows = visible()
  if (!rows.some((s) => s.id === selected)) selected = rows[0]?.id || ''
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
    : `<div class="empty">${query ? '没有匹配的片段' : '还没有片段<br><small>新建一条，或从设置导入</small>'}</div>`
  $('count').textContent = `${rows.length} 条片段 · ${snippets.reduce((a, s) => a + (s.useCount || 0), 0)} 次复制`
  if (kit.mode === 'shell') renderDetail()
}

function renderDetail() {
  const s = snippets.find((x) => x.id === selected)
  if (!s) {
    $('detail').innerHTML = '<div class="empty">左侧选择片段<br><small>或点「新建片段」添加第一条</small></div>'
    return
  }
  const vars = core.extractVars(s.content)
  $('detail').innerHTML = `
    <div class="detail-head">
      <div class="detail-name">
        <h2>${esc(s.title)}</h2>
        <div class="snippet-meta"><span class="lang ${core.langClass(s.lang)}">${esc(s.lang || 'text')}</span>${s.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
      </div>
      <div class="detail-actions">
        <button data-act="edit">编辑</button>
        <button data-act="delete" class="danger">删除</button>
      </div>
    </div>
    <pre class="code mono">${esc(s.content)}</pre>
    <div class="detail-foot">
      <span class="muted">${s.useCount ? `已复制 ${s.useCount} 次` : '尚未使用'}${vars.length ? ` · ${vars.length} 个占位符` : ''}</span>
      <button class="primary" data-act="copy">复制${vars.length ? '（填值）' : ''}</button>
    </div>`
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

// —— 编辑器 —— //
function openEditor(snippet) {
  editing = snippet || null
  $('editor-title').textContent = snippet ? '编辑片段' : '新建片段'
  $('f-title').value = snippet?.title || ''
  $('f-lang').value = snippet?.lang || ''
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

// —— 详情操作（复制 / 编辑 / 删除二次确认） —— //
$('detail').onclick = (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act
  if (!act) return
  const s = snippets.find((x) => x.id === selected)
  if (!s) return
  if (act === 'copy') return void copySnippet(s)
  if (act === 'edit') return openEditor(s)
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
  for (const s of incoming) if (known.has(s.id)) s.id = crypto.randomUUID()
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
