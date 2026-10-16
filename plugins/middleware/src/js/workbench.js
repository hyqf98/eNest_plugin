/**
 * workbench.js — 插件构建入口（vite lib entry → assets/app/workbench.js）
 * 职责：主题注入 / store 恢复 / Tab+树+状态栏首绘 / 生命周期（onEnter/onBeforeClose/onDestroy）
 *       quick 模式（body[data-mode=quick] + 只读约束）/ 全局快捷键（Mod+F 聚焦搜索、Mod+W 关 Tab、Esc 层级退出）
 *       恢复标签描述，显式打开后建立独立会话
 */
import { commands, isComposing } from './commands.js'
import api from './api.js'
import store from './store.js'
import { closeContextMenu } from './components.js'
import { renderAll, setMode as setTabsMode, closeTaskTab, disposePanels, openSettings } from './tabs.js'
import { renderTree, applyTreeWidth, initializeNavigation, closeNavigation } from './tree.js'
import { refreshStatus, setMode as setStatusMode } from './status.js'

let mode = 'shell'
let booted = false
const registry = commands

/* ———————————————— quick 模式 ———————————————— */

function applyMode(nextMode) {
  mode = nextMode === 'quick' ? 'quick' : 'shell'
  document.body.dataset.mode = mode // main.css 按 body[data-mode=quick] 收窄树/隐藏 .write
  setTabsMode(mode)
  setStatusMode(mode)
  applyTreeWidth(mode)
}

/* ———————————————— 快捷键 ———————————————— */

function focusSearch() {
  const page = document.querySelector('#page-host .page:not([hidden])')
  const input = page?.querySelector('.search input, input[type="search"]') || page?.querySelector('input[type="text"]')
  if (input) {
    input.focus()
    input.select?.()
  }
}

function makeCommands() {
  registry.configure(store.ui.productivity.shortcuts)
  registry.register('mw.focusSearch', { element: document, run: focusSearch })
  registry.register('mw.settings', { element: document, run: openSettings })
  registry.register('mw.closeTab', {
    element: document, run: () => {
      if (store.activeTask) closeTaskTab(store.activeTask)
    },
    isActive: () => !!store.activeTask
  })
}
function escapeLayers() {
  if (closeNavigation()) return true
  if (document.querySelector('#ctx-root .ctxmenu')) {
    closeContextMenu()
    return true
  }
  if (document.querySelector('#drawer-root .drawer.on')) {
    import('./connections.js').then(({ closeDrawer }) => closeDrawer()).catch(() => {})
    return true
  }
  return false
}

function bindKeys() {
  document.addEventListener('keydown', (event) => {
    // 弹窗内的键盘事件由 createDialog 自行处理（stopPropagation）
    if (isComposing(event) || event.defaultPrevented) return
    if (document.querySelector('dialog[open]')) return
    if (event.key === 'Escape') {
      if (escapeLayers()) event.preventDefault()
      return
    }
    if (document.querySelector('#drawer-root .drawer.on')) return
    registry.handle(event)
  })
  window.addEventListener('mw-command-error', event => { void api.toast(event.detail?.message || '操作失败', 'error') })
}

/* ———————————————— boot ———————————————— */

async function boot() {
  if (booted) return
  booted = true

  await api.applyTheme()
  applyMode(await api.mode())
  await store.load()
  // Runtime sessions are opened per surface and per connection.
  initializeNavigation(mode)

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
  // renderAll lazily opens the active task.

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
    disposePanels()
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

function fatal(e) {
  // boot 崩溃也要保证基本可读
  console.error('[middleware] boot failed:', e)
  const root = document.getElementById('page-host')
  if (root) root.innerHTML = `<div class="empty-cap"><div class="big">⚠️</div>插件启动失败：${String(e?.message ?? e).slice(0, 120)}</div>`
}

/** React 壳挂载后调用（App.jsx useEffect，commit 后骨架 DOM 已就绪）；booted 守卫保证幂等 */
export { boot, fatal, registry, renderAll }
