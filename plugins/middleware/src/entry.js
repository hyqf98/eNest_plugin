/* React 迁移：业务 CSS 必须先于 @enest/plugin-kit/* 加载（复刻原 <link> 级联顺序，像素级一致的命门） */
import './css/main.css'
import './css/workbench.css'
import './css/settings.css'
import '@enest/plugin-kit/workbench.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'middleware', family: 'workbench', scope: '#root',
  regions: { navigation: '.tree', toolbar: '.workbench-head', main: '.content', auxiliary: '.suggestions', status: '.status-bar' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'
import './js/workbench.js'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
// 纸感手绘主题层最后加载：令牌桥用 !important 接管宿主内联 token。
import './css/paper-theme.css'
