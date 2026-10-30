import './style.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit/widget.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'password-book', family: 'collection', scope: '#root',
  regions: { navigation: '.sidebar', toolbar: 'header', main: '.entries', status: 'footer' }
})
// MCP handler 注册：模块加载即注册（不等 onEnter，MCP 冷启动页面隐藏）
import './js/mcp.mjs'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
