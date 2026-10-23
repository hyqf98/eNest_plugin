/**
 * markdown v2 主界面 —— Typora 式本地文件工作台。
 * shell 模式：工具栏 + 侧栏（大纲/文件树/图片资产）+ 即时渲染编辑器 + 状态栏。
 * quick 模式：速记编辑器（提交落收件箱，dismissQuick 保活）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createEditor, updateLiveOpts, extractOutline, computeStats, EditorView, setTypewriter as setTypewriterCm } from '../cm/live.js'
import { wrapSelection, toggleLinePrefix, insertBlock, FENCE_TEXT, TABLE_TEXT, LINK_TEXT, IMAGE_TEXT } from '../cm/formatOps.js'
import { call, onBackendEvent, resolveImageToDataUrl, dataUrlToParts, readClipboardImage } from '../js/rpc.js'
import { applyTheme, builtinThemeCss, adaptTyporaCss, BUILTIN_THEMES } from '../render/theme.js'
import { setMermaidLook } from '../render/render.js'
import { Sidebar } from './Sidebar.jsx'
import { SettingsPage } from './SettingsPage.jsx'
import { UploadMenu } from './UploadMenu.jsx'
import { ExportMenu } from './ExportMenu.jsx'

const WELCOME = `# 未命名文档

开始书写。粘贴图片试试（⌘V），或把 .md 文件拖进来。

## 语法速览

- **加粗** 与 *斜体*，\`行内代码\`，==高亮==，~~删除线~~
- 任务清单：- [ ] 未完成 / - [x] 已完成
- 数学：$e^{i\\pi} + 1 = 0$

| 表格 | 支持 | 拖拽列宽 |
| --- | --- | --- |
| 圆角 | 简约 | 留白 |

\`\`\`mermaid
graph LR
  A[想法] --> B{写下来?}
  B -->|是| C[结构化]
  B -->|否| D[先记一笔]
\`\`\`

> 引用块，圆角左线。
`


export function App() {
  const [kit, setKit] = useState(null)
  const [mode, setMode] = useState('shell')
  const [page, setPage] = useState('editor')

  /* —— 文档状态 —— */
  const [docPath, setDocPath] = useState('')
  const [docName, setDocName] = useState('未命名')
  const [saveState, setSaveState] = useState('saved')
  const [stats, setStats] = useState(() => computeStats(''))
  const [outline, setOutline] = useState([])
  const [recentFiles, setRecentFiles] = useState([])
  const [sidebarTab, setSidebarTab] = useState('outline')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarPeek, setSidebarPeek] = useState(false)
  const [conflict, setConflict] = useState(null)
  const [themeList, setThemeList] = useState(BUILTIN_THEMES)
  const [activeTheme, setActiveTheme] = useState('enest-minimal')
  const [darkMode, setDarkMode] = useState(false)
  const [typewriter, setTypewriter] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [docVersion, setDocVersion] = useState(0) // 内容变化计数（资源面板 400ms 防抖重提取）
  const [moreOpen, setMoreOpen] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y } 编辑区右键格式菜单

  /* —— refs —— */
  const editorHostRef = useRef(null)
  const moreRef = useRef(null)
  const exportRef = useRef(null) // ExportMenu 暴露 { html, pdf, png }
  const viewRef = useRef(null)
  const docPathRef = useRef('')
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef(0)
  const resTimerRef = useRef(0)
  const textRef = useRef('')
  const kitRef = useRef(null)
  const settingsRef = useRef({})
  const sidebarRef = useRef(null)
  const sidebarToggleRef = useRef(null)
  const sidebarBindingRef = useRef(null)

  useEffect(() => {
    if (mode !== 'shell' || page !== 'editor') return
    const binding = PluginKit.bindHoverPanel(sidebarToggleRef.current, sidebarRef.current, {
      enabled: () => !sidebarOpen,
      onOpenChange: setSidebarPeek,
      delay: 120,
      hideDelay: 300,
      handleClick: false,
    })
    sidebarBindingRef.current = binding
    return () => { binding.destroy(); sidebarBindingRef.current = null }
  }, [mode, page, sidebarOpen])

  const toggleSidebar = () => {
    sidebarBindingRef.current?.hide()
    setSidebarOpen((open) => !open)
  }

  docPathRef.current = docPath
  // 供 Sidebar 直接替换文内链接（避免把 EditorView 穿透 props）
  useEffect(() => { (window).__mdViewRef = viewRef })

  const toast = useCallback((message, type = "info") => {
    kitRef.current?.toast?.(message, type)
  }, [])

  /* ---------------- 保存 ---------------- */
  const flushSave = useCallback(async () => {
    if (!dirtyRef.current) return
    const text = textRef.current
    if (!docPathRef.current) return // 未落盘文档：等用户保存
    setSaveState('saving')
    try {
      await call('doc.save', docPathRef.current, text)
      dirtyRef.current = false
      setSaveState('saved')
    } catch (e) {
      setSaveState('error')
      toast(`保存失败：${e.message}`, 'error')
    }
  }, [toast])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    setSaveState('dirty')
    clearTimeout(saveTimerRef.current)
    if (settingsRef.current.autoSave === false) return
    saveTimerRef.current = setTimeout(() => void flushSave(), 500)
  }, [flushSave])

  /* ---------------- 打开/新建/另存 ---------------- */
  const openFile = useCallback(async (path) => {
    try {
      await call('doc.grant', path)
      const { text } = await call('doc.open', path)
      dirtyRef.current = false
      textRef.current = text
      setDocPath(path)
      setDocName(path.split('/').pop() || '文档')
      const view = viewRef.current
      if (view) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      }
      setSaveState('saved')
      setStats(computeStats(text))
      setOutline(extractOutline(text))
      setDocVersion((v) => v + 1)
      api()?.ui?.setTitle?.(`${path.split('/').pop()} — Markdown`)
    } catch (e) {
      toast(`打开失败：${e.message}`, 'error')
    }
  }, [toast])

  const openWithPicker = useCallback(async () => {
    const handles = await api()?.localFiles?.pick?.({ kind: 'file', multiple: false, access: 'read' })
    const path = handles?.[0]?.displayPath
    if (path) await openFile(path)
  }, [openFile])

  const newDoc = useCallback(() => {
    dirtyRef.current = false
    textRef.current = ''
    setDocPath('')
    setDocName('未命名')
    const view = viewRef.current
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    setSaveState('saved')
    setOutline([])
    viewRef.current?.focus()
  }, [])

  const saveAs = useCallback(async () => {
    const handle = await api()?.localFiles?.pickSave?.({ defaultName: `${docName}.md` })
    const path = handle?.displayPath
    if (!path) return
    try {
      const { path: saved } = await call('doc.saveAs', path, textRef.current)
      dirtyRef.current = false
      setDocPath(saved)
      setDocName(saved.split('/').pop() || '文档')
      setSaveState('saved')
      toast('已保存', 'success')
    } catch (e) {
      toast(`保存失败：${e.message}`, 'error')
    }
  }, [docName, toast])

  const doSave = useCallback(async () => {
    if (docPathRef.current) await flushSave()
    else await saveAs()
  }, [flushSave, saveAs])

  /* ---------------- 粘贴图片 ---------------- */
  const insertAtCursor = useCallback((text) => {
    const view = viewRef.current
    if (!view) return
    const pos = view.state.selection.main.head
    view.dispatch({ changes: { from: pos, to: pos, insert: text } })
  }, [])

  const handleImage = useCallback(async (dataUrl, action) => {
    if (action === 'base64') {
      insertAtCursor(`![](${dataUrl})`)
      return
    }
    if (action === 'local' || action === 'upload') {
      setUploading(true)
      try {
        if (action === 'local' && !docPathRef.current) {
          toast('请先保存文档再使用本地 assets', 'error')
          return
        }
        const { mime, bytesB64 } = dataUrlToParts(dataUrl)
        if (action === 'upload' && !docPathRef.current) {
          // 上传模式没有本地文档也可（PicList/GitHub/脚本）；local 需要
        }
        const result = await call('upload.run', docPathRef.current, 'pasted.png', mime, bytesB64)
        insertAtCursor(`\n${result.markdown}\n`)
        try { await api()?.clipboard?.writeText?.(result.url) } catch { /* 可选 */ }
        toast('图片已插入', 'success')
      } catch (e) {
        toast(`图片处理失败：${e.message}`, 'error')
      } finally {
        setUploading(false)
      }
    }
  }, [insertAtCursor, toast])

  /* ---------------- 格式操作（右键菜单复用，逻辑与 keymap 同源） ---------------- */
  const applyFormatAction = useCallback((action) => {
    const view = viewRef.current
    if (!view) return
    if (action.wrap) return void wrapSelection(view, action.wrap)
    if (action.line) return void toggleLinePrefix(view, action.line)
    if (action.fence) return void insertBlock(view, FENCE_TEXT, 3)
    if (action.table) return void insertBlock(view, TABLE_TEXT, 2)
    if (action.link) return void insertBlock(view, LINK_TEXT, 1)
    if (action.image) return void insertBlock(view, IMAGE_TEXT, 2)
  }, [])

  /* 编辑区右键菜单：格式操作收纳处（对齐 Typora 右键习惯） */
  const onEditorContextMenu = useCallback((e) => {
    const host = editorHostRef.current
    if (!host || !host.contains(e.target)) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const esc = (e) => { if (e.key === 'Escape') setCtxMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [ctxMenu])

  /* 「⋯」菜单：点菜单项后关闭再执行 */
  const closeMore = useCallback((fn) => {
    setMoreOpen(false)
    fn?.()
  }, [])
  useEffect(() => {
    if (!moreOpen) return
    const close = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [moreOpen])

  const onPaste = useCallback(async (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result)
          const defaultAction = settingsRef.current.imageDefaultAction || 'ask'
          if (defaultAction === 'ask') {
            window.dispatchEvent(new CustomEvent('md-ask-image', { detail: dataUrl }))
          } else {
            void handleImage(dataUrl, defaultAction)
          }
        }
        reader.readAsDataURL(file)
        return
      }
    }
    // 纯文本粘贴：检测是否为图片路径（剪贴板历史场景）—— 交给默认
  }, [handleImage])

  /* ---------------- 拖入打开 ---------------- */
  const onDrop = useCallback(async (e) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    const md = files.find((f) => /\.md$/i.test(f.name))
    try {
      const handles = await api()?.localFiles?.fromDrop?.(files.map((f) => (f).path || f.name))
      const handle = handles?.find?.((h) => /\.md$/i.test(h.name))
      if (handle?.displayPath) await openFile(handle.displayPath)
    } catch {
      toast('拖入被取消', 'info')
    }
  }, [openFile, toast])

  /* ---------------- 外部变更冲突 ---------------- */
  useEffect(() => {
    const off = onBackendEvent(({ event, data }) => {
      if (event !== 'doc.changed') return
      if (data.path !== docPathRef.current) return
      if (dirtyRef.current) {
        setConflict({ path: data.path, deleted: !!data.deleted })
      } else if (!data.deleted) {
        // 干净文档：静默重载
        void call('doc.read', data.path).then(({ text }) => {
          const view = viewRef.current
          if (!view) return
          textRef.current = text
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
          setSaveState('saved')
        }).catch(() => {})
      } else {
        toast('文件已被外部删除', 'error')
      }
    })
    return off
  }, [toast])

  const resolveConflict = useCallback(async (choice) => {
    const c = conflict
    setConflict(null)
    if (!c) return
    if (choice === 'mine') {
      // 以我为准：直接覆盖
      dirtyRef.current = true
      await flushSave()
    } else if (choice === 'disk') {
      const { text } = await call('doc.read', c.path).catch(() => ({ text: textRef.current }))
      const view = viewRef.current
      if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      dirtyRef.current = false
      setSaveState('saved')
    } else {
      await saveAs()
    }
  }, [conflict, flushSave, saveAs])

  /* ---------------- 主题 ---------------- */
  const applyThemeById = useCallback(async (themeId, dark) => {
    const builtin = BUILTIN_THEMES.find((t) => t.id === themeId)
    if (builtin) {
      applyTheme(themeId, builtinThemeCss(themeId))
    } else {
      // 用户主题（Typora CSS）
      try {
        const { css } = await call('theme.read', themeId)
        applyTheme(themeId, builtinThemeCss('enest-minimal') + adaptTyporaCss(css))
      } catch {
        applyTheme('enest-minimal', builtinThemeCss('enest-minimal'))
        themeId = 'enest-minimal'
      }
    }
    setActiveTheme(themeId)
    // 持久化（浅/深各自记忆）
    void call('theme.setPrefs', dark ? themeId : undefined, dark ? undefined : themeId).catch(() => {})
  }, [])

  const initTheme = useCallback(async (dark) => {
    try {
      const list = await call('theme.list')
      const userThemes = list.themes.map((t) => ({ id: t.name, name: t.name, source: 'user' }))
      setThemeList([...(BUILTIN_THEMES), ...userThemes])
    } catch { /* backend 未授权时保留内置 */ }
    const prefs = await call('theme.prefs').catch(() => ({ lightTheme: 'enest-minimal', darkTheme: 'enest-minimal-dark' }))
    const want = dark ? (prefs.darkTheme || 'enest-minimal-dark') : (prefs.lightTheme || 'enest-minimal')
    await applyThemeById(want, dark)
  }, [applyThemeById])

  /* ---------------- 编辑器创建 ---------------- */
  useEffect(() => {
    if (mode !== 'shell' || page !== 'editor') return
    const host = editorHostRef.current
    if (!host || viewRef.current) return

    const liveOpts = {
      renderHtml: settingsRef.current.renderHtml !== false,
      resolveImage: (url) => resolveImageToDataUrl(docPathRef.current, url),
      onLinkClick: (url) => {
        if (/^https?:\/\//i.test(url)) void api()?.shell?.openExternal?.(url)
        else if (url.startsWith('#')) {
          // 锚点：找标题
          const view = viewRef.current
          if (!view) return
          const text = view.state.doc.toString()
          const target = outline.find((o) => o.text === url.slice(1))
          if (target) view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true })
        }
      },
    }

    const view = createEditor({
      parent: host,
      initialText: textRef.current,
      opts: liveOpts,
      onChange: (text) => {
        textRef.current = text
        scheduleSave()
        setStats(computeStats(text))
        setOutline(extractOutline(text))
        // 资源面板防抖重提取（400ms 静默后才 +1，避免每键全量正则）
        clearTimeout(resTimerRef.current)
        resTimerRef.current = setTimeout(() => setDocVersion((v) => v + 1), 400)
      },
      typewriter,
      focus: false,
    })
    viewRef.current = view
    if (!textRef.current) {
      textRef.current = WELCOME
      view.dispatch({ changes: { from: 0, to: 0, insert: WELCOME } })
    }
    if (typewriter) setTypewriterCm(view, true)

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, page])

  /* ---------------- 生命周期 ---------------- */
  useEffect(() => {
    let alive = true
    const k = PluginKit.create({
      title: 'Markdown 编辑器',
      quickPlaceholder: '速记一句话，⏎ 落收件箱…',
      height: 420,
      defaults: { typewriterMode: false, focusMode: false, renderHtml: true, mermaidLook: 'handDrawn', imageDefaultAction: 'ask', autoSave: true },
    })
    kitRef.current = k
    setKit(k)
    setMode(k.mode === 'quick' ? 'quick' : 'shell')

    k.onMode?.((m) => setMode(m === 'quick' ? 'quick' : 'shell'))
    k.onSettings?.((settings) => {
      settingsRef.current = settings
      setTypewriter(settings.typewriterMode === true)
      setFocusMode(settings.focusMode === true)
      setMermaidLook(settings.mermaidLook === 'rounded' || settings.mermaidLook === 'classic' ? settings.mermaidLook : 'handDrawn')
      const view = viewRef.current
      if (view) updateLiveOpts(view, {
        renderHtml: settings.renderHtml !== false,
        resolveImage: (url) => resolveImageToDataUrl(docPathRef.current, url),
        onLinkClick: liveLinkHandler,
      })
    })

    const booted = (async () => {
      await k.ready
      if (!alive) return
      // 旧笔记清理（v2 改为本地文件编辑器，旧 storage 数据废弃）
      void call('legacy.cleanup').then(async (r) => {
        if (!r?.skipped) {
          try { await api()?.storage?.remove?.('mdnotes_v1') } catch { /* 无旧数据 */ }
        }
      }).catch(() => {})
      // 恢复最近文件
      try {
        const { list } = await call('recent.list')
        if (alive && list.length) setRecentFiles(list)
      } catch { /* backend 未授权 */ }
      // 外观跟随
      try {
        const appearance = await api()?.ui?.getThemeTokens?.()
        const dark = document.documentElement.dataset.theme === 'dark' || appearance?.colorScheme === 'dark'
        if (alive) { setDarkMode(dark); await initTheme(dark) }
      } catch { await initTheme(false) }
      api()?.ui?.onThemeChange?.((tokens) => {
        const dark = tokens?.colorScheme === 'dark' || document.documentElement.dataset.theme === 'dark'
        setDarkMode(dark)
        void initTheme(dark)
      })
      api()?.ui?.onAppearanceChange?.((snap) => {
        const dark = snap?.scheme === 'dark' || snap?.colorScheme === 'dark'
        setDarkMode(dark)
        void initTheme(dark)
      })
    })()
    void booted

    // 全局事件
    document.addEventListener('paste', onPaste, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('dragover', ((e) => e.preventDefault()))
    const onAskImage = (e) => {
      const detail = e.detail
      window.dispatchEvent(new CustomEvent('md-show-upload-menu', { detail }))
    }
    window.addEventListener('md-ask-image', onAskImage)
    // 快捷键
    const keys = (e) => {
      if (e.isComposing) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void doSave() }
      if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newDoc() }
      if (mod && e.key === '\\') { e.preventDefault(); setSidebarOpen((v) => !v) }
      if (e.key === 'F8' && !mod) { e.preventDefault(); toggleTypewriter() }
      if (e.key === 'F9' && !mod) { e.preventDefault(); toggleFocus() }
    }
    document.addEventListener('keydown', keys)

    api()?.onEnter?.((event) => {
      if (event?.code === 'settings') { setPage('settings'); setMode('shell') ; return }
      if (event?.code === 'inbox' || k.mode === 'quick') setMode('quick')
      else setMode('shell')
    })
    api()?.onBeforeClose?.(async () => {
      clearTimeout(saveTimerRef.current)
      await flushSave().catch(() => {})
    })

    return () => {
      alive = false
      document.removeEventListener('paste', onPaste, true)
      document.removeEventListener('drop', onDrop, true)
      window.removeEventListener('md-ask-image', onAskImage)
      document.removeEventListener('keydown', keys)
      k.destroy?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const liveLinkHandler = (url) => {
    if (/^https?:\/\//i.test(url)) void api()?.shell?.openExternal?.(url)
  }

  const toggleTypewriter = () => {
    const next = !typewriter
    setTypewriter(next)
    void api()?.settings?.set?.('typewriterMode', next)
    if (viewRef.current) setTypewriterCm(viewRef.current, next)
  }
  const toggleFocus = () => {
    const next = !focusMode
    setFocusMode(next)
    void api()?.settings?.set?.('focusMode', next)
    document.querySelector('.md-scope')?.setAttribute('data-focus-mode', next ? 'on' : 'off')
  }

  /* ---------------- quick 速记 ---------------- */
  if (mode === 'quick') {
    return <QuickScratch kit={kit} />
  }

  /* ---------------- 设置页 ---------------- */
  if (page === 'settings') {
    return <SettingsPage onBack={() => setPage('editor')} themeList={themeList} activeTheme={activeTheme} onThemeChange={(id) => void applyThemeById(id, darkMode)} />
  }

  /* ---------------- shell 编辑器 ---------------- */
  return (
    <main className="md-app md-scope" data-sidebar={sidebarOpen ? 'open' : 'closed'} data-focus-mode={focusMode ? 'on' : 'off'}>
      <UploadMenu onHandle={handleImage} uploading={uploading} />
      <ExportMenu ref={exportRef} docPath={docPath} textRef={textRef} darkMode={darkMode} toast={toast} />
      {ctxMenu && (
        <div className="md-ctx-menu" style={{ left: Math.min(ctxMenu.x, window.innerWidth - 230), top: Math.min(ctxMenu.y, window.innerHeight - 420) }} role="menu">
          <div className="md-menu-label">格式</div>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ wrap: '**' }) }}>加粗<kbd>⌘B</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ wrap: '*' }) }}>斜体<kbd>⌘I</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ wrap: '`' }) }}>行内代码<kbd>⌘E</kbd></button>
          <div className="md-menu-sep" />
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ line: '# ' }) }}>一级标题<kbd>⌘1</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ line: '## ' }) }}>二级标题<kbd>⌘2</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ line: '### ' }) }}>三级标题<kbd>⌘3</kbd></button>
          <div className="md-menu-sep" />
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ line: '- ' }) }}>无序列表<kbd>⌘⇧8</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ line: '1. ' }) }}>有序列表<kbd>⌘⇧9</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ line: '- [ ] ' }) }}>任务清单<kbd>⌘⇧7</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ line: '> ' }) }}>引用<kbd>⌘⇧U</kbd></button>
          <div className="md-menu-sep" />
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ fence: true }) }}>代码块<kbd>⌘⇧L</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ table: true }) }}>表格<kbd>⌘⇧G</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ link: true }) }}>链接<kbd>⌘K</kbd></button>
          <button role="menuitem" onClick={() => { setCtxMenu(null); applyFormatAction({ image: true }) }}>图片<kbd>⇧⌘K</kbd></button>
        </div>
      )}
      {conflict && (
        <div className="md-conflict-overlay" role="alertdialog" aria-label="文件在外部被修改">
          <div className="md-conflict-card">
            <h3>文件在外部被修改</h3>
            <p className="md-conflict-path">{conflict.path}</p>
            {conflict.deleted ? <p>文件已被删除，但编辑器中仍有未保存的修改。</p> : <p>磁盘版本与你的未保存修改冲突。</p>}
            <div className="md-conflict-actions">
              <button className="pk-btn" onClick={() => void resolveConflict('mine')}>保留我的版本</button>
              <button className="pk-btn" onClick={() => void resolveConflict('disk')}>加载磁盘版本</button>
              <button className="pk-btn" onClick={() => void resolveConflict('copy')}>另存一份…</button>
            </div>
          </div>
        </div>
      )}
      <div className="md-body">
        <button ref={sidebarToggleRef} type="button" className="pk-btn pk-btn-ghost pk-btn-sm md-sidebar-toggle"
          aria-controls="md-navigation" aria-expanded={sidebarOpen || sidebarPeek}
          aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'} title={sidebarOpen ? '收起侧栏（⌘\\）' : '展开侧栏（⌘\\）'}
          onClick={toggleSidebar}>☰</button>
        <Sidebar
          panelRef={sidebarRef}
          tab={sidebarTab}
          onTab={setSidebarTab}
          outline={outline}
          docPath={docPath}
          textRef={textRef}
          docVersion={docVersion}
          recentFiles={recentFiles}
          onOpenFile={(p) => void openFile(p)}
          onJump={(pos) => viewRef.current?.dispatch({ selection: { anchor: pos }, scrollIntoView: true })}
          toast={toast}
          viewRef={viewRef}
        />
        <section className="md-editor-pane" onDrop={(e) => void onDrop(e.nativeEvent)} onDragOver={(e) => e.preventDefault()} onContextMenu={onEditorContextMenu}>
          <div ref={editorHostRef} className="md-editor-host" />
          {/* 右上角浮动菜单：不占布局行高，悬停才完全显形 */}
          <div className="md-float-menu md-more-wrap" ref={moreRef}>
            <button className="md-more-btn" onClick={() => setMoreOpen((v) => !v)} title="菜单">⋯</button>
            {moreOpen && (
              <div className="md-more-menu" role="menu">
                <div className="md-menu-label">文件</div>
                <button className="pk-menu-item" role="menuitem" onClick={() => closeMore(newDoc)}>新建<kbd>⌘N</kbd></button>
                <button className="pk-menu-item" role="menuitem" onClick={() => closeMore(() => void openWithPicker())}>打开…</button>
                <button className="pk-menu-item" role="menuitem" onClick={() => closeMore(() => void doSave())}>保存<kbd>⌘S</kbd></button>
                <button className="pk-menu-item" role="menuitem" onClick={() => closeMore(() => void saveAs())}>另存为…</button>
                <div className="md-menu-sep" />
                <div className="md-menu-label">导出</div>
                <button className="pk-menu-item" role="menuitem" onClick={() => { setMoreOpen(false); void exportRef.current?.html() }}>HTML 单文件</button>
                <button className="pk-menu-item" role="menuitem" onClick={() => { setMoreOpen(false); void exportRef.current?.pdf() }}>PDF（系统打印）</button>
                <button className="pk-menu-item" role="menuitem" onClick={() => { setMoreOpen(false); void exportRef.current?.png() }}>PNG 长图</button>
                <div className="md-menu-sep" />
                <div className="md-menu-label">视图</div>
                <button className="pk-menu-item" role="menuitem" onClick={() => closeMore(toggleTypewriter)} aria-checked={typewriter}>{typewriter ? '✓ ' : ''}打字机模式<kbd>F8</kbd></button>
                <button className="pk-menu-item" role="menuitem" onClick={() => closeMore(toggleFocus)} aria-checked={focusMode}>{focusMode ? '✓ ' : ''}专注模式<kbd>F9</kbd></button>
                <button className="pk-menu-item" role="menuitem" onClick={() => closeMore(toggleSidebar)}>侧栏<kbd>⌘\</kbd></button>
                <div className="md-menu-sep" />
                <div className="md-menu-label">主题</div>
                <div className="md-menu-themes">
                  {themeList.map((t) => (
                    <button key={t.id} role="menuitemradio" aria-checked={t.id === activeTheme}
                      className={t.id === activeTheme ? 'is-active' : ''}
                      onClick={() => { setMoreOpen(false); void applyThemeById(t.id, darkMode) }}>{t.name}</button>
                  ))}
                </div>
                <div className="md-menu-sep" />
                <button className="pk-menu-item" role="menuitem" onClick={() => { setMoreOpen(false); setPage('settings') }}>设置…</button>
              </div>
            )}
          </div>
        </section>
      </div>
      <footer className="md-statusbar">
        <button className={`md-status-save md-save-${saveState}`} onClick={() => void doSave()} title="保存（⌘S）">
          <span className={`md-doc-pill-dot md-dot-${saveState}`} />
          {{ saved: '已保存', dirty: '未保存', saving: '保存中', error: '保存失败', conflict: '冲突' }[saveState]}
        </button>
        <span className="md-docname" title={docPath}>{docPath ? docPath : '未落盘文档（⌘S 选择位置）'}</span>
        <span className="md-grow" />
        <span className="md-stats">{stats.words} 词 · {stats.chars} 字符 · {stats.lines} 行 · 约 {stats.readMinutes} 分钟</span>
      </footer>
    </main>
  )
}

/* ---------------- Quick 速记 ---------------- */

function QuickScratch({ kit }) {
  const hostRef = useRef(null)
  const viewRef2 = useRef(null)
  const draftRef = useRef('')
  const [saved, setSaved] = useState(true)

  useEffect(() => {
    if (!hostRef.current || viewRef2.current) return
    const view = createEditor({
      parent: hostRef.current,
      initialText: draftRef.current,
      opts: { renderHtml: true },
      onChange: (text) => { draftRef.current = text; setSaved(false) },
      focus: true,
    })
    viewRef2.current = view
    return () => { view.destroy(); viewRef2.current = null }
  }, [])

  useEffect(() => {
    if (!kit) return
    kit.onAction?.((action) => {
      if (action === 'submit') {
        const text = draftRef.current.trim()
        if (!text) return
        void call('scratch.append', text).then(() => {
          draftRef.current = ''
          viewRef2.current?.dispatch({ changes: { from: 0, to: viewRef2.current.state.doc.length, insert: '' } })
          setSaved(true)
          kit.toast?.('已记入收件箱', 'success')
          api()?.ui?.dismissQuick?.()
        }).catch((e) => kit.toast?.(`速记失败：${e.message}`, 'error'))
      }
    })
    api()?.setDirty?.(draftRef.current.trim().length > 0)
    api()?.onSaveRequested?.(async () => {
      const text = draftRef.current.trim()
      if (text) await call('scratch.append', text).catch(() => {})
      draftRef.current = ''
      setSaved(true)
    })
  }, [kit])

  return (
    <main className="md-app md-quick md-scope">
      <div ref={hostRef} className="md-editor-host" />
      <footer className="md-quick-status">
        <span>速记 · ⏎ 提交到收件箱 · Esc 收起</span>
        <span className="md-grow" />
        <span>{saved ? '已同步' : '草稿…'}</span>
      </footer>
    </main>
  )
}

function api() { return (window).enest || (window).zapi }
