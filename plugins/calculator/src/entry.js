import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'calculator', family: 'instrument', scope: '#root',
  regions: { navigation: '.filters', toolbar: '.toolbar', main: '.calculation', auxiliary: '.history', status: 'footer' }
})
import './css/main.css'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
