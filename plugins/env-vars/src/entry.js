import './style.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit/widget.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'env-vars', family: 'collection', scope: '#root',
  regions: { navigation: '.scopes', toolbar: 'header', main: '.table-col', status: '.status' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
