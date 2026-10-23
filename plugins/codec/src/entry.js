import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'codec', family: 'editor', scope: '#root',
  regions: { navigation: '.modes', toolbar: '.toolbar', main: '.panes', auxiliary: '.history', status: 'footer' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'
import './ui/pk-ui.css'

createRoot(document.getElementById('root')).render(createElement(App))
