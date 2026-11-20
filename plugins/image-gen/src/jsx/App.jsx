/**
 * App — AI 生图主组件：视图路由（chat/library）+ 会话状态 + 生成编排 + lightbox + 设置弹窗。
 * 会话 KV：索引 image-gen.sessions.v1 + 分键 image-gen.session.<id>；防抖 600ms 写入。
 * Quick 模式：隐藏会话栏/预览库/设置齿轮，单会话直进，↗ 主窗口打开。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SessionRail } from './SessionRail.jsx'
import { ChatView } from './ChatView.jsx'
import { LibraryView } from './LibraryView.jsx'
import { Lightbox } from './Lightbox.jsx'
import { SettingsDialog, loadTemplates, loadSaveDir } from './SettingsDialog.jsx'
import { loadProviders, getDefaultProvider } from '../js/providers.mjs'
import { runGeneration, loadSessionIndex, loadSession, persistSession, deleteSession } from '../js/agent.mjs'
import { loadRecords, removeRecord, deleteAsset, getAsset, assetPreviewUrl } from '../js/assets.mjs'
import { saveAssetToDirectory } from '../js/backendBridge.mjs'

const GEAR_SVG = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
  <circle cx="12" cy="12" r="3.2" />
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
</svg>

const uid = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function App() {
  const kitRef = useRef(null)
  const api = window.enest || window.zapi

  const [ready, setReady] = useState(false)
  const [quickMode, setQuickMode] = useState(() => (api?.getLaunchMode?.() || new URLSearchParams(location.search).get('mode')) === 'quick')
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [view, setView] = useState('chat')

  const [sessions, setSessions] = useState([])
  const [activeId, setActiveId] = useState('')
  const [messages, setMessages] = useState([])
  const [running, setRunning] = useState(false)

  const [providers, setProviders] = useState([])
  const [templates, setTemplates] = useState([])
  const [saveDir, setSaveDir] = useState(null)
  const [prefs, setPrefs] = useState(null)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState('providers')

  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])
  const [size, setSize] = useState('auto')
  const [nCount, setNCount] = useState(1)
  const [lightbox, setLightbox] = useState(null)   // { items, index }
  const [records, setRecords] = useState([])
  const [dragOver, setDragOver] = useState(false)

  /* refs（回调与防抖读写最新值） */
  const messagesRef = useRef(messages); messagesRef.current = messages
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  const providersRef = useRef(providers); providersRef.current = providers
  const saveDirRef = useRef(saveDir); saveDirRef.current = saveDir
  const runningRef = useRef(running); runningRef.current = running
  const abortRef = useRef(null)
  const persistTimer = useRef(0)

  const toast = useCallback((message, kind = 'info') => {
    kitRef.current?.toast(message, kind)
  }, [])

  /* —— 初始化 —— */
  useEffect(() => {
    const kit = PluginKit.create({
      title: 'AI 生图',
      quickPlaceholder: '描述要生成的画面 · Enter 发送',
      height: 560,
      prefs: true,
      defaults: { defaultSize: 'auto', defaultN: 1, defaultQuality: 'auto' },
      onQuery: value => { setInput(String(value ?? '')) },
      onAction: action => { if (action === 'submit') stateRef.current.send?.() }
    })
    kitRef.current = kit
    let alive = true
    void (async () => {
      try {
        await kit.ready
        if (!alive) return
        setPrefs({ ...kit.settings })
        const [prov, tpl, dir, index] = await Promise.all([loadProviders(), loadTemplates(), loadSaveDir(), loadSessionIndex()])
        if (!alive) return
        setProviders(prov)
        setTemplates(tpl)
        setSaveDir(dir)
        setSize(kit.settings.defaultSize ?? 'auto')
        setNCount(Math.min(4, Math.max(1, Number(kit.settings.defaultN) || 1)))
        setSessions(index)
        // Quick 单会话直进：不回放历史列表，主窗口模式恢复最近会话
        if (kit.mode !== 'quick' && index.length) {
          const first = index[0]
          setActiveId(first.id)
          setMessages(await loadSession(first.id))
        }
        setReady(true)
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
        setReady(true)
      }
    })()
    kit.onMode(next => setQuickMode(next === 'quick'))
    return () => { alive = false }
  }, [toast])

  /* —— Quick onEnter：带入文本/图片 —— */
  useEffect(() => {
    api?.onEnter?.(event => {
      const text = typeof event?.payload === 'string' ? event.payload : event?.payload?.type === 'text' ? event.payload.text : ''
      if (text) setInput(text)
      const images = event?.input?.images ?? []
      if (images.length) {
        setAttachments(prev => [...prev, ...images.slice(0, Math.max(0, 4 - prev.length)).map((img, i) => ({
          id: uid() + i, dataUrl: img.dataUrl, name: '粘贴图片'
        }))])
      }
    })
  }, [])

  /* —— 会话持久化（防抖 600ms）—— */
  const schedulePersist = useCallback(() => {
    clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const id = activeIdRef.current
      if (!id) return
      void persistSession({ id, messages: messagesRef.current }).catch(() => {})
    }, 600)
  }, [])

  useEffect(() => {
    if (!ready) return
    schedulePersist()
  }, [messages, ready, schedulePersist])

  /* —— 会话操作 —— */
  const ensureSession = useCallback(() => {
    if (activeIdRef.current) return activeIdRef.current
    const id = uid()
    setActiveId(id)
    activeIdRef.current = id
    setSessions(prev => [{ id, title: '新会话', updatedAt: Date.now() }, ...prev])
    return id
  }, [])

  const newSession = useCallback(() => {
    if (runningRef.current) { toast('生成中，请先停止'); return }
    clearTimeout(persistTimer.current)
    const id = uid()
    setActiveId(id)
    activeIdRef.current = id
    setMessages([])
    setSessions(prev => [{ id, title: '新会话', updatedAt: Date.now() }, ...prev])
    setInput(''); setAttachments([])
  }, [toast])

  const selectSession = useCallback(async id => {
    if (id === activeIdRef.current || runningRef.current) return
    clearTimeout(persistTimer.current)
    void persistSession({ id: activeIdRef.current, messages: messagesRef.current }).catch(() => {})
    setActiveId(id)
    activeIdRef.current = id
    setMessages(await loadSession(id))
  }, [])

  const removeSession = useCallback(async id => {
    clearTimeout(persistTimer.current)
    await deleteSession(id)
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (id === activeIdRef.current) {
        setActiveId(next[0]?.id ?? '')
        activeIdRef.current = next[0]?.id ?? ''
        setMessages([])
      }
      return next
    })
  }, [])

  const renameSession = useCallback(id => {
    const current = sessions.find(s => s.id === id)
    const name = window.prompt('重命名会话', current?.title ?? '')
    if (name === null || !name.trim()) return
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, title: name.trim().slice(0, 40) } : s)))
    void (async () => {
      // 重命名直接改索引标题（分键不动）
      try {
        const storage = (window.enest || window.zapi).storage
        const index = await loadSessionIndex()
        await storage.set('image-gen.sessions.v1', index.map(s => (s.id === id ? { ...s, title: name.trim().slice(0, 40) } : s)))
      } catch { /* 下次写入会重新同步 */ }
    })()
  }, [sessions])

  /* —— 发送 / 停止 —— */
  const stopRun = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const send = useCallback(async ({ overridePrompt, overrideAttachments } = {}) => {
    const prompt = (overridePrompt ?? input).trim()
    const atts = overrideAttachments ?? attachments
    if (!prompt && !atts.length) return
    if (runningRef.current) { toast('正在生成中'); return }
    const provider = getDefaultProvider(providersRef.current)
    if (!provider) {
      setSettingsOpen(true)
      setSettingsSection('providers')
      toast('还没有可用渠道，先添加一个')
      return
    }
    const sessionId = ensureSession()
    const userMsg = { id: uid(), role: 'user', prompt, attachments: atts.map(a => ({ assetId: a.dataUrl, name: a.name })) }
    const assistantId = uid()
    const assistantMsg = { id: assistantId, role: 'assistant', status: 'running', receivedBytes: 0 }
    setMessages(prev => [...prev, userMsg, assistantMsg])
    setInput(''); setAttachments([])

    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    const patch = (patchObj) => setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, ...patchObj } : m)))
    try {
      const result = await runGeneration({
        provider, prompt, sessionId,
        attachments: atts.map(a => ({ dataUrl: a.dataUrl, name: a.name })),
        size, quality: prefs?.defaultQuality ?? 'auto', n: nCount,
        saveDir: saveDirRef.current,
        signal: controller.signal,
        onProgress: bytes => setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, receivedBytes: (m.receivedBytes ?? 0) + bytes } : m)))
      })
      patch({
        status: 'ok',
        images: result.images.map(img => ({ assetId: img.assetId })),
        revised: result.revised,
        meta: { provider: provider.name, model: result.model, apiKind: result.apiKind, size: result.size, n: result.n, ms: result.ms, usage: result.usage },
        error: null
      })
      void loadRecords().then(setRecords)
    } catch (err) {
      if (err?.name === 'AbortError') {
        patch({ status: 'cancelled', error: null })
      } else {
        patch({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }, [input, attachments, nCount, size, prefs, ensureSession, toast])

  /* —— 重试（同参数重跑出新消息）—— */
  const retryAt = useCallback(async (index) => {
    const list = messagesRef.current
    // 找该 AI 消息之前最近的用户消息
    let userMsg = null
    for (let i = index - 1; i >= 0; i -= 1) {
      if (list[i]?.role === 'user') { userMsg = list[i]; break }
    }
    if (!userMsg) return
    // 附件 assetId 是 data: 前缀（会话内快照），直接复用
    await send({
      overridePrompt: userMsg.prompt,
      overrideAttachments: (userMsg.attachments ?? []).map(a => ({ id: uid(), dataUrl: a.assetId, name: a.name }))
    })
  }, [send])

  /* —— 图片操作 —— */
  const buildLightboxItems = useCallback(async (items) => {
    // items: [{assetId|url, prompt}] → 解析 url（blob 缓存）
    const resolved = []
    for (const item of items) {
      const url = item.url ?? await assetPreviewUrl(item.assetId)
      if (url) resolved.push({ ...item, url })
    }
    return resolved
  }, [])

  const openLightbox = useCallback(async (assetId, url, prompt = '') => {
    const items = await buildLightboxItems([{ assetId, url, prompt }])
    if (items.length) setLightbox({ items, index: 0 })
  }, [buildLightboxItems])

  const openLightboxAt = useCallback(async (assetId, prompt = '') => {
    // 以当前会话消息流为时间线（最近用户提示词兜底展示）
    let lastPrompt = prompt
    const timeline = []
    for (const m of messagesRef.current) {
      if (m.role === 'user' && m.prompt) lastPrompt = m.prompt
      if (m.role !== 'assistant' || m.status !== 'ok') continue
      for (const img of m.images ?? []) timeline.push({ assetId: img.assetId, prompt: lastPrompt })
    }
    if (!timeline.length) { await openLightbox(assetId, undefined, prompt); return }
    const items = await buildLightboxItems(timeline)
    const index = Math.max(0, items.findIndex(i => i.assetId === assetId))
    setLightbox({ items, index })
  }, [buildLightboxItems, openLightbox])

  /** 下载：优先自定义目录句柄，失败/无句柄走宿主原生保存框 */
  const downloadAsset = useCallback(async (assetId) => {
    try {
      const asset = await getAsset(assetId)
      if (!asset) { toast('图片不存在或已删除', 'error'); return }
      const ext = (asset.mime?.split('/')?.[1] ?? 'png').replace('jpeg', 'jpg')
      const name = `image-gen-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.${ext}`
      if (saveDirRef.current?.handleId) {
        try {
          await saveAssetToDirectory({ handleId: saveDirRef.current.handleId, name, dataUrl: asset.dataUrl })
          toast('已保存到目录', 'success')
          return
        } catch {
          toast('保存目录已失效，请重新选择', 'error')
        }
      }
      const res = await api.shell.saveFile({ defaultName: name, dataUrl: asset.dataUrl })
      if (res?.ok) toast('已保存', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [api, toast])

  const deleteImageAsset = useCallback(async (assetId) => {
    try {
      await deleteAsset(assetId)
      setMessages(prev => prev.map(m => {
        if (m.role !== 'assistant' || !Array.isArray(m.images)) return m
        const images = m.images.filter(img => img.assetId !== assetId)
        if (images.length === m.images.length) return m
        return { ...m, images, status: images.length ? m.status : 'error', error: images.length ? m.error : '图片已删除' }
      }))
      setRecords(prev => prev.filter(r => r.assetId !== assetId))
      toast('已删除', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [toast])

  const imageAction = useCallback((action, assetId) => {
    if (action === 'download') void downloadAsset(assetId)
    else if (action === 'delete') void deleteImageAsset(assetId)
    else if (action === 'continue') void continueWithImage(assetId)
  }, [downloadAsset, deleteImageAsset])

  /** 以此图继续：首图转 Composer 附件，占位切换 */
  const continueWithImage = useCallback(async (assetId) => {
    try {
      const asset = await getAsset(assetId)
      if (!asset) { toast('图片不存在或已删除', 'error'); return }
      setAttachments([{ id: uid(), dataUrl: asset.dataUrl, name: '以此图继续' }])
      setView('chat')
      document.querySelector('.ig-composer-input')?.focus()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [toast])

  const copyPrompt = useCallback(async (text) => {
    if (!text) return
    try { await kitRef.current?.copy(text); toast('已复制', 'success') } catch { /* 忽略 */ }
  }, [toast])

  const downloadAll = useCallback((message) => {
    for (const img of message?.images ?? []) void downloadAsset(img.assetId)
  }, [downloadAsset])

  /* —— 预览库 —— */
  const refreshRecords = useCallback(async () => setRecords(await loadRecords()), [])
  useEffect(() => { if (ready && view === 'library') void refreshRecords() }, [ready, view, refreshRecords])

  const recordAction = useCallback((action, record) => {
    if (action === 'download') void downloadAsset(record.assetId)
    else if (action === 'continue') void continueWithImage(record.assetId)
    else if (action === 'delete') {
      void (async () => {
        await deleteAsset(record.assetId)
        await removeRecord(record.id)
        setRecords(prev => prev.filter(r => r.id !== record.id))
        toast('已删除', 'success')
      })()
    }
  }, [downloadAsset, continueWithImage, toast])

  /* —— 文件选择 / 拖入 —— */
  const pickFiles = useCallback(async () => {
    try {
      const handles = await api.localFiles.pick({ kind: 'file', multiple: true, access: 'read',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
      const list = Array.isArray(handles) ? handles : (handles ? [handles] : [])
      const next = []
      for (const handle of list.slice(0, 4)) {
        const dataUrl = await api.localFiles.read({ handleId: handle.id, encoding: 'dataUrl' })
        next.push({ id: uid(), dataUrl, name: handle.name })
      }
      if (next.length) setAttachments(prev => {
        const room = 4 - prev.length
        if (next.length > room) toast(`最多 4 张附件，已忽略 ${next.length - room} 张`)
        return [...prev, ...next.slice(0, room)]
      })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [api, toast])

  /* 整窗拖入（遮罩在 App 根监听） */
  useEffect(() => {
    const onDragOver = (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return
      event.preventDefault()
      setDragOver(true)
    }
    const onDragLeave = (event) => {
      if (event.relatedTarget) return
      setDragOver(false)
    }
    const onDrop = async (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return
      event.preventDefault()
      setDragOver(false)
      const files = [...event.dataTransfer.files].filter(f => f.type.startsWith('image/')).slice(0, 4)
      if (!files.length) return
      const next = []
      for (const file of files) {
        next.push({ id: uid(), dataUrl: await new Promise(resolve => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.readAsDataURL(file)
        }), name: file.name })
      }
      setAttachments(prev => {
        const room = 4 - prev.length
        if (next.length > room) toast(`最多 4 张附件，已忽略 ${next.length - room} 张`)
        return [...prev, ...next.slice(0, room)]
      })
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [toast])

  /* —— 回填（用户消息重新编辑 / ⭐模板跳设置）—— */
  const recallMessage = useCallback((message) => {
    setInput(message.prompt ?? '')
    setAttachments((message.attachments ?? []).map(a => ({ id: uid(), dataUrl: a.assetId, name: a.name })))
    document.querySelector('.ig-composer-input')?.focus()
  }, [])

  const openSettingsAt = useCallback((section) => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  /* —— 顶栏 —— */
  const currentProvider = getDefaultProvider(providers) ?? providers[0] ?? null
  const topbar = (
    <header className="ig-topbar">
      <button type="button" className="ig-icon-btn ig-topbar-menu-btn" title="会话列表" aria-label="会话列表"
        onClick={() => setRailCollapsed(v => !v)}>☰</button>
      <button type="button" className="ig-chip-select" title={currentProvider ? `${currentProvider.name}（${currentProvider.apiKind}）` : '未配置渠道'}
        onClick={() => openSettingsAt('providers')} disabled={!providers.length}>
        <span className="ig-kind-dot" data-kind={currentProvider?.apiKind} />
        <span className="ig-chip-label">{currentProvider?.name ?? '未配置渠道'}</span>
        <span className="ig-caret">▾</span>
      </button>
      <span className="ig-model-label" title={currentProvider?.model}>{currentProvider?.model ?? ''}</span>
      <span className="ig-topbar-spacer" />
      {!quickMode && view === 'chat' && (
        <button type="button" className="ig-icon-btn" title="预览库" aria-label="预览库" onClick={() => setView('library')}>▦</button>
      )}
      {view === 'library' && (
        <button type="button" className="ig-icon-btn" title="回到会话" aria-label="回到会话" onClick={() => setView('chat')}>✉</button>
      )}
      {quickMode && (
        <button type="button" className="ig-icon-btn ig-open-shell" title="在主窗口打开" aria-label="在主窗口打开"
          onClick={() => api?.ui?.openInShell?.()}>↗</button>
      )}
    </header>
  )

  /* —— stateRef（命令式桥）—— */
  const stateRef = useRef({})
  stateRef.current = { send }

  const composerProps = {
    value: input, onChange: setInput, onSend: () => void send(), busy: running, onStop: stopRun,
    attachments, onAttachmentsChange: setAttachments,
    size, onSizeChange: setSize, n: nCount, onNChange: v => setNCount(Math.min(4, Math.max(1, v))),
    templates, onOpenTemplateSettings: () => openSettingsAt('templates'),
    onPickFiles: pickFiles, onImageClick: url => setLightbox({ items: [{ url, prompt: '' }], index: 0 }),
    onRecall: recallMessage,
    toast, editMode: attachments.length > 0
  }

  if (!ready || !prefs) return <div className="ig-app"><main className="ig-stage" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--ig-muted)' }}>正在准备…</main></div>

  return (
    <div className="ig-app" data-rail-collapsed={railCollapsed && !quickMode ? '' : undefined}>
      {!quickMode && (
        <SessionRail
          sessions={sessions} activeId={activeId}
          onSelect={selectSession} onNew={newSession} onDelete={removeSession} onRename={renameSession}
        />
      )}
      {view === 'chat' || quickMode ? (
        <ChatView
          messages={messages}
          topbar={topbar}
          running={running}
          onOpenImage={(assetId, url) => void openLightboxAt(assetId)}
          onImageAction={imageAction}
          onRetry={retryAt}
          onContinue={img => void continueWithImage(img.assetId)}
          onDownloadAll={downloadAll}
          onCopyPrompt={copyPrompt}
          composerProps={composerProps}
        />
      ) : (
        <LibraryView
          records={records}
          topbar={topbar}
          onOpen={(record, url) => setLightbox({ items: [{ url, prompt: record.prompt, assetId: record.assetId }], index: 0 })}
          onAction={recordAction}
          onCopy={record => void copyPrompt(record.prompt)}
          onBulkDownload={ids => { for (const r of records.filter(r => ids.includes(r.id))) void downloadAsset(r.assetId) }}
          onBulkDelete={ids => {
            void (async () => {
              for (const r of records.filter(r => ids.includes(r.id))) {
                await deleteAsset(r.assetId)
                await removeRecord(r.id)
              }
              await refreshRecords()
              toast('已删除', 'success')
            })()
          }}
          onGoChat={() => setView('chat')}
        />
      )}

      {!quickMode && (
        <button type="button" className="ig-gear" title="设置" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>
          {GEAR_SVG}
        </button>
      )}

      <SettingsDialog
        open={settingsOpen} onOpenChange={setSettingsOpen}
        section={settingsSection} onSectionChange={setSettingsSection}
        providers={providers} onProvidersChanged={async () => setProviders(await loadProviders())}
        prefs={prefs} onPrefsChanged={async next => {
          setPrefs(next)
          await kitRef.current?.setPref('defaultSize', next.defaultSize)
          await kitRef.current?.setPref('defaultN', next.defaultN)
          await kitRef.current?.setPref('defaultQuality', next.defaultQuality)
          setSize(next.defaultSize)
          setNCount(Math.min(4, Math.max(1, Number(next.defaultN) || 1)))
        }}
        saveDir={saveDir} onSaveDirChanged={setSaveDir}
        templates={templates} onTemplatesChanged={setTemplates}
        toast={toast}
      />

      {lightbox && (
        <Lightbox
          items={lightbox.items} index={lightbox.index}
          onIndexChange={index => setLightbox(prev => ({ ...prev, index }))}
          onClose={() => setLightbox(null)}
          onContinue={item => { setLightbox(null); void item.assetId ? continueWithImage(item.assetId) : null }}
          onDownload={item => item.assetId ? void downloadAsset(item.assetId) : toast('该图片无法直接下载（本地附件）', 'error')}
          onDelete={item => {
            if (!item.assetId) { setLightbox(null); return }
            void deleteImageAsset(item.assetId)
            const rest = lightbox.items.filter(i => i.assetId !== item.assetId)
            if (!rest.length) setLightbox(null)
            else setLightbox(prev => ({ items: rest, index: Math.min(prev.index, rest.length - 1) }))
          }}
          onCopyPrompt={item => void copyPrompt(item.prompt)}
        />
      )}

      {dragOver && (
        <div className="ig-drop-mask" aria-label="拖入图片">
          <div className="ig-drop-box">松开添加图片</div>
        </div>
      )}
    </div>
  )
}
