import './js/color-math.js'
import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'color-picker', family: 'flow', scope: '#root',
  regions: { navigation: '.work-seg', toolbar: '.app-head', main: '.color-layout', auxiliary: '.control-panel', status: '#status' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
