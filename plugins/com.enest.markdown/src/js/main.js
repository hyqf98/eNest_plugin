import * as core from './core.js'

const api = window.enest || window.zapi
const $ = (id) => document.getElementById(id)
const esc = PluginKit.escape
const KEY = 'mdnotes_v1'

let groups = ['收件箱']
let notes = []
let currentGroup = ''
let currentId = ''
let query = ''
let dirty = false
let saveTimer = 0
let ready = false
let confirmTimer = 0
let view = 'split' // edit | split | preview

const kit = PluginKit.create({
  title: 'Markdown 笔记',
  quickPlaceholder: '速记到收件箱…',
  height: 440,
  defaults: { autoPreview: true },
})

async function persist() {
  await kit.save(KEY, { version: 1, groups, notes })
}
function scheduleSave() {
  dirty = true
  $('save-state').textContent = '未保存…'
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void flushSave(), 800)
}
async function flushSave() {
  if (!dirty || !ready) return
  try {
    // 编辑中的内容先入内存
    if (currentId) {
      const note = notes.find((n) => n.id === currentId)
      if (note) {
        note.content = $('editor').value
        note.updatedAt = Date.now()
      }
    }
    await persist()
    dirty = false
    $('save-state').textContent = '已保存'
  } catch (e) {
    $('save-state').textContent = '保存失败 · 重试'
    kit.toast(e.message, 'error')
  }
}

// —— 树渲染 —— //
function visibleNotes() {
  const list = notes.filter((n) => !currentGroup || n.group === currentGroup)
  if (!query.trim()) return list.sort((a, b) => b.updatedAt - a.updatedAt)
  const q = query.trim().toLowerCase()
  return list
    .filter((n) => `${n.title}\n${n.content}`.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function render() {
  // 分组
  $('groups').innerHTML = groups
    .map(
      (g) => `<div class="group ${currentGroup === g ? 'active' : ''}" role="treeitem" data-group="${esc(g)}" tabindex="0">
  <span class="group-name">${esc(g)}</span>
  <span class="group-count mono">${notes.filter((n) => n.group === g).length || ''}</span>
</div>`,
    )
    .join('')
  // 笔记
  const rows = visibleNotes()
  $('notes-tree').innerHTML = rows.length
    ? rows
        .map((n) => {
          const hit = core.searchHighlight(n, query)
          const title = query.trim() && hit.hit ? hit.title : esc(n.title)
          const snippetHtml = query.trim() && hit.hit ? `<span class="note-snippet">${hit.snippet}</span>` : ''
          return `<div class="note-row ${currentId === n.id ? 'active' : ''}" role="treeitem" data-id="${esc(n.id)}" tabindex="0">
  <span class="note-title">${title || '<em>无标题</em>'}${snippetHtml}</span>
  <span class="note-meta mono">${new Date(n.updatedAt).toLocaleDateString()}</span>
  <button class="row-delete" data-del="${esc(n.id)}" title="删除笔记">×</button>
</div>`
        })
        .join('')
    : '<div class="empty small">该分组还没有笔记</div>'
  $('search-summary').textContent = query.trim()
    ? `${rows.length} 条命中「${query.trim()}」`
    : `${notes.length} 条笔记 · ${groups.length} 个分组`
  renderEditor()
}

function renderEditor() {
  const note = notes.find((n) => n.id === currentId)
  if (!note) {
    $('editor').value = ''
    $('editor').disabled = true
    $('preview').innerHTML = '<div class="empty">选择或新建一条笔记</div>'
    $('editor-stats').textContent = ''
    renderOutline('')
    return
  }
  if ($('editor').value !== note.content && document.activeElement !== $('editor')) {
    $('editor').value = note.content
  }
  $('editor').disabled = false
  if (!$('preview').hidden) $('preview').innerHTML = core.renderMarkdown(note.content)
  renderStats(note.content)
  renderOutline(note.content)
}

function renderStats(text) {
  const s = core.stats(text)
  const mins = core.readingTime(text)
  $('editor-stats').textContent = `${s.words} 字 · ${s.lines} 行 · 约 ${mins} 分钟阅读`
}

/* 大纲：标题树 + 源码行定位 */
function renderOutline(text) {
  const items = core.outlineDepth(core.outline(text))
  $('outline-status').textContent = items.length ? `${items.length} 个标题` : ''
  if (!items.length) {
    $('outline-tree').innerHTML = '<div class="outline-empty">用 # 起个标题，大纲会出现在这里</div>'
    return
  }
  $('outline-tree').innerHTML = items
    .map(
      (it, i) =>
        `<button type="button" class="outline-item" data-line="${it.line}" style="padding-left:${8 + it.depth * 14}px" title="跳转到第 ${it.line + 1} 行"><span class="oh mono">h${it.level}</span><span class="ot">${esc(it.text)}</span></button>`,
    )
    .join('')
}
$('outline-tree').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-line]')
  if (!btn) return
  const line = Number(btn.dataset.line)
  const el = $('editor')
  const lines = el.value.split('\n')
  let pos = 0
  for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1
  el.focus()
  el.selectionStart = el.selectionEnd = pos
  // 让目标行滚进视野：用临时 textarea 度量近似行高
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22
  el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 2)
  if (view === 'preview') setView('split')
})

// —— 视图模式：编辑 / 双栏 / 预览 —— //
function setView(next) {
  view = next
  const body = $('editor-body')
  body.dataset.view = next
  $('editor').hidden = next === 'preview'
  $('preview').hidden = next === 'edit'
  $('outline').hidden = next === 'preview'
  for (const [id, mode] of [['mode-edit', 'edit'], ['mode-split', 'split'], ['mode-preview', 'preview']]) {
    $(id).setAttribute('aria-selected', String(mode === next))
  }
  if (next !== 'edit') void hydratePreview()
  else renderOutline($('editor').value)
}
$('mode-edit').onclick = () => setView('edit')
$('mode-split').onclick = () => setView('split')
$('mode-preview').onclick = () => setView('preview')
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.defaultPrevented) return
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
  if (e.key === '1') {
    e.preventDefault()
    setView('edit')
  } else if (e.key === '2') {
    e.preventDefault()
    setView('split')
  } else if (e.key === '3') {
    e.preventDefault()
    setView('preview')
  }
})

// —— 编辑与工具条 —— //
$('editor').addEventListener('input', () => {
  const note = notes.find((n) => n.id === currentId)
  if (!note) return
  note.content = $('editor').value
  note.updatedAt = Date.now()
  scheduleSave()
  if (!$('preview').hidden) $('preview').innerHTML = core.renderMarkdown(note.content)
  renderStats(note.content)
  renderOutline(note.content)
})

function insertAt(transform) {
  const el = $('editor')
  const result = transform(el.value, el.selectionStart, el.selectionEnd)
  el.value = result.text
  el.selectionStart = el.selectionEnd = result.caret
  el.focus()
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
document.querySelector('.editor-toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn || !btn.dataset) return
  if (btn.dataset.wrap) return insertAt((t, s, e2) => core.transformWrap(t, s, e2, btn.dataset.wrap))
  if (btn.dataset.line) return insertAt((t, s) => core.transformLinePrefix(t, s, btn.dataset.line))
  if (btn.dataset.block) return insertAt((t, s, e2) => core.transformBlock(t, s, e2, btn.dataset.block))
})

// 粘贴图片 → storage.blobs 附件
$('editor').addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items || []
  const imageItem = [...items].find((i) => i.type.startsWith('image/'))
  if (!imageItem) return
  e.preventDefault()
  const file = imageItem.getAsFile()
  if (!file) return
  await attachImage(file)
})
$('attach-image').onclick = async () => {
  try {
    if (!api?.clipboard?.readImage) throw new Error('宿主不支持读取剪贴板图片')
    const img = await api.clipboard.readImage()
    if (!img) return kit.toast('剪贴板中没有图片')
    const res = await fetch(img.dataUrl)
    const blob = await res.blob()
    await attachImage(blob)
  } catch (err) {
    kit.toast(err.message, 'error')
  }
}
async function attachImage(file) {
  const note = notes.find((n) => n.id === currentId)
  if (!note) return kit.toast('先选择一条笔记', 'error')
  if (file.size > 24e6) return kit.toast('图片超过 24 MB', 'error')
  if (!api?.storage?.blobs?.put) return kit.toast('当前宿主不支持附件，请更新 eNest', 'error')
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
  try {
    const blob = await api.storage.blobs.put({ dataUrl })
    const name = `img-${Date.now()}.png`
    note.attachments[name] = blob.id
    note.content += `${note.content.endsWith('\n') || !note.content ? '' : '\n'}\n![${name}](blob:${blob.id})\n`
    $('editor').value = note.content
    scheduleSave()
    render()
    kit.toast('图片已作为附件插入', 'success')
  } catch (err) {
    kit.toast(err.message, 'error')
  }
}
// 预览时把 blob:id 换成 dataURL
async function hydratePreview() {
  const note = notes.find((n) => n.id === currentId)
  if (!note) return
  let html = core.renderMarkdown(note.content)
  for (const [name, blobId] of Object.entries(note.attachments)) {
    try {
      const blob = await api?.storage?.blobs?.get?.(blobId)
      if (blob?.dataUrl) html = html.split(`src="blob:${blobId}"`).join(`src="${blob.dataUrl}" alt="${esc(name)}"`)
    } catch {}
  }
  $('preview').innerHTML = html
}

// —— 分组与笔记管理 —— //
$('new-group').onclick = () => {
  const name = prompt('分组名称')
  if (!name) return
  const g = name.trim().slice(0, 60)
  if (g && !groups.includes(g)) {
    groups.push(g)
    currentGroup = g
    void persist().catch(() => {})
    render()
  }
}
$('new-note').onclick = () => createNote()
function createNote(title = '', content = '', group = currentGroup || '收件箱') {
  const note = core.normalizeNote({ title: title || '未命名笔记', content, group })
  notes.unshift(note)
  if (!groups.includes(note.group)) groups.push(note.group)
  currentGroup = note.group
  currentId = note.id
  void persist().catch(() => {})
  render()
  if (kit.mode === 'shell') $('editor').focus()
  return note
}

$('groups').onclick = (e) => {
  const row = e.target.closest('[data-group]')
  if (!row) return
  const g = row.dataset.group
  if (e.target.closest('[data-rename]')) return renameGroup(g)
  currentGroup = g
  render()
}
$('groups').onkeydown = (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const row = e.target.closest('[data-group]')
  if (row) {
    e.preventDefault()
    currentGroup = row.dataset.group
    render()
  }
}
function renameGroup(g) {
  const name = prompt('重命名分组', g)
  if (!name) return
  const next = name.trim().slice(0, 60)
  if (!next || groups.includes(next)) return
  groups = groups.map((x) => (x === g ? next : x))
  notes.forEach((n) => (n.group === g ? (n.group = next) : null))
  if (currentGroup === g) currentGroup = next
  void persist().catch(() => {})
  render()
}
$('groups').oncontextmenu = (e) => {
  const row = e.target.closest('[data-group]')
  if (!row) return
  e.preventDefault()
  renameGroup(row.dataset.group)
}

$('notes-tree').onclick = (e) => {
  const del = e.target.closest('[data-del]')
  if (del) {
    e.stopPropagation()
    const id = del.dataset.del
    const btn = del
    if (!btn.dataset.confirming) {
      btn.dataset.confirming = '1'
      btn.textContent = '确认?'
      clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => {
        delete btn.dataset.confirming
        btn.textContent = '×'
      }, 2600)
      return
    }
    clearTimeout(confirmTimer)
    const note = notes.find((n) => n.id === id)
    notes = notes.filter((n) => n.id !== id)
    for (const blobId of Object.values(note?.attachments || {})) api?.storage?.blobs?.remove?.(blobId).catch(() => {})
    if (currentId === id) currentId = ''
    void persist().catch(() => {})
    render()
    kit.toast('笔记已删除')
    return
  }
  const row = e.target.closest('[data-id]')
  if (row) selectNote(row.dataset.id)
}
$('notes-tree').onkeydown = (e) => {
  if (e.key !== 'Enter' || e.target.closest('[data-del]')) return
  const row = e.target.closest('[data-id]')
  if (row) {
    e.preventDefault()
    selectNote(row.dataset.id)
  }
}
$('notes-tree').oncontextmenu = (e) => {
  const row = e.target.closest('[data-id]')
  if (!row) return
  e.preventDefault()
  const note = notes.find((n) => n.id === row.dataset.id)
  if (!note) return
  const next = prompt('移动到分组（输入分组名，或输入新名称创建）', note.group)
  if (!next) return
  const g = next.trim().slice(0, 60)
  if (!g) return
  note.group = g
  if (!groups.includes(g)) groups.push(g)
  void persist().catch(() => {})
  render()
}

// —— 搜索 —— //
$('search').oninput = (e) => {
  query = e.target.value
  kit.setQuery(query)
  render()
}

// —— 导出 —— //
function currentNote() {
  return notes.find((n) => n.id === currentId)
}
$('export-md').onclick = async () => {
  const note = currentNote()
  if (!note) return kit.toast('先选择一条笔记', 'error')
  try {
    await kit.saveText(`${note.title || '笔记'}.md`, note.content)
  } catch (e) {
    kit.toast(e.message, 'error')
  }
}
$('export-html').onclick = async () => {
  const note = currentNote()
  if (!note) return kit.toast('先选择一条笔记', 'error')
  try {
    await kit.saveText(`${note.title || '笔记'}.html`, core.noteToHtml(note.title, note.content))
  } catch (e) {
    kit.toast(e.message, 'error')
  }
}

// —— 模板 —— //
function applyTemplate(key) {
  const tpl = core.TEMPLATES[key]
  if (!tpl) return
  const el = $('editor')
  const note = notes.find((n) => n.id === currentId)
  if (!note) return
  note.content = el.value = note.content ? note.content + '\n\n' + tpl.content : tpl.content
  scheduleSave()
  render()
}

// —— Quick 速记：直接落收件箱 —— //
function quickCapture(text) {
  const note = core.normalizeNote({
    title: text.split('\n')[0].slice(0, 40) || '速记',
    content: text,
    group: '收件箱',
  })
  notes.unshift(note)
  if (!groups.includes('收件箱')) groups.unshift('收件箱')
  currentGroup = '收件箱'
  currentId = note.id
  void persist().catch(() => {})
  render()
  kit.toast('已存入收件箱', 'success')
}

kit.onAction?.((action) => {
  if (action === 'submit' && kit.mode === 'quick') {
    const text = kit.mode === 'quick' ? query.trim() : ''
    if (text) {
      quickCapture(text)
      kit.setQuery('')
      $('search').value = ''
    }
  }
})

// —— 启动 —— //
const booted = (async () => {
  await kit.ready
  const data = await kit.load(KEY, null)
  if (data && Array.isArray(data.notes)) {
    notes = data.notes.map((n) => core.normalizeNote(n))
    groups = [...new Set(['收件箱', ...(data.groups || []), ...notes.map((n) => n.group)])]
  }
  ready = true
  currentGroup = groups[0] || '收件箱'
  currentId = notes[0]?.id || ''
  const defaultView = kit.settings.autoPreview === false ? 'edit' : 'split'
  setView(kit.mode === 'quick' ? 'edit' : defaultView)
  render()
  // 空态引导：预置欢迎笔记
  if (!notes.length && kit.mode === 'shell') {
    createNote(
      '欢迎使用 Markdown 笔记',
      '# 欢迎\n\n这是一条示例笔记，可以直接改写或删除。\n\n## 语法速览\n\n- **加粗** 与 *斜体*\n- `行内代码`\n- ==高亮== 与 ~~删除线~~\n\n```js\nconst x = 42 // 代码块自带高亮\n```\n\n| 表格 | 示例 |\n| --- | --- |\n| A | B |\n\n- [ ] 任务清单\n\n> 引用与[链接](https://example.com)\n',
      '收件箱',
    )
  }
})()

// 模板快捷：F2 唤起
$('editor').addEventListener('keydown', (e) => {
  if (e.key === 'F2') {
    e.preventDefault()
    const key = prompt('插入模板：meeting（会议记录）/ weekly（周报）/ todo（待办）')
    if (key) applyTemplate(key)
  }
})

api?.onEnter?.(async (event) => {
  await booted
  const payload = event?.payload
  const text = typeof payload === 'string' ? payload : payload?.text
  if (event?.code === 'inbox' && text) return void quickCapture(String(text))
  if (kit.mode === 'quick') $('search')?.focus()
})

api?.onBeforeClose?.(async () => {
  clearTimeout(saveTimer)
  if (!ready) return
  try {
    await flushSave()
  } catch {}
})

kit.onMode(() => {
  if (!ready) return
  if (kit.mode === 'quick') setView('edit')
  render()
})
