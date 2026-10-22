/**
 * 主题样式台只预览本包 ThemePackV2；全局快照只提供 light/dark。
 * 本地切色与「跟随宿主」均不激活主题、不写入宿主设置。
 */
import { mountWorkbench } from './workbench.js'
import { applyAppearance, observeDocumentVisibility, releaseFonts } from '../shared/applyAppearance.js'
import { createPreviewAppearance, loadPreviewTheme } from '../shared/previewTheme.js'

const api = window.enest || window.zapi
const container = document.getElementById('root')
if (!container) throw new Error('#root is missing')

const stopVisibility = observeDocumentVisibility()
const systemMode = matchMedia('(prefers-color-scheme: dark)')
let hostMode = systemMode.matches ? 'dark' : 'light'
let hasHostMode = false
let previewMode = null
let pack
let offAppearance
let disposeWorkbench
let disposed = false
let revision = -1

const renderPreview = () => {
  if (!disposed && pack) applyAppearance(createPreviewAppearance(pack, previewMode ?? hostMode))
}
const followSystem = () => {
  if (hasHostMode) return
  hostMode = systemMode.matches ? 'dark' : 'light'
  renderPreview()
}
systemMode.addEventListener('change', followSystem)

// 先订阅再水合；仅消费模式，不把当前全局主题的 tokens/fonts/components 带进样式台。
if (api?.theme?.getAppearance) {
  const accept = appearance => {
    if (disposed || !appearance || appearance.revision < revision) return
    if (appearance.mode !== 'light' && appearance.mode !== 'dark') return
    revision = appearance.revision
    hasHostMode = true
    hostMode = appearance.mode
    renderPreview()
  }
  offAppearance = api.theme.onAppearanceChange?.(accept)
  void api.theme.getAppearance().then(accept).catch(() => undefined)
}

void loadPreviewTheme(new URL('./plugin.json', document.baseURI)).then(theme => {
  if (disposed) return
  pack = theme
  renderPreview()
  disposeWorkbench = mountWorkbench(container, mode => {
    // null 是「跟随宿主」的有效值，不能用 if (mode) 把它丢弃。
    previewMode = mode === 'light' || mode === 'dark' ? mode : null
    renderPreview()
  }, pack.palettes)
}).catch(() => {
  if (disposed) return
  const message = document.createElement('p')
  message.textContent = '无法读取素描本主题声明，请重新打开样式台。'
  container.replaceChildren(message)
})

window.addEventListener('pagehide', () => {
  disposed = true
  offAppearance?.()
  systemMode.removeEventListener('change', followSystem)
  stopVisibility()
  disposeWorkbench?.()
  releaseFonts()
}, { once: true })
