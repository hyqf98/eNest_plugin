import './css/main.css'
import './js/image-core.js'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'image-tools', family: 'flow', scope: '#root',
  regions: { navigation: '.mode-seg', toolbar: '.app-head', main: '.work-layout', auxiliary: '.queue-panel', status: '#status' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
