/**
 * Markdown 笔记主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 renderMarkdown/searchHighlight/stats/outline/transform* 复用 core.js（未改动）。
 * 生成型 DOM（分组树/笔记列表/大纲/预览 HTML）沿用批 1 约定：原版等价 HTML 字符串 +
 * dangerouslySetInnerHTML + 容器级事件委托。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as core from '../js/core.js'

const api = window.enest || window.zapi
const esc = PluginKit.escape
const KEY = 'mdnotes_v1'

const WELCOME = '# 欢迎\n\n这是一条示例笔记，可以直接改写或删除。\n\n## 语法速览\n\n- **加粗** 与 *斜体*\n- `行内代码`\n- ==高亮== 与 ~~删除线~~\n\n```js\nconst x = 42 // 代码块自带高亮\n```\n\n| 表格 | 示例 |\n| --- | --- |\n| A | B |\n\n- [ ] 任务清单\n\n> 引用与[链接](https://example.com)\n'

export function App() {
  const kitRef = useRef(null)
  const editorRef = useRef(null)
  const outlineTreeRef = useRef(null)

  /* —— 与原版模块级变量等价的状态 —— */
  const [groups, setGroups] = useState(['收件箱'])
  const [notes, setNotes] = useState([])
  const [currentGroup, setCurrentGroup] = useState('')
  const [currentId, setCurrentId] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState('split') // edit | split | preview
  const [saveState, setSaveState] = useState('已保存')
  const [editorDisabled, setEditorDisabled] = useState(true)
  const [editorValue, setEditorValue] = useState('')
  const [previewHtml, setPreviewHtml] = useState('')
  const [groupsHtml, setGroupsHtml] = useState('')
  const [notesHtml, setNotesHtml] = useState('')
  const [statsText, setStatsText] = useState('')
  const [outlineStatus, setOutlineStatus] = useState('')
  const [outlineHtml, setOutlineHtml] = useState('')
  const [summaryText, setSummaryText] = useState('')
  const [ready, setReady] = useState(false)

  /* 命令式管线 ref 镜像（latest-ref 桥接，等价原闭包变量） */
  const stateRef = useRef({})
  stateRef.current = { groups, notes, currentGroup, currentId, query, view, ready }
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef(0)
  const confirmTimerRef = useRef(0)
  const queryRef = useRef('')
  queryRef.current = query

  const persist = useCallback(async (groupsNext, notesNext) => {
    await kitRef.current.save(KEY, { version: 1, groups: groupsNext, notes: notesNext })
  }, [])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    setSaveState('未保存…')
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => void flushSaveRef.current(), 800)
  }, [])

  const flushSave = useCallback(async () => {
    if (!dirtyRef.current || !stateRef.current.ready) return
    try {
      const { notes: list, currentId: id } = stateRef.current
      if (id) {
        const note = list.find((n) => n.id === id)
        if (note) {
          note.content = editorRef.current?.value ?? note.content
          note.updatedAt = Date.now()
        }
      }
      await persist(stateRef.current.groups, list)
      dirtyRef.current = false
      setSaveState('已保存')
    } catch (e) {
      setSaveState('保存失败 · 重试')
      kitRef.current.toast(e.message, 'error')
    }
  }, [persist])
  const flushSaveRef = useRef(flushSave)
  flushSaveRef.current = flushSave

  /* —— 树渲染（等价原 render：生成 HTML 字符串） —— */
  const visibleNotes = useCallback((list, group, q) => {
    const filtered = list.filter((n) => !group || n.group === group)
    if (!q.trim()) return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt)
    const needle = q.trim().toLowerCase()
    return filtered
      .filter((n) => `${n.title}\n${n.content}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [])

  const renderStats = useCallback((text) => {
    const s = core.stats(text)
    const mins = core.readingTime(text)
    setStatsText(`${s.words} 字 · ${s.lines} 行 · 约 ${mins} 分钟阅读`)
  }, [])

  /* 大纲：标题树 + 源码行定位 */
  const renderOutline = useCallback((text) => {
    const items = core.outlineDepth(core.outline(text))
    setOutlineStatus(items.length ? `${items.length} 个标题` : '')
    if (!items.length) {
      setOutlineHtml('<div class="outline-empty">用 # 起个标题，大纲会出现在这里</div>')
      return
    }
    setOutlineHtml(
      items
        .map(
          (it) =>
            `<button type="button" class="outline-item" data-line="${it.line}" style="padding-left:${8 + it.depth * 14}px" title="跳转到第 ${it.line + 1} 行"><span class="oh mono">h${it.level}</span><span class="ot">${esc(it.text)}</span></button>`,
        )
        .join(''),
    )
  }, [])

  const renderEditor = useCallback(
    (list, id, currentView) => {
      const note = list.find((n) => n.id === id)
      if (!note) {
        setEditorValue('')
        setEditorDisabled(true)
        setPreviewHtml('<div class="empty">选择或新建一条笔记</div>')
        setStatsText('')
        renderOutline('')
        return
      }
      // 受控编辑器：非聚焦时同步内容（等价原 if (el.value !== note.content && activeElement…)）
      const el = editorRef.current
      if (el && el.value !== note.content && document.activeElement !== el) setEditorValue(note.content)
      setEditorDisabled(false)
      if (currentView !== 'edit') setPreviewHtml(core.renderMarkdown(note.content))
      renderStats(note.content)
      renderOutline(note.content)
    },
    [renderOutline, renderStats],
  )

  const render = useCallback(
    (next = {}) => {
      const s = { ...stateRef.current, ...next }
      const list = s.notes
      // 分组
      setGroupsHtml(
        s.groups
          .map(
            (g) => `<div class="group ${s.currentGroup === g ? 'active' : ''}" role="treeitem" data-group="${esc(g)}" tabindex="0">
  <span class="group-name">${esc(g)}</span>
  <span class="group-count mono">${list.filter((n) => n.group === g).length || ''}</span>
</div>`,
          )
          .join(''),
      )
      // 笔记
      const rows = visibleNotes(list, s.currentGroup, s.query)
      setNotesHtml(
        rows.length
          ? rows
              .map((n) => {
                const hit = core.searchHighlight(n, s.query)
                const title = s.query.trim() && hit.hit ? hit.title : esc(n.title)
                const snippetHtml = s.query.trim() && hit.hit ? `<span class="note-snippet">${hit.snippet}</span>` : ''
                return `<div class="note-row ${s.currentId === n.id ? 'active' : ''}" role="treeitem" data-id="${esc(n.id)}" tabindex="0">
  <span class="note-title">${title || '<em>无标题</em>'}${snippetHtml}</span>
  <span class="note-meta mono">${new Date(n.updatedAt).toLocaleDateString()}</span>
  <button class="row-delete" data-del="${esc(n.id)}" title="删除笔记">×</button>
</div>`
              })
              .join('')
          : '<div class="empty small">该分组还没有笔记</div>',
      )
      setSummaryText(
        s.query.trim() ? `${rows.length} 条命中「${s.query.trim()}」` : `${list.length} 条笔记 · ${s.groups.length} 个分组`,
      )
      renderEditor(list, s.currentId, s.view)
    },
    [renderEditor, visibleNotes],
  )
  const renderRef = useRef(render)
  renderRef.current = render

  /* —— 视图模式：编辑 / 双栏 / 预览 —— */
  const setViewMode = useCallback(
    (next) => {
      setView(next)
      stateRef.current.view = next
      const text = editorRef.current?.value ?? ''
      if (next !== 'edit') {
        const note = stateRef.current.notes.find((n) => n.id === stateRef.current.currentId)
        if (note) void hydratePreviewRef.current(note)
      } else renderOutline(text)
    },
    [renderOutline],
  )
  const hydratePreviewRef = useRef(null)

  /* —— 编辑与工具条 —— */
  const onEditorInput = useCallback(() => {
    const { notes: list, currentId: id } = stateRef.current
    const note = list.find((n) => n.id === id)
    if (!note) return
    note.content = editorRef.current.value
    note.updatedAt = Date.now()
    scheduleSave()
    if (stateRef.current.view !== 'edit') setPreviewHtml(core.renderMarkdown(note.content))
    renderStats(note.content)
    renderOutline(note.content)
  }, [renderOutline, renderStats, scheduleSave])

  const insertAt = useCallback(
    (transform) => {
      const el = editorRef.current
      const result = transform(el.value, el.selectionStart, el.selectionEnd)
      setEditorValue(result.text)
      // 与原版一致：改值后派发 input 走统一管线（原生 setter 保持受控同步）
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = result.caret
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.focus()
      })
    },
    [],
  )

  const onToolbarClick = useCallback(
    (e) => {
      const btn = e.target.closest('button')
      if (!btn || !btn.dataset) return
      if (btn.dataset.wrap) return insertAt((t, s, e2) => core.transformWrap(t, s, e2, btn.dataset.wrap))
      if (btn.dataset.line) return insertAt((t, s) => core.transformLinePrefix(t, s, btn.dataset.line))
      if (btn.dataset.block) return insertAt((t, s, e2) => core.transformBlock(t, s, e2, btn.dataset.block))
    },
    [insertAt],
  )

  /* 粘贴图片 → storage.blobs 附件 */
  const attachImage = useCallback(async (file) => {
    const { notes: list, currentId: id } = stateRef.current
    const note = list.find((n) => n.id === id)
    if (!note) return kitRef.current.toast('先选择一条笔记', 'error')
    if (file.size > 24e6) return kitRef.current.toast('图片超过 24 MB', 'error')
    if (!api?.storage?.blobs?.put) return kitRef.current.toast('当前宿主不支持附件，请更新 eNest', 'error')
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
      setEditorValue(note.content)
      scheduleSave()
      renderRef.current()
      kitRef.current.toast('图片已作为附件插入', 'success')
    } catch (err) {
      kitRef.current.toast(err.message, 'error')
    }
  }, [scheduleSave])

  const onEditorPaste = useCallback(
    (e) => {
      const items = e.clipboardData?.items || []
      const imageItem = [...items].find((i) => i.type.startsWith('image/'))
      if (!imageItem) return
      e.preventDefault()
      const file = imageItem.getAsFile()
      if (file) void attachImage(file)
    },
    [attachImage],
  )

  const onAttachImage = useCallback(async () => {
    try {
      if (!api?.clipboard?.readImage) throw new Error('宿主不支持读取剪贴板图片')
      const img = await api.clipboard.readImage()
      if (!img) return kitRef.current.toast('剪贴板中没有图片')
      const res = await fetch(img.dataUrl)
      const blob = await res.blob()
      await attachImage(blob)
    } catch (err) {
      kitRef.current.toast(err.message, 'error')
    }
  }, [attachImage])

  // 预览时把 blob:id 换成 dataURL
  const hydratePreview = useCallback(async (note) => {
    let html = core.renderMarkdown(note.content)
    for (const [name, blobId] of Object.entries(note.attachments)) {
      try {
        const blob = await api?.storage?.blobs?.get?.(blobId)
        if (blob?.dataUrl) html = html.split(`src="blob:${blobId}"`).join(`src="${blob.dataUrl}" alt="${esc(name)}"`)
      } catch {}
    }
    setPreviewHtml(html)
  }, [])
  hydratePreviewRef.current = hydratePreview

  /* —— 分组与笔记管理 —— */
  const createNote = useCallback(
    (title = '', content = '', group) => {
      const s = stateRef.current
      const note = core.normalizeNote({ title: title || '未命名笔记', content, group: group || s.currentGroup || '收件箱' })
      const list = [note, ...s.notes]
      const nextGroups = s.groups.includes(note.group) ? s.groups : [...s.groups, note.group]
      stateRef.current.notes = list
      stateRef.current.groups = nextGroups
      stateRef.current.currentGroup = note.group
      stateRef.current.currentId = note.id
      setNotes(list)
      setGroups(nextGroups)
      setCurrentGroup(note.group)
      setCurrentId(note.id)
      void persist(nextGroups, list).catch(() => {})
      renderRef.current({ notes: list, groups: nextGroups, currentGroup: note.group, currentId: note.id })
      if (kitRef.current?.mode === 'shell') requestAnimationFrame(() => editorRef.current?.focus())
      return note
    },
    [persist],
  )

  const renameGroup = useCallback(
    (g) => {
      const name = prompt('重命名分组', g)
      if (!name) return
      const next = name.trim().slice(0, 60)
      if (!next || stateRef.current.groups.includes(next)) return
      const nextGroups = stateRef.current.groups.map((x) => (x === g ? next : x))
      const list = stateRef.current.notes
      list.forEach((n) => (n.group === g ? (n.group = next) : null))
      stateRef.current.groups = nextGroups
      if (stateRef.current.currentGroup === g) {
        stateRef.current.currentGroup = next
        setCurrentGroup(next)
      }
      setGroups(nextGroups)
      void persist(nextGroups, list).catch(() => {})
      renderRef.current({ groups: nextGroups })
    },
    [persist],
  )

  const onNewGroup = useCallback(() => {
    const name = prompt('分组名称')
    if (!name) return
    const g = name.trim().slice(0, 60)
    if (g && !stateRef.current.groups.includes(g)) {
      const nextGroups = [...stateRef.current.groups, g]
      stateRef.current.groups = nextGroups
      stateRef.current.currentGroup = g
      setGroups(nextGroups)
      setCurrentGroup(g)
      void persist(nextGroups, stateRef.current.notes).catch(() => {})
      renderRef.current({ groups: nextGroups, currentGroup: g })
    }
  }, [persist])

  const onGroupsClick = useCallback(
    (e) => {
      const row = e.target.closest('[data-group]')
      if (!row) return
      const g = row.dataset.group
      if (e.target.closest('[data-rename]')) return renameGroup(g)
      stateRef.current.currentGroup = g
      setCurrentGroup(g)
      renderRef.current({ currentGroup: g })
    },
    [renameGroup],
  )

  const onGroupsKeyDown = useCallback((e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const row = e.target.closest('[data-group]')
    if (row) {
      e.preventDefault()
      stateRef.current.currentGroup = row.dataset.group
      setCurrentGroup(row.dataset.group)
      renderRef.current({ currentGroup: row.dataset.group })
    }
  }, [])

  const onGroupsContextMenu = useCallback(
    (e) => {
      const row = e.target.closest('[data-group]')
      if (!row) return
      e.preventDefault()
      renameGroup(row.dataset.group)
    },
    [renameGroup],
  )

  const selectNote = useCallback((id) => {
    stateRef.current.currentId = id
    setCurrentId(id)
    renderRef.current({ currentId: id })
  }, [])

  const onNotesClick = useCallback((e) => {
    const del = e.target.closest('[data-del]')
    if (del) {
      e.stopPropagation()
      const id = del.dataset.del
      if (!del.dataset.confirming) {
        del.dataset.confirming = '1'
        del.textContent = '确认?'
        clearTimeout(confirmTimerRef.current)
        confirmTimerRef.current = setTimeout(() => {
          delete del.dataset.confirming
          del.textContent = '×'
        }, 2600)
        return
      }
      clearTimeout(confirmTimerRef.current)
      const s = stateRef.current
      const note = s.notes.find((n) => n.id === id)
      const list = s.notes.filter((n) => n.id !== id)
      for (const blobId of Object.values(note?.attachments || {})) api?.storage?.blobs?.remove?.(blobId).catch(() => {})
      s.notes = list
      setNotes(list)
      const nextId = s.currentId === id ? '' : s.currentId
      s.currentId = nextId
      setCurrentId(nextId)
      void persist(s.groups, list).catch(() => {})
      renderRef.current({ notes: list, currentId: nextId })
      kitRef.current.toast('笔记已删除')
      return
    }
    const row = e.target.closest('[data-id]')
    if (row) selectNote(row.dataset.id)
  }, [persist, selectNote])

  const onNotesKeyDown = useCallback(
    (e) => {
      if (e.key !== 'Enter' || e.target.closest('[data-del]')) return
      const row = e.target.closest('[data-id]')
      if (row) {
        e.preventDefault()
        selectNote(row.dataset.id)
      }
    },
    [selectNote],
  )

  const onNotesContextMenu = useCallback(
    (e) => {
      const row = e.target.closest('[data-id]')
      if (!row) return
      e.preventDefault()
      const s = stateRef.current
      const note = s.notes.find((n) => n.id === row.dataset.id)
      if (!note) return
      const next = prompt('移动到分组（输入分组名，或输入新名称创建）', note.group)
      if (!next) return
      const g = next.trim().slice(0, 60)
      if (!g) return
      note.group = g
      const nextGroups = s.groups.includes(g) ? s.groups : [...s.groups, g]
      s.groups = nextGroups
      setGroups(nextGroups)
      void persist(nextGroups, s.notes).catch(() => {})
      renderRef.current({ groups: nextGroups })
    },
    [persist],
  )

  /* —— 大纲点击跳转 —— */
  const onOutlineClick = useCallback((e) => {
    const btn = e.target.closest('[data-line]')
    if (!btn) return
    const line = Number(btn.dataset.line)
    const el = editorRef.current
    if (!el) return
    const lines = el.value.split('\n')
    let pos = 0
    for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1
    el.focus()
    el.selectionStart = el.selectionEnd = pos
    // 让目标行滚进视野：用临时 textarea 度量近似行高
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22
    el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 2)
    if (stateRef.current.view === 'preview') setViewModeRef.current('split')
  }, [])

  /* —— 搜索 —— */
  const onSearchInput = useCallback(
    (e) => {
      const value = e.target.value
      setQuery(value)
      queryRef.current = value
      kitRef.current?.setQuery(value)
      renderRef.current({ query: value })
    },
    [],
  )

  /* —— 导出 —— */
  const currentNote = useCallback(() => stateRef.current.notes.find((n) => n.id === stateRef.current.currentId), [])
  const exportMd = useCallback(async () => {
    const note = currentNote()
    if (!note) return kitRef.current.toast('先选择一条笔记', 'error')
    try {
      await kitRef.current.saveText(`${note.title || '笔记'}.md`, note.content)
    } catch (e) {
      kitRef.current.toast(e.message, 'error')
    }
  }, [currentNote])
  const exportHtml = useCallback(async () => {
    const note = currentNote()
    if (!note) return kitRef.current.toast('先选择一条笔记', 'error')
    try {
      await kitRef.current.saveText(`${note.title || '笔记'}.html`, core.noteToHtml(note.title, note.content))
    } catch (e) {
      kitRef.current.toast(e.message, 'error')
    }
  }, [currentNote])

  /* —— 模板 —— */
  const applyTemplate = useCallback(
    (key) => {
      const tpl = core.TEMPLATES[key]
      if (!tpl) return
      const s = stateRef.current
      const note = s.notes.find((n) => n.id === s.currentId)
      if (!note) return
      const el = editorRef.current
      note.content = (el?.value ?? note.content) ? note.content + '\n\n' + tpl.content : tpl.content
      setEditorValue(note.content)
      scheduleSave()
      renderRef.current()
    },
    [scheduleSave],
  )

  /* —— Quick 速记：直接落收件箱 —— */
  const quickCapture = useCallback(
    (text) => {
      const s = stateRef.current
      const note = core.normalizeNote({
        title: text.split('\n')[0].slice(0, 40) || '速记',
        content: text,
        group: '收件箱',
      })
      const list = [note, ...s.notes]
      const nextGroups = s.groups.includes('收件箱') ? s.groups : ['收件箱', ...s.groups]
      s.notes = list
      s.groups = nextGroups
      s.currentGroup = '收件箱'
      s.currentId = note.id
      setNotes(list)
      setGroups(nextGroups)
      setCurrentGroup('收件箱')
      setCurrentId(note.id)
      void persist(nextGroups, list).catch(() => {})
      renderRef.current({ notes: list, groups: nextGroups, currentGroup: '收件箱', currentId: note.id })
      kitRef.current.toast('已存入收件箱', 'success')
    },
    [persist],
  )

  /* ⌘1/2/3 视图切换（等价原 document keydown） */
  const setViewModeRef = useRef(setViewMode)
  setViewModeRef.current = setViewMode
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing || e.defaultPrevented) return
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === '1') {
        e.preventDefault()
        setViewModeRef.current('edit')
      } else if (e.key === '2') {
        e.preventDefault()
        setViewModeRef.current('split')
      } else if (e.key === '3') {
        e.preventDefault()
        setViewModeRef.current('preview')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /* F2 模板（等价原 editor keydown） */
  const onEditorKeyDown = useCallback(
    (e) => {
      if (e.key === 'F2') {
        e.preventDefault()
        const key = prompt('插入模板：meeting（会议记录）/ weekly（周报）/ todo（待办）')
        if (key) applyTemplate(key)
      }
    },
    [applyTemplate],
  )

  /* —— 生命周期：PluginKit 一次初始化 + latest-ref 桥接 —— */
  useEffect(() => {
    let alive = true
    const kit = PluginKit.create({
      title: 'Markdown 笔记',
      quickPlaceholder: '速记到收件箱…',
      height: 440,
      defaults: { autoPreview: true },
    })
    kitRef.current = kit
    kit.onAction?.((action) => {
      if (action === 'submit' && kit.mode === 'quick') {
        const text = queryRef.current.trim()
        if (text) {
          quickCaptureRef.current(text)
          kit.setQuery('')
          const input = document.getElementById('search')
          if (input) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(input, '')
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
        }
      }
    })
    kit.onMode(() => {
      if (!stateRef.current.ready) return
      if (kit.mode === 'quick') setViewModeRef.current('edit')
      renderRef.current()
    })
    const booted = (async () => {
      await kit.ready
      if (!alive) return
      const data = await kit.load(KEY, null)
      if (!alive) return
      let list = []
      let nextGroups = ['收件箱']
      if (data && Array.isArray(data.notes)) {
        list = data.notes.map((n) => core.normalizeNote(n))
        nextGroups = [...new Set(['收件箱', ...(data.groups || []), ...list.map((n) => n.group)])]
      }
      setNotes(list)
      setGroups(nextGroups)
      setReady(true)
      stateRef.current.ready = true
      stateRef.current.notes = list
      stateRef.current.groups = nextGroups
      stateRef.current.currentGroup = nextGroups[0] || '收件箱'
      stateRef.current.currentId = list[0]?.id || ''
      setCurrentGroup(stateRef.current.currentGroup)
      setCurrentId(stateRef.current.currentId)
      const defaultView = kit.settings.autoPreview === false ? 'edit' : 'split'
      setViewModeRef.current(kit.mode === 'quick' ? 'edit' : defaultView)
      renderRef.current({
        notes: list,
        groups: nextGroups,
        currentGroup: stateRef.current.currentGroup,
        currentId: stateRef.current.currentId,
      })
      // 空态引导：预置欢迎笔记
      if (!list.length && kit.mode === 'shell') {
        createNoteRef.current('欢迎使用 Markdown 笔记', WELCOME, '收件箱')
      }
    })()
    api?.onEnter?.(async (event) => {
      await booted
      if (!alive) return
      const payload = event?.payload
      const text = typeof payload === 'string' ? payload : payload?.text
      if (event?.code === 'inbox' && text) return void quickCaptureRef.current(String(text))
      if (kit.mode === 'quick') document.getElementById('search')?.focus()
    })
    api?.onBeforeClose?.(async () => {
      clearTimeout(saveTimerRef.current)
      if (!stateRef.current.ready) return
      try {
        await flushSaveRef.current()
      } catch {}
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const quickCaptureRef = useRef(quickCapture)
  quickCaptureRef.current = quickCapture
  const createNoteRef = useRef(createNote)
  createNoteRef.current = createNote

  /* 视图属性派生（等价原 setView 里的 hidden 切换） */
  const editorHidden = view === 'preview'
  const previewHidden = view === 'edit'
  const outlineHidden = view === 'preview'

  return (
    <main className="md-notes">
      <header>
        <div className="brand shell-only">
          <h1>Markdown 笔记</h1>
        </div>
        <input
          id="search"
          className="search"
          type="search"
          placeholder="全文搜索标题与内容"
          aria-label="搜索笔记"
          onChange={onSearchInput}
        />
        <span className="grow"></span>
        <button id="export-md" className="shell-only" onClick={() => void exportMd()}>导出 .md</button>
        <button id="export-html" className="shell-only" onClick={() => void exportHtml()}>导出 .html</button>
        <button data-open-settings className="shell-only">设置</button>
      </header>

      <div className="workspace">
        <nav className="tree-pane shell-only">
          <div className="tree-head">
            <span className="tree-label">分组</span>
            <button id="new-group" title="新建分组" onClick={onNewGroup}>＋</button>
          </div>
          <div id="groups" role="tree" onClick={onGroupsClick} onKeyDown={onGroupsKeyDown} onContextMenu={onGroupsContextMenu}
            dangerouslySetInnerHTML={{ __html: groupsHtml }}></div>
          <div className="tree-head">
            <span className="tree-label">笔记</span>
            <button id="new-note" title="新建笔记" onClick={() => createNote()}>＋</button>
          </div>
          <div id="notes-tree" role="tree" onClick={onNotesClick} onKeyDown={onNotesKeyDown} onContextMenu={onNotesContextMenu}
            dangerouslySetInnerHTML={{ __html: notesHtml }}></div>
        </nav>

        <section className="editor-pane">
          <div className="editor-toolbar" onClick={onToolbarClick}>
            <button data-wrap="**" title="加粗">B</button>
            <button data-wrap="*" title="斜体">I</button>
            <button data-line="#" title="标题">H</button>
            <button data-line="- " title="无序列表">•≡</button>
            <button data-line="1. " title="有序列表">1.</button>
            <button data-block={'```\n\n```'} title="代码块">‹›</button>
            <button data-block={'| 列1 | 列2 |\n| --- | --- |\n|  |  |'} title="表格">⊞</button>
            <button data-wrap="`" title="行内代码">`x`</button>
            <button data-line="- [ ] " title="任务清单">☑</button>
            <button id="attach-image" title="粘贴剪贴板图片为附件" onClick={() => void onAttachImage()}>🖼</button>
            <span className="grow"></span>
            <div className="mode-switch" role="tablist" aria-label="视图模式">
              <button id="mode-edit" role="tab" aria-selected={view === 'edit'} title="仅编辑（⌘1）" onClick={() => setViewMode('edit')}>编辑</button>
              <button id="mode-split" role="tab" aria-selected={view === 'split'} title="双栏（⌘2）" onClick={() => setViewMode('split')}>双栏</button>
              <button id="mode-preview" role="tab" aria-selected={view === 'preview'} title="仅预览（⌘3）" onClick={() => setViewMode('preview')}>预览</button>
            </div>
          </div>
          <div className="editor-body" id="editor-body" data-view={view}>
            <textarea
              id="editor"
              ref={editorRef}
              spellcheck="false"
              placeholder="开始写…（Markdown 语法，自动保存）"
              hidden={editorHidden}
              disabled={editorDisabled}
              value={editorValue}
              onChange={(e) => setEditorValue(e.target.value)}
              onInput={onEditorInput}
              onPaste={onEditorPaste}
              onKeyDown={onEditorKeyDown}
            ></textarea>
            <aside id="outline" className="outline shell-only" aria-label="标题大纲" hidden={outlineHidden}>
              <div className="outline-head">大纲</div>
              <div id="outline-tree" className="outline-tree" ref={outlineTreeRef} onClick={onOutlineClick}
                dangerouslySetInnerHTML={{ __html: outlineHtml }}></div>
            </aside>
            <div id="preview" className="preview md-render" hidden={previewHidden}
              dangerouslySetInnerHTML={{ __html: previewHtml }}></div>
          </div>
          <div className="editor-status">
            <span id="save-state">{saveState}</span>
            <span id="editor-stats" className="muted">{statsText}</span>
            <span className="grow"></span>
            <span id="outline-status" className="muted shell-only">{outlineStatus}</span>
          </div>
        </section>
      </div>

      <footer>
        <span id="search-summary">{summaryText}</span>
      </footer>
    </main>
  )
}
