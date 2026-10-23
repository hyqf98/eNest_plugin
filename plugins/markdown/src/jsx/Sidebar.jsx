/**
 * markdown v2 —— 侧栏：大纲（折叠+检索定位） / 文件树（多根） / 资源（链接聚合卡片）。
 * 资源面板从当前文档动态提取全部引用，按类型分图标小卡片；图片卡悬停放大预览。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call, resolveImageToDataUrl } from '../js/rpc.js'
import { extractResources, KIND_ICON, KIND_LABEL, isImageExt, titleFor } from '../js/resources.js'

export function Sidebar({ panelRef, tab, onTab, outline, docPath, textRef, docVersion, recentFiles, onOpenFile, onJump, toast, viewRef }) {
  const [tree, setTree] = useState([])
  const [roots, setRoots] = useState([])
  const [activeRoot, setActiveRoot] = useState('')
  const [expanded, setExpanded] = useState(new Set())
  const [outlineQuery, setOutlineQuery] = useState('')
  const [collapsedOutline, setCollapsedOutline] = useState(new Set())
  const [hoverPreview, setHoverPreview] = useState(null)

  /* —— 资源列表：跟随文档版本（docVersion 每次内容变化 +1）—— */
  const resources = useMemo(() => {
    void docVersion
    return extractResources(textRef.current || '')
  }, [docVersion, textRef])

  const grouped = useMemo(() => {
    const map = {}
    for (const r of resources) (map[r.kind] ||= []).push(r)
    return map
  }, [resources])

  /* —— 图片缩略图 / 放大预览（经后端 dataUrl）—— */
  const thumbCache = useRef(new Map())
  const [thumbs, setThumbs] = useState({})
  const imageList = grouped.image || []
  useEffect(() => {
    const images = imageList.slice(0, 40)
    let alive = true
    for (const img of images) {
      if (thumbs[img.url] || thumbCache.current.has(img.url)) continue
      void resolveImageToDataUrl(docPath, img.url).then((dataUrl) => {
        if (!alive || !dataUrl) return
        thumbCache.current.set(img.url, dataUrl)
        setThumbs((prev) => ({ ...prev, [img.url]: dataUrl }))
      }).catch(() => {})
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageList, docPath])

  const showPreview = useCallback((e, url) => {
    const dataUrl = thumbs[url] || thumbCache.current.get(url)
    if (!dataUrl) return
    const rect = e.currentTarget.getBoundingClientRect()
    setHoverPreview({ x: rect.right + 8, y: Math.max(8, rect.top - 20), dataUrl })
  }, [thumbs])
  const hidePreview = useCallback(() => setHoverPreview(null), [])

  /* —— 文件树 —— */
  const loadTree = useCallback(async (root) => {
    try {
      await call('dir.grant', root)
      const nodes = await call('dir.list', root)
      setTree(nodes)
      setActiveRoot(root)
    } catch (e) {
      toast(`目录读取失败：${e.message}`, 'error')
    }
  }, [toast])

  useEffect(() => {
    void call('dir.recentRoots').then(({ roots: r }) => {
      setRoots(r)
      if (r[0]) void loadTree(r[0])
    }).catch(() => {})
  }, [loadTree])

  const pickRoot = useCallback(async () => {
    const handles = await window.enest?.localFiles?.pick?.({ kind: 'directory', multiple: false, access: 'read' })
    const path = handles?.[0]?.displayPath
    if (path) {
      const { roots: r } = await call('dir.recentRoots')
      setRoots(r)
      void loadTree(path)
    }
  }, [loadTree])

  /* —— 资源卡片点击行为 —— */
  const jumpToAnchor = useCallback((url) => {
    const view = viewRef?.current
    if (!view) return
    const text = textRef.current || ''
    const target = url.slice(1)
    const re = /^#{1,6}\s+(.*?)(?:\s*\{#[\w-]+\})?\s*$/
    const lines = text.split('\n')
    let pos = 0
    for (const line of lines) {
      const m = re.exec(line)
      if (m && (m[1] === target || m[1].toLowerCase() === target.toLowerCase())) {
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
        view.focus()
        return
      }
      pos += line.length + 1
    }
    toast('未找到该锚点标题', 'info')
  }, [viewRef, textRef, toast])

  const onItemClick = useCallback((r) => {
    if (r.kind === 'anchor') return jumpToAnchor(r.url)
    if (r.kind === 'web' || r.kind === 'mail' || r.kind === 'tel') {
      if (/^https?:\/\//i.test(r.url)) void window.enest?.shell?.openExternal?.(r.url)
      else if (/^mailto:/i.test(r.url) || /^tel:/i.test(r.url)) void window.enest?.shell?.openExternal?.(r.url)
      return
    }
    if (r.kind === 'doc' || r.kind === 'file') {
      // 相对路径：拼当前文档目录后尝试打开
      if (docPath && !/^https?:|^data:/i.test(r.url)) {
        const dir = docPath.slice(0, docPath.lastIndexOf('/'))
        const clean = decodeURIComponent(r.url.split(/[?#]/)[0])
        void onOpenFile(clean.startsWith('/') ? clean : `${dir}/${clean}`)
      }
      return
    }
    // image：滚动到文档中该图片位置
    const view = viewRef?.current
    if (!view) return
    const idx = (textRef.current || '').indexOf(r.url)
    if (idx >= 0) { view.dispatch({ selection: { anchor: idx }, scrollIntoView: true }); view.focus() }
  }, [jumpToAnchor, docPath, onOpenFile, viewRef, textRef])

  /* —— 外链转本地 —— */
  const externalize = useCallback(async (r) => {
    if (!docPath) return
    try {
      const { url: local } = await call('assets.externalize', docPath, r.url)
      const view = viewRef?.current
      const text = textRef.current || ''
      if (!view || !text.includes(r.url)) { toast('未能在文档中定位该链接', 'error'); return }
      const next = text.split(r.url).join(local)
      textRef.current = next
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
      thumbCache.current.delete(r.url)
      setThumbs((prev) => { const n = { ...prev }; delete n[r.url]; return n })
      toast('已转存本地', 'success')
    } catch (e) {
      toast(`转存失败：${e.message}`, 'error')
    }
  }, [docPath, viewRef, textRef, toast])

  /* —— 大纲：检索过滤 + 层级折叠 —— */
  const visibleOutline = useMemo(() => {
    const nodes = outline.map((n, idx) => ({ ...n, idx }))
    const q = outlineQuery.trim().toLowerCase()
    if (q) return nodes.filter((n) => n.text.toLowerCase().includes(q))
    const hidden = new Set()
    let hideBelow = 0
    nodes.forEach((node) => {
      if (hideBelow > 0 && node.level > hideBelow) { hidden.add(node.idx); return }
      hideBelow = collapsedOutline.has(node.idx) ? node.level : 0
    })
    return nodes.map((n) => ({ ...n, hidden: hidden.has(n.idx) }))
  }, [outline, outlineQuery, collapsedOutline])

  const KIND_ORDER = ['image', 'web', 'doc', 'file', 'anchor', 'mail', 'tel']

  return (
    <aside className="md-sidebar" id="md-navigation" ref={panelRef} data-tab={tab} aria-label="文档导航">
      <div className="md-sidebar-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'outline'} onClick={() => onTab('outline')}>大纲</button>
        <button role="tab" aria-selected={tab === 'files'} onClick={() => onTab('files')}>文件</button>
        <button role="tab" aria-selected={tab === 'assets'} onClick={() => onTab('assets')}>资源{resources.length ? ` ${resources.length}` : ''}</button>
      </div>

      {tab === 'outline' && (
        <div className="md-sidebar-panel md-outline">
          <div className="md-outline-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3 3"/></svg>
            <input type="text" placeholder="检索标题，回车定位" value={outlineQuery}
              onChange={(e) => setOutlineQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const first = visibleOutline.find((n) => !n.hidden)
                  if (first) { onJump(first.from); setOutlineQuery('') }
                }
                if (e.key === 'Escape') setOutlineQuery('')
              }} aria-label="大纲检索" />
          </div>
          <div role="tree">
            {outline.length === 0 && <p className="md-sidebar-empty">暂无标题</p>}
            {outlineQuery && !visibleOutline.length && <p className="md-sidebar-empty">无匹配标题</p>}
            {visibleOutline.map(({ level, text, from, idx, hidden }) => hidden ? null : (
              <div key={idx} className={`md-outline-item md-outline-l${Math.min(level, 6)}`}
                role="treeitem">
                <button className="md-outline-text" onClick={() => onJump(from)} title={text}>{text}</button>
                {!outlineQuery && outline.some((n, i2) => i2 > idx && n.level > level) && (
                  <button className={`md-outline-fold ${collapsedOutline.has(idx) ? 'is-collapsed' : ''}`}
                    onClick={() => setCollapsedOutline((prev) => {
                      const next = new Set(prev)
                      if (next.has(idx)) next.delete(idx); else next.add(idx)
                      return next
                    })}
                    title={collapsedOutline.has(idx) ? '展开子级' : '折叠子级'}>{collapsedOutline.has(idx) ? '▸' : '▾'}</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'files' && (
        <div className="md-sidebar-panel md-files">
          <div className="md-files-head">
            <select className="pk-input md-root-select" value={activeRoot} onChange={(e) => void loadTree(e.target.value)} aria-label="工作目录">
              {roots.length === 0 && <option value="">选择目录…</option>}
              {roots.map((r) => <option key={r} value={r}>{r.split('/').pop()}</option>)}
            </select>
            <button className="pk-btn pk-btn-sm" onClick={() => void pickRoot()} title="打开目录">＋</button>
            <button className="pk-btn pk-btn-sm" onClick={() => void loadTree(activeRoot)} title="刷新">⟳</button>
          </div>
          <div className="md-file-tree" role="tree">
            <TreeNodes nodes={tree} expanded={expanded} setExpanded={setExpanded} onOpenFile={onOpenFile} activePath={docPath} />
          </div>
          {recentFiles.length > 0 && (
            <div className="md-recent">
              <div className="md-sidebar-label">最近</div>
              {recentFiles.slice(0, 8).map((f) => (
                <button key={f.path} className="md-recent-item" onClick={() => onOpenFile(f.path)} title={f.path}>{f.name}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'assets' && (
        <div className="md-sidebar-panel md-assets">
          {resources.length === 0 && <p className="md-sidebar-empty">{docPath ? '本文档没有链接或图片' : '先打开一个文档'}</p>}
          {KIND_ORDER.map((kind) => {
            const items = grouped[kind]
            if (!items || !items.length) return null
            return (
              <div key={kind} className="md-asset-group">
                <div className="md-sidebar-label">{KIND_LABEL[kind]} · {items.length}</div>
                <div className="md-asset-grid">
                  {items.map((r, i) => {
                    const title = titleFor(r.url, r.label)
                    if (kind === 'image') {
                      const remote = /^https?:\/\//i.test(r.url)
                      return (
                        <div key={i} className="md-asset-row">
                          <button className="md-asset-card md-asset-image"
                            onMouseEnter={(e) => showPreview(e, r.url)} onMouseLeave={hidePreview}
                            onClick={() => onItemClick(r)} title={title}>
                            <span className="md-asset-thumb">
                              {thumbs[r.url] ? <img src={thumbs[r.url]} alt="" /> : KIND_ICON.image}
                            </span>
                            <span className="md-asset-name">{title}</span>
                          </button>
                          {remote && docPath && (
                            <button className="md-asset-act" title="下载并转存为本地图片"
                              onClick={() => void externalize(r)}>⇩</button>
                          )}
                        </div>
                      )
                    }
                    return (
                      <button key={i} className={`md-asset-card md-asset-${kind}`}
                        onClick={() => onItemClick(r)} title={r.url}>
                        <span className="md-asset-icon">{KIND_ICON[kind]}</span>
                        <span className="md-asset-name">{title}</span>
                        {(kind === 'web' || kind === 'anchor') && <span className="md-asset-badge">{kind === 'web' ? '↗' : '#'}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {hoverPreview && (
        <div className="md-img-hoverpop" style={{ left: Math.min(hoverPreview.x, window.innerWidth - 310), top: Math.min(hoverPreview.y, window.innerHeight - 250) }}>
          <img src={hoverPreview.dataUrl} alt="" />
        </div>
      )}
    </aside>
  )
}

function TreeNodes({ nodes, expanded, setExpanded, onOpenFile, activePath, depth = 0 }) {
  if (!nodes.length) return <p className="md-sidebar-empty">空目录</p>
  return (
    <>
      {nodes.map((node) => {
        const isOpen = expanded.has(node.path)
        return (
          <div key={node.path}>
            {node.type === 'dir' ? (
              <button className="md-tree-dir" style={{ '--depth': depth }}
                onClick={() => setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(node.path)) next.delete(node.path); else next.add(node.path)
                  return next
                })}>
                <span className="md-tree-caret">{isOpen ? '▾' : '▸'}</span>{node.name}
              </button>
            ) : (
              <button className={`md-tree-file${node.path === activePath ? ' is-active' : ''}`} style={{ '--depth': depth }}
                onClick={() => onOpenFile(node.path)} title={node.path}>
                {node.name}
              </button>
            )}
            {node.type === 'dir' && isOpen && node.children && (
              <TreeNodes nodes={node.children} expanded={expanded} setExpanded={setExpanded} onOpenFile={onOpenFile} activePath={activePath} depth={depth + 1} />
            )}
          </div>
        )
      })}
    </>
  )
}
