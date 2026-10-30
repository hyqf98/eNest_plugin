/**
 * 密码本主界面：顶栏（标题/计数/搜索/MoreMenu）+ 左栏分类 + 右侧条目卡片与详情。
 * 数据层复用 js/store.js（storage 元数据 + vault 密码引用）；MCP handler 复用同一 store。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, MoreMenu, Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/index.jsx'
import * as store from '../js/store.js'
import { backend } from '../js/backend.js'
import { EntryList } from './EntryList.jsx'
import { EntryDetail } from './EntryDetail.jsx'
import { EntryDialog, CategoryDialog } from './EntryDialog.jsx'
import { Icon } from './icons.jsx'

const api = () => window.enest || window.zapi
const ALL = '__all__'

export function App() {
  const kitRef = useRef(null)
  const [entries, setEntries] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [activeCategory, setActiveCategory] = useState(ALL)
  const [selectedId, setSelectedId] = useState('')
  const [status, setStatus] = useState('就绪')
  const [entryDialog, setEntryDialog] = useState({ open: false, entry: null })
  const [categoryDialog, setCategoryDialog] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [mcpDialog, setMcpDialog] = useState(false)
  const [genDialog, setGenDialog] = useState(false)
  const [genResult, setGenResult] = useState('')

  const refresh = useCallback(() => {
    const snap = store.snapshot()
    setEntries(snap.entries)
    setCategories(snap.categories)
  }, [])

  useEffect(() => {
    refresh()
    const off = store.onChange(() => refresh())
    void store.load()
      .then(() => { refresh(); setLoading(false) })
      .catch((error) => { setLoadError(error?.message || String(error)); setLoading(false) })
    return () => { off() }
  }, [refresh])

  // 搜索防抖 120ms
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword.trim().toLowerCase()), 120)
    return () => clearTimeout(timer)
  }, [keyword])

  const toast = useCallback((message, kind) => {
    kitRef.current?.toast?.(message, kind || 'success')
    setStatus(message)
  }, [])

  const copy = useCallback(async (text, options) => {
    try {
      await api()?.clipboard?.writeText?.(text, options || {})
      toast('已复制到剪贴板', 'success')
    } catch (error) {
      toast(error?.message || '复制失败', 'error')
    }
  }, [toast])

  const counts = useMemo(() => {
    const map = {}
    for (const entry of entries) map[entry.category] = (map[entry.category] || 0) + 1
    return map
  }, [entries])

  const filtered = useMemo(() => {
    let list = entries
    if (activeCategory !== ALL) list = list.filter((entry) => entry.category === activeCategory)
    if (debounced) {
      list = list.filter((entry) =>
        [entry.title, entry.site, entry.username].some((field) => String(field || '').toLowerCase().includes(debounced)))
    }
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [entries, activeCategory, debounced])

  const selected = useMemo(() => entries.find((entry) => entry.id === selectedId) || null, [entries, selectedId])

  const categoryText = useCallback((id) => {
    return categories.find((item) => item.id === id)?.name || '默认'
  }, [categories])

  const saveEntry = useCallback(async (draft) => {
    if (draft.id) {
      await store.updateEntry(draft.id, draft)
      toast(`已更新「${draft.title}」`, 'success')
    } else {
      const entry = await store.createEntry(draft)
      setSelectedId(entry.id)
      toast(`已创建「${entry.title}」，密码已加密保存`, 'success')
    }
  }, [toast])

  const createCategory = useCallback(async (name) => {
    const item = await store.createCategory(name)
    return item
  }, [])

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    try {
      await store.deleteEntry(target.id)
      if (selectedId === target.id) setSelectedId('')
      toast(`已删除「${target.title}」`, 'success')
    } catch (error) {
      toast(error.message, 'error')
    }
  }, [deleteTarget, selectedId, toast])

  const openGenerator = async () => {
    setGenResult('')
    setGenDialog(true)
    try { setGenResult((await backend.generatePassword({})).password) }
    catch { setGenResult('') }
  }

  const sidebarItems = [
    { id: ALL, name: '全部', count: entries.length },
    ...categories.map((item) => ({ id: item.id, name: item.name, count: counts[item.id] || 0 }))
  ]

  return (
    <main className="app">
      <header>
        <div className="brand">
          <span className="brand-icon">{Icon.lock(18)}</span>
          <div>
            <h1>密码本</h1>
            <span className="muted">{entries.length} 个账号 · 本地加密</span>
          </div>
        </div>
        <div className="search-wrap">
          {Icon.search(14)}
          <input
            type="search" value={keyword} onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索标题 / 站点 / 用户名" aria-label="搜索条目"
          />
          {keyword && <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm clear" aria-label="清空搜索" onClick={() => setKeyword('')}>×</button>}
        </div>
        <Button variant="primary" onClick={() => setEntryDialog({ open: true, entry: null })}>{Icon.plus(13)} 新建</Button>
        <MoreMenu
          label="更多" ariaLabel="密码本更多操作"
          items={[
            { key: 'new', label: '新建条目', onSelect: () => setEntryDialog({ open: true, entry: null }) },
            { key: 'categories', label: '分类管理', onSelect: () => setCategoryDialog(true) },
            { key: 'generator', label: '生成密码工具', onSelect: () => void openGenerator() },
            'sep',
            { key: 'mcp', label: 'MCP 工具说明', onSelect: () => setMcpDialog(true) }
          ]}
        />
      </header>

      <div className="layout">
        <aside className="sidebar" aria-label="分类">
          <nav>
            {sidebarItems.map((item) => (
              <button
                type="button" key={item.id}
                className={'side-item' + (activeCategory === item.id ? ' active' : '')}
                onClick={() => setActiveCategory(item.id)}
              >
                <span>{item.id === ALL ? Icon.shield(13) : Icon.folder(13)} {item.name}</span>
                <span className="badge count">{item.count}</span>
              </button>
            ))}
          </nav>
          <Button variant="primary" className="side-new" onClick={() => setEntryDialog({ open: true, entry: null })}>{Icon.plus(13)} 新建条目</Button>
        </aside>

        <section className="entries" aria-label="条目列表">
          {loading ? (
            <div className="state-view">正在加载密码本…</div>
          ) : loadError ? (
            <div className="state-view error">
              <p>加载失败：{loadError}</p>
              <Button onClick={() => { setLoading(true); setLoadError(''); void store.load().then(() => { refresh(); setLoading(false) }).catch((e) => { setLoadError(e.message); setLoading(false) }) }}>重试</Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="state-view empty">
              <p className="empty-title">{Icon.shield(24)} 密码本还是空的</p>
              <p className="empty-text">把常用网站的账号密码收进来：密码加密存入本机保险库，条目只保留元数据。<br />也可以通过 MCP 工具让 AI 助手在获得授权后替你读写。</p>
              <Button variant="primary" onClick={() => setEntryDialog({ open: true, entry: null })}>{Icon.plus(13)} 新建第一个条目</Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="state-view empty"><p className="empty-title">没有匹配的条目</p><p className="empty-text">换个关键词，或清除搜索再看全部条目。</p></div>
          ) : (
            <EntryList
              entries={filtered} activeId={selectedId}
              onSelect={(entry) => setSelectedId(entry.id)}
              onEdit={(entry) => setEntryDialog({ open: true, entry })}
              onDelete={(entry) => setDeleteTarget(entry)}
            />
          )}
        </section>

        <EntryDetail
          entry={selected} categoryText={selected ? categoryText(selected.category) : ''}
          onEdit={(entry) => setEntryDialog({ open: true, entry })}
          onDelete={(entry) => setDeleteTarget(entry)}
          onCopy={copy} toast={toast}
        />
      </div>

      <footer>
        <span>共 {entries.length} 条 · 当前 {filtered.length} 条</span>
        <span className="status-text" role="status">{status}</span>
        <span className="muted">{Icon.lock(12)} 密码加密存储于本机保险库</span>
      </footer>

      <EntryDialog
        open={entryDialog.open} onOpenChange={(open) => setEntryDialog({ open, entry: open ? entryDialog.entry : null })}
        entry={entryDialog.entry} categories={categories}
        onSave={saveEntry} onCreateCategory={createCategory}
      />

      <CategoryDialog
        open={categoryDialog} onOpenChange={setCategoryDialog}
        categories={categories} counts={counts}
        onRename={(id, name) => store.renameCategory(id, name)}
        onDelete={(id) => store.deleteCategory(id)}
        onCreate={createCategory}
      />

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="pb-dialog" aria-label="删除条目">
          <DialogTitle>删除条目</DialogTitle>
          <DialogDescription>
            将删除「{deleteTarget?.title}」的条目信息，并同步移除保险库中对应的加密密码。此操作不可撤销。
          </DialogDescription>
          <div className="dialog-actions">
            <span className="spacer" />
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>{Icon.trash(13)} 删除</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={genDialog} onOpenChange={setGenDialog}>
        <DialogContent className="pb-dialog pb-generator" aria-label="生成密码">
          <DialogTitle>生成密码</DialogTitle>
          <DialogDescription>使用系统级安全随机源生成的 20 位密码（默认排除易混淆字符）。</DialogDescription>
          <div className="gen-result mono" aria-live="polite">{genResult || '生成中…'}</div>
          <div className="dialog-actions">
            <span className="spacer" />
            <Button variant="ghost" onClick={() => void openGenerator()}>{Icon.refresh(13)} 重新生成</Button>
            <Button variant="primary" disabled={!genResult} onClick={() => { if (genResult) void copy(genResult, { excludeFromHistory: true }) }}>{Icon.copy(13)} 复制</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mcpDialog} onOpenChange={setMcpDialog}>
        <DialogContent className="pb-dialog pb-mcp" aria-label="MCP 工具说明">
          <DialogTitle>MCP 工具说明</DialogTitle>
          <DialogDescription>
            在宿主设置「开发者 → MCP 服务」启用后，持有令牌的本机 AI 客户端可调用本插件的 5 个工具：
          </DialogDescription>
          <dl className="mcp-list">
            <dt className="mono">list</dt><dd>列出条目（不含密码）</dd>
            <dt className="mono">get</dt><dd>读取单条（含密码明文，仅供受信任助手按用户明确要求使用）</dd>
            <dt className="mono">create</dt><dd>新建条目（密码写入加密保险库）</dd>
            <dt className="mono">update</dt><dd>更新条目（未传字段不动，密码可选替换）</dd>
            <dt className="mono">delete</dt><dd>删除条目（同步移除保险库密码）</dd>
          </dl>
          <p className="mcp-note">MCP 执行期间如遇尚未授权的敏感能力（如保险库写入），宿主会返回 needs-consent，不会弹出授权框；请先在插件页面完成一次正常操作授权。</p>
          <div className="dialog-actions">
            <span className="spacer" />
            <Button onClick={() => setMcpDialog(false)}>知道了</Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
