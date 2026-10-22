/**
 * 主题工作区入口（homes/sketchbook.html 的脚本，零构建）
 *
 * 职责：挂滤镜定义 → 解析桥接 → 建 controller → 首帧后渲染 → 订阅可见性。
 * 宿主在开屏期间隐藏预热本页，所以初始化不能等可见事件。
 *
 * 注意：本页在 dev 源码态由宿主直接从磁盘读取（不经过 vite），
 * 所以这里必须是浏览器可直接执行的纯 ESM，不能有 JSX / TS / 打包语法。
 */
import { createController } from './controller.js'
import { resolveBridge } from './bridge.js'
import { createMarketView } from './SketchMarket.js'
import { applyAppearance, observeDocumentVisibility, releaseFonts } from '../shared/applyAppearance.js'
import { mountSketchDefs } from '../shared/sketchPrimitives.js'

const container = document.getElementById('home-root')
if (!container) throw new Error('#home-root is missing')

async function boot() {
  mountSketchDefs(document.body)
  const { bridge: realBridge, mock: wantMock } = resolveBridge()
  // 只有明确要预览时才动态引入演示数据。开发判定放在 import() 的实参位置，
  // 生产构建里 import.meta.env.DEV 被替换成 false，Rollup 能整块删除这条分支，
  // 演示数据不会进入发布包；宿主内运行时走真实桥，也不进这里。
  const preview = wantMock && import.meta.env?.DEV ? await import('./mockBridge.js') : null
  const bridge = realBridge ?? (preview ? await preview.createMockBridge() : null)
  const mock = !realBridge && Boolean(bridge)

  if (!bridge) {
    container.innerHTML = '<div class="sk-market"><div class="sk-page"><div class="sk-empty">'
      + '<strong>工作区桥接不可用</strong><span>请从 eNest 内打开本主题的插件市场首页。</span>'
      + '</div></div></div>'
    return
  }

  const root = document.documentElement
  root.dataset.surface = 'workspace'
  root.dataset.homeVisible = 'false'
  const stopVisibility = observeDocumentVisibility()
  if (mock) root.dataset.sketchbookMock = 'true'

  const controller = createController(bridge, {
    applyAppearance(snapshot) { applyAppearance(snapshot.appearance, snapshot.resources) },
    applyVisibility(visible) { root.dataset.homeVisible = String(visible) },
    // 预览没有 enest-home 协议，用 mock 自带的纯文本；真实宿主走 controller 内的受控 fetch。
    loadReadme: preview && mock ? async () => preview.readMockReadme() : undefined,
  })

  const view = createMarketView(controller)
  container.replaceChildren(view.root)
  view.update(controller.getState())

  const unsubscribe = controller.subscribe(() => {
    const state = controller.getState()
    root.dataset.homeVisible = String(state.visible)
    root.dataset.workspaceRoute = state.route.page
    view.update(state)
  })

  window.addEventListener('pagehide', () => {
    unsubscribe()
    controller.dispose()
    view.dispose()
    stopVisibility()
    releaseFonts()
  }, { once: true })

  await controller.start().catch(error => {
    console.error('[sketchbook] workspace failed to start', error)
    root.dataset.workspaceError = 'true'
  })
}

void boot()
