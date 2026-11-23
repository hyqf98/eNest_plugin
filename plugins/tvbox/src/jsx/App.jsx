import { useCallback, useEffect, useRef, useState } from 'react'
import { call, saveSearchKeyword } from '../js/api.js'
import { HomePage } from './HomePage.jsx'
import { VodPage } from './VodPage.jsx'
import { CollectPage } from './CollectPage.jsx'
import { DetailPage } from './DetailPage.jsx'
import { PlayerPage } from './PlayerPage.jsx'
import { LivePage } from './LivePage.jsx'
import { ConfigPage, ListPage } from './ConfigPage.jsx'
import { CloudPage } from './CloudPage.jsx'
import { SearchBox } from './SearchBox.jsx'
import { useKit } from './widgets.jsx'

/** 左侧导航项（icon 字符 + 文案，参照漫画屋悬浮竖向胶囊） */
const RAIL = [
  { name: 'home', glyph: '🏠', label: '首页' },
  { name: 'vod', glyph: '🗂', label: '分类' },
  { name: 'live', glyph: '📺', label: '直播' },
  { name: 'cloud', glyph: '☁️', label: '网盘' },
  { name: 'keep', glyph: '⭐', label: '收藏' },
  { name: 'history', glyph: '🕘', label: '历史' },
  { name: 'config', glyph: '⚙️', label: '配置' },
]

/**
 * 应用：左侧悬浮竖向导航 + 内容区（view 状态机 home/vod/collect/detail/live/keep/history/config）；
 * player 全屏覆盖层。
 */
export function App() {
  const [view, setView] = useState({ name: 'home' })
  const [player, setPlayer] = useState(null)
  const [sites, setSites] = useState([])
  const [keyword, setKeyword] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadSeq, setReloadSeq] = useState(0)   // 手动刷新：递增强制当前页重挂载重拉
  const kit = useKit()
  const siteDropRef = useRef(null)

  const refreshSites = useCallback(async () => {
    try {
      const list = await call('site.list')
      setSites(list)
      setActiveSite(prev => (prev && list.some(s => s.key === prev && !s.disabled)) ? prev : (list.find(s => !s.disabled)?.key ?? ''))
      try {
        const current = await call('config.current')
        setNotice(current?.notice ?? '')
      } catch { /* 未配置时静默 */ }
    } catch { /* 后端未就绪时静默，首页引导配置 */ }
  }, [])

  useEffect(() => { void refreshSites() }, [refreshSites])

  const openVod = useCallback((item) => {
    // 兼容列表项 vod_id 与收藏/历史条目 vodId 两种字段形态
    const vodId = item.vodId ?? item.vod_id
    const siteKey = item.siteKey
    setView({ name: 'detail', siteKey, vodId: String(vodId), siteName: item.siteName ?? sites.find(s => s.key === siteKey)?.name ?? '' })
  }, [sites])

  const openPlayer = useCallback((params) => { setPlayer(params) }, [])
  const closePlayer = useCallback(() => { setPlayer(null) }, [])

  const resumeHistory = useCallback(async (h) => {
    try {
      const detail = await call('site.detail', [h.siteKey, h.vodId])
      const flagIndex = Math.max(0, detail.flags.findIndex(f => f.flag === h.flag))
      setPlayer({
        siteKey: h.siteKey, siteName: h.siteName, vodId: h.vodId, vodName: h.vodName || detail.vod_name,
        flags: detail.flags, flagIndex, episodeIndex: h.episodeIndex || 0,
        cover: h.vodPic || detail.vod_pic, resumeSec: h.positionSec || 0,
      })
    } catch (e) {
      kit?.toast(`续播失败：${e?.message || e}`)
    }
  }, [kit])

  const doSearch = useCallback((kwArg) => {
    const kw = String(kwArg ?? keyword).trim()
    if (!kw) return
    void saveSearchKeyword(kw).catch(() => {})
    setView({ name: 'collect', keyword: kw, sites })
  }, [keyword, sites])

  return (
    <div className="tb-app">
      {/* 左侧悬浮竖向导航 */}
      <nav className="tb-rail">
        <div className="tb-rail-inner">
          {RAIL.map(item => (
            <button
              key={item.name}
              className={`tb-rail-btn${(view.name === item.name || (item.name === 'home' && view.name === 'collect') || (item.name === 'vod' && view.name === 'detail' && view.from === 'vod')) ? ' pk-active' : ''}`}
              onClick={() => {
                setView(item.name === 'vod' ? { name: 'vod' } : { name: item.name })
              }}
            >
              <span className="tb-rail-glyph">{item.glyph}</span>
              <span>{item.label}</span>
            </button>
          ))}
          {/* 手动刷新当前页：重挂载内容区触发各页面数据 useEffect 重拉 */}
          <button
            className="tb-rail-btn tb-rail-refresh"
            onClick={() => { setReloadSeq(s => s + 1); void refreshSites() }}
            title="刷新当前页"
            aria-label="刷新当前页"
          >
            <span className="tb-rail-glyph">↻</span>
            <span>刷新</span>
          </button>
        </div>
      </nav>

      {/* 内容区 */}
      <main className="tb-main" key={reloadSeq}>
        {/* 顶行工具条：聚合模式只有搜索框（多源自动参与，站点启停在配置页） */}
        {view.name !== 'live' ? (
          <div className="tb-topbar">
            <SearchBox keyword={keyword} setKeyword={setKeyword} onSearch={doSearch} onOpenVod={openVod} />
          </div>
        ) : null}

        {notice && view.name === 'home' ? <div className="tb-error" style={{ marginBottom: 10 }}>{notice}</div> : null}

        {view.name === 'home' ? <HomePage sites={sites} onOpenVod={openVod} onGoConfig={() => setView({ name: 'config' })} onPlayResume={resumeHistory} onGoCategory={(sectionKey) => setView({ name: 'vod', sectionKey })} /> : null}
        {view.name === 'vod' ? <VodPage params={view} onOpenVod={item => { setView({ name: 'detail', siteKey: item.siteKey || item.sources?.[0]?.siteKey, vodId: String(item.vodId ?? item.vod_id ?? item.sources?.[0]?.vodId), siteName: item.siteName ?? item.sources?.[0]?.siteName ?? '', from: 'vod' }) }} /> : null}
        {view.name === 'collect' ? <CollectPage params={view} onOpenVod={openVod} onBack={() => setView({ name: 'home' })} /> : null}
        {view.name === 'detail' ? <DetailPage params={{ ...view, onOpenVod: openVod }} onBack={() => setView(view.from === 'vod' ? { name: 'vod' } : { name: 'home' })} onPlay={openPlayer} /> : null}
        {view.name === 'live' ? <div style={{ height: 'calc(100% - 0px)' }}><LivePage onBack={() => setView({ name: 'home' })} /></div> : null}
        {view.name === 'cloud' ? <CloudPage /> : null}
        {view.name === 'keep' ? <ListPage mode="keep" onOpenVod={openVod} /> : null}
        {view.name === 'history' ? <ListPage mode="history" onOpenVod={openVod} onPlayResume={resumeHistory} /> : null}
        {view.name === 'config' ? <ConfigPage onConfigChanged={refreshSites} /> : null}
      </main>

      {player ? <PlayerPage params={player} onExit={closePlayer} onSwitchEpisode={i => setPlayer(p => p ? { ...p, episodeIndex: i } : p)} onSwitchFlag={i => setPlayer(p => p ? { ...p, flagIndex: i } : p)} /> : null}
    </div>
  )
}
