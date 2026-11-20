import { Component, useCallback, useEffect, useMemo, useState } from 'react'
import { call, loadHistory, loadFavorites } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { BrowsePage } from './BrowsePage.jsx'
import { SourcesPage } from './SourcesPage.jsx'
import { SettingsPage } from './SettingsPage.jsx'
import { MinePage } from './MinePage.jsx'
import { DetailPage } from './DetailPage.jsx'
import { ReaderPage } from './ReaderPage.jsx'
import { ComicGrid, SourcePicker, ErrorBox, LoadMore } from './widgets.jsx'

/** 全局错误边界：任何页面渲染崩溃显示错误卡而非白屏 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error) {
    console.error('[comic-house] render crash:', error)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="ch-app">
          <div className="ch-error pk-empty" role="alert" style={{ margin: 'auto' }}>
            <span className="ch-error-text">页面渲染出错：{String(this.state.error?.message || this.state.error).slice(0, 160)}</span>
            <button className="pk-btn pk-btn-sm" onClick={() => { this.setState({ error: null }); location.reload() }}>重载</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/** 应用状态：浏览 / 数据源 / 历史 / 详情 / 阅读 */
export function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  )
}

function AppInner() {
  const [sources, setSources] = useState([])
  const [sourcesError, setSourcesError] = useState('')
  const [activeSource, setActiveSource] = useState('')       // 当前源 key
  const [view, setView] = useState({ name: 'browse' })        // {name, ...params}
  const [history, setHistory] = useState([])
  const [favorites, setFavorites] = useState([])
  const kit = useKit()

  const refreshSources = useCallback(async () => {
    setSourcesError('')
    try {
      const list = await call('sources.list')
      setSources(list)
      setActiveSource(prev => {
        if (prev && list.some(s => s.key === prev && s.enabled)) return prev
        const first = list.find(s => s.enabled)
        return first ? first.key : ''
      })
    } catch (error) {
      notifyError(error)
      setSourcesError('数据源加载失败')
    }
  }, [])

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await loadHistory())
    } catch { /* ignore */ }
  }, [])

  const refreshFavorites = useCallback(async () => {
    try {
      setFavorites(await loadFavorites())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    void refreshSources(); void refreshHistory(); void refreshFavorites()
  }, [refreshSources, refreshHistory, refreshFavorites])

  const openComic = useCallback((comic) => {
    setView({ name: 'detail', sourceKey: comic.sourceKey, comicId: comic.id, title: comic.title })
  }, [])
  const readComic = useCallback(async (sourceKey, comicId, epId, info) => {
    await setView({ name: 'reader', sourceKey, comicId, epId, info })
  }, [])
  const exitReader = useCallback(() => {
    setView({ name: 'detail', sourceKey: view.sourceKey, comicId: view.comicId })
    void refreshHistory()
  }, [view])

  const sourceName = useMemo(
    () => sources.find(s => s.key === activeSource)?.name ?? '',
    [sources, activeSource]
  )

  if (view.name === 'reader') {
    return <ReaderPage params={view} onExit={exitReader} kit={kit} />
  }

  return (
    <div className="ch-app">
      {/* 左侧悬浮导航（垂直居中；壳标题栏已显示插件 icon 与名称） */}
      <nav className="ch-rail ch-nav" aria-label="页面">
        <div className="ch-rail-inner">
          <button className={railClass(view, 'browse')} onClick={() => setView({ name: 'browse' })}>
            <span className="ch-rail-glyph" aria-hidden>✦</span>发现
          </button>
          <button className={railClass(view, 'sources')} onClick={() => setView({ name: 'sources' })}>
            <span className="ch-rail-glyph" aria-hidden>⇄</span>数据源
          </button>
          <button className={railClass(view, 'mine')} onClick={() => { setView({ name: 'mine' }); void refreshFavorites() }}>
            <span className="ch-rail-glyph" aria-hidden>♥</span>我的
          </button>
          <button className={railClass(view, 'settings')} onClick={() => setView({ name: 'settings' })}>
            <span className="ch-rail-glyph" aria-hidden>⚙</span>设置
          </button>
        </div>
      </nav>
      <main className="ch-main ch-body">
        {view.name === 'browse' && (
          <BrowsePage
            sources={sources}
            activeSource={activeSource}
            sourceName={sourceName}
            onSourceChange={setActiveSource}
            onOpenSources={() => setView({ name: 'sources' })}
            onOpenComic={openComic}
          />
        )}
        {view.name === 'sources' && (
          <SourcesPage sources={sources} onChanged={async () => {
            // 卸载源后连带刷新历史与收藏（后端已级联清理对应条目）
            await refreshSources()
            await refreshHistory()
            await refreshFavorites()
          }} />
        )}
        {view.name === 'mine' && (
          <MinePage favorites={favorites} history={history} sources={sources} onOpen={openComic} onRefreshFavorites={refreshFavorites} onRefreshHistory={refreshHistory} />
        )}
        {view.name === 'settings' && <SettingsPage />}
        {view.name === 'detail' && (
          <DetailPage
            sourceKey={view.sourceKey}
            comicId={view.comicId}
            onBack={() => setView({ name: 'browse' })}
            onRead={(epId, info) => void readComic(view.sourceKey, view.comicId, epId, info)}
          />
        )}
      </main>
    </div>
  )
}

function railClass(view, name) {
  const active = view.name === name || (name === 'browse' && view.name === 'detail')
  return active ? 'ch-rail-btn pk-active' : 'ch-rail-btn'
}

/** plugin-kit 降级封装：宿主可用时用 kit.toast，否则静默 */
function useKit() {
  const toast = useCallback((message, type = 'info') => {
    const kit = window.PluginKit?.create ? window.PluginKit : null
    try { kit?.create?.({}).toast?.(message, type) } catch { /* ignore */ }
  }, [])
  return { toast }
}

export { ComicGrid, LoadMore }
