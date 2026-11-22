import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'memes', family: 'collection', scope: '#root',
  regions: { navigation: '.mm-nav', toolbar: '.mm-top', main: '.mm-body', status: '.mm-foot' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
