/**
 * markdown v2 主界面 —— Typora 式本地文件工作台。
 * shell 模式：侧栏（大纲/文件树/图片资产）+ 即时渲染编辑器 + 状态栏。
 * quick 模式：速记编辑器（提交落收件箱，dismissQuick 保活）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createEditor, updateLiveOpts, extractOutline, computeStats, EditorView, setTypewriter as setTypewriterCm } from '../cm/live.js'
import { wrapSelection, toggleLinePrefix, insertBlock, FENCE_TEXT, TABLE_TEXT, LINK_TEXT, IMAGE_TEXT } from '../cm/formatOps.js'
import { call, onBackendEvent, resolveImageToDataUrl, dataUrlToParts, readClipboardImage } from '../js/rpc.js'
import { applyTheme, builtinThemeCss, adaptTyporaCss, BUILTIN_THEMES } from '../render/theme.js'
import { setMermaidLook } from '../render/render.js'
import { resolveImageDir } from '../js/imageDir.js'
import { applyContentMetrics, applyMotionSettings, loadUserThemes, applyUserTheme, deleteUserTheme } from '../js/preferences.js'
import { Sidebar } from './Sidebar.jsx'
import { SettingsPage } from './SettingsPage.jsx'
import { UploadMenu } from './UploadMenu.jsx'
import { ExportMenu } from './ExportMenu.jsx'
import { PanelView } from './PanelView.jsx'

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

const SIDEBAR_DEFAULT_WIDTH = 232
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 480
const SIDEBAR_WIDTH_KEY = 'md.sidebarWidth'

export function App() {
  const [kit, setKit] = useState(null)
  const [mode, setMode] = useState(() => api()?.getLaunchMode?.() || 'shell')
  const [page, setPage] = useState('editor')
  const [documentsReady, setDocumentsReady] = useState(false)
  const [documentError, setDocumentError] = useState('')

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
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
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
  const [imageDir, setImageDir] = useState(null) // { raw, path, exists, error }
  const [imageMenu, setImageMenu] = useState(null) // { x, y, src, width, height } 图片尺寸工具

  /* —— refs —— */
  const editorHostRef = useRef(null)
  const moreRef = useRef(null)
  const exportRef = useRef(null) // ExportMenu 暴露 { html, pdf, png }
  const viewRef = useRef(null)
  const editorStateRef = useRef(null)
  const editorScrollRef = useRef(0)
  const scratchDraftRef = useRef('')
  const scratchPendingRef = useRef(null)
  const scratchActionRef = useRef(null)
  const scratchSyncRef = useRef(null)
  const docPathRef = useRef('')
  const docLoadRevisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef(0)
  const resTimerRef = useRef(0)
  const textRef = useRef('')
  const kitRef = useRef(null)
  const settingsRef = useRef({})
  const sidebarRef = useRef(null)
  const sidebarHandleRef = useRef(null)
  const sidebarBindingRef = useRef(null)
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH)
  const imageDirRef = useRef(null)
  const resizingRef = useRef(false)
  const suppressHandleClickRef = useRef(false)
  const handleClickTimerRef = useRef(0)

  const saveScratchDraft = useCallback(async () => {
    if (scratchPendingRef.current) return scratchPendingRef.current
    const draft = scratchDraftRef.current
    if (!draft.trim()) return false
    // Submission belongs to the shared model, not a layout that may unmount mid-save.
    const pending = call('scratch.append', draft.trim()).then(() => {
      if (scratchDraftRef.current === draft) scratchDraftRef.current = ''
      scratchSyncRef.current?.()
      api()?.setDirty?.(scratchDraftRef.current.trim().length > 0)
      return true
    }).finally(() => {
      if (scratchPendingRef.current === pending) scratchPendingRef.current = null
    })
    scratchPendingRef.current = pending
    return pending
  }, [])

  /* —— 侧栏宽度：持久化 + 应用到 CSS 变量 —— */
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
    document.documentElement.style.setProperty('--md-sidebar-width', `${sidebarWidth}px`)
  }, [sidebarWidth])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const stored = await api()?.storage?.get?.(SIDEBAR_WIDTH_KEY)
        const n = Number(stored)
        if (alive && Number.isFinite(n) && n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH) setSidebarWidth(Math.round(n))
      } catch { /* 用默认宽度 */ }
    })()
    return () => { alive = false }
  }, [])

  const persistSidebarWidth = useCallback((width) => {
    try { void api()?.storage?.set?.(SIDEBAR_WIDTH_KEY, Math.round(width)) } catch { /* 忽略 */ }
  }, [])

  /* 侧栏右边缘拖拽调宽：主进程不参与，纯 renderer 指针事件（跟手，不触发文字选中） */
  const startSidebarResize = useCallback((e) => {
    if (e.button !== 0 || !sidebarOpen) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current
    resizingRef.current = true
    document.body.classList.add('md-sidebar-resizing')
    document.body.dataset.mdSidebarResizing = 'on'

    const onMove = (ev) => {
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(startWidth + ev.clientX - startX)))
      sidebarWidthRef.current = next
      document.documentElement.style.setProperty('--md-sidebar-width', `${next}px`)
      setSidebarWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      resizingRef.current = false
      document.body.classList.remove('md-sidebar-resizing')
      delete document.body.dataset.mdSidebarResizing
      persistSidebarWidth(sidebarWidthRef.current)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
  }, [sidebarOpen, persistSidebarWidth])

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    sidebarWidthRef.current = SIDEBAR_DEFAULT_WIDTH
    document.documentElement.style.setProperty('--md-sidebar-width', `${SIDEBAR_DEFAULT_WIDTH}px`)
    persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
  }, [persistSidebarWidth])

  useEffect(() => {
    if (mode !== 'shell' || page !== 'editor') return
    const binding = PluginKit.bindHoverPanel(sidebarHandleRef.current, sidebarRef.current, {
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
  imageDirRef.current = imageDir
  // 供 Sidebar 直接替换文内链接（避免把 EditorView 穿透 props）
  useEffect(() => { (window).__mdViewRef = viewRef })

  const toast = useCallback((message, type = "info") => {
    kitRef.current?.toast?.(message, type)
  }, [])

  /* ---------------- 设置应用 ---------------- */

  /** 图片/HTML 尺寸、代码配色、动效开关：全部写根元素变量/属性，即时生效 */
  const applyPreferences = useCallback((settings) => {
    applyContentMetrics(document.documentElement, settings)
    applyMotionSettings(document.documentElement, settings)
  }, [])

  /** 重新解析本地图片目录（设置变更或首次启动时调用），并把结果登记为 backend 授权 */
  const refreshImageDir = useCallback(async (settings) => {
    const s = settings || settingsRef.current || {}
    let assetsDir = ''
    try {
      const paths = await call('info.paths')
      assetsDir = paths?.assetsDir || ''
    } catch { /* backend 未授权时用 resolvePath 推算 */ }
    const resolved = await resolveImageDir(s.localImageDir, api(), assetsDir)
    setImageDir(resolved)
    imageDirRef.current = resolved
    // 手输目录要在 backend 侧登记持久授权，否则预览读不到、保存也会被"路径越界"拒绝
    if (resolved?.path && !resolved.fallback) {
      void call('images.setDir', resolved.path, resolved.raw).catch(() => {})
    } else if (resolved?.fallback) {
      void call('images.setDir', '', resolved.raw || '').catch(() => {})
    }
    if (resolved?.error) toast(`图片目录解析失败：${resolved.error}，已回退到插件私有 assets`, 'error')
  }, [toast])

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
    const revision = ++docLoadRevisionRef.current
    try {
      await call('doc.grant', path)
      if (revision !== docLoadRevisionRef.current) return
      const { text } = await call('doc.open', path)
      if (revision !== docLoadRevisionRef.current) return
      dirtyRef.current = false
      textRef.current = text
      docPathRef.current = path
      editorStateRef.current = null
      setDocPath(path)
      setDocName(path.split('/').pop() || '文档')
      const view = viewRef.current
      if (view) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      }
      setSaveState('saved')
      setDocumentError('')
      setStats(computeStats(text))
      setOutline(extractOutline(text))
      setDocVersion((v) => v + 1)
      api()?.ui?.setTitle?.(`${path.split('/').pop()} — Markdown`)
    } catch (e) {
      if (revision !== docLoadRevisionRef.current) return
      setDocumentError(`打开失败：${e.message}`)
      toast(`打开失败：${e.message}`, 'error')
    }
  }, [toast])

  const openWithPicker = useCallback(async () => {
    const handles = await api()?.localFiles?.pick?.({ kind: 'file', multiple: false, access: 'read' })
    const path = handles?.[0]?.displayPath
    if (path) await openFile(path)
  }, [openFile])

  const newDoc = useCallback(() => {
    docLoadRevisionRef.current++
    dirtyRef.current = false
    textRef.current = ''
    docPathRef.current = ''
    editorStateRef.current = null
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

  /**
   * 图片落盘。
   * `local` 走 upload.local（与图床选择解耦），目录用设置里的手输路径经
   * `shell.resolvePath` 解析后的绝对路径；解析失败时回退插件私有 assets。
   */
  const handleImage = useCallback(async (dataUrl, action) => {
    if (action === 'base64') {
      insertAtCursor(`![](${dataUrl})`)
      return
    }
    setUploading(true)
    try {
      const { mime, bytesB64 } = dataUrlToParts(dataUrl)
      if (action === 'local') {
        const dir = imageDirRef.current?.path || undefined
        const result = await call('upload.local', docPathRef.current || '', 'pasted.png', mime, bytesB64, dir)
        insertAtCursor(`\n${result.markdown}\n`)
        toast('图片已存到本地', 'success')
      } else {
        const result = await call('upload.run', docPathRef.current, 'pasted.png', mime, bytesB64)
        insertAtCursor(`\n${result.markdown}\n`)
        try { await api()?.clipboard?.writeText?.(result.url) } catch { /* 可选 */ }
        toast('图片已插入', 'success')
      }
    } catch (e) {
      toast(`图片处理失败：${e.message}`, 'error')
    } finally {
      setUploading(false)
    }
  }, [insertAtCursor, toast])

  /* ---------------- 图片尺寸工具（单张覆盖） ---------------- */

  /** 在光标处的图片语法后追加 {width=.. height=..}，渲染层会转成内联样式 */
  const applyImageSize = useCallback((width, height) => {
    const view = viewRef.current
    const menu = imageMenu
    setImageMenu(null)
    if (!view || !menu) return
    const text = view.state.doc.toString()
    const src = menu.src
    if (!src) return
    const idx = text.indexOf(src)
    if (idx < 0) { toast('未能在文档中定位该图片', 'error'); return }
    // 定位图片语法结束的右括号
    let close = text.indexOf(')', idx + src.length)
    const angle = text.lastIndexOf(']', idx)
    if (close < 0 || angle < 0) { toast('图片语法不完整，无法设置尺寸', 'error'); return }
    let end = close + 1
    // 已有 {width=..} 覆盖时先删掉
    const tail = /^\{[^}]*\}/.exec(text.slice(end))
    if (tail) end += tail[0].length
    const attrs = []
    if (width) attrs.push(`width=${width}`)
    if (height) attrs.push(`height=${height}`)
    const insert = attrs.length ? `{${attrs.join(' ')}}` : ''
    view.dispatch({ changes: { from: close + 1, to: end, insert } })
    view.focus()
    toast(insert ? '已设置该图片尺寸' : '已清除该图片尺寸', 'success')
  }, [imageMenu, toast])

  /** 渲染态图片点击：弹出小工具设置单张宽高 */
  const onEditorClick = useCallback((e) => {
    const img = e.target?.closest?.('.md-atomic img, .md-html-block img')
    if (!img) return
    const rect = img.getBoundingClientRect()
    setImageMenu({
      x: Math.min(e.clientX, window.innerWidth - 240),
      y: Math.min(e.clientY + 12, window.innerHeight - 200),
      src: img.getAttribute('data-src') || img.getAttribute('src') || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  }, [])

  useEffect(() => {
    if (!imageMenu) return
    const close = (e) => {
      // 工具自身与触发它的图片都不关闭，避免 mousedown 先于 click 关掉面板
      if (e.target?.closest?.('.md-img-tool, .md-atomic img, .md-html-block img')) return
      setImageMenu(null)
    }
    const esc = (e) => { if (e.key === 'Escape') setImageMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [imageMenu])

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
    if (kitRef.current?.mode === 'panel') return
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
    // 纯文本粘贴：若整段就是本地图片路径（截图工具的「复制文件路径」），直接插入图片语法
    const text = e.clipboardData.getData('text/plain')?.trim() ?? ''
    if (!text || text.includes('\n')) return
    if (/^(?:file:\/\/)?(?:\/|~\/|[A-Za-z]:[\\/]).+\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(text)) {
      e.preventDefault()
      const url = text.replace(/^file:\/\//i, '')
      insertAtCursor(`![](${url})`)
      toast('已按本地图片插入', 'success')
    }
  }, [handleImage, insertAtCursor, toast])

  /* ---------------- 拖入打开 / 拖入图片 ---------------- */

  const onDrop = useCallback(async (e) => {
    if (kitRef.current?.mode === 'panel') return
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    const images = files.filter((f) => /^image\//.test(f.type))
    const md = files.find((f) => /\.md$/i.test(f.name))
    if (md) {
      try {
        const handles = await api()?.localFiles?.fromDrop?.(files.map((f) => (f).path || f.name))
        const handle = handles?.find?.((h) => /\.md$/i.test(h.name))
        if (handle?.displayPath) await openFile(handle.displayPath)
      } catch {
        toast('拖入被取消', 'info')
      }
      return
    }
    // 拖入图片：与粘贴同一套动作（默认动作 / 询问）
    if (images.length) {
      for (const file of images) {
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => resolve('')
          reader.readAsDataURL(file)
        })
        if (!dataUrl) continue
        const defaultAction = settingsRef.current.imageDefaultAction || 'ask'
        if (defaultAction === 'ask') window.dispatchEvent(new CustomEvent('md-ask-image', { detail: dataUrl }))
        else await handleImage(dataUrl, defaultAction)
      }
    }
  }, [openFile, toast, handleImage])

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
          if (docPathRef.current !== data.path || dirtyRef.current) return
          const view = viewRef.current
          textRef.current = text
          if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
          setStats(computeStats(text))
          setOutline(extractOutline(text))
          setDocVersion((v) => v + 1)
          dirtyRef.current = false
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
      // 用户主题（Typora CSS / 上传的 CSS 主题）：优先读宿主私有文件区
      const applied = await applyUserTheme(themeId, builtinThemeCss('enest-minimal'))
      if (!applied) {
        applyTheme('enest-minimal', builtinThemeCss('enest-minimal'))
        themeId = 'enest-minimal'
      }
    }
    setActiveTheme(themeId)
    // 持久化（浅/深各自记忆）
    void call('theme.setPrefs', dark ? themeId : undefined, dark ? undefined : themeId).catch(() => {})
  }, [])

  const refreshThemeList = useCallback(async () => {
    const userThemes = await loadUserThemes()
    setThemeList([...BUILTIN_THEMES, ...userThemes])
    return userThemes
  }, [])

  const initTheme = useCallback(async (dark) => {
    await refreshThemeList().catch(() => { /* backend 未授权时保留内置 */ })
    const prefs = await call('theme.prefs').catch(() => ({ lightTheme: 'enest-minimal', darkTheme: 'enest-minimal-dark' }))
    const want = dark ? (prefs.darkTheme || 'enest-minimal-dark') : (prefs.lightTheme || 'enest-minimal')
    await applyThemeById(want, dark)
  }, [applyThemeById, refreshThemeList])

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
    if (editorStateRef.current?.doc.toString() === textRef.current) {
      view.setState(editorStateRef.current)
      updateLiveOpts(view, liveOpts)
      view.scrollDOM.scrollTop = editorScrollRef.current
    }
    if (!textRef.current && !editorStateRef.current && !docPathRef.current && docLoadRevisionRef.current === 0) {
      textRef.current = WELCOME
      view.dispatch({ changes: { from: 0, to: 0, insert: WELCOME } })
    }
    if (typewriter) setTypewriterCm(view, true)

    return () => {
      editorStateRef.current = view.state
      editorScrollRef.current = view.scrollDOM.scrollTop
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
      onAction: action => scratchActionRef.current?.(action),
      defaults: {
        typewriterMode: false,
        focusMode: false,
        renderHtml: true,
        mermaidLook: 'handDrawn',
        imageDefaultAction: 'ask',
        autoSave: true,
        localImageDir: '',
        codeTheme: 'default',
        motionEnabled: false,
        motionPreset: 'both',
        imageMaxWidth: 100,
        imageMaxHeight: 0,
        htmlBlockMaxWidth: 100,
        htmlBlockMaxHeight: 0,
      },
    })
    kitRef.current = k
    setKit(k)
    setMode(k.mode)

    k.onMode?.(setMode)
    k.onSettings?.((settings, changedKey) => {
      settingsRef.current = settings
      setTypewriter(settings.typewriterMode === true)
      setFocusMode(settings.focusMode === true)
      setMermaidLook(settings.mermaidLook === 'rounded' || settings.mermaidLook === 'classic' ? settings.mermaidLook : 'handDrawn')
      applyPreferences(settings)
      // 手输图片目录：解析为绝对路径（宿主统一 API，跨平台）
      if (changedKey === undefined || changedKey === 'localImageDir') void refreshImageDir(settings)
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
      applyPreferences(k.settings)
      void refreshImageDir(k.settings)
      // 旧笔记清理（v2 改为本地文件编辑器，旧 storage 数据废弃）
      void call('legacy.cleanup').then(async (r) => {
        if (!r?.skipped) {
          try { await api()?.storage?.remove?.('mdnotes_v1') } catch { /* 无旧数据 */ }
        }
      }).catch(() => {})
      // 恢复最近文件
      try {
        const { list } = await call('recent.list')
        if (alive && list.length) {
          setRecentFiles(list)
          // A cold widget reads the same document model without mounting CodeMirror.
          if (k.mode === 'panel' && !textRef.current && !docPathRef.current && docLoadRevisionRef.current === 0) await openFile(list[0].path)
        }
      } catch (error) {
        if (alive) setDocumentError(`读取文稿失败：${error.message}`)
      } finally {
        if (alive) setDocumentsReady(true)
      }
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
      if (e.isComposing || k.mode === 'panel') return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void doSave() }
      if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newDoc() }
      if (mod && e.key === '\\') { e.preventDefault(); setSidebarOpen((v) => !v) }
      if (e.key === 'F8' && !mod) { e.preventDefault(); toggleTypewriter() }
      if (e.key === 'F9' && !mod) { e.preventDefault(); toggleFocus() }
    }
    document.addEventListener('keydown', keys)

    api()?.onEnter?.((event) => {
      setMode(k.mode)
      if (event?.code === 'settings') { setPage('settings'); return }
      // 打开方式：双击 .md / enest-md:// 链接进入，读首个文件切主窗打开
      if (event?.code === 'open-file' || event?.code === 'open-url') {
        setPage('editor')
        const target = event?.code === 'open-file'
          ? event?.payload?.paths?.[0]
          : undefined
        if (target) void openFile(target)
        return
      }
      if (event?.code === 'inbox') setPage('scratch')
      else if (event?.code === 'main') setPage('editor')
    })
    api()?.onBeforeClose?.(async () => {
      clearTimeout(saveTimerRef.current)
      await flushSave().catch(() => {})
    })
    const offScratchSave = api()?.onSaveRequested?.(saveScratchDraft)

    return () => {
      alive = false
      offScratchSave?.()
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
  if (mode === 'panel') {
    return <PanelView name={docName} text={textRef.current} stats={stats} ready={documentsReady}
      error={documentError} dirty={saveState === 'dirty' || saveState === 'error'} conflict={conflict}
      onOpen={() => {
        setPage('editor')
        void api().ui.openInShell().catch(error => toast(error.message, 'error'))
      }} />
  }
  if (mode === 'quick' || page === 'scratch') {
    return <QuickScratch kit={kit} draftRef={scratchDraftRef} actionRef={scratchActionRef}
      syncRef={scratchSyncRef} onSave={saveScratchDraft} />
  }

  /* ---------------- 设置页 ---------------- */
  if (page === 'settings') {
    return (
      <SettingsPage
        onBack={() => setPage('editor')}
        themeList={themeList}
        activeTheme={activeTheme}
        onThemeChange={(id) => void applyThemeById(id, darkMode)}
        onThemesChanged={() => void refreshThemeList()}
        imageDir={imageDir}
        onRefreshImageDir={() => void refreshImageDir()}
        settings={kit?.settings || {}}
        onSettingChange={(key, value) => void api()?.settings?.set?.(key, value)}
      />
    )
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
      {imageMenu && (
        <div className="md-img-tool" style={{ left: imageMenu.x, top: imageMenu.y }} role="dialog" aria-label="图片尺寸">
          <div className="md-menu-label">本图尺寸（当前 {imageMenu.width}×{imageMenu.height}）</div>
          <div className="md-img-tool-row">
            {[25, 50, 75, 100].map((pct) => (
              <button key={pct} onClick={() => applyImageSize(`${pct}%`)}>{pct}%</button>
            ))}
          </div>
          <div className="md-img-tool-row">
            {[320, 480, 640, 800].map((px) => (
              <button key={px} onClick={() => applyImageSize(`${px}px`)}>{px}px</button>
            ))}
          </div>
          <div className="md-img-tool-row">
            <button onClick={() => applyImageSize('', '')}>清除尺寸</button>
          </div>
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
          imageDir={imageDir?.path || ''}
        />
        {/* 侧栏右边缘把手：单击切换，横向拖动调宽，双击恢复默认宽度 */}
        <button
          ref={sidebarHandleRef}
          type="button"
          className="md-sidebar-handle"
          aria-controls="md-navigation"
          aria-expanded={sidebarOpen || sidebarPeek}
          aria-label={sidebarOpen ? '收起侧栏（拖动可调宽，双击恢复默认宽度）' : '展开侧栏'}
          title={sidebarOpen ? '收起侧栏 · 拖动调宽 · 双击复位' : '展开侧栏'}
          onPointerDown={(e) => {
            if (e.button !== 0 || !sidebarOpen) return
            const startX = e.clientX
            let dragging = false
            const onMove = (ev) => {
              if (dragging) return
              if (Math.abs(ev.clientX - startX) > 3) {
                dragging = true
                suppressHandleClickRef.current = true
                document.removeEventListener('pointermove', onMove)
                document.removeEventListener('pointerup', onUp)
                startSidebarResize(ev)
              }
            }
            const onUp = () => {
              document.removeEventListener('pointermove', onMove)
              document.removeEventListener('pointerup', onUp)
            }
            document.addEventListener('pointermove', onMove)
            document.addEventListener('pointerup', onUp, { once: true })
          }}
          onClick={() => {
            // 拖动调宽结束后的 click 不当作切换
            if (suppressHandleClickRef.current) { suppressHandleClickRef.current = false; return }
            // 延迟一拍：双击（复位宽度）时取消这次切换
            clearTimeout(handleClickTimerRef.current)
            handleClickTimerRef.current = setTimeout(() => toggleSidebar(), 240)
          }}
          onDoubleClick={(e) => {
            e.preventDefault()
            clearTimeout(handleClickTimerRef.current)
            suppressHandleClickRef.current = false
            resetSidebarWidth()
          }}
        />
        <section className="md-editor-pane" onDrop={(e) => void onDrop(e.nativeEvent)} onDragOver={(e) => e.preventDefault()} onContextMenu={onEditorContextMenu} onClick={onEditorClick}>
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

function QuickScratch({ kit, draftRef, actionRef, syncRef, onSave }) {
  const hostRef = useRef(null)
  const viewRef2 = useRef(null)
  const submittingRef = useRef(false)
  const [saved, setSaved] = useState(() => !draftRef.current)

  useEffect(() => {
    if (!hostRef.current || viewRef2.current) return
    const view = createEditor({
      parent: hostRef.current,
      initialText: draftRef.current,
      opts: { renderHtml: true },
      onChange: (text) => {
        draftRef.current = text
        setSaved(!text.trim())
        api()?.setDirty?.(text.trim().length > 0)
      },
      focus: true,
    })
    viewRef2.current = view
    return () => { view.destroy(); viewRef2.current = null }
  }, [])

  useEffect(() => {
    if (!kit) return
    const syncDraft = () => {
      const view = viewRef2.current
      if (view && view.state.doc.toString() !== draftRef.current) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draftRef.current } })
      }
      setSaved(!draftRef.current.trim())
    }
    const handleAction = (action) => {
      if (action === 'submit' && !submittingRef.current) {
        submittingRef.current = true
        void onSave().then((didSave) => {
          if (!didSave) return
          kit.toast?.('已记入收件箱', 'success')
          if (kit.mode === 'quick' && !draftRef.current.trim()) void api()?.ui?.dismissQuick?.()
        }).catch((e) => kit.toast?.(`速记失败：${e.message}`, 'error'))
          .finally(() => { submittingRef.current = false })
      }
    }
    actionRef.current = handleAction
    syncRef.current = syncDraft
    api()?.setDirty?.(draftRef.current.trim().length > 0)
    return () => {
      if (actionRef.current === handleAction) actionRef.current = null
      if (syncRef.current === syncDraft) syncRef.current = null
    }
  }, [kit, draftRef, actionRef, syncRef, onSave])

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
