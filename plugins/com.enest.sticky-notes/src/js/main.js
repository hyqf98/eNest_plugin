;(() => {
  const api = window.enest || window.zapi,
    $ = (id) => document.getElementById(id),
    esc = PluginKit.escape,
    KEY = 'notes_v2',
    colors = ['#cfa467', '#7fa894', '#b78180', '#7b9ebc', '#a592b7']
  let notes = [],
    selected = '',
    query = '',
    filter = 'all',
    tag = '',
    ready = false,
    preview = false,
    layout = 'list',
    saveTimer,
    undo = null
  const kit = PluginKit.create({
    title: '备忘录',
    quickPlaceholder: '搜索笔记与标签',
    height: 500,
    defaults: { defaultColor: '#cfa467', defaultLayout: 'list' },
    onQuery: (value) => {
      query = value
      renderList()
    },
    onAction: (action) => {
      const rows = visible()
      let i = rows.findIndex((n) => n.id === selected)
      if (action === 'next' || action === 'previous') {
        selected =
          rows[
            Math.max(
              0,
              Math.min(rows.length - 1, i + (action === 'next' ? 1 : -1)),
            )
          ]?.id || ''
        renderList()
      }
      if (action === 'submit' && selected) open(selected)
    },
  })
  const uid = () => crypto.randomUUID(),
    normalize = (n) => ({
      id: typeof n.id === 'string' ? n.id : uid(),
      title: String(n.title || ''),
      text: String(n.text || ''),
      color:
        typeof n.color === 'string' && /^#[\da-f]{6}$/i.test(n.color)
          ? n.color
          : colors[0],
      pinned: !!n.pinned,
      createdAt: Number(n.createdAt) || Date.now(),
      updatedAt: Number(n.updatedAt) || Date.now(),
      tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
      archived: !!n.archived,
      deletedAt: Number(n.deletedAt) || null,
    })
  function title(n) {
    return (
      n.title.trim() ||
      n.text
        .split('\n')
        .find((l) => l.trim())
        ?.replace(/^#+\s*/, '')
        .slice(0, 60) ||
      '未命名笔记'
    )
  }
  async function persist() {
    if (!ready) return
    status('保存中…')
    try {
      await kit.save(KEY, { version: 2, notes })
      status('已保存')
    } catch (e) {
      status('保存失败 · 点击重试')
      kit.toast(e.message, 'error')
    }
  }
  function status(text) {
    if ($('save-state')) $('save-state').textContent = text
  }
  function save(immediate = false) {
    clearTimeout(saveTimer)
    if (immediate) void persist()
    else saveTimer = setTimeout(persist, 300)
  }
  function visible() {
    return notes
      .filter(
        (n) =>
          (filter === 'trash' ? !!n.deletedAt : !n.deletedAt) &&
          (filter === 'archive'
            ? n.archived
            : filter === 'trash'
              ? true
              : !n.archived) &&
          (filter === 'pinned' ? n.pinned : true) &&
          (!tag || n.tags.includes(tag)) &&
          `${n.title} ${n.text} ${n.tags.join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
      )
  }
  function renderList() {
    $('tabs').innerHTML = Object.entries({
      all: '全部',
      pinned: '置顶',
      archive: '归档',
      trash: '回收站',
    })
      .map(
        ([key, label]) =>
          `<button data-filter="${key}" class="${filter === key ? 'active' : ''}">${label}</button>`,
      )
      .join('')
    const tags = [...new Set(notes.flatMap((n) => n.tags))]
    $('tag-filter').innerHTML =
      '<option value="">全部标签</option>' +
      tags
        .map((t) => `<option ${t === tag ? 'selected' : ''}>${esc(t)}</option>`)
        .join('')
    const rows = visible()
    if (!selected && rows.length) selected = rows[0].id
    $('notes').innerHTML = rows.length
      ? rows
          .map(
            (n) =>
              `<article class="note-row ${n.id === selected ? 'selected' : ''}" data-id="${esc(n.id)}" tabindex="0" role="listitem" style="--note-color:${n.color}"><div class="note-title">${n.pinned ? '⌑ ' : ''}${esc(title(n))}</div><div class="note-excerpt">${esc(n.text || '还没有内容')}</div><div class="note-meta"><span>${esc(n.tags.map((t) => '#' + t).join(' '))}</span><time>${new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></div></article>`,
          )
          .join('')
      : '<div class="empty">没有匹配的笔记<br><small>记录一句话，让想法有个落点</small></div>'
    const grid = layout === 'grid' && kit.mode === 'shell'
    $('notes').classList.toggle('grid', grid)
    $('app').classList.toggle('grid-layout', grid)
    $('layout').textContent = grid ? '列表视图' : '卡片视图'
  }
  function markdown(text) {
    let inCode = false
    return (
      text
        .split('\n')
        .map((line) => {
          if (/^```/.test(line)) {
            inCode = !inCode
            return inCode ? '<pre><code>' : '</code></pre>'
          }
          if (inCode) return esc(line) + '\n'
          let html = esc(line)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
          const m = /^(#{1,3})\s+(.+)/.exec(line)
          if (m) return `<h${m[1].length}>${esc(m[2])}</h${m[1].length}>`
          if (/^[-*] \[[ x]\] /.test(line))
            return (
              '<p>' +
              (/^[-*] \[x\]/.test(line) ? '☑ ' : '☐ ') +
              esc(line.slice(6)) +
              '</p>'
            )
          if (/^[-*] /.test(line)) return '<p>• ' + html.slice(2) + '</p>'
          return '<p>' + (html || '<br>') + '</p>'
        })
        .join('') + (inCode ? '</code></pre>' : '')
    )
  }
  function open(id) {
    selected = id
    preview = false
    $('editor').classList.add('open')
    renderList()
    renderEditor()
  }
  function renderEditor() {
    const n = notes.find((n) => n.id === selected)
    if (!n) {
      $('editor').innerHTML =
        '<div class="editor-empty">选择一条笔记，或开始记录</div>'
      return
    }
    $('editor').innerHTML =
      `<div class="editor-top"><button id="back" aria-label="返回笔记列表">←</button><div class="colors">${colors.map((c) => `<button class="color ${n.color === c ? 'chosen' : ''}" data-color="${c}" style="--swatch:${c}" aria-label="切换便签颜色 ${c}"></button>`).join('')}</div><span class="spacer"></span><button id="pin">${n.pinned ? '取消置顶' : '置顶'}</button><button id="preview-toggle">${preview ? '编辑' : '预览'}</button><button id="copy">复制</button><button id="export-note" class="shell-only">导出</button><button id="archive">${n.archived ? '取消归档' : '归档'}</button><button id="delete">${n.deletedAt ? '恢复' : '删除'}</button></div><div class="document"><input id="title" aria-label="笔记标题" placeholder="无标题" value="${esc(n.title)}" maxlength="200"><input id="tags" aria-label="笔记标签" placeholder="添加标签，用逗号分隔" value="${esc(n.tags.join(', '))}"><textarea id="body" placeholder="开始写吧。支持 Markdown 预览。" spellcheck="false" ${preview ? 'hidden' : ''}>${esc(n.text)}</textarea><div id="preview" ${preview ? '' : 'hidden'}>${markdown(n.text)}</div></div><div class="editor-foot"><span id="words">${n.text.length} 字</span><span>⌘ / Ctrl + Shift + Enter 保存</span><button id="undo" ${undo ? '' : 'hidden'}>撤销删除</button><button id="purge" ${n.deletedAt ? '' : 'hidden'}>永久删除</button><button id="save-state">已保存</button></div>`
    for (const [id, key] of [
      ['title', 'title'],
      ['body', 'text'],
      ['tags', 'tags'],
    ])
      $(id).oninput = () => {
        n[key] =
          key === 'tags'
            ? $(id)
                .value.split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean)
            : $(id).value
        n.updatedAt = Date.now()
        $('words').textContent = n.text.length + ' 字'
        save()
        renderList()
      }
    $('back').onclick = () => {
      $('editor').classList.remove('open')
      void persist()
    }
    $('preview-toggle').onclick = () => {
      preview = !preview
      renderEditor()
    }
    $('pin').onclick = () => {
      n.pinned = !n.pinned
      save(true)
      renderList()
      renderEditor()
    }
    $('editor')
      .querySelectorAll('[data-color]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            n.color = b.dataset.color
            save(true)
            renderEditor()
            renderList()
          }),
      )
    $('copy').onclick = () =>
      kit
        .copy((n.title ? n.title + '\n\n' : '') + n.text)
        .catch((e) => kit.toast(e.message, 'error'))
    $('export-note').onclick = () =>
      kit
        .saveText(
          title(n).replace(/[\\/:*?"<>|]/g, '_') + '.md',
          (n.title ? '# ' + n.title + '\n\n' : '') + n.text,
        )
        .catch((e) => kit.toast(e.message, 'error'))
    $('archive').onclick = () => {
      n.archived = !n.archived
      save(true)
      renderList()
      renderEditor()
    }
    $('delete').onclick = () => {
      undo = structuredClone(n)
      n.deletedAt = n.deletedAt ? null : Date.now()
      save(true)
      renderList()
      renderEditor()
      kit.toast(n.deletedAt ? '已移入回收站' : '已恢复笔记')
    }
    $('undo').onclick = () => {
      if (undo) {
        const i = notes.findIndex((x) => x.id === undo.id)
        if (i >= 0) notes[i] = undo
        else notes.push(undo)
        undo = null
        save(true)
        renderList()
        renderEditor()
      }
    }
    $('purge').onclick = () => {
      if (!confirm('永久删除这条笔记？此操作不能撤销。')) return
      notes = notes.filter((x) => x.id !== n.id)
      selected = ''
      undo = null
      save(true)
      renderList()
      renderEditor()
    }
    $('save-state').onclick = () => void persist()
  }
  function create(text = '', titleText = '') {
    if (!ready) return
    const n = normalize({
      id: uid(),
      text,
      title: titleText,
      color: kit.settings.defaultColor,
    })
    notes.unshift(n)
    filter = 'all'
    tag = ''
    query = ''
    $('search').value = ''
    kit.setQuery('')
    save(true)
    open(n.id)
    $('body')?.focus()
  }
  $('new').onclick = () => create()
  $('quick-form').onsubmit = (e) => {
    e.preventDefault()
    const text = $('quick-input').value.trim()
    if (text) {
      create(text)
      $('quick-input').value = ''
    }
  }
  $('template').onchange = (e) => {
    const templates = {
      meeting: ['会议记录', '# 议题\n\n## 讨论\n\n## 决定\n\n## 待办\n- [ ] '],
      checklist: ['行动清单', '- [ ] 第一件事\n- [ ] 第二件事\n'],
      idea: ['想法草稿', '## 想解决什么\n\n## 可行的办法\n\n## 下一步\n'],
    }
    const t = templates[e.target.value]
    if (t) create(t[1], t[0])
    e.target.value = ''
  }
  $('notes').onclick = (e) => {
    const row = e.target.closest('[data-id]')
    if (row) open(row.dataset.id)
  }
  $('notes').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const row = e.target.closest('[data-id]')
      if (row) open(row.dataset.id)
    }
  }
  $('tabs').onclick = (e) => {
    if (e.target.dataset.filter) {
      filter = e.target.dataset.filter
      renderList()
    }
  }
  $('tag-filter').onchange = (e) => {
    tag = e.target.value
    renderList()
  }
  $('search').oninput = (e) => {
    query = e.target.value
    kit.setQuery(query)
    renderList()
  }
  $('layout').onclick = () => {
    layout = layout === 'list' ? 'grid' : 'list'
    renderList()
  }
  $('export-all').onclick = () =>
    kit
      .saveText(
        '备忘录备份.json',
        JSON.stringify({ version: 2, notes }, null, 2),
      )
      .catch((e) => kit.toast(e.message, 'error'))
  $('import').onclick = async () => {
    try {
      const [file] = await api.localFiles.pick({ kind: 'file', access: 'read' })
      if (!file) return
      if (file.size > 10e6) throw Error('导入文件不能超过 10 MB')
      const text = await api.localFiles.read({ handleId: file.id, encoding: 'text', maxBytes: 10000000 })
      if (/\.json$/i.test(file.name)) {
        const data = JSON.parse(text),
          incoming = Array.isArray(data) ? data : data.notes
        if (
          !Array.isArray(incoming) ||
          incoming.some((n) => !n || typeof n.text !== 'string')
        )
          throw Error('笔记备份格式不正确')
        notes.push(...incoming.map((n) => normalize({ ...n, id: uid() })))
        save(true)
        renderList()
        kit.toast(`已导入 ${incoming.length} 条笔记`)
      } else create(text, file.name.replace(/\.(md|txt)$/i, ''))
    } catch (e) {
      kit.toast(e.message, 'error')
    }
  }
  const initialized = (async () => {
    try {
      await kit.ready
      layout = kit.settings.defaultLayout === 'grid' ? 'grid' : 'list'
      const saved = await kit.load(KEY, null)
      if (saved) {
        if (saved.version !== 2 || !Array.isArray(saved.notes))
          throw Error('笔记数据格式异常，未覆盖原数据')
        notes = saved.notes.map(normalize)
      } else {
        const old = await kit.load('notes_v1', [])
        if (!Array.isArray(old)) throw Error('旧笔记数据格式异常')
        await kit.save('notes_v1_backup', old)
        notes = old
          .filter((n) => n && typeof n.text === 'string')
          .map(normalize)
        await kit.save(KEY, { version: 2, notes })
      }
      ready = true
      renderList()
      renderEditor()
    } catch (e) {
      $('notes').innerHTML =
        '<div class="empty">读取失败，原数据已保留。请重新打开插件。</div>'
      kit.toast(e.message, 'error')
    }
  })()
  api?.onEnter?.(async ({ payload }) => {
    await initialized
    const text =
      typeof payload === 'string'
        ? payload
        : payload?.type === 'text'
          ? payload.text
          : ''
    if (text) {
      const existing = notes.find((n) => n.text === text && !n.deletedAt)
      if (existing) open(existing.id)
      else create(text)
    }
  })
  api?.onBeforeClose?.(async () => {
    await initialized
    clearTimeout(saveTimer)
    return persist()
  })
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      void persist()
    }
  })
  kit.onMode(() => {
    if (ready) renderList()
  })
  kit.onSettings((s) => {
    layout = s.defaultLayout === 'grid' ? 'grid' : 'list'
    if (ready) renderList()
  })
})()
