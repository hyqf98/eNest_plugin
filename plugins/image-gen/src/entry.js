import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'image-gen', family: 'editor', scope: '#root',
  regions: { navigation: '.ig-rail', main: '.ig-stage', auxiliary: '.ig-composer' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'
import './ui/pk-ui.css'

createRoot(document.getElementById('root')).render(createElement(App))
