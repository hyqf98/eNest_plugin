import { AppProvider, DISCOVER_ITEMS, PAGES, pageOf, useApp, type NavId } from './js/state'
import { LibraryView } from './views/Library/LibraryView'
import { DetailView } from './views/Detail/DetailView'
import { DownloadsView } from './views/Downloads/DownloadsView'
import { MyGamesView } from './views/MyGames/MyGamesView'
import { PanSouView } from './views/PanSou/PanSouView'
import { SettingsView } from './views/Settings/SettingsView'
import { Spinner, Empty } from './components/base'
import { GearSix } from '@phosphor-icons/react'
import { Glyph } from './components/Glyph'
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
 * 导航只有一层：一条下划线式的页面导航（发现 / 我的游戏 / 下载管理），右侧是设置与天翼云盘账号。
 * 「发现」下面的内容栏目（PC 游戏、主机游戏…）是第二行里的胶囊 chips——和主导航用不同的形状，
 * 两级不会被看成同一回事。
 * 详情是独立的一页：打开后整块内容区都是详情，导航与列表都不渲染，返回才回到列表。
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
        <NavBar />
        <main className="gh-view" key={app.nav}>
          <ActiveView />
        </main>
      </div>
    </div>
  )
}

/*
 * 页头两行。
 * 第一行：页面导航（左）+ 下载角标 + 设置 + 天翼云盘账号（右）。
 * 第二行只在「发现」下出现：内容栏目的胶囊 chips。
 */
function NavBar() {
  const app = useApp()
  const current = pageOf(app.nav)
  const badge = app.activeCount > 0 ? app.activeCount : 0
  const inDiscover = current === 'discover'
  return (
    <header className="gh-nav" role="navigation" aria-label="游戏盒子导航">
      <div className="gh-nav-bar">
        <div className="gh-seg" role="tablist" aria-label="页面">
          {PAGES.map(page => {
            const active = page.id === current
            // 「发现」已激活时再点一次不跳走：仍停在当前的内容栏目；从别的页面回来时也回到上次的栏目
            const target = page.id === 'discover' ? app.lastDiscover : page.id
            return (
              <button
                key={page.id}
                type="button"
                role="tab"
                aria-selected={active}
                className="gh-seg-item"
                onClick={() => { if (!active) app.setNav(target) }}
              >
                {page.label}
                {page.id === 'downloads' && badge ? (
                  <span className="gh-seg-badge" role="img" aria-label={`${badge} 个进行中的任务`}>{badge}</span>
                ) : null}
              </button>
            )
          })}
        </div>

        <div className="gh-nav-tools">
          <button
            type="button"
            className="gh-nav-tool"
            aria-label="设置"
            title="设置"
            aria-current={app.nav === 'settings' ? 'page' : undefined}
            onClick={() => app.setNav('settings')}
          >
            <Glyph icon={GearSix} size={16} />
          </button>
          <AuthPill />
        </div>
      </div>

      {inDiscover ? (
        <div className="gh-chip-row" role="group" aria-label="内容栏目">
          {DISCOVER_ITEMS.map(item => (
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
      ) : null}
    </header>
  )
}

function AuthPill() {
  const app = useApp()
  const { auth } = app
  // 三种状态高度一致（都是 32px），切换时页头不跳动
  if (auth.state === 'logged-in') return <button type="button" className="gh-nav-auth" data-tone="ok" onClick={() => app.setNav('settings')} title="天翼云盘账号设置">天翼云盘 · {auth.nickname || '已登录'}</button>
  // 未登录 / 已过期都是按钮：点了直接去设置页登录。状态标签不可点，用户会以为"点了没反应"
  if (auth.state === 'expired') {
    return <button type="button" className="gh-nav-auth" data-tone="warn" onClick={() => app.setNav('settings')} title="去设置页重新登录">天翼云盘 · 登录已过期</button>
  }
  if (auth.state === 'logged-out') {
    return <button type="button" className="gh-nav-auth" onClick={() => app.setNav('settings')}>登录天翼云盘</button>
  }
  return <span className="gh-nav-auth" aria-hidden="true" />
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
