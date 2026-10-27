import './css/main.css'
import './css/motion.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
import 'katex/dist/katex.min.css'
window.PluginKit.useAppearanceLayout({
  plugin: 'markdown', family: 'editor', scope: '#root',
  regions: { main: '.md-editor-pane', auxiliary: '.md-sidebar', status: '.md-statusbar' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'
import './ui/pk-ui.css'

// Sidebar 等组件需要直接派发文档变更（避免 props drilling）
Object.defineProperty(window, '__mdView', {
  get() { return window.__mdViewRef?.current ?? null },
  configurable: true,
})

createRoot(document.getElementById('root')).render(createElement(App))
