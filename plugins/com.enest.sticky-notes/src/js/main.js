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
    color = '',
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
  // 相对时间：刚刚 / n 分钟前 / 小时 / 昨天 / 日期
  function relTime(ts) {
    const diff = Date.now() - ts,
      min = 60000,
      hour = 60 * min,
      day = 24 * hour
    if (diff < min) return '刚刚'
    if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`
    if (diff < 2 * day) return '昨天'
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  }
  function wordCount(text) {
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length,
      words = text
        .replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ')
        .split(/\s+/)
        .filter(Boolean).length
    return { chars: text.length, words: cjk + words }
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
          (!color || n.color === color) &&
          `${n.title} ${n.text} ${n.tags.join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
      )
  }
  function countFor(key) {
    if (key === 'all')
      return notes.filter((n) => !n.deletedAt && !n.archived).length
    if (key === 'pinned')
      return notes.filter((n) => n.pinned && !n.deletedAt && !n.archived).length
    if (key === 'archive') return notes.filter((n) => n.archived && !n.deletedAt).length
    if (key === 'trash') return notes.filter((n) => n.deletedAt).length
    return 0
  }
  function colorCount(c) {
    return notes.filter((n) => !n.deletedAt && !n.archived && n.color === c)
      .length
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
          `<button data-filter="${key}" class="${filter === key ? 'active' : ''}">${label}${countFor(key) ? `<span class="t-count">${countFor(key)}</span>` : ''}</button>`,
      )
      .join('')
    $('color-filter').innerHTML =
      `<button class="all-dot ${color === '' ? 'chosen' : ''}" data-color="" aria-label="全部颜色" title="全部颜色">全</button>` +
      colors
        .map(
          (c) =>
            `<button class="dot ${color === c ? 'chosen' : ''}" data-color="${c}" style="--swatch:${c}" aria-label="筛选颜色 ${c}">${colorCount(c) ? `<span class="c-count">${colorCount(c)}</span>` : ''}</button>`,
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
              `<article class="note-row ${n.id === selected ? 'selected' : ''}" data-id="${esc(n.id)}" tabindex="0" role="listitem" style="--note-color:${n.color}"><div class="note-title">${n.pinned ? '⌑ ' : ''}${esc(title(n))}</div><div class="note-excerpt">${esc(n.text || '还没有内容')}</div><div class="note-meta"><span>${esc(n.tags.map((t) => '#' + t).join(' '))}</span><time>${relTime(n.updatedAt)}</time></div></article>`,
          )
          .join('')
      : '<div class="empty">' + emptyArt() + '没有匹配的笔记<br><small>记录一句话，让想法有个落点</small></div>'
    const grid = layout === 'grid' && kit.mode === 'shell'
    $('notes').classList.toggle('grid', grid)
    $('app').classList.toggle('grid-layout', grid)
    $('layout').textContent = grid ? '列表视图' : '卡片视图'
    // 相对时间随时间流逝会过期，这里不做定时器；切换视图/输入时自然刷新
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
        '<div class="editor-empty">' + editorEmptyArt() + '</div>'
      return
    }
    const wc = wordCount(n.text)
    $('editor').innerHTML =
      `<div class="editor-top"><button id="back" aria-label="返回笔记列表">←</button><div class="colors">${colors.map((c) => `<button class="color ${n.color === c ? 'chosen' : ''}" data-color="${c}" style="--swatch:${c}" aria-label="切换便签颜色 ${c}"></button>`).join('')}</div><span class="spacer"></span><button id="pin">${n.pinned ? '取消置顶' : '置顶'}</button><button id="preview-toggle">${preview ? '编辑' : '预览'}</button><button id="copy">复制</button><button id="export-note" class="shell-only">导出 .md</button><button id="export-txt" class="shell-only">导出 .txt</button><button id="archive">${n.archived ? '取消归档' : '归档'}</button><button id="delete" class="danger">${n.deletedAt ? '恢复' : '删除'}</button></div><div class="document"><input id="title" aria-label="笔记标题" placeholder="无标题" value="${esc(n.title)}" maxlength="200"><input id="tags" aria-label="笔记标签" placeholder="添加标签，用逗号分隔" value="${esc(n.tags.join(', '))}"><textarea id="body" placeholder="开始写吧。支持 Markdown 预览。" spellcheck="false" ${preview ? 'hidden' : ''}>${esc(n.text)}</textarea><div id="preview" ${preview ? '' : 'hidden'}>${markdown(n.text)}</div></div><div class="editor-foot"><span class="stat">${wc.chars} 字符 · ${wc.words} 词</span><span class="stat" title="${esc(new Date(n.updatedAt).toLocaleString())}">编辑于 ${relTime(n.updatedAt)}</span><span>⌘ / Ctrl + Shift + Enter 保存</span><button id="undo" ${undo ? '' : 'hidden'}>撤销删除</button><button id="purge" ${n.deletedAt ? '' : 'hidden'}>永久删除</button><button id="save-state">已保存</button></div>`
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
        const now = wordCount(n.text)
        const stat = $('editor').querySelector('.stat')
        if (stat) stat.textContent = `${now.chars} 字符 · ${now.words} 词`
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
    const safeName = () => title(n).replace(/[\\/:*?"<>|]/g, '_')
    $('export-note').onclick = () =>
      kit
        .saveText(
          safeName() + '.md',
          (n.title ? '# ' + n.title + '\n\n' : '') + n.text,
        )
        .catch((e) => kit.toast(e.message, 'error'))
    $('export-txt').onclick = () =>
      kit
        .saveText(safeName() + '.txt', (n.title ? n.title + '\n\n' : '') + n.text)
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
    color = ''
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
    PluginKit.upgradeSelects() // 模板下拉复位后同步自定义下拉标签
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
  $('color-filter').onclick = (e) => {
    const btn = e.target.closest('[data-color]')
    if (btn) {
      color = color === btn.dataset.color ? '' : btn.dataset.color
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
  // 全量导出 Markdown：每条笔记一段，含标签与更新时间（基础保存能力）
  $('export-md').onclick = () => {
    const live = notes.filter((n) => !n.deletedAt)
    if (!live.length) return kit.toast('没有可导出的笔记')
    const doc = live
      .map((n) => {
        const head = '# ' + title(n)
        const meta = `\n\n> 标签：${n.tags.map((t) => '#' + t).join(' ') || '无'} · 更新于 ${new Date(n.updatedAt).toLocaleString()}\n\n`
        return head + meta + n.text.trim()
      })
      .join('\n\n---\n\n')
    kit
      .saveText(
        `备忘录-${new Date().toISOString().slice(0, 10)}.md`,
        doc + '\n',
      )
      .catch((e) => kit.toast(e.message, 'error'))
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
  function emptyArt() {
    return `<svg viewBox="0 0 96 96" aria-hidden="true"><rect x="22" y="16" width="52" height="66" rx="6" fill="none" stroke="var(--line)" stroke-width="2.5" transform="rotate(-4 48 48)"/><rect x="26" y="20" width="52" height="66" rx="6" fill="none" stroke="var(--warm)" stroke-width="2.5" transform="rotate(3 52 52)"/><path d="M38 44h28M38 56h22M38 68h16" stroke="var(--warm)" stroke-width="2.5" stroke-linecap="round" opacity=".55"/></svg>`
  }
  function editorEmptyArt() {
    return `<svg viewBox="0 0 96 96" aria-hidden="true"><rect x="24" y="14" width="48" height="68" rx="6" fill="none" stroke="var(--line)" stroke-width="2.5"/><path d="M34 32h28M34 44h28M34 56h18" stroke="var(--warm)" stroke-width="2.5" stroke-linecap="round" opacity=".55"/><path d="M62 62l14 14m0-14L62 76" stroke="var(--line)" stroke-width="2.5" stroke-linecap="round"/></svg>选择一条笔记，或新建开始记录`
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
