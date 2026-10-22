import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'ccswitch', family: 'collection', scope: '#root',
  regions: { navigation: '.nav', toolbar: '.toolbar', main: '.content', auxiliary: '.drawer-panel', status: '.toasts' }
})
import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
