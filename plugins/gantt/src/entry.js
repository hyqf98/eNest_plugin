import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit/widget.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'gantt', family: 'workbench', scope: '#root',
  regions: { navigation: '.plan-sidebar', toolbar: 'header', main: '.gantt-stage', status: '.gantt-foot' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'
import './ui/pk-ui.css'

createRoot(document.getElementById('root')).render(createElement(App))
