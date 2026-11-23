import { AppProvider, NAV_GROUPS, navGroupOf, useApp, type NavId } from './js/state'
import { LibraryView } from './views/Library/LibraryView'
import { DetailView } from './views/Detail/DetailView'
import { DownloadsView } from './views/Downloads/DownloadsView'
import { MyGamesView } from './views/MyGames/MyGamesView'
import { PanSouView } from './views/PanSou/PanSouView'
import { SettingsView } from './views/Settings/SettingsView'
import { Spinner, Empty } from './components/base'
import { TooltipProvider } from './ui'

export function App() {
  // Tooltip 必须在 Provider 内使用；全插件只在这里挂一次，详情页与设置页共享
  return (
    <TooltipProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </TooltipProvider>
  )
}

/*
 * 外壳布局对齐壳的工作区首页：没有左侧菜单列，也不在左上角重复标题（壳的标签栏已经标明当前插件）。
 * 工具栏在内容区里面（和壳的 home-toolbar 一样，上留 10px、下留 16px），不是贴顶的通栏：
 * 左侧是下划线式的主栏目分段，右侧是当前分组内的子栏目 chips 与账号状态。
 * 详情是独立的一页：打开后整块内容区都是详情，工具栏与列表都不渲染——返回才回到列表。
 */
function Shell() {
  const app = useApp()
  if (!app.ready) {
    return <div className="gh-boot">{app.bootError ? <Empty title="启动失败" body={app.bootError} /> : <Spinner label="正在连接后端…" />}</div>
  }
  if (app.detailId) return <DetailView itemId={app.detailId} />
  return (
    <div className="gh-app">
      <div className="gh-page">
        <Toolbar />
        <main className="gh-view" key={app.nav}>
          <ActiveView />
        </main>
      </div>
    </div>
  )
}

function Toolbar() {
  const app = useApp()
  const currentGroup = navGroupOf(app.nav)
  const badge = app.activeCount > 0 ? app.activeCount : 0
  return (
    <header className="gh-toolbar-bar" role="navigation" aria-label="游戏屋导航">
      <div className="gh-seg" role="tablist" aria-label="主栏目">
        {NAV_GROUPS.map(group => {
          const active = group.label === currentGroup.label
          const target = active ? app.nav : group.items[0].id
          return (
            <button
              key={group.label}
              type="button"
              role="tab"
              aria-selected={active}
              className="gh-seg-item"
              onClick={() => app.setNav(target)}
            >
              {group.label}
              {group.items.some(item => item.id === 'downloads') && badge ? <span className="gh-seg-badge" aria-label={`${badge} 个进行中的任务`}>{badge}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="gh-chip-row" role="group" aria-label="分类">
        {currentGroup.items.map(item => (
          <button
            key={item.id}
            type="button"
            className="gh-chip"
            aria-pressed={app.nav === item.id}
            title={item.label}
            onClick={() => app.setNav(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <AuthPill />
    </header>
  )
}

function AuthPill() {
  const app = useApp()
  const { auth } = app
  if (auth.state === 'logged-in') return <span className="gh-status" data-tone="ok">天翼云盘 · {auth.nickname}</span>
  // 未登录 / 已过期都是按钮：点了直接去设置页登录。状态标签不可点，用户会以为"点了没反应"
  if (auth.state === 'expired') {
    return <button type="button" className="gh-toolbar-btn" data-tone="warn" onClick={() => app.setNav('settings')} title="去设置页重新登录">天翼云盘 · 登录已过期</button>
  }
  if (auth.state === 'logged-out') {
    return <button type="button" className="gh-toolbar-btn" onClick={() => app.setNav('settings')}>登录天翼云盘</button>
  }
  return null
}

function ActiveView() {
  const { nav } = useApp()
  switch (nav) {
    case 'pc':
    case 'console':
    case 'software':
    case 'trainer':
    case 'mod':
      return <LibraryView section={nav} />
    case 'pansou':
      return <PanSouView />
    case 'my':
      return <MyGamesView />
    case 'downloads':
      return <DownloadsView />
    case 'settings':
      return <SettingsView />
    default:
      return null
  }
}

export type { NavId }
