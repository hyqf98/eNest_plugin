/* CSS 级联顺序是像素级一致的命门：原版 index.html 中 main.css / workbench.css
   以 <link> 先于 plugin-kit CSS 加载，React 化后必须在 entry.js 最先 import 复刻该顺序 */
import '@ssh/css/main.css'
import '@ssh/css/workbench.css'
import '@ssh/css/completion.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit/widget.css'
import '@enest/plugin-kit/workbench.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'ssh', family: 'workbench', scope: '#root',
  regions: { navigation: '#side-body', toolbar: '.wb-session-context', main: '.workspace', auxiliary: '#panel-sftp', status: '.wb-statusbar' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
// 纸感手绘主题层最后加载：令牌桥用 !important 接管宿主内联 token。
import './css/paper-theme.css'
