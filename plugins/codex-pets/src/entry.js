import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'codex-pets', family: 'collection', scope: '#root',
  regions: { navigation: '.cp-nav', toolbar: '.cp-top', main: '.cp-body', auxiliary: '.cp-cursor-pet', status: '.cp-foot' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
