// 业务 CSS 先于 plugin-kit 注入（复刻原 <link> 在 head、kit CSS 后置的级联顺序，
// kit 的 `button{font:inherit}` 等规则需能覆盖业务基础样式——顺序不可调换）。
import './css/main.css'
import './css/workbench.css'
import './css/workspace.css'
import './css/productivity.css'
import './css/gridProductivity.css'
import './css/dataOperations.css'
import './css/sqlIntelligence.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/workbench.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'database', family: 'workbench', scope: '#root',
  regions: { navigation: '.side', toolbar: '.wb-querybar,.mid-chrome', main: '.workspace', auxiliary: '.right-panel', status: '.wb-status' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from './jsx/App.jsx'
import { databaseIndexedView } from '@db/launch-index.js'

flushSync(() => createRoot(document.getElementById('root')).render(createElement(App)))

// 命令式业务核心（backend API 调用 / Monaco 集成 / 树与结果网格）原样复用，
// 等 React 渲染出静态外壳后再启动，保证 main.js 的 boot() 能查到全部容器。
import('./js/main.js').catch(error => databaseIndexedView.fail(error))
import './ui/pk-ui.css'
// 纸感手绘主题层最后加载：令牌桥用 !important 接管宿主内联 token。
import './css/paper-theme.css'
