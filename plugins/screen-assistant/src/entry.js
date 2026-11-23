import './styles/base.css'
import './styles/shell.css'
import './styles/views.css'
import './styles/editor.css'
import './styles/tools.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'

window.PluginKit.useAppearanceLayout({
  plugin: 'screen-assistant',
  family: 'flow',
  scope: '#root',
  regions: { navigation: '.sa-rail', main: '.sa-main', auxiliary: '.sa-lightbox', status: '.sa-status' }
})

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.jsx'
import './ui/pk-ui.css'

createRoot(document.getElementById('root')).render(createElement(App))
