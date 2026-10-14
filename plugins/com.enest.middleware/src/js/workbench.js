/**
 * workbench.js — 插件构建入口（vite lib entry → assets/app/workbench.js）
 * 职责：主题注入 / store 恢复 / Tab+树+状态栏首绘 / 生命周期（onEnter/onBeforeClose/onDestroy）
 *       quick 模式（body[data-mode=quick] + 只读约束）/ 全局快捷键（Mod+F 聚焦搜索、Mod+W 关 Tab、Esc 层级退出）
 *       恢复连接会话能力缓存（api.session 的 session.open 回填）
 */
import { CommandRegistry } from '@enest/plugin-kit/workbench'
import api from './api.js'
import store from './store.js'
import { renderAll, setMode as setTabsMode, setSessionCaps, ensureSession, closeConnTab } from './tabs.js'
import { renderTree, applyTreeWidth } from './tree.js'
import { refreshStatus, setMode as setStatusMode } from './status.js'

let mode = 'shell'
let booted = false
const registry = new CommandRegistry()

/* ———————————————— quick 模式 ———————————————— */

function applyMode(nextMode) {
  mode = nextMode === 'quick' ? 'quick' : 'shell'
  document.body.dataset.mode = mode // main.css 按 body[data-mode=quick] 收窄树/隐藏 .write
  setTabsMode(mode)
  setStatusMode(mode)
  applyTreeWidth(mode)
}

/* ———————————————— 会话恢复：把 api.session 缓存的会话能力回填 tabs ———————————————— */

async function restoreSessionCaps() {
  for (const conn of store.connections) {
    try {
      const info = await api.session.get(api.sessionInfoKey(conn.id))
      if (info?.capabilities) setSessionCaps(conn.id, info.capabilities, info.messageQueryModes)
    } catch { /* ignore */ }
  }
}

/* ———————————————— 快捷键 ———————————————— */

function focusSearch() {
  // 页面里的 .search input（topics/messages 等）优先；没有则聚焦首页
  const input = document.querySelector('#page-host .search input')
  if (input) {
    input.focus()
    input.select?.()
    return
  }
  const homeSearch = document.querySelector('#page-host input[type="text"]')
  if (homeSearch) homeSearch.focus()
}

function makeCommands() {
  registry.register({ id: 'mw.focusSearch', label: '聚焦搜索', shortcut: 'Mod+F', run: focusSearch })
  registry.register({
    id: 'mw.closeTab',
    label: '关闭当前 Tab',
    shortcut: 'Mod+W',
    run: () => {
      if (store.activeTab) closeConnTab(store.activeTab)
    },
    enabled: () => !!store.activeTab
  })
  // Esc 层级退出：先关右键菜单 → 再关抽屉/弹窗（dialog 原生 Esc 已处理一层）
  registry.register({
    id: 'mw.escape',
    label: '退出弹层',
    shortcut: 'Escape',
    run: () => {
      const ctx = document.querySelector('#ctx-root .ctxmenu')
      if (ctx) {
        ctx.remove()
        return
      }
      const drawer = document.querySelector('#drawer-root .drawer.on')
      if (drawer) {
        import('./connections.js').then(({ closeDrawer }) => closeDrawer()).catch(() => {})
      }
    }
  })
}

function bindKeys() {
  document.addEventListener('keydown', (event) => {
    // 弹窗内的键盘事件由 createDialog 自行处理（stopPropagation）
    if (event.isComposing || event.defaultPrevented) return
    if (document.querySelector('dialog[open]')) return
    // 输入框内的 Esc/裸键不抢（Mod+F / Mod+W 仍生效）
    if (event.key === 'Escape' && event.target.closest?.('input, textarea, select')) {
      event.target.blur?.()
      return
    }
    registry.handle(event, { inEditor: true })
  }, true)
}

/* ———————————————— boot ———————————————— */

async function boot() {
  if (booted) return
  booted = true

  await api.applyTheme()
  applyMode(await api.mode())
  await store.load()
  await restoreSessionCaps()

  makeCommands()
  bindKeys()
  api.onModeChange((next) => {
    applyMode(next)
    renderAll()
  })

  renderTree()
  applyTreeWidth(mode)
  renderAll()
  refreshStatus()

  void api.setTitle('中间件控制台').catch(() => {})
  void ensureSession(store.activeTab) // 激活 Tab 懒连接（能力就位后自动重绘）

  /* —— 生命周期 —— */
  api.onEnter(() => {
    // 从设置页等回到插件：刷新树/页面（连接可能被外部改）
    renderTree()
    renderAll()
  })
  api.onBeforeClose(async () => {
    try {
      await store.flush()
    } catch { /* ignore */ }
  })
  api.onDestroy(() => {
    try {
      void store.flush()
    } catch { /* ignore */ }
  })
  window.addEventListener('pagehide', () => {
    try {
      void store.flush()
    } catch { /* ignore */ }
  })

  // 宿主滞后提示（mw 不存在时 api 层已 toast，这里不再重复）
}

boot().catch((e) => {
  // boot 崩溃也要保证基本可读
  console.error('[middleware] boot failed:', e)
  const root = document.getElementById('page-host')
  if (root) root.innerHTML = `<div class="empty-cap"><div class="big">⚠️</div>插件启动失败：${String(e?.message ?? e).slice(0, 120)}</div>`
})

export { registry, renderAll }
