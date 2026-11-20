import { Component, useCallback, useEffect, useState } from 'react'
import { loadHistory, loadFavorites } from '../js/api.js'
import { notifyError } from '../js/notify.js'
import { BrowsePage } from './BrowsePage.jsx'
import { SourcesPage } from './SourcesPage.jsx'
import { SettingsPage } from './SettingsPage.jsx'
import { MinePage } from './MinePage.jsx'
import { DetailPage } from './DetailPage.jsx'
import { ReaderPage } from './ReaderPage.jsx'

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
    console.error('[novel-house] render crash:', error)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="nh-app">
          <div className="nh-error pk-empty" role="alert" style={{ margin: 'auto' }}>
            <span className="nh-error-text">页面渲染出错：{String(this.state.error?.message || this.state.error).slice(0, 160)}</span>
            <button className="pk-btn pk-btn-sm" onClick={() => { this.setState({ error: null }); location.reload() }}>重载</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/** 应用状态：浏览 / 书源 / 历史 / 详情 / 阅读 */
export function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  )
}

function AppInner() {
  const [sources, setSources] = useState([])
  const [view, setView] = useState({ name: 'browse' })        // {name, ...params}
  const [history, setHistory] = useState([])
  const [favorites, setFavorites] = useState([])

  const refreshSources = useCallback(async () => {
    try {
      const list = await callSafe('sources.list')
      setSources(list)
    } catch (error) {
      notifyError(error)
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

  const openBook = useCallback((book) => {
    setView({ name: 'detail', sourceKey: book.sourceKey, bookId: book.bookId ?? book.id, title: book.title })
  }, [])

  const readBook = useCallback(async (sourceKey, bookId, chId, chTitle, info) => {
    await setView({ name: 'reader', sourceKey, bookId, chId, chTitle, info })
  }, [])

  const exitReader = useCallback(() => {
    setView(prev => ({ name: 'detail', sourceKey: prev.sourceKey, bookId: prev.bookId }))
    void refreshHistory()
  }, [refreshHistory])

  if (view.name === 'reader') {
    return <ReaderPage params={view} onExit={exitReader} />
  }

  return (
    <div className="nh-app">
      {/* 左侧悬浮导航（垂直居中；壳标题栏已显示插件 icon 与名称） */}
      <nav className="nh-rail nh-nav" aria-label="页面">
        <div className="nh-rail-inner">
          <button className={railClass(view, 'browse')} onClick={() => setView({ name: 'browse' })}>
            <span className="nh-rail-glyph" aria-hidden>✦</span>发现
          </button>
          <button className={railClass(view, 'sources')} onClick={() => setView({ name: 'sources' })}>
            <span className="nh-rail-glyph" aria-hidden>⇄</span>书源
          </button>
          <button className={railClass(view, 'mine')} onClick={() => { setView({ name: 'mine' }); void refreshFavorites() }}>
            <span className="nh-rail-glyph" aria-hidden>♥</span>我的
          </button>
          <button className={railClass(view, 'settings')} onClick={() => setView({ name: 'settings' })}>
            <span className="nh-rail-glyph" aria-hidden>⚙</span>设置
          </button>
        </div>
      </nav>
      <main className="nh-main nh-body">
        {view.name === 'browse' && (
          <BrowsePage
            sources={sources}
            onOpenSources={() => setView({ name: 'sources' })}
            onOpenBook={openBook}
          />
        )}
        {view.name === 'sources' && (
          <SourcesPage sources={sources} onChanged={refreshSources} />
        )}
        {view.name === 'mine' && (
          <MinePage favorites={favorites} history={history} sources={sources} onOpen={openBook} onRefreshFavorites={refreshFavorites} onRefreshHistory={refreshHistory} />
        )}
        {view.name === 'settings' && <SettingsPage />}
        {view.name === 'detail' && (
          <DetailPage
            sourceKey={view.sourceKey}
            bookId={view.bookId}
            title={view.title}
            onBack={() => setView({ name: 'browse' })}
            onRead={(chId, chTitle, info) => void readBook(view.sourceKey, view.bookId, chId, chTitle, info)}
          />
        )}
      </main>
    </div>
  )
}

/** 后端桥缺失时不炸启动：Sources 加载失败在页面内展示 */
async function callSafe(method, args) {
  const enest = window.enest || window.zapi
  if (!enest?.backend?.call) return []
  return enest.backend.call(method, args, { timeoutMs: 120_000 })
}

function railClass(view, name) {
  const active = view.name === name || (name === 'browse' && view.name === 'detail')
  return active ? 'nh-rail-btn pk-active' : 'nh-rail-btn'
}
